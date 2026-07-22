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
 * @returns {Promise<{manifest: object, appDir: string}>}
 */
export async function installFromGit(repoUrl, appsDir) {
  await fs.mkdir(appsDir, { recursive: true });

  // Clone into a temp dir first so we can read the manifest and learn the real id.
  const tmpDir = path.join(appsDir, `.tmp-${Date.now()}`);
  await run(`git clone --depth 1 ${JSON.stringify(repoUrl)} ${JSON.stringify(tmpDir)}`, appsDir);

  let manifest;
  try {
    manifest = await readManifest(tmpDir);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  // Move into its id-named final location, replacing any prior install.
  const appDir = path.join(appsDir, manifest.id);
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.rename(tmpDir, appDir);

  try {
    await run(manifest.install, appDir);
  } catch (err) {
    await fs.rm(appDir, { recursive: true, force: true });
    throw err;
  }

  return { manifest, appDir };
}
