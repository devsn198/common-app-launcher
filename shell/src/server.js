import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.js';
import { Supervisor } from './supervisor.js';
import { installFromGit } from './installer.js';
import { readManifest } from './manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SHELL_ROOT, '..');
// Overridable so a test run gets a throwaway registry instead of the real one.
const DATA_DIR = process.env.SHELL_DATA_DIR
  ? path.resolve(process.env.SHELL_DATA_DIR)
  : path.join(SHELL_ROOT, 'data');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const APP_DATA_ROOT = path.join(DATA_DIR, 'app-data');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
const PUBLIC_DIR = path.join(SHELL_ROOT, 'public');

const PORT = Number(process.env.SHELL_PORT) || 4000;
const SHELL_URL = `http://localhost:${PORT}`;

const registry = new Registry(REGISTRY_FILE);
const supervisor = new Supervisor({ shellUrl: SHELL_URL, appDataRoot: APP_DATA_ROOT });

const app = express();
// Scoped to the Shell's own API on purpose. Mounted globally this parser also
// consumes the body of JSON requests bound for an app — the request reaches the
// proxy with its stream already drained, and the app receives an empty body.
app.use('/shell', express.json());

// --- Proxy: /apps/<id>/* → that app's subprocess ---------------------------
// The router picks the live target from the supervisor's port map per request.
const appProxy = createProxyMiddleware({
  changeOrigin: true,
  ws: true,
  pathRewrite: (reqPath, req) => reqPath.replace(new RegExp(`^/apps/${req.params.id}`), '') || '/',
  router: (req) => `http://127.0.0.1:${supervisor.getPort(req.params.id)}`,
  on: {
    error: (err, req, res) => {
      // `res` may be a raw Socket (ws upgrade) — guard before responding.
      if (!res || typeof res.writeHead !== 'function' || res.headersSent || res.writableEnded) return;
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`App "${req.params?.id}" is not reachable.`);
    },
  },
});

// Guard: if the app isn't running (never installed, or just removed), reply 502
// immediately rather than proxying to nowhere — which would hang the request.
app.use('/apps/:id', (req, res, next) => {
  if (!supervisor.getPort(req.params.id)) {
    return res.status(502).type('text/plain').send(`App "${req.params.id}" is not running.`);
  }
  return appProxy(req, res, next);
});

// --- Contract + Shell API --------------------------------------------------

// List registered apps + live status for the tab bar.
app.get('/shell/apps', (req, res) => {
  const apps = registry.list().map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon ?? '📦',
    logo: a.logo ?? null,
    version: a.version,
    ...supervisor.getState(a.id),
  }));
  res.json({ apps });
});

// Rich per-app health for the Settings health view.
app.get('/shell/health', (req, res) => {
  const apps = registry.list().map((a) => ({
    id: a.id,
    name: a.name,
    logo: a.logo ?? null,
    version: a.version ?? null,
    ...supervisor.getHealth(a.id),
  }));
  res.json({ apps });
});

// Run one health check now (on demand) and report the result.
app.post('/shell/recheck', async (req, res) => {
  const { id } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const { ok, ms } = await supervisor.pingHealth(id);
  res.json({ ok, ms, status: supervisor.getState(id).status });
});

