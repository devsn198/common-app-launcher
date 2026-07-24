const STORE_ID = 'store';

const logo = document.getElementById('logo');
const tablistEl = document.getElementById('tablist');
const frame = document.getElementById('frame');
const statusPane = document.getElementById('statusPane');
const emptyEl = document.getElementById('empty');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPane = document.getElementById('settingsPane');
const toastEl = document.getElementById('toast');

let apps = [];
let activeId = null;
let pollTimer = null;
let toastTimer = null;
let settingsOpen = false;
let drag = null;           // live rail-drag state, else null
let railLocked = false;    // while set, renderTabs() stands down (drag in flight)
let suppressClick = false; // swallow the click that trails a drag's pointerup
const expandedLogs = new Set();

const userApps = () => apps.filter((a) => a.id !== STORE_ID);
const monogram = (app) => (app.name || app.id).trim().charAt(0).toUpperCase() || '?';
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function fetchApps() {
  const res = await fetch('/shell/apps');
  const { apps: list } = await res.json();
  return list;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  void toastEl.offsetWidth; // reflow so the transition runs
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => (toastEl.hidden = true), 220);
  }, 1900);
}

// ── The launcher gem ───────────────────────────────────────────────────────
// It only breathes while the Store is open. Stopping it needs help: dropping a
// CSS animation snaps the element straight back to its base value — the browser
// does not transition out of an animation. So the live frame is pinned as an
// inline style first, the animation is removed, and only then are the inline
// values cleared, which the CSS transition can carry home smoothly.
const gemImg = logo.querySelector('img');
const gemHalo = logo.querySelector('.gem-halo');
const gemParts = [gemImg, gemHalo];

function setGem(active) {
  if (active === logo.classList.contains('active')) return; // no-op on every poll

  if (active) {
    for (const el of gemParts) {
      el.style.transition = 'none';
      el.style.transform = el.style.filter = el.style.opacity = '';
    }
    void logo.offsetWidth;                       // commit before the keyframes start
    for (const el of gemParts) el.style.transition = '';
    logo.classList.add('active');
    return;
  }

  // Pin whatever frame the animation is currently showing…
  const frozen = gemParts.map((el) => {
    const cs = getComputedStyle(el);
    return { el, transform: cs.transform, filter: cs.filter, opacity: cs.opacity };
  });
  for (const f of frozen) {
    f.el.style.transition = 'none';
    f.el.style.transform = f.transform;
    f.el.style.filter = f.filter;
    f.el.style.opacity = f.opacity;
  }
  void logo.offsetWidth;
  logo.classList.remove('active');               // …stop the keyframes…
  for (const el of gemParts) el.style.transition = '';
  requestAnimationFrame(() => {                  // …then release, so the transition runs
    for (const el of gemParts) {
      el.style.transform = el.style.filter = el.style.opacity = '';
    }
  });
}

function renderTabs() {
  if (railLocked) return; // never rebuild the rail out from under a live drag
  const scroll = tablistEl.scrollTop; // preserve scroll across the 2s poll re-render
  tablistEl.innerHTML = '';

  for (const app of userApps()) {
    const btn = document.createElement('button');
    btn.className = `tab status-${app.status}${app.id === activeId ? ' active' : ''}`;
    btn.title = `${app.name} — ${app.status}`;
    btn.setAttribute('aria-label', `${app.name} (${app.status})`);

    if (app.logo) {
      // Render the app's declared logo; fall back to a monogram if it fails to load.
      const img = document.createElement('img');
      img.className = 'logo-img';
      img.src = `/apps/${app.id}/${String(app.logo).replace(/^\/+/, '')}`;
      img.alt = '';
      img.onerror = () => {
        const m = document.createElement('span');
        m.className = 'mono';
        m.textContent = monogram(app);
        img.replaceWith(m);
      };
      btn.appendChild(img);
    } else {
      const m = document.createElement('span');
      m.className = 'mono';
      m.textContent = monogram(app);
      btn.appendChild(m);
    }

    btn.dataset.id = app.id;
    btn.addEventListener('pointerdown', onTilePointerDown);
    btn.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; } // that click ended a drag
      selectTab(app.id);
    });
    tablistEl.appendChild(btn);
  }

  // "+" takes the user to the Store (the add-an-app surface); sits after the last tile.
  const add = document.createElement('button');
  add.className = 'add';
  add.title = 'Add an app';
  add.setAttribute('aria-label', 'Add an app — open the Store');
  add.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none"
      stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14"/></svg>`;
  add.addEventListener('click', () => selectTab(STORE_ID));
  tablistEl.appendChild(add);

  tablistEl.scrollTop = scroll;
  setGem(!settingsOpen && activeId === STORE_ID);
  settingsBtn.classList.toggle('active', settingsOpen);
}

