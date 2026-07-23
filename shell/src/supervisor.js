import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findFreePort } from './ports.js';

const HEALTH_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 15000;
const MONITOR_INTERVAL_MS = 5000;   // how often to re-check running apps
const HEALTH_PING_TIMEOUT_MS = 2000;
const HISTORY_CAP = 20;
const STDERR_CAP = 8000; // keep only the tail of captured stderr

/**
 * Supervises app subprocesses: spawns them with the injected Contract env,
 * polls their health check, tracks status/uptime/restarts, monitors running
 * apps for hangs, and restarts/kills on demand.
 *
 * status ∈ 'starting' | 'healthy' | 'unhealthy' | 'crashed' | 'failed'
 *   unhealthy = process alive but not answering its health check (a hang)
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
    /** @type {Map<string, {child?: import('node:child_process').ChildProcess, port?: number, status: string, stderr: string, manifest: object, appDir: string, startedAt?: number, restarts: number, lastCheck: object|null, history: Array<{at:number,status:string}>}>} */
    this.procs = new Map();
    this.monitorTimer = null;
  }

  getState(id) {
    const p = this.procs.get(id);
    if (!p) return { status: 'unknown' };
    return { status: p.status, port: p.port };
  }

  getPort(id) {
    return this.procs.get(id)?.port;
  }

  /** Record a status change in the app's short history (only when it changes). */
  _pushHistory(entry, status) {
    const last = entry.history[entry.history.length - 1];
    if (last && last.status === status) return;
    entry.history.push({ at: Date.now(), status });
    if (entry.history.length > HISTORY_CAP) entry.history.shift();
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

    const entry = {
      status: 'starting',
      stderr: '',
      manifest,
      appDir,
      port,
      startedAt: Date.now(),
      restarts: existing?.restarts ?? 0,   // preserved across restarts
      lastCheck: null,
      history: existing?.history ?? [],
    };
    this.procs.set(manifest.id, entry);
    this._pushHistory(entry, 'starting');

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

    // Capture BOTH streams into the log buffer so "Logs" shows the app's output
    // (most apps log to stdout, not stderr).
    child.stderr.on('data', (buf) => {
      entry.stderr = (entry.stderr + buf.toString()).slice(-STDERR_CAP);
    });
    child.stdout.on('data', (buf) => {
      entry.stderr = (entry.stderr + buf.toString()).slice(-STDERR_CAP);
      process.stdout.write(`[${manifest.id}] ${buf}`);
    });

    child.on('exit', (code, signal) => {
      // Only downgrade a live/starting app; ignore exits after an intentional stop.
      if (entry.status === 'healthy' || entry.status === 'unhealthy' || entry.status === 'starting') {
        entry.status = 'crashed';
        this._pushHistory(entry, 'crashed');
        entry.stderr = (entry.stderr + `\n[process exited: code=${code} signal=${signal}]`).slice(-STDERR_CAP);
      }
      entry.child = undefined;
    });

    const healthy = await this._waitForHealth(port, manifest.healthCheck, entry);
    if (healthy && entry.status === 'starting') {
      entry.status = 'healthy';
      this._pushHistory(entry, 'healthy');
    } else if (entry.status === 'starting') {
      entry.status = 'failed';
      this._pushHistory(entry, 'failed');
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

  /**
   * One on-demand health check against a running app. Updates lastCheck.
   * @returns {Promise<{ok: boolean, ms: number|null}>}
   */
  async pingHealth(id) {
    const entry = this.procs.get(id);
    if (!entry || !entry.child || !entry.port) return { ok: false, ms: null };
    const url = `http://127.0.0.1:${entry.port}${entry.manifest.healthCheck}`;
    const t0 = Date.now();
    let ok = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_PING_TIMEOUT_MS) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    const ms = Date.now() - t0;
    entry.lastCheck = { at: Date.now(), ok, ms };
    return { ok, ms };
  }

  /** Continuously re-check running apps so a *hang* (not just a crash) is detected. */
  startMonitor() {
    clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(async () => {
      for (const [id, entry] of this.procs) {
        if (!entry.child || (entry.status !== 'healthy' && entry.status !== 'unhealthy')) continue;
        const { ok } = await this.pingHealth(id);
        const next = ok ? 'healthy' : 'unhealthy';
        if (entry.status !== next) {
          entry.status = next;
          this._pushHistory(entry, next);
        }
      }
    }, MONITOR_INTERVAL_MS);
  }

  stopMonitor() {
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
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
    p.restarts = (p.restarts ?? 0) + 1;
    this.stop(id);
    p.status = 'starting';
    return this.start(p.manifest, p.appDir);
  }

  getStderr(id) {
    return this.procs.get(id)?.stderr ?? '';
  }

  /** Rich health snapshot for one app (for the Settings health view). */
  getHealth(id) {
    const p = this.procs.get(id);
    if (!p) return { status: 'unknown' };
    const running = p.status === 'healthy' || p.status === 'unhealthy' || p.status === 'starting';
    return {
      status: p.status,
      port: p.port ?? null,
      startedAt: p.startedAt ?? null,
      uptimeMs: running && p.startedAt ? Date.now() - p.startedAt : null,
      restarts: p.restarts ?? 0,
      healthCheck: p.manifest?.healthCheck ?? null,
      lastCheck: p.lastCheck ?? null,
      history: p.history ?? [],
    };
  }

  stopAll() {
    this.stopMonitor();
    for (const id of this.procs.keys()) this.stop(id);
  }
}
