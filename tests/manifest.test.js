import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManifest, MANIFEST_FILENAME } from '../shell/src/manifest.js';

const VALID = {
  id: 'my-app',
  name: 'My App',
  logo: 'logo.svg',
  install: 'npm ci',
  start: 'node server.js',
  healthCheck: '/health',
};

// Write a manifest (or raw text) into a throwaway app dir and read it back.
async function withManifest(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'man-'));
  if (contents !== undefined) {
    const body = typeof contents === 'string' ? contents : JSON.stringify(contents);
    await fs.writeFile(path.join(dir, MANIFEST_FILENAME), body);
  }
  return readManifest(dir);
}

test('accepts a well-formed manifest', async () => {
  assert.deepEqual(await withManifest(VALID), VALID);
});

test('rejects a missing manifest with a path in the message', async () => {
  await assert.rejects(withManifest(undefined), /No app\.manifest\.json found/);
});

test('rejects malformed JSON', async () => {
  await assert.rejects(withManifest('{ nope'), /not valid JSON/);
});

for (const field of ['id', 'name', 'logo', 'install', 'start', 'healthCheck']) {
  test(`rejects a manifest missing "${field}"`, async () => {
    const { [field]: _dropped, ...rest } = VALID;
    await assert.rejects(withManifest(rest), new RegExp(`missing required field\\(s\\).*${field}`));
  });
}

for (const id of ['Has-Caps', 'has space', '-leading-hyphen', 'under_score', 'sla/sh']) {
  test(`rejects non-URL-safe id "${id}"`, async () => {
    await assert.rejects(withManifest({ ...VALID, id }), /must be URL-safe/);
  });
}

test('accepts ids with digits and hyphens', async () => {
  const m = await withManifest({ ...VALID, id: 'app2-x' });
  assert.equal(m.id, 'app2-x');
});

test('rejects a healthCheck that is not a rooted path', async () => {
  await assert.rejects(withManifest({ ...VALID, healthCheck: 'health' }), /must be a path starting with/);
});

test('rejects a non-string logo', async () => {
  // `logo: 1` is truthy, so it clears the required-field check and must be
  // caught by the type check instead.
  await assert.rejects(withManifest({ ...VALID, logo: 1 }), /must be a path string/);
});
