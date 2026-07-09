import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'assets', 'models');
const MANIFEST_PATH = path.join(MODELS_DIR, 'bodyshop-chassis-manifest.json');
const DRAFT_PATH = path.join(MODELS_DIR, '_bodyshop-draft.glb');
const CLEANED_PATH = path.join(MODELS_DIR, '_bodyshop-cleaned.glb');
const CLEAN_SCRIPT = path.join(ROOT, 'scripts', 'clean-bodyshop-glb.py');
const BLENDER_BIN = process.env.BLENDER_BIN
  || '/Applications/Blender.app/Contents/MacOS/blender';

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

    // Blender planar-dissolve cleanup (dust-and-bullets cut cleanup pipeline).
    if (url.pathname === '/__editor/bodyshop/clean' && req.method === 'POST') {
      try {
        if (!fs.existsSync(BLENDER_BIN)) {
          sendJson(res, 500, {
            error: `Blender not found at ${BLENDER_BIN}. Set BLENDER_BIN or install Blender.`,
          });
          return;
        }
        if (!fs.existsSync(CLEAN_SCRIPT)) {
          sendJson(res, 500, { error: 'Missing scripts/clean-bodyshop-glb.py' });
          return;
        }

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

        const ratio = Number.isFinite(Number(body.ratio)) ? Number(body.ratio) : 1;
        const planarAngle = Number.isFinite(Number(body.planarAngle))
          ? Number(body.planarAngle)
          : 5;
        const mergeDistance = Number.isFinite(Number(body.mergeDistance))
          ? Number(body.mergeDistance)
          : 0.00005;

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamfall-bodyshop-clean-'));
        const inputPath = path.join(workDir, 'input.glb');
        const outputPath = path.join(workDir, 'output.glb');
        fs.writeFileSync(inputPath, glbBytes);

        const args = [
          '--background',
          '--python',
          CLEAN_SCRIPT,
          '--',
          inputPath,
          outputPath,
          '--ratio',
          String(ratio),
          '--planar-angle',
          String(planarAngle),
          '--merge-distance',
          String(mergeDistance),
        ];

        const result = await execFileAsync(BLENDER_BIN, args, {
          cwd: ROOT,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 10 * 60 * 1000,
        });

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          sendJson(res, 500, {
            error: 'Blender clean produced no output.',
            stderr: String(result.stderr || '').slice(-2000),
            stdout: String(result.stdout || '').slice(-2000),
          });
          return;
        }

        fs.mkdirSync(MODELS_DIR, { recursive: true });
        fs.copyFileSync(outputPath, CLEANED_PATH);

        const summaryMatch = String(result.stdout || '').match(/vertices[\s\S]*?faces[\s\S]*$/m);
        const summary = summaryMatch
          ? summaryMatch[0].trim().split('\n').pop()
          : 'cleaned';

        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          // ignore temp cleanup failures
        }

        sendJson(res, 200, {
          ok: true,
          url: `/assets/models/_bodyshop-cleaned.glb?v=${Date.now()}`,
          summary,
          stdout: String(result.stdout || '').slice(-4000),
        });
      } catch (error) {
        sendJson(res, 500, {
          error: error.message || 'Failed to clean GLB.',
          stderr: String(error.stderr || '').slice(-2000),
        });
      }
      return;
    }

    res.statusCode = 405;
    res.setHeader('allow', 'GET, POST');
    res.end('Method Not Allowed');
  };
}
