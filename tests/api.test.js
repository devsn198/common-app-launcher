import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOCK_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'clock');

let shell;      // the spawned Shell process
let base;       // http://127.0.0.1:<port>
let dataDir;    // throwaway registry + app-data, never the real one

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const get = (p) => fetch(base + p);
const post = (p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const ids = async () => (await (await get('/shell/apps')).json()).apps.map((a) => a.id);

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-data-'));

  shell = spawn(process.execPath, [path.join(REPO_ROOT, 'shell', 'src', 'server.js')], {
    env: { ...process.env, SHELL_PORT: String(port), SHELL_DATA_DIR: dataDir },
    stdio: 'ignore',
  });

  // Wait for the listener rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i++) {
    try {
      if ((await get('/shell/apps')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Shell did not come up');
});

after(async () => {
  shell?.kill();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('boots with the Store seeded', async () => {
  assert.ok((await ids()).includes('store'));
});

test('a request for an app that is not running 502s instead of hanging', async () => {
  // Regression: with no target the proxy error handler got an undefined `res`,
  // threw, and left the request open forever.
  const started = Date.now();
  const res = await get('/apps/does-not-exist/');
  assert.equal(res.status, 502);
  assert.ok(Date.now() - started < 2000, 'should fail fast, not hang');
});

test('registers a local app by path and proxies to it', async () => {
  const res = await post('/shell/tabs', { path: CLOCK_DIR });
  assert.equal(res.status, 200, await res.text());
  assert.ok((await ids()).includes('clock'));

  const page = await get('/apps/clock/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Clock<\/title>/);
});

test('serves the app logo declared in its manifest', async () => {
  const res = await get('/apps/clock/logo.svg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
});

test('reorder persists the given order', async () => {
  await post('/shell/reorder', { ids: ['clock', 'store'] });
  assert.deepEqual(await ids(), ['clock', 'store']);
  await post('/shell/reorder', { ids: ['store', 'clock'] });
  assert.deepEqual(await ids(), ['store', 'clock']);
});

test('reorder rejects a non-array payload', async () => {
  assert.equal((await post('/shell/reorder', { ids: 'clock' })).status, 400);
});

test('health reports the app as healthy with a port', async () => {
  const { apps } = await (await get('/shell/health')).json();
  const clock = apps.find((a) => a.id === 'clock');
  assert.equal(clock.status, 'healthy');
  assert.ok(clock.port > 0);
});

test('the Store cannot be uninstalled', async () => {
  assert.equal((await post('/shell/uninstall', { id: 'store' })).status, 400);
  assert.ok((await ids()).includes('store'));
});

test('uninstalling an unknown app 404s', async () => {
  assert.equal((await post('/shell/uninstall', { id: 'nope' })).status, 404);
});

test('uninstall drops the app but never deletes a source dir it did not clone', async () => {
  assert.equal((await post('/shell/uninstall', { id: 'clock' })).status, 200);
  assert.equal((await ids()).includes('clock'), false);
  // clock was registered by path, so its files live outside the managed apps dir.
  await fs.access(path.join(CLOCK_DIR, 'server.js')); // throws if it was deleted
});

test('a JSON body bound for an app reaches it intact', async () => {
  // Regression: express.json() was mounted globally, ahead of the proxy, so it
  // drained the request stream and the app received an empty body.
  const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'json-echo');
  assert.equal((await post('/shell/tabs', { path: fixture })).status, 200);

  const payload = { hello: 'world', n: 42 };
  const res = await fetch(base + '/apps/json-echo/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const seen = await res.json();
  assert.equal(seen.method, 'POST');
  assert.deepEqual(JSON.parse(seen.received || '{}'), payload, 'the app saw a different body than was sent');

  await post('/shell/uninstall', { id: 'json-echo' });
});

test('the removed app stops being proxied', async () => {
  assert.equal((await get('/apps/clock/')).status, 502);
});
