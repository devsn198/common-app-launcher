import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readManifest } from './manifest.js';

/**
 * Run a shell command in a directory, capturing output. Rejects with a helpful
 * error (including captured output tail) on non-zero exit.
 */
function run(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (out += b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`\`${command}\` failed (exit ${code}):\n${out.slice(-4000)}`));
    });
  });
}

/**
 * Clone a repo and run its declared install command.
 * @param {string} repoUrl any git-cloneable ref: https URL, ssh, file://, or local path
 * @param {string} appsDir directory where installed apps are cloned
 * @param {object} [opts]
 * @param {string} [opts.subpath] install the app from this subfolder of the repo (monorepo support)
 * @param {string} [opts.branch] clone this branch instead of the default
 * @returns {Promise<{manifest: object, appDir: string}>}
 */
export async function installFromGit(repoUrl, appsDir, { subpath, branch } = {}) {
  await fs.mkdir(appsDir, { recursive: true });

  // Clone into a temp dir first so we can read the manifest and learn the real id.
  const tmpDir = path.join(appsDir, `.tmp-${Date.now()}`);
  const branchArg = branch ? `--branch ${JSON.stringify(branch)} ` : '';
  await run(`git clone --depth 1 ${branchArg}${JSON.stringify(repoUrl)} ${JSON.stringify(tmpDir)}`, appsDir);

  // The app's root is either the clone root or a subfolder within it.
  let appRoot = tmpDir;
  if (subpath) {
    appRoot = path.resolve(tmpDir, subpath);
    // Guard against path traversal (e.g. "../../etc") escaping the clone.
    if (appRoot !== tmpDir && !appRoot.startsWith(tmpDir + path.sep)) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      throw new Error(`Invalid subpath "${subpath}".`);
    }
  }

  let manifest;
  try {
    manifest = await readManifest(appRoot);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  // Move just the app's folder into its id-named final location, then discard the
  // rest of the clone (matters for monorepo subpath installs).
  const appDir = path.join(appsDir, manifest.id);
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.rename(appRoot, appDir);
  if (appRoot !== tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });

  try {
    await run(manifest.install, appDir);
  } catch (err) {
    await fs.rm(appDir, { recursive: true, force: true });
    throw err;
  }

  return { manifest, appDir };
}
