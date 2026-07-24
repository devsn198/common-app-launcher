import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../shell/src/registry.js';

async function tmpRegistry() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-'));
  const reg = new Registry(path.join(dir, 'registry.json'));
  await reg.load();
  return reg;
}

const rec = (id) => ({ id, name: id, path: `/apps/${id}` });

test('load() on a missing file starts empty rather than throwing', async () => {
  const reg = await tmpRegistry();
  assert.deepEqual(reg.list(), []);
});

test('list() preserves insertion order — it is what drives the rail', async () => {
  const reg = await tmpRegistry();
  for (const id of ['a', 'b', 'c']) await reg.add(rec(id));
  assert.deepEqual(reg.list().map((r) => r.id), ['a', 'b', 'c']);
});

test('reorder() applies the given order', async () => {
  const reg = await tmpRegistry();
  for (const id of ['a', 'b', 'c']) await reg.add(rec(id));
  await reg.reorder(['c', 'a', 'b']);
  assert.deepEqual(reg.list().map((r) => r.id), ['c', 'a', 'b']);
});

test('reorder() keeps apps the caller did not mention instead of dropping them', async () => {
  // Guards the real race: an install landing mid-drag must not be erased by the
  // stale id list the browser sends on drop.
  const reg = await tmpRegistry();
  for (const id of ['store', 'a', 'b']) await reg.add(rec(id));
  await reg.reorder(['b', 'a']); // 'store' is not a rail tile, so it is never sent
  assert.deepEqual(reg.list().map((r) => r.id), ['b', 'a', 'store']);
});

test('reorder() ignores unknown ids', async () => {
  const reg = await tmpRegistry();
  await reg.add(rec('a'));
  await reg.reorder(['ghost', 'a']);
  assert.deepEqual(reg.list().map((r) => r.id), ['a']);
});

test('reorder() survives a reload — the order is on disk, not in memory', async () => {
  const reg = await tmpRegistry();
  for (const id of ['a', 'b', 'c']) await reg.add(rec(id));
  await reg.reorder(['c', 'b', 'a']);
  const reloaded = await new Registry(reg.filePath).load();
  assert.deepEqual(reloaded.list().map((r) => r.id), ['c', 'b', 'a']);
});

test('add() upserts without duplicating', async () => {
  const reg = await tmpRegistry();
  await reg.add(rec('a'));
  await reg.add({ ...rec('a'), name: 'renamed' });
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get('a').name, 'renamed');
});

test('remove() deletes and persists', async () => {
  const reg = await tmpRegistry();
  await reg.add(rec('a'));
  await reg.remove('a');
  assert.equal(reg.has('a'), false);
  const reloaded = await new Registry(reg.filePath).load();
  assert.deepEqual(reloaded.list(), []);
});
