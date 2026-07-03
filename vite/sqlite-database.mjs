import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'dreamfall.db');
export const DEFAULT_DATA_ROOT = path.resolve(__dirname, '..', 'data');

const ALLOWED_COLLECTIONS = new Set(['blueprints', 'worldmaps', 'mapbuilder', 'garage', 'state']);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const COLLECTION_DIRS = {
  blueprints: 'blueprints',
  worldmaps: 'worldmaps',
  mapbuilder: 'mapbuilder',
  garage: 'garage',
};

const dbCache = new Map();

function getDbInode(dbPath) {
  try {
    return fs.statSync(dbPath).ino;
  } catch {
    return null;
  }
}

function normalizeStoredEntry(collection, id, data) {
  if (!data || typeof data !== 'object') return data;
  if (collection === 'mapbuilder' || id === '_draft') return data;
  if (!Array.isArray(data) && collection !== 'state') data.id = id;
  return data;
}

function ensureDataDir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_entries (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      name TEXT,
      saved_at INTEGER NOT NULL DEFAULT 0,
      export_static INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS idx_store_entries_collection ON store_entries(collection);
    CREATE INDEX IF NOT EXISTS idx_store_entries_export_static ON store_entries(export_static);

    CREATE TABLE IF NOT EXISTS app_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      data TEXT NOT NULL DEFAULT '{}'
    );
    INSERT OR IGNORE INTO app_state (singleton, data) VALUES (1, '{}');
  `);
}

export function sanitizeStoreId(id) {
  const decoded = decodeURIComponent(String(id ?? ''));
  if (!ID_PATTERN.test(decoded)) return null;
  return decoded;
}

function entryMeta(row) {
  return {
    id: row.id,
    name: row.name ?? row.id,
    savedAt: row.saved_at ?? 0,
    bytes: Buffer.byteLength(row.data ?? '', 'utf8'),
    exportStatic: Boolean(row.export_static),
  };
}

function extractMeta(collection, id, data) {
  if (collection === 'state' || !data || typeof data !== 'object' || Array.isArray(data)) {
    return { name: id, savedAt: 0 };
  }
  return {
    name: data.name ?? data.id ?? id,
    savedAt: Number(data.savedAt ?? data.updatedAt ?? Date.now()) || 0,
  };
}

export function readAppState(db) {
  const row = db.prepare('SELECT data FROM app_state WHERE singleton = 1').get();
  if (!row?.data) return {};
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAppState(db, data) {
  const payload = JSON.stringify(data ?? {});
  db.prepare('UPDATE app_state SET data = ? WHERE singleton = 1').run(payload);
}

export function buildStoreIndex(db) {
  const rows = db.prepare(`
    SELECT collection, id, data, name, saved_at, export_static
    FROM store_entries
    ORDER BY saved_at DESC
  `).all();

  const index = {
    blueprints: [],
    worldmaps: [],
    mapbuilder: [],
    garage: [],
    state: readAppState(db),
  };

  for (const row of rows) {
    if (!index[row.collection]) continue;
    index[row.collection].push(entryMeta(row));
  }

  return index;
}

export function buildStoreSnapshot(db) {
  const rows = db.prepare('SELECT collection, id, data FROM store_entries').all();
  const snapshot = {
    blueprints: {},
    worldmaps: {},
    mapbuilder: {},
    garage: {},
    state: readAppState(db),
  };

  for (const row of rows) {
    if (!snapshot[row.collection]) continue;
    try {
      snapshot[row.collection][row.id] = normalizeStoredEntry(
        row.collection,
        row.id,
        JSON.parse(row.data),
      );
    } catch {
      // skip corrupt rows
    }
  }

  return snapshot;
}

export function readStoreEntry(db, collection, id) {
  if (collection === 'state') {
    if (id !== '_') return null;
    return readAppState(db);
  }

  const row = db.prepare(`
    SELECT data FROM store_entries WHERE collection = ? AND id = ?
  `).get(collection, id);
  if (!row) return null;

  const data = JSON.parse(row.data);
  return normalizeStoredEntry(collection, id, data);
}

export function writeStoreEntry(db, collection, id, data, { exportStatic = null } = {}) {
  if (collection === 'state') {
    if (id !== '_') throw new Error('Invalid state id');
    writeAppState(db, data);
    return;
  }

  const payload = JSON.stringify(data);
  const { name, savedAt } = extractMeta(collection, id, data);
  const now = Date.now();
  const existing = db.prepare('SELECT export_static FROM store_entries WHERE collection = ? AND id = ?')
    .get(collection, id);
  const exportFlag = exportStatic === null
    ? (existing?.export_static ?? 0)
    : (exportStatic ? 1 : 0);

  db.prepare(`
    INSERT INTO store_entries (collection, id, data, name, saved_at, export_static, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET
      data = excluded.data,
      name = excluded.name,
      saved_at = excluded.saved_at,
      export_static = excluded.export_static,
      updated_at = excluded.updated_at
  `).run(collection, id, payload, name, savedAt, exportFlag, now);
}

export function deleteStoreEntry(db, collection, id) {
  if (collection === 'state') {
    if (id !== '_') return false;
    writeAppState(db, {});
    return true;
  }
  const result = db.prepare('DELETE FROM store_entries WHERE collection = ? AND id = ?')
    .run(collection, id);
  return result.changes > 0;
}

export function isDatabaseEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM store_entries').get()?.count ?? 0;
  const state = readAppState(db);
  return count === 0 && !state.activeSceneId && !state.activeGarageBuildId;
}

export function importJsonFilesToDatabase(db, dataRoot = DEFAULT_DATA_ROOT) {
  let imported = 0;

  for (const [collection, dirName] of Object.entries(COLLECTION_DIRS)) {
    const dir = path.join(dataRoot, dirName);
    if (!fs.existsSync(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      const filePath = path.join(dir, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        writeStoreEntry(db, collection, id, data);
        imported += 1;
      } catch {
        // skip corrupt files
      }
    }
  }

  const statePath = path.join(dataRoot, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      writeAppState(db, state);
      imported += 1;
    } catch {
      // ignore
    }
  }

  return imported;
}

export function openDreamfallDatabase(options = {}) {
  const dbPath = path.resolve(options.dbPath ?? DEFAULT_DB_PATH);
  const inode = getDbInode(dbPath);
  const cached = dbCache.get(dbPath);
  if (cached?.db && cached.ino === inode && inode != null) return cached.db;
  if (cached?.db) {
    try { cached.db.close(); } catch {}
    dbCache.delete(dbPath);
  }

  ensureDataDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  if (options.importJsonOnEmpty !== false && isDatabaseEmpty(db)) {
    const imported = importJsonFilesToDatabase(db, options.dataRoot ?? DEFAULT_DATA_ROOT);
    if (imported > 0) {
      console.info(`[dreamfall-db] imported ${imported} JSON file(s) from data/ → SQLite`);
    }
  }

  dbCache.set(dbPath, { db, ino: getDbInode(dbPath) });
  return db;
}

export function closeDreamfallDatabase(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath);
  const cached = dbCache.get(resolved);
  if (!cached?.db) return;
  try { cached.db.close(); } catch {}
  dbCache.delete(resolved);
}

export function listExportableEntries(db, manifest = {}) {
  const wanted = {
    blueprints: new Set(manifest.blueprints ?? []),
    worldmaps: new Set(manifest.worldmaps ?? []),
    garage: new Set(manifest.garage ?? []),
  };

  const includeExportStatic = manifest.includeExportStatic !== false;
  const rows = db.prepare('SELECT collection, id, export_static FROM store_entries').all();
  const ids = {
    blueprints: new Set(),
    worldmaps: new Set(),
    garage: new Set(),
  };

  for (const row of rows) {
    if (!ids[row.collection]) continue;
    if (wanted[row.collection].has(row.id)) ids[row.collection].add(row.id);
    if (includeExportStatic && row.export_static) ids[row.collection].add(row.id);
  }

  return ids;
}

export {
  ALLOWED_COLLECTIONS,
  ID_PATTERN,
};
