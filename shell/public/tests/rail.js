// Rail drag-to-reorder behaviour, driven with synthetic PointerEvents against
// the real layout (getBoundingClientRect must be real, which is why this runs
// in the browser rather than jsdom).
import { ok, eq, sleep, until } from './harness.js';

const rail = () => document.getElementById('tablist');
const tiles = () => [...rail().querySelectorAll('.tab')];
const ids = () => tiles().map((t) => t.dataset.id);
const serverIds = async () =>
  (await (await fetch('/shell/apps')).json()).apps.map((a) => a.id).filter((id) => id !== 'store');

let pid = 500; // fresh pointerId per gesture, so captures never collide

/** Press a tile, move by (dx, dy), and either release or abandon the gesture. */
async function gesture(index, dx, dy, { release = true, inspect } = {}) {
  const t = tiles()[index];
  const box = t.getBoundingClientRect();
  const x0 = box.left + box.width / 2;
  const y0 = box.top + box.height / 2;
  const id = ++pid;
  const send = (el, type, x, y) =>
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, button: 0, isPrimary: true, clientX: x, clientY: y,
    }));

  send(t, 'pointerdown', x0, y0);
  send(window, 'pointermove', x0 + dx, y0 + dy);
  const observed = inspect ? inspect(t) : undefined;
  if (release) {
    send(window, 'pointerup', x0 + dx, y0 + dy);
    await sleep(300); // let the settle animation finish and the DOM commit
  }
  return observed;
}

/** A click the way a browser emits one: pointerdown → pointerup → click. */
async function realClick(tile) {
  await gesture(tiles().indexOf(tile), 0, 0);
  tile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function slotPitch() {
  const t = tiles();
  return t[1].getBoundingClientRect().top - t[0].getBoundingClientRect().top;
}

export default {
  async before() {
    if (tiles().length < 2) throw new Error('needs at least 2 installed apps');
    return { original: ids() };
  },

  async after({ original }) {
    // Put the rail back exactly as we found it.
    await fetch('/shell/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: original }),
    });
    await sleep(2100); // next poll redraws from the server
  },

  'drag down one slot reorders the rail and persists it': async () => {
    const before = ids();
    await gesture(0, 0, slotPitch() + 6);
    const expected = [before[1], before[0], ...before.slice(2)];
    eq(ids(), expected, 'DOM order');
    eq(await serverIds(), expected, 'persisted order');
  },

  'the lifted tile is pinned to the X axis': async () => {
    // Shoving the pointer far sideways must not move the tile horizontally.
    const tf = await gesture(0, 400, slotPitch(), {
      release: false,
      inspect: (t) => t.style.transform,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    ok(/^translateY\(/.test(tf), `transform should be translateY-only, got "${tf}"`);
    ok(!/translateX|translate3d|matrix/.test(tf), `transform leaked an X component: "${tf}"`);
  },

  'travel clamps to the ends of the column': async () => {
    const pitch = slotPitch();
    const last = (tiles().length - 1) * pitch;

    const down = await gesture(0, 0, 99999, { release: false, inspect: (t) => t.style.transform });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    eq(down, `translateY(${last}px) scale(1.06)`, 'clamped at the bottom slot');

    const up = await gesture(0, 0, -99999, { release: false, inspect: (t) => t.style.transform });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    eq(up, 'translateY(0px) scale(1.06)', 'clamped at the top slot');
  },

  'displaced tiles animate while the dragged one does not': async () => {
    const styles = await gesture(0, 0, slotPitch() + 6, {
      release: false,
      inspect: () => ({
        dragged: getComputedStyle(tiles()[0]).transitionDuration,
        displaced: getComputedStyle(tiles()[1]).transitionDuration,
      }),
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    eq(styles.dragged, '0s', 'dragged tile must track the pointer with no transition');
    ok(parseFloat(styles.displaced) > 0, 'displaced tile should transition, else it snaps');
  },

  'Escape cancels the drag and leaves no stray transforms': async () => {
    const before = ids();
    await gesture(0, 0, slotPitch() + 6, { release: false });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    eq(ids(), before, 'order after cancel');
    eq(tiles().map((t) => t.style.transform || ''), before.map(() => ''), 'leftover transforms');
    ok(!rail().classList.contains('reordering'), 'reordering class should be cleared');
  },

  'a click after a committed drag still selects the tab': async () => {
    // Regression: the click-suppression flag outlived the gesture and swallowed
    // the next genuine click, leaving tiles unresponsive.
    const target = tiles()[tiles().length - 1];
    const wanted = target.dataset.id;
    // Park on the Store first, otherwise the assertion can pass without the
    // click having done anything (the frame may already be on that app).
    document.getElementById('logo').click();
    await until(() => document.getElementById('frame').getAttribute('src') === '/apps/store/', 'the Store');

    await gesture(0, 0, slotPitch() + 6); // commit a drag, which arms click-suppression
    await realClick(tiles().find((t) => t.dataset.id === wanted));
    await until(() => document.getElementById('frame').getAttribute('src') === `/apps/${wanted}/`,
      `frame to load /apps/${wanted}/`);
  },

  'a plain click never reorders': async () => {
    const before = ids();
    await gesture(1, 0, 2); // under the 4px drag threshold
    eq(ids(), before, 'order after a click');
  },

  'the + button stays pinned last': async () => {
    await gesture(0, 0, slotPitch() * 99);
    ok(rail().lastElementChild.classList.contains('add'), '+ should be the final rail child');
  },
};
