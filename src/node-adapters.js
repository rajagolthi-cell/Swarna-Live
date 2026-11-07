// Local (Node.js) stand-ins for Cloudflare D1 and R2.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

export function sqliteDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)) continue;
    db.exec(fs.readFileSync(new URL(name, MIGRATIONS), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  }
  return {
    all: async (sql, ...p) => db.prepare(sql).all(...p),
    get: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
    run: async (sql, ...p) => {
      const r = db.prepare(sql).run(...p);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
  };
}

export function folderFiles(dir) {
  const full = (key) => {
    const p = path.resolve(dir, key);
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('Bad key');
    return p;
  };
  return {
    put: async (key, data, contentType) => {
      fs.mkdirSync(path.dirname(full(key)), { recursive: true });
      fs.writeFileSync(full(key), Buffer.from(data));
      fs.writeFileSync(full(key) + '.type', contentType);
    },
    get: async (key) => {
      if (!fs.existsSync(full(key))) return null;
      return { body: fs.readFileSync(full(key)), contentType: fs.readFileSync(full(key) + '.type', 'utf8') };
    },
    delete: async (key) => {
      fs.rmSync(full(key), { force: true });
      fs.rmSync(full(key) + '.type', { force: true });
    },
  };
}

export function memoryFiles() {
  const m = new Map();
  return {
    put: async (key, data, contentType) => { m.set(key, { body: new Uint8Array(data), contentType }); },
    get: async (key) => m.get(key) ?? null,
    delete: async (key) => { m.delete(key); },
    size: () => m.size,
  };
}
