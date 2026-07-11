import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_COLLECTIONS,
  DEFAULT_DB_PATH,
  buildStoreIndex,
  buildStoreSnapshot,
  deleteStoreEntry,
  openDreamfallDatabase,
  readStoreEntry,
  sanitizeStoreId,
  writeStoreEntry,
} from './sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_PAYLOAD_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseStoreUrl(url) {
  const pathname = new URL(url, 'http://localhost').pathname;
  if (pathname === '/api/store/index') return { kind: 'index' };
  if (pathname === '/api/store/snapshot') return { kind: 'snapshot' };

  const match = pathname.match(/^\/api\/store\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;

  const collection = match[1];
  const id = match[2] ?? null;
  if (!ALLOWED_COLLECTIONS.has(collection)) return { error: 'Unknown collection', status: 404 };
  return { kind: 'entry', collection, id };
}

export function createDreamfallStoreMiddleware(options = {}) {
  const dbPath = options.dbPath ?? process.env.DREAMFALL_DB_PATH ?? DEFAULT_DB_PATH;

  return async (req, res, next) => {
    const db = openDreamfallDatabase({
      dbPath,
      dataRoot: options.dataRoot,
      importJsonOnEmpty: options.importJsonOnEmpty,
    });
    const parsed = parseStoreUrl(req.url ?? '');
    if (!parsed) return next();
    if (parsed.error) return sendJson(res, parsed.status, { error: parsed.error });

    try {
      if (parsed.kind === 'index') {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end('Method Not Allowed');
          return;
        }
        sendJson(res, 200, buildStoreIndex(db));
        return;
      }

      if (parsed.kind === 'snapshot') {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end('Method Not Allowed');
          return;
        }
        sendJson(res, 200, buildStoreSnapshot(db));
        return;
      }

      const { collection, id } = parsed;
      if (!id) {
        sendJson(res, 400, { error: 'Missing id' });
        return;
      }

      if (collection !== 'state' && !sanitizeStoreId(id)) {
        sendJson(res, 400, { error: 'Invalid id' });
        return;
      }

      if (req.method === 'GET') {
        const data = readStoreEntry(db, collection, id);
        if (data === null) sendJson(res, 404, { error: 'Not found' });
        else sendJson(res, 200, data);
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        let data;
        try {
          data = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' });
          return;
        }
        writeStoreEntry(db, collection, id, data);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = deleteStoreEntry(db, collection, id);
        if (!deleted) sendJson(res, 404, { error: 'Not found' });
        else sendJson(res, 200, { ok: true });
        return;
      }

      res.statusCode = 405;
      res.setHeader('allow', 'GET, PUT, DELETE');
      res.end('Method Not Allowed');
    } catch (err) {
      console.error('[dreamfall-store]', err);
      sendJson(res, 500, { error: err?.message || 'Internal error' });
    }
  };
}

function registerStoreWatcher(server, dbPath) {
  if (server.__dreamfallStoreWatcherRegistered) return;
  server.__dreamfallStoreWatcherRegistered = true;

  let timer = null;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      server.ws?.send({ type: 'custom', event: 'dreamfall:store-changed' });
    }, 150);
  };

  try {
    const watcher = watch(path.dirname(dbPath), (_event, filename) => {
      if (!filename || filename === path.basename(dbPath) || filename.startsWith(`${path.basename(dbPath)}-`)) {
        notify();
      }
    });
    server.httpServer?.on('close', () => watcher.close());
  } catch (err) {
    console.warn('[dreamfall-store] fs.watch unavailable:', err?.message || err);
  }
}

export function dreamfallStorePlugin(options = {}) {
  const dbPath = options.dbPath ?? process.env.DREAMFALL_DB_PATH ?? DEFAULT_DB_PATH;

  const attach = (server) => {
    server.middlewares.use(createDreamfallStoreMiddleware({ dbPath, dataRoot: options.dataRoot }));
    registerStoreWatcher(server, dbPath);
  };

  return {
    name: 'dreamfall-store',
    configureServer(server) {
      attach(server);
    },
    configurePreviewServer(server) {
      attach(server);
    },
    async closeBundle() {
      // Also chained explicitly from `npm run build` → `export:static-data`.
      // Keep this hook so plain `vite build` / preview still ships dist/data.
      if (process.env.NODE_ENV === 'test') return;
      if (process.env.DREAMFALL_SKIP_CLOSE_BUNDLE_EXPORT === '1') return;
      // Rebuild better-sqlite3 if this Node ABI does not match the compiled addon.
      await import('../scripts/ensure-better-sqlite3.mjs');
      const { exportStaticDataToDist } = await import('./export-static-data.mjs');
      await exportStaticDataToDist({ dbPath });
    },
  };
}

// Back-compat for scripts that imported buildStoreIndex from the old file plugin.
export { buildStoreIndex, buildStoreSnapshot } from './sqlite-database.mjs';