// ── Rail reordering ────────────────────────────────────────────────────────
// Pointer-driven rather than HTML5 drag-and-drop, for two reasons: the native
// drag image can't be constrained to one axis, and native reordering means
// moving nodes in the DOM — a layout change, which CSS cannot transition (hence
// the snap). Here nothing moves in the DOM until the drop: the lifted tile gets
// a translateY tracking the pointer, and the tiles it passes get a translateY of
// one slot, which *is* transitionable. The DOM order is only rewritten at the end.

const DRAG_THRESHOLD = 4; // px of travel before a press becomes a drag, so clicks still work
const SETTLE_MS = 180;

function onTilePointerDown(e) {
  if (e.button !== 0) return; // primary button / touch only
  // A drag doesn't always emit a trailing click (it depends where the pointer
  // came to rest), so clear the flag per press rather than relying on that click
  // to consume it — otherwise a stale `true` swallows the next real click.
  suppressClick = false;
  const tiles = [...tablistEl.querySelectorAll('.tab')];
  if (tiles.length < 2) return; // nothing to reorder
  const el = e.currentTarget;
  const first = tiles[0].getBoundingClientRect();
  drag = {
    el,
    tiles,
    from: tiles.indexOf(el),
    to: tiles.indexOf(el),
    startY: e.clientY,
    // Slot pitch = tile height + the flex gap, read from the live layout.
    step: tiles.length > 1 ? tiles[1].getBoundingClientRect().top - first.top : el.offsetHeight,
    active: false,
    pointerId: e.pointerId,
  };
  railLocked = true; // freeze the rail: the poll must not rebuild it under us
  el.setPointerCapture(e.pointerId);
}

