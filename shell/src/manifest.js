import fs from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_FILENAME = 'app.manifest.json';

const REQUIRED_FIELDS = ['id', 'name', 'logo', 'install', 'start', 'healthCheck'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Read and validate an app.manifest.json from an app directory.
 * Throws with a clear message on any problem so callers can surface it inline.
 * @param {string} appDir absolute path to the app's root directory
 * @returns {Promise<object>} the parsed, validated manifest
 */
export async function readManifest(appDir) {
  const manifestPath = path.join(appDir, MANIFEST_FILENAME);

  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`No ${MANIFEST_FILENAME} found at repo root (${manifestPath}).`);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${MANIFEST_FILENAME} is not valid JSON: ${err.message}`);
  }

  const missing = REQUIRED_FIELDS.filter((f) => !manifest[f]);
  if (missing.length) {
    throw new Error(`${MANIFEST_FILENAME} is missing required field(s): ${missing.join(', ')}.`);
  }

  if (!ID_RE.test(manifest.id)) {
    throw new Error(
      `Manifest "id" must be URL-safe (lowercase letters, digits, hyphens): got "${manifest.id}".`
    );
  }

  if (typeof manifest.healthCheck !== 'string' || !manifest.healthCheck.startsWith('/')) {
    throw new Error(`Manifest "healthCheck" must be a path starting with "/", got "${manifest.healthCheck}".`);
  }

  if (typeof manifest.logo !== 'string') {
    throw new Error(`Manifest "logo" must be a path string (relative to the app root), e.g. "logo.svg".`);
  }

  return manifest;
}
