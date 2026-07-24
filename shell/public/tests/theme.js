// Design-system integrity.
//
// This suite exists because of a real defect: style.css styled the Settings
// health rows with `var(--panel, #191e2a)` while the Shell never defined
// `--panel`. It rendered correctly only by falling through to the hardcoded
// fallback — invisible in review, and exactly the failure mode that three
// copy-pasted palettes produce. A token that stops resolving must fail loudly.
import { ok, eq, until, sleep } from './harness.js';

// Every token the Shell or a bundled app actually depends on.
const REQUIRED = [
  's-0', 's-1', 's-2', 's-3', 's-sunken', 'line', 'border',
  'rim', 'rim-strong', 'under', 'under-strong',
  'elev-contact', 'elev-ambient', 'elev-overlay', 'depth-rest', 'depth-raised',
  'text', 'muted', 'faint',
  'accent', 'accent-weak', 'accent-line',
  'ok', 'warn', 'bad', 'ok-bg', 'warn-bg', 'bad-bg', 'neutral-bg',
  'font-ui', 'font-mono', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'lh',
  'sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6',
  'r-sm', 'r-md', 'r-lg', 'ease', 'dur-1', 'dur-2',
  'depth-sunken', 'rail-w', 'tile', 'tile-icon', 'tile-gap', 'pane-pad',
];

// The aliases the bundled apps were written against, kept for compatibility.
const ALIASES = ['stage', 'bg', 'rail', 'panel', 'surface', 'surface-hi', 'rail-edge', 'dot-ok', 'dot-warn', 'dot-bad', 'shadow'];

const frame = () => document.getElementById('frame');
const resolve = (doc, name) => getComputedStyle(doc.documentElement).getPropertyValue(`--${name}`).trim();

async function openApp(id) {
  const tile = [...document.querySelectorAll('#tablist .tab')].find((t) => t.dataset.id === id);
  if (tile) tile.click();
  else document.getElementById('logo').click(); // the Store has no rail tile
  await until(() => {
    const d = frame().contentDocument;
    return d && d.readyState === 'complete' && d.documentElement ? d : null;
  }, `app ${id} to load`);
  await sleep(80);
  return frame().contentDocument;
}

export default {
  async before() {
    const apps = (await (await fetch('/shell/apps')).json()).apps;
    return { apps, wasActive: document.querySelector('#tablist .tab.active')?.dataset.id ?? null };
  },

  async after({ wasActive }) {
    if (wasActive) {
      const tile = [...document.querySelectorAll('#tablist .tab')].find((t) => t.dataset.id === wasActive);
      tile?.click();
    } else {
      document.getElementById('logo').click();
    }
    await sleep(120);
  },

  'every required token resolves in the Shell': () => {
    const missing = REQUIRED.filter((n) => !resolve(document, n));
    eq(missing, [], 'tokens with no value');
  },

  'the compatibility aliases resolve too': () => {
    // --panel is in here on purpose: it is the token whose absence caused the bug.
    const missing = ALIASES.filter((n) => !resolve(document, n));
    eq(missing, [], 'aliases with no value');
  },

  'no Shell rule depends on an undefined custom property': async () => {
    // Walk the loaded stylesheets, pull out every var(--x) reference, and prove
    // each one has a value. This is the generic form of the original defect.
    const referenced = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules) walk(r.cssRules);
          const text = r.style?.cssText || '';
          for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)/gi)) referenced.add(m[1]);
        }
      };
      walk(rules);
    }
    ok(referenced.size > 10, `expected to find token references, found ${referenced.size}`);
    const unresolved = [...referenced].filter((n) => !resolve(document, n));
    eq(unresolved, [], 'referenced but undefined');
  },

  'the rail tiles carry rim light, not a dark drop shadow': () => {
    const tile = document.querySelector('#tablist .tab');
    ok(tile, 'needs at least one app tile');
    const shadow = getComputedStyle(tile).boxShadow;
    ok(/inset/.test(shadow), `resting tile should have an inset rim, got "${shadow}"`);
  },

  'the active tile is raised and rim-lit': async () => {
    const tile = document.querySelector('#tablist .tab');
    tile.click();
    await sleep(120);
    const active = document.querySelector('#tablist .tab.active');
    ok(active, 'a tile should be active after clicking it');
    const cs = getComputedStyle(active);
    ok(/inset/.test(cs.boxShadow), 'active tile must keep an inset rim');
    ok(cs.transform !== 'none', 'active tile should be lifted, so its ambient shadow reads');
  },

  'apps that adopt the theme resolve identical tokens to the Shell': async ({ apps }) => {
    // Adopting /theme.css is an OPTIONAL affordance of the Contract, so an app
    // that doesn't link it is not a failure — it just isn't checked. What must
    // hold is that every app which *does* link it gets the same values, i.e.
    // there is genuinely one source of truth rather than a convincing copy.
    const keys = ['s-0', 's-1', 's-2', 'accent', 'text', 'ok'];
    const shell = Object.fromEntries(keys.map((n) => [n, resolve(document, n)]));
    const adopted = [];
    const skipped = [];

    for (const app of apps) {
      const doc = await openApp(app.id);
      const links = !!doc.querySelector('link[href$="/theme.css"], link[href="/theme.css"]');
      if (!links) { skipped.push(app.id); continue; }
      eq(Object.fromEntries(keys.map((n) => [n, resolve(doc, n)])), shell, `${app.id} diverges from the Shell`);
      adopted.push(app.id);
    }

    ok(adopted.length >= 1, `no app adopted the theme (skipped: ${skipped.join(', ') || 'none'})`);
    // Surface non-adopters rather than letting a silent skip look like a pass.
    if (skipped.length) console.info('[theme] apps not using the shared theme:', skipped.join(', '));
  },
};
