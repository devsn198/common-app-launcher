import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The registry is the Shell's source of truth for which apps are installed.
 * Stored as a JSON array of { id, name, icon, path, version } records under
 * the Shell's data directory. Per-app runtime data lives elsewhere.
 */
export class Registry {
  /** @param {string} filePath absolute path to registry.json */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, object>} */
    this.apps = new Map();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const list = JSON.parse(raw);
      this.apps = new Map(list.map((a) => [a.id, a]));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.apps = new Map(); // first boot: no registry yet
    }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const list = [...this.apps.values()];
    await fs.writeFile(this.filePath, JSON.stringify(list, null, 2));
  }

  has(id) {
    return this.apps.has(id);
  }

  get(id) {
    return this.apps.get(id);
  }

  list() {
    return [...this.apps.values()];
  }

  /** Upsert a record and persist. */
  async add(record) {
    this.apps.set(record.id, record);
    await this.save();
    return record;
  }

  async remove(id) {
    this.apps.delete(id);
    await this.save();
  }

  /**
   * Rebuild the record order (a Map iterates in insertion order, and `list()`
   * drives the rail). Unknown ids are ignored and any app the caller didn't
   * mention keeps its relative order at the end, so a concurrent install can't
   * be dropped by a stale reorder.
   */
  async reorder(ids) {
    const next = new Map();
    for (const id of ids) {
      if (this.apps.has(id)) next.set(id, this.apps.get(id));
    }
    for (const [id, record] of this.apps) {
      if (!next.has(id)) next.set(id, record);
    }
    this.apps = next;
    await this.save();
  }
}