// Clone → install → spawn → register. Owned by the Shell in the MVP.
app.post('/shell/install', async (req, res) => {
  const repoUrl = (req.body?.repoUrl || '').trim();
  const subpath = (req.body?.subpath || '').trim() || undefined;
  const branch = (req.body?.branch || '').trim() || undefined;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required.' });
  try {
    const { manifest, appDir } = await installFromGit(repoUrl, APPS_DIR, { subpath, branch });
    const { status } = await supervisor.start(manifest, appDir);
    if (status !== 'healthy') {
      return res.status(502).json({
        error: `App "${manifest.id}" installed but failed to start.`,
        stderr: supervisor.getStderr(manifest.id),
      });
    }
    await registry.add(recordFrom(manifest, appDir));
    res.json({ ok: true, app: { id: manifest.id, name: manifest.name } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Contract endpoint: register an already-local app by path. Any app may call it.
app.post('/shell/tabs', async (req, res) => {
  const { path: appPath } = req.body ?? {};
  if (!appPath) return res.status(400).json({ error: 'path is required.' });
  const appDir = path.resolve(appPath);
  try {
    const manifest = await readManifest(appDir);
    const { status } = await supervisor.start(manifest, appDir);
    if (status !== 'healthy') {
      return res.status(502).json({ error: `App "${manifest.id}" failed to start.`, stderr: supervisor.getStderr(manifest.id) });
    }
    await registry.add(recordFrom(manifest, appDir));
    res.json({ ok: true, app: { id: manifest.id, name: manifest.name } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Persist the rail's tile order after a drag.
app.post('/shell/reorder', async (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array.' });
  try {
    await registry.reorder(ids);
    res.json({ ok: true, order: registry.list().map((a) => a.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart a crashed/failed app.
app.post('/shell/restart', async (req, res) => {
  const { id } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  try {
    const { status } = await supervisor.restart(id);
    res.json({ ok: status === 'healthy', status, stderr: supervisor.getStderr(id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Uninstall: stop the app, drop it from the registry, and delete its cloned files.
app.post('/shell/uninstall', async (req, res) => {
  const { id } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  if (id === 'store') return res.status(400).json({ error: 'The Store cannot be removed.' });
  if (!registry.has(id)) return res.status(404).json({ error: `Unknown app "${id}".` });
  try {
    const record = registry.get(id);
    supervisor.remove(id);
    await registry.remove(id);
    // Only delete files the Shell itself cloned (under the managed apps dir); never a
    // source directory registered by path. App data under APP_DATA_ROOT is left intact.
    if (record.path && path.resolve(record.path).startsWith(APPS_DIR + path.sep)) {
      await fs.rm(record.path, { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Captured stderr for a failed/crashed app (shown in its tab).
app.get('/shell/logs/:id', (req, res) => {
  res.type('text/plain').send(supervisor.getStderr(req.params.id) || '(no output captured)');
});

// --- Launcher UI (served last so it doesn't shadow /apps or /shell) ---------
app.use(express.static(PUBLIC_DIR));

function recordFrom(manifest, appDir) {
  return {
    id: manifest.id,
    name: manifest.name,
    icon: manifest.icon ?? '📦',
    logo: manifest.logo ?? null,
    version: manifest.version ?? null,
    path: appDir,
  };
}

// --- Boot ------------------------------------------------------------------

async function seedStoreIfMissing() {
  if (registry.has('store')) return;
  const storeSrc = path.join(REPO_ROOT, 'examples', 'store');
  try {
    const manifest = await readManifest(storeSrc);
    // Run the Store's install step (idempotent) so it can boot.
    // The Store has no deps in the MVP, but keep the flow uniform.
    await registry.add(recordFrom(manifest, storeSrc));
    console.log('Seeded Store from examples/store.');
  } catch (err) {
    console.warn(`Could not seed Store: ${err.message}`);
  }
}

async function bootRegisteredApps() {
  for (const record of registry.list()) {
    try {
      const manifest = await readManifest(record.path);
      const { status } = await supervisor.start(manifest, record.path);
      console.log(`  ${status === 'healthy' ? '✓' : '✗'} ${record.id} (${status})`);
    } catch (err) {
      console.warn(`  ✗ ${record.id}: ${err.message}`);
    }
  }
}

async function main() {
  await fs.mkdir(APPS_DIR, { recursive: true });
  await registry.load();
  await seedStoreIfMissing();

  app.listen(PORT, async () => {
    console.log(`\n  Common App Shell running at ${SHELL_URL}\n`);
    console.log('Booting registered apps:');
    await bootRegisteredApps();
    supervisor.startMonitor(); // begin continuous health checks
    console.log('\nReady.\n');
  });
}

function shutdown() {
  console.log('\nShutting down apps…');
  supervisor.stopAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
