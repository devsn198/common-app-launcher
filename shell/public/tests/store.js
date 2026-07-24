// Store behaviour. Deliberately offline: the search results are seeded straight
// into the Store's own localStorage cache rather than hitting the GitHub API, so
// the suite is deterministic and costs no rate limit.
import { ok, eq, sleep, until } from './harness.js';

const LS_KEY = 'store:search';
const frame = () => document.getElementById('frame');

async function openStore() {
  document.getElementById('logo').click();
  await until(() => {
    const d = frame().contentDocument;
    return d && d.getElementById('searchForm') ? d : null;
  }, 'the Store to load');
  return frame().contentDocument;
}

async function reloadStore() {
  frame().contentWindow.location.reload();
  await sleep(120);
  return until(() => {
    const d = frame().contentDocument;
    return d && d.getElementById('searchForm') && d.getElementById('installed').children.length ? d : null;
  }, 'the Store to reload');
}

const availableNames = (d) => [...d.querySelectorAll('#results .card .nm')].map((n) => n.textContent.trim());
const addedNames = (d) => [...d.querySelectorAll('#installed .card .nm')].map((n) => n.textContent.trim());

export default {
  async before() {
    const doc = await openStore();
    const saved = frame().contentWindow.localStorage.getItem(LS_KEY);
    const installed = (await (await fetch('/shell/apps')).json()).apps.filter((a) => a.id !== 'store');
    if (!installed.length) throw new Error('needs at least 1 installed app');
    return { saved, installed, doc };
  },

  async after({ saved }) {
    const ls = frame().contentWindow.localStorage;
    if (saved === null) ls.removeItem(LS_KEY);
    else ls.setItem(LS_KEY, saved);
    await reloadStore();
  },

  'classify() reads a bare account name': ({ doc }) => {
    eq(doc.defaultView.classify('someone'), { type: 'account', user: 'someone' });
  },

  'classify() reads an account URL': ({ doc }) => {
    eq(doc.defaultView.classify('https://github.com/someone'), { type: 'account', user: 'someone' });
  },

  'classify() reads a repo URL': ({ doc }) => {
    const c = doc.defaultView.classify('https://github.com/someone/thing');
    eq(c.type, 'repo');
    eq(c.url, 'https://github.com/someone/thing.git');
    ok(!c.subpath, 'a root repo URL should carry no subpath');
  },

  'classify() reads a monorepo subdirectory URL': ({ doc }) => {
    const c = doc.defaultView.classify('https://github.com/me/mono/tree/main/examples/clock');
    eq(c.type, 'repo');
    eq(c.url, 'https://github.com/me/mono.git');
    eq(c.branch, 'main');
    eq(c.subpath, 'examples/clock');
  },

  'classify() tolerates a trailing slash and a .git suffix': ({ doc }) => {
    eq(doc.defaultView.classify('https://github.com/a/b.git/').url, 'https://github.com/a/b.git');
  },

  'installed apps are excluded from Available': async ({ installed }) => {
    const other = { id: 'not-installed-x', name: 'Not Installed X', sub: 'someone/x', cloneUrl: 'https://example.invalid/x.git', icon: null };
    const seeded = {
      q: 'someone',
      view: {
        label: 'someone',
        apps: [
          { id: installed[0].id, name: installed[0].name, sub: 'someone/y', cloneUrl: 'https://example.invalid/y.git', icon: null },
          other,
        ],
      },
    };
    frame().contentWindow.localStorage.setItem(LS_KEY, JSON.stringify(seeded));
    const d = await reloadStore();

    const avail = availableNames(d);
    ok(avail.includes('Not Installed X'), 'an uninstalled app should be offered');
    ok(!avail.includes(installed[0].name), `${installed[0].name} is installed and must not be offered again`);
    ok(addedNames(d).includes(installed[0].name), 'it should appear under Added instead');
    eq(d.getElementById('availCnt').textContent, '1 · someone', 'count reflects what is shown');
  },

  'Available shows a message rather than an empty box when everything is added': async ({ installed }) => {
    const seeded = {
      q: 'someone',
      view: {
        label: 'someone',
        apps: installed.map((a) => ({ id: a.id, name: a.name, sub: 'someone/z', cloneUrl: 'https://example.invalid/z.git', icon: null })),
      },
    };
    frame().contentWindow.localStorage.setItem(LS_KEY, JSON.stringify(seeded));
    const d = await reloadStore();
    eq(availableNames(d), [], 'no cards');
    ok(/is added/.test(d.querySelector('#results .note')?.textContent ?? ''), 'expected an all-added note');
  },

  'the search query and results survive a reload': async () => {
    const seeded = {
      q: 'persisted-user',
      view: { label: 'persisted-user', apps: [{ id: 'ghost-app', name: 'Ghost App', sub: 'persisted-user/ghost', cloneUrl: 'https://example.invalid/g.git', icon: null }] },
    };
    frame().contentWindow.localStorage.setItem(LS_KEY, JSON.stringify(seeded));
    const d = await reloadStore();
    eq(d.getElementById('user').value, 'persisted-user', 'query restored');
    ok(availableNames(d).includes('Ghost App'), 'results restored without re-searching');
  },

  'leaving for Settings and coming back keeps the Store alive': async () => {
    const d = await openStore();
    d.getElementById('user').value = 'typed-but-not-searched';
    document.getElementById('settingsBtn').click();
    await sleep(150);
    ok(frame().getAttribute('src') === '/apps/store/', 'the iframe must not be torn down for Settings');
    document.getElementById('logo').click();
    await sleep(150);
    eq(frame().contentDocument.getElementById('user').value, 'typed-but-not-searched', 'input survived');
  },
};