// Shift every tile the dragged one has passed by exactly one slot, in the
// direction that opens a hole at `to`. Tiles it hasn't passed sit at 0.
function layoutSlots() {
  const { tiles, el, from, to, step } = drag;
  tiles.forEach((tile, i) => {
    if (tile === el) return;
    let shift = 0;
    if (from < to && i > from && i <= to) shift = -step;
    else if (from > to && i < from && i >= to) shift = step;
    tile.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dy = e.clientY - drag.startY;

  if (!drag.active) {
    if (Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.el.classList.add('dragging');
    tablistEl.classList.add('reordering');
  }

  // Clamp to the column's own extent so the tile can't be dragged out of the rail.
  const min = -drag.from * drag.step;
  const max = (drag.tiles.length - 1 - drag.from) * drag.step;
  const y = Math.max(min, Math.min(max, dy));

  // Only translateY — X is never written, so the tile is pinned to the column.
  drag.el.style.transform = `translateY(${y}px) scale(1.06)`;

  const to = drag.from + Math.round(y / drag.step);
  if (to !== drag.to) {
    drag.to = to;
    layoutSlots();
  }
}

async function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);

  if (!d.active) { railLocked = false; return; } // a plain click, never became a drag

  suppressClick = true; // the click that follows pointerup must not switch tabs

  // Glide the tile the rest of the way into its slot before committing.
  d.el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1)`;
  d.el.style.transform = `translateY(${(d.to - d.from) * d.step}px) scale(1)`;
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  for (const tile of d.tiles) { tile.style.transform = ''; tile.style.transition = ''; }
  d.el.classList.remove('dragging');
  tablistEl.classList.remove('reordering');

  const order = d.tiles.map((t) => t.dataset.id);
  order.splice(d.to, 0, order.splice(d.from, 1)[0]);
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (a) => rank.get(a.id) ?? Number.MAX_SAFE_INTEGER; // unrailed (Store) sinks last, as the registry does
  apps.sort((a, b) => at(a) - at(b));

  railLocked = false;
  renderTabs(); // redraw in the committed order; transforms are already cleared

  if (d.to === d.from) return; // ended in its original slot — nothing to persist
  try {
    const res = await fetch('/shell/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: order }),
    });
    if (!res.ok) throw new Error('reorder rejected');
  } catch {
    toast('Could not save the new order.');
    await refresh(); // resync with whatever the server actually has
  }
}

// Esc or a cancelled pointer (e.g. the OS taking over) abandons the drag.
function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  for (const tile of d.tiles) tile.style.transform = '';
  d.el.classList.remove('dragging');
  tablistEl.classList.remove('reordering');
  railLocked = false;
  renderTabs();
}

function currentApp() {
  return apps.find((a) => a.id === activeId);
}

function showApp(app) {
  statusPane.hidden = true;
  emptyEl.hidden = true;
  frame.hidden = false;
  const src = `/apps/${app.id}/`;
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}

function showStatus(app) {
  frame.hidden = true;
  emptyEl.hidden = true;
  frame.removeAttribute('src');
  statusPane.hidden = false;
  const label = app.status === 'starting' ? 'Starting…' : app.status === 'failed' ? 'Failed to start' : 'Crashed';
  statusPane.innerHTML = `
    <h2>${app.name} — ${label}</h2>
    <p class="sub">${
      app.status === 'starting'
        ? 'Waiting for the app to become healthy.'
        : 'The app process is not running. Other tabs are unaffected.'
    }</p>
    <pre id="logbox">loading logs…</pre>
    ${app.status === 'starting' ? '' : '<button class="btn" id="restartBtn">Restart</button>'}
  `;
  fetch(`/shell/logs/${app.id}`)
    .then((r) => r.text())
    .then((t) => {
      const box = document.getElementById('logbox');
      if (box) box.textContent = t;
    });
  const rb = document.getElementById('restartBtn');
  if (rb) {
    rb.addEventListener('click', async () => {
      rb.disabled = true;
      rb.textContent = 'Restarting…';
      await fetch('/shell/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: app.id }),
      });
      await refresh();
    });
  }
}

function renderStage() {
  if (settingsOpen) {
    // Hide the frame but keep its `src`: tearing it down would reload the app
    // (and lose its in-page state) every time the user peeks at Settings.
    frame.hidden = true;
    statusPane.hidden = true;
    emptyEl.hidden = true;
    settingsPane.hidden = false;
    return;
  }
  settingsPane.hidden = true;
  const app = currentApp();
  if (!app) {
    frame.hidden = true;
    statusPane.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  // A hung app ('unhealthy') is still running, so still show its UI.
  if (app.status === 'healthy' || app.status === 'unhealthy') showApp(app);
  else showStatus(app);
}

// Which tab (or Settings) the user is on, so a refresh returns them there
// instead of bouncing back to the Store.
const UI_KEY = 'shell:ui';
function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ activeId, settingsOpen })); } catch {}
}
function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch { return null; }
}

function selectTab(id) {
  settingsOpen = false;
  activeId = id;
  saveUi();
  renderTabs();
  renderStage();
}

async function refresh() {
  apps = await fetchApps();
  // Default to the Store, then fall back to the first user app.
  if (!activeId || !apps.some((a) => a.id === activeId)) {
    activeId = apps.some((a) => a.id === STORE_ID) ? STORE_ID : userApps()[0]?.id ?? null;
  }
  renderTabs();
  renderStage();
}

// ── Settings: the App Health view (rendered by the Shell, not an app) ──────
const STATUS_LABEL = {
  healthy: 'Healthy', unhealthy: 'Unhealthy', starting: 'Starting',
  crashed: 'Crashed', failed: 'Failed', unknown: 'Unknown',
};

function fmtUptime(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function healthRow(a) {
  const icon = a.logo
    ? `<img src="/apps/${a.id}/${String(a.logo).replace(/^\/+/, '')}" alt="" onerror="this.replaceWith(document.createTextNode('${monogram(a)}'))">`
    : monogram(a);
  const hist = (a.history || []).slice(-15)
    .map((h) => `<span class="hd hd-${h.status}" title="${STATUS_LABEL[h.status] || h.status} — ${fmtAgo(h.at)}"></span>`).join('');
  const last = a.lastCheck ? `${fmtAgo(a.lastCheck.at)} · ${a.lastCheck.ms}ms${a.lastCheck.ok ? '' : ' · failed'}` : 'not yet';
  const open = expandedLogs.has(a.id);
  return `
    <div class="hrow">
      <div class="hicon">${icon}</div>
      <div class="hmain">
        <div class="hline1">
          <span class="hname">${escapeHtml(a.name)}</span>
          <span class="badge b-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
        </div>
        <div class="hmeta">
          <span>port ${a.port ?? '—'}</span>
          <span>up ${fmtUptime(a.uptimeMs)}</span>
          <span>${a.restarts || 0} restart${a.restarts === 1 ? '' : 's'}</span>
          <span>checked ${last}</span>
        </div>
        ${hist ? `<div class="hhist">${hist}</div>` : ''}
      </div>
      <div class="hactions">
        <button class="mini" data-action="recheck" data-id="${a.id}">Re-check</button>
        <button class="mini" data-action="restart" data-id="${a.id}">Restart</button>
        <button class="mini" data-action="logs" data-id="${a.id}">${open ? 'Hide logs' : 'Logs'}</button>
      </div>
      ${open ? `<pre class="hlogs" id="hlogs-${a.id}">loading…</pre>` : ''}
    </div>`;
}

async function renderSettings() {
  let list;
  try {
    const res = await fetch('/shell/health');
    list = (await res.json()).apps;
  } catch {
    settingsPane.innerHTML = '<div class="settings-wrap"><p class="empty-row">Could not load health.</p></div>';
    return;
  }
  const healthy = list.filter((a) => a.status === 'healthy').length;
  const down = list.filter((a) => ['crashed', 'failed', 'unhealthy', 'unknown'].includes(a.status)).length;
  settingsPane.innerHTML = `
    <div class="settings-wrap">
      <h1 class="settings-title">Settings</h1>
      <div class="sec-head">
        <h2 class="sec-label">App health</h2>
        <span class="sec-note">${list.length} app${list.length === 1 ? '' : 's'} · ${healthy} healthy${down ? ` · ${down} down` : ''}</span>
      </div>
      <div class="hist-legend">
        <span class="ll-label">recent status:</span>
        <span class="ll"><i class="hd hd-healthy"></i>healthy</span>
        <span class="ll"><i class="hd hd-unhealthy"></i>unhealthy</span>
        <span class="ll"><i class="hd hd-crashed"></i>down</span>
        <span class="ll"><i class="hd hd-starting"></i>starting</span>
      </div>
      <div class="health-list">${list.map(healthRow).join('') || '<p class="empty-row">No apps.</p>'}</div>
      <h2 class="sec-label about-label">About</h2>
      <p class="about-line">Common App Launcher · v0.1.0</p>
    </div>`;
  settingsPane.querySelectorAll('[data-action]').forEach((btn) =>
    btn.addEventListener('click', () => onHealthAction(btn.dataset.action, btn.dataset.id)));
  // (re)fill any expanded log boxes — survives the periodic re-render
  for (const id of expandedLogs) {
    fetch(`/shell/logs/${id}`).then((r) => r.text()).then((t) => {
      const box = document.getElementById(`hlogs-${id}`);
      if (box) box.textContent = t || '(no output)';
    }).catch(() => {});
  }
}

async function onHealthAction(action, id) {
  if (action === 'restart') {
    await fetch('/shell/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    await refresh(); // keep the rail statuses in sync too
    renderSettings();
  } else if (action === 'recheck') {
    await fetch('/shell/recheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    renderSettings();
  } else if (action === 'logs') {
    expandedLogs.has(id) ? expandedLogs.delete(id) : expandedLogs.add(id);
    renderSettings();
  }
}

function openSettings() { settingsOpen = true; saveUi(); renderTabs(); renderStage(); renderSettings(); }
function closeSettings() { settingsOpen = false; saveUi(); renderTabs(); renderStage(); }

// Poll so newly installed apps and status changes appear live.
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const prev = JSON.stringify(apps.map((a) => [a.id, a.status]));
    apps = await fetchApps();
    const next = JSON.stringify(apps.map((a) => [a.id, a.status]));
    if (!activeId || !apps.some((a) => a.id === activeId)) {
      activeId = apps.some((a) => a.id === STORE_ID) ? STORE_ID : userApps()[0]?.id ?? null;
    }
    renderTabs();
    if (settingsOpen) renderSettings();
    else if (prev !== next) renderStage();
  }, 2000);
}

// Pointer capture keeps these firing even when the cursor leaves the tile.
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', cancelDrag);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelDrag(); });

logo.addEventListener('click', () => selectTab(STORE_ID));
settingsBtn.addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));

// Let an app (e.g. the Store) tell the shell to refresh after an install.
window.addEventListener('message', (e) => {
  if (e.data === 'shell:refresh') refresh();
});

// Restore the last view before the first render, so there is no flash of the
// Store on the way to wherever the user actually was.
const savedUi = loadUi();
if (savedUi) {
  activeId = savedUi.activeId ?? null;
  settingsOpen = !!savedUi.settingsOpen;
}

await refresh();
if (settingsOpen) renderSettings();
startPolling();
