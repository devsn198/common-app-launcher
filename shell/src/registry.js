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
}
