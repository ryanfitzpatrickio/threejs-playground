import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'assets', 'models');
const MANIFEST_PATH = path.join(MODELS_DIR, 'bodyshop-chassis-manifest.json');
const DRAFT_PATH = path.join(MODELS_DIR, '_bodyshop-draft.glb');

const MAX_GLB_BYTES = 48 * 1024 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_GLB_BYTES * 2) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sanitizeId(id) {
  const clean = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || null;
}

function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function upsertManifestEntry(manifest, entry) {
  const next = manifest.entries.filter((item) => item.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => a.name.localeCompare(b.name));
  return { version: 1, entries: next };
}

export function bodyshopPlugin() {
  return {
    name: 'dreamfall-bodyshop',
    configureServer(server) {
      server.middlewares.use(bodyshopMiddleware());
    },
  };
}

function bodyshopMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/__editor/bodyshop/')) return next();

    if (url.pathname === '/__editor/bodyshop/chassis' && req.method === 'GET') {
      sendJson(res, 200, readManifest());
      return;
    }

    if (url.pathname === '/__editor/bodyshop/draft' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const glbBase64 = String(body.glbBase64 || '');
        if (!glbBase64) {
          sendJson(res, 400, { error: 'Missing glbBase64 payload.' });
          return;
        }
        const glbBytes = Buffer.from(glbBase64, 'base64');
        if (!glbBytes.length || glbBytes.length > MAX_GLB_BYTES) {
          sendJson(res, 400, { error: 'GLB payload is empty or too large.' });
          return;
        }
        fs.mkdirSync(MODELS_DIR, { recursive: true });
        fs.writeFileSync(DRAFT_PATH, glbBytes);
        sendJson(res, 200, { ok: true, url: '/assets/models/_bodyshop-draft.glb' });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'Failed to save draft.' });
      }
      return;
    }

    if (url.pathname === '/__editor/bodyshop/chassis' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = sanitizeId(body.id);
        if (!id) {
          sendJson(res, 400, { error: 'Invalid chassis id.' });
          return;
        }

        const glbBase64 = String(body.glbBase64 || '');
        if (!glbBase64) {
          sendJson(res, 400, { error: 'Missing glbBase64 payload.' });
          return;
        }

        const glbBytes = Buffer.from(glbBase64, 'base64');
        if (!glbBytes.length || glbBytes.length > MAX_GLB_BYTES) {
          sendJson(res, 400, { error: 'GLB payload is empty or too large.' });
          return;
        }

        fs.mkdirSync(MODELS_DIR, { recursive: true });
        const fileName = `${id}.glb`;
        const filePath = path.join(MODELS_DIR, fileName);
        fs.writeFileSync(filePath, glbBytes);

        const entry = {
          id,
          name: String(body.name || id).trim(),
          description: String(body.description || 'Authored in Bodyshop.').trim(),
          url: `/assets/models/${fileName}`,
          defaultTransform: body.defaultTransform ?? null,
          devOnly: body.devOnly === true,
        };

        const manifest = upsertManifestEntry(readManifest(), entry);
        writeManifest(manifest);
        sendJson(res, 200, { ok: true, entry, manifest });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'Failed to publish chassis.' });
      }
      return;
    }

    res.statusCode = 405;
    res.setHeader('allow', 'GET, POST');
    res.end('Method Not Allowed');
  };
}
