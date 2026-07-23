import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findFreePort } from './ports.js';

const HEALTH_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 15000;
const STDERR_CAP = 8000; // keep only the tail of captured stderr

/**
 * Supervises app subprocesses: spawns them with the injected Contract env,
 * polls their health check, tracks status, and restarts/kills on demand.
 *
 * status ∈ 'starting' | 'healthy' | 'crashed' | 'failed'
 */
export class Supervisor {
  /**
   * @param {object} opts
   * @param {string} opts.shellUrl base URL apps use to call Contract endpoints
   * @param {string} opts.appDataRoot directory under which per-app data dirs live
   */
  constructor({ shellUrl, appDataRoot }) {
    this.shellUrl = shellUrl;
    this.appDataRoot = appDataRoot;
    /** @type {Map<string, {child?: import('node:child_process').ChildProcess, port?: number, status: string, stderr: string, manifest: object, appDir: string}>} */
    this.procs = new Map();
  }

  getState(id) {
    const p = this.procs.get(id);
    if (!p) return { status: 'unknown' };
    return { status: p.status, port: p.port };
  }

  getPort(id) {
    return this.procs.get(id)?.port;
  }

  /**
   * Spawn an app and wait until it passes its health check.
   * @param {object} manifest validated manifest
   * @param {string} appDir absolute path to the app directory
   * @returns {Promise<{status: string, port?: number}>}
   */
  async start(manifest, appDir) {
    // If already running healthy, leave it be.
    const existing = this.procs.get(manifest.id);
    if (existing?.status === 'healthy' && existing.child && !existing.child.killed) {
      return { status: 'healthy', port: existing.port };
    }

    const port = await findFreePort();
    const appDataDir = path.join(this.appDataRoot, manifest.id);
    await fs.mkdir(appDataDir, { recursive: true });

    const entry = { status: 'starting', stderr: '', manifest, appDir, port };
    this.procs.set(manifest.id, entry);

    const child = spawn(manifest.start, {
      cwd: appDir,
      shell: true,
      env: {
        ...process.env,
        PORT: String(port),
        APP_DATA_DIR: appDataDir,
        SHELL_URL: this.shellUrl,
      },
    });
    entry.child = child;

    child.stderr.on('data', (buf) => {
      entry.stderr = (entry.stderr + buf.toString()).slice(-STDERR_CAP);
    });
    child.stdout.on('data', (buf) => {
      process.stdout.write(`[${manifest.id}] ${buf}`);
    });

    child.on('exit', (code, signal) => {
      // Only downgrade a live/starting app; ignore exits after an intentional stop.
      if (entry.status === 'healthy' || entry.status === 'starting') {
        entry.status = 'crashed';
        entry.stderr = (entry.stderr + `\n[process exited: code=${code} signal=${signal}]`).slice(-STDERR_CAP);
      }
      entry.child = undefined;
    });

    const healthy = await this._waitForHealth(port, manifest.healthCheck, entry);
    if (healthy && entry.status === 'starting') {
      entry.status = 'healthy';
    } else if (entry.status === 'starting') {
      entry.status = 'failed';
      this.stop(manifest.id);
    }
    return { status: entry.status, port };
  }

  async _waitForHealth(port, healthPath, entry) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    const url = `http://127.0.0.1:${port}${healthPath}`;
    while (Date.now() < deadline) {
      if (entry.status === 'crashed') return false; // process died while starting
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    return false;
  }

  /** Kill an app's process without removing it from the map. */
  stop(id) {
    const p = this.procs.get(id);
    if (p?.child && !p.child.killed) {
      p.child.kill('SIGTERM');
    }
  }

  /** Stop an app and forget it entirely (used on uninstall). */
  remove(id) {
    this.stop(id);
    this.procs.delete(id);
  }

  /** Restart a known app (must have been started before). */
  async restart(id) {
    const p = this.procs.get(id);
    if (!p) throw new Error(`Unknown app "${id}".`);
    this.stop(id);
    p.status = 'starting';
    return this.start(p.manifest, p.appDir);
  }

  getStderr(id) {
    return this.procs.get(id)?.stderr ?? '';
  }

  stopAll() {
    for (const id of this.procs.keys()) this.stop(id);
  }
}
