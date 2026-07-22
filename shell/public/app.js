const STORE_ID = 'store';

const logo = document.getElementById('logo');
const tablistEl = document.getElementById('tablist');
const frame = document.getElementById('frame');
const statusPane = document.getElementById('statusPane');
const emptyEl = document.getElementById('empty');
const settingsBtn = document.getElementById('settingsBtn');
const toastEl = document.getElementById('toast');

let apps = [];
let activeId = null;
let pollTimer = null;
let toastTimer = null;

const userApps = () => apps.filter((a) => a.id !== STORE_ID);
const monogram = (app) => (app.name || app.id).trim().charAt(0).toUpperCase() || '?';

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

function renderTabs() {
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

    btn.addEventListener('click', () => selectTab(app.id));
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
  logo.classList.toggle('active', activeId === STORE_ID);
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
  const app = currentApp();
  if (!app) {
    frame.hidden = true;
    statusPane.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  if (app.status === 'healthy') showApp(app);
  else showStatus(app);
}

function selectTab(id) {
  activeId = id;
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

// Poll so newly installed apps and status changes (crash/restart) appear live.
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
    if (prev !== next) renderStage();
  }, 2000);
}

logo.addEventListener('click', () => selectTab(STORE_ID));
settingsBtn.addEventListener('click', () => toast('Settings coming soon'));

// Let an app (e.g. the Store) tell the shell to refresh after an install.
window.addEventListener('message', (e) => {
  if (e.data === 'shell:refresh') refresh();
});

await refresh();
startPolling();
