/**
 * Dev-only Outfit Import Studio bake bridge.
 *
 * POST /__editor/outfit/prepare  — Blender weight transfer + optional morph bake
 * GET  /__editor/outfit/status   — Blender availability
 * GET  /__editor/outfit/manifest — draft imports under public/assets/simoutfits/_import
 * POST /__editor/outfit/promote  — copy draft → standard/morph
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getSimBodyProfile, isSimBodyId } from '../src/game/characters/simhuman/simBodyProfiles.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMPORT_DIR = path.join(ROOT, 'public', 'assets', 'simoutfits', '_import');
const STANDARD_DIR = path.join(ROOT, 'public', 'assets', 'simoutfits', 'standard');
const MORPH_DIR = path.join(ROOT, 'public', 'assets', 'simoutfits', 'morph');
const MANIFEST_PATH = path.join(IMPORT_DIR, 'manifest.json');
const PROMOTED_MANIFEST_PATH = path.join(ROOT, 'public', 'assets', 'simoutfits', 'manifest.json');
const IMPORT_ASSET_PREFIX = '/assets/simoutfits/_import/';
const PREPARE_PY = path.join(ROOT, 'scripts', 'prepare-unrigged-outfit.py');
const BAKE_PY = path.join(ROOT, 'scripts', 'bake-outfit-morphs.py');
const OPTIMIZE_JS = path.join(ROOT, 'scripts', 'optimize-sim-outfit-variants.mjs');
const BLENDER_BIN = process.env.BLENDER_BIN
  || '/Applications/Blender.app/Contents/MacOS/Blender';

const MAX_GLB_BYTES = 48 * 1024 * 1024;
// Cloth + optional source FBX travel as base64 (~4/3 each) inside one JSON body.
// Keep headroom above 2× the binary cap so real Meshy imports do not trip the
// reader and get a silent TCP reset (browser: net::ERR_CONNECTION_RESET).
const MAX_JSON_BODY_BYTES = Math.floor(MAX_GLB_BYTES * 4.5);
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

let busy = false;

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function serveGeneratedImportAsset(req, res, url) {
  if (!url.pathname.startsWith(IMPORT_ASSET_PREFIX)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!url.pathname.endsWith('.glb')) return false;

  let filename = '';
  try {
    filename = decodeURIComponent(url.pathname.slice(IMPORT_ASSET_PREFIX.length));
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid outfit asset path' });
    return true;
  }
  if (!filename || path.basename(filename) !== filename || !filename.endsWith('.glb')) {
    sendJson(res, 404, { ok: false, error: 'Generated outfit asset not found' });
    return true;
  }

  const filePath = path.join(IMPORT_DIR, filename);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { ok: false, error: `Generated outfit asset missing: ${filename}` });
    return true;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: `Generated outfit asset missing: ${filename}` });
    return true;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'model/gltf-binary');
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message });
    else res.destroy(error);
  });
  stream.pipe(res);
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        // Drain and reject with a real HTTP error — req.destroy() alone surfaces
        // as net::ERR_CONNECTION_RESET in the browser with no response body.
        oversized = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(Object.assign(
          new Error(
            `Bake payload too large (${(total / (1024 * 1024)).toFixed(1)} MiB). `
            + `Cap is ${(MAX_JSON_BODY_BYTES / (1024 * 1024)).toFixed(0)} MiB JSON `
            + `(cloth + optional source FBX as base64). Lower max verts, re-export a lighter mesh, `
            + 'or drop the source FBX textures path.',
          ),
          { statusCode: 413 },
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(Object.assign(
          new Error(`Invalid JSON body: ${error?.message ?? error}`),
          { statusCode: 400 },
        ));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeId(id) {
  const clean = String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function readPromotedManifest() {
  try {
    const raw = fs.readFileSync(PROMOTED_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writePromotedManifest(manifest) {
  fs.mkdirSync(path.dirname(PROMOTED_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(PROMOTED_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function upsertEntry(manifest, entry) {
  const next = manifest.entries.filter((item) => item.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { version: 1, entries: next };
}

function reconcileExistingPromotions() {
  let promoted = readPromotedManifest();
  let changed = false;
  for (const draft of readManifest().entries) {
    const standardPath = path.join(STANDARD_DIR, `${draft.id}.glb`);
    if (!fs.existsSync(standardPath)) continue;
    const morphPath = path.join(MORPH_DIR, `${draft.id}.glb`);
    const existing = promoted.entries.find((entry) => entry.id === draft.id);
    const bodyId = Object.keys(draft.bodies ?? {}).find(isSimBodyId);
    if (!bodyId) continue;
    // A draft may reuse an id that was promoted earlier for another body.
    // The deployable filename does not encode body, so the file on disk still
    // belongs to the existing promotion; never infer that it also represents
    // the newer draft body. The live catalog can merge the promoted body with
    // the body-specific draft without corrupting the promoted manifest.
    if (existing && !existing.bodies?.[bodyId]) continue;
    const version = Math.round(Math.max(
      fs.statSync(standardPath).mtimeMs,
      fs.existsSync(morphPath) ? fs.statSync(morphPath).mtimeMs : 0,
    ));
    const entry = {
      id: draft.id,
      name: existing?.name || draft.name || draft.id,
      description: existing?.description || `Promoted import (${bodyId})`,
      promoted: true,
      bodies: {
        ...(existing?.bodies ?? {}),
        [bodyId]: {
          standard: `/assets/simoutfits/standard/${draft.id}.glb?v=${version}`,
          morph: `/assets/simoutfits/morph/${draft.id}.glb?v=${version}`,
        },
      },
    };
    promoted = upsertEntry(promoted, entry);
    changed = true;
  }
  if (changed) writePromotedManifest(promoted);
}

function blenderAvailable() {
  try {
    return fs.existsSync(BLENDER_BIN);
  } catch {
    return false;
  }
}

async function runBlender(args, label) {
  try {
    const { stdout, stderr } = await execFileAsync(BLENDER_BIN, args, {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      timeout: JOB_TIMEOUT_MS,
    });
    return {
      label,
      stdout: String(stdout || '').slice(-8000),
      stderr: String(stderr || '').slice(-4000),
    };
  } catch (error) {
    // Node's execFile attaches stdout/stderr on failure; surface them for the UI.
    error.stdout = String(error.stdout || '').slice(-8000);
    error.stderr = String(error.stderr || '').slice(-4000);
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

export function outfitPreparePlugin() {
  reconcileExistingPromotions();
  return {
    name: 'dreamfall-outfit-prepare',
    configureServer(server) {
      server.middlewares.use(outfitPrepareMiddleware());
    },
  };
}

function outfitPrepareMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Files written after Vite startup must never fall through to index.html;
    // GLTFLoader otherwise reports an opaque `Unexpected token '<'` parse error.
    if (serveGeneratedImportAsset(req, res, url)) return;
    if (!url.pathname.startsWith('/__editor/outfit/')) return next();

    try {
      if (url.pathname === '/__editor/outfit/status' && req.method === 'GET') {
        sendJson(res, 200, {
          blender: blenderAvailable(),
          blenderBin: BLENDER_BIN,
          busy,
          importDir: '/assets/simoutfits/_import/',
        });
        return;
      }

      if (url.pathname === '/__editor/outfit/manifest' && req.method === 'GET') {
        sendJson(res, 200, readManifest());
        return;
      }

      if (url.pathname === '/__editor/outfit/prepare' && req.method === 'POST') {
        if (busy) {
          sendJson(res, 409, { ok: false, error: 'Bake already running' });
          return;
        }
        if (!blenderAvailable()) {
          sendJson(res, 500, {
            ok: false,
            error: `Blender not found at ${BLENDER_BIN}. Set BLENDER_BIN.`,
          });
          return;
        }

        const body = await readJsonBody(req);
        const id = sanitizeId(body.id);
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Invalid id' });
          return;
        }
        // `gender` is retained as a read-only fallback for older Import Studio clients.
        const bodyId = String(body.body ?? body.gender ?? '');
        const bodyProfile = getSimBodyProfile(bodyId);
        if (!bodyProfile) {
          sendJson(res, 400, { ok: false, error: `Unsupported outfit body: ${bodyId || '(missing)'}` });
          return;
        }
        const name = String(body.name || id).slice(0, 80);
        const clothB64 = body.clothGlbBase64;
        if (!clothB64 || typeof clothB64 !== 'string') {
          sendJson(res, 400, { ok: false, error: 'clothGlbBase64 required' });
          return;
        }
        const clothBuf = Buffer.from(clothB64, 'base64');
        if (clothBuf.length > MAX_GLB_BYTES) {
          sendJson(res, 400, { ok: false, error: 'Cloth GLB too large' });
          return;
        }

        // Optional original FBX for real textures (browser re-export often loses them).
        let sourceBuf = null;
        let sourceExt = '.fbx';
        if (typeof body.sourceFileBase64 === 'string' && body.sourceFileBase64.length > 32) {
          sourceBuf = Buffer.from(body.sourceFileBase64, 'base64');
          sourceExt = String(body.sourceFileExt || '.fbx').toLowerCase();
          if (!sourceExt.startsWith('.')) sourceExt = `.${sourceExt}`;
          if (sourceBuf.length > MAX_GLB_BYTES * 2) {
            sendJson(res, 400, { ok: false, error: 'Source FBX too large' });
            return;
          }
        }

        const options = body.options ?? {};
        const maxVerts = Number(options.maxVerts) || 70000;
        const maxTexture = Number(options.maxTexture) || 2048;
        const expectedBindHeight = Number(options.expectedBindHeight);
        const expectedBindScale = Number(options.expectedBindScale);
        const bodyWorldScaleY = Number(options.bodyWorldScaleY);
        if (
          !(expectedBindHeight > 0.02 && expectedBindHeight < 10)
          || !(expectedBindScale > 1.25 && expectedBindScale < 4)
          || !(bodyWorldScaleY > 0.25 && bodyWorldScaleY < 0.75)
        ) {
          sendJson(res, 409, {
            ok: false,
            error: 'Missing or invalid bind-space export measurements. Hard-refresh the page, re-snap, then bake again.',
          });
          return;
        }
        // Default false for imports — morph bake is optional quality.
        const bakeMorphs = options.bakeMorphs === true;
        const pose = body.pose && typeof body.pose === 'object' ? body.pose : {};
        const poseBoneCount = pose?.bones && typeof pose.bones === 'object'
          ? Object.keys(pose.bones).length
          : Object.keys(pose).length;
        if (poseBoneCount > 0 && pose.format !== 'bone-world-delta-v1') {
          sendJson(res, 409, {
            ok: false,
            error: 'Outfit pose payload is from a stale client. Hard-refresh the page, pose again, then Apply weights.',
          });
          return;
        }
        // Empty pose = rest bake: weights transfer from a T-pose body onto the
        // authored (usually arms-down) garment — wrong for Meshy imports.
        // Two silent rest bakes shipped before this became opt-in.
        if (poseBoneCount === 0 && options.allowRestPose !== true) {
          sendJson(res, 409, {
            ok: false,
            error: 'Pose is empty (rest). Apply Arms down in the Import Studio before baking, '
              + 'or tick "Bake at rest pose" for garments authored in T-pose.',
          });
          return;
        }

        const bodyGlb = path.join(
          ROOT,
          'public',
          'assets',
          'simhuman',
          bodyProfile.outfitDonorFile,
        );
        if (!fs.existsSync(bodyGlb)) {
          sendJson(res, 500, { ok: false, error: `Missing body ${bodyGlb}` });
          return;
        }

        busy = true;
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamfall-outfit-'));
        const logs = [];
        try {
          const clothPath = path.join(tmp, 'cloth.glb');
          const posePath = path.join(tmp, 'pose.json');
          // Keep Blender I/O under /tmp until the job finishes. Writing into
          // public/ mid-request can trip Vite's watcher and kill the HTTP
          // connection (browser: net::ERR_CONNECTION_RESET / Failed to fetch).
          const rawPath = path.join(tmp, `${id}.raw.glb`);
          fs.mkdirSync(IMPORT_DIR, { recursive: true });
          fs.writeFileSync(clothPath, clothBuf);
          fs.writeFileSync(posePath, `${JSON.stringify(pose, null, 2)}\n`);

          const prepArgs = [
            '--background',
            '--python', PREPARE_PY,
            '--',
            '--cloth', clothPath,
            '--body', bodyGlb,
            '--output', rawPath,
            '--no-auto-align',
            '--pose', posePath,
            '--max-verts', String(maxVerts),
            '--max-texture', String(maxTexture),
            '--expected-bind-height', String(expectedBindHeight),
          ];
          if (sourceBuf) {
            const donorPath = path.join(tmp, `textures-from${sourceExt}`);
            fs.writeFileSync(donorPath, sourceBuf);
            prepArgs.push('--textures-from', donorPath);
          }
          try {
            logs.push(await runBlender(prepArgs, 'prepare-unrigged'));
          } catch (prepErr) {
            const msg = String(prepErr?.message || prepErr);
            const tail = [
              prepErr?.stdout,
              prepErr?.stderr,
            ].filter(Boolean).join('\n').slice(-2000);
            throw Object.assign(
              new Error(
                `Blender weight transfer failed. ${msg}`
                + (tail ? `\n${tail}` : ''),
              ),
              { statusCode: 500 },
            );
          }
          if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size < 64) {
            throw Object.assign(
              new Error(
                'Blender finished without writing a skinned GLB. Check the pose (Arms down), '
                + 'body selection, and Blender console log.',
              ),
              { statusCode: 500 },
            );
          }

          // Validate against this garment's measured bind-space height. Partial
          // garments (tops, skirts, shoes) do not span the full ~3.49 UBC body.
          // Allow room for posed→rest backsolving while still catching a 0.5x
          // runtime-space export.
          const heightTolerance = Math.max(0.12, expectedBindHeight * 0.35);
          const minBindHeight = Math.max(0.001, expectedBindHeight - heightTolerance);
          const maxBindHeight = expectedBindHeight + heightTolerance;
          const probePy = path.join(tmp, 'probe_height.py');
          fs.writeFileSync(
            probePy,
            [
              'import bpy, sys',
              `path = ${JSON.stringify(rawPath)}`,
              'bpy.ops.wm.read_homefile(use_empty=True)',
              'bpy.ops.import_scene.gltf(filepath=path)',
              'zs = []',
              'for o in bpy.data.objects:',
              '    if o.type != "MESH" or "ico" in o.name.lower():',
              '        continue',
              '    mw = o.matrix_world',
              '    for v in o.data.vertices:',
              '        zs.append((mw @ v.co).z)',
              'h = (max(zs) - min(zs)) if zs else 0.0',
              `expected = ${JSON.stringify(expectedBindHeight)}`,
              `lo = ${JSON.stringify(minBindHeight)}`,
              `hi = ${JSON.stringify(maxBindHeight)}`,
              'print(f"[outfit-prepare] raw_height={h:.4f} expected={expected:.4f} range=[{lo:.4f},{hi:.4f}]")',
              'sys.exit(0 if zs and lo <= h <= hi else 3)',
              '',
            ].join('\n'),
            'utf8',
          );
          try {
            const probeLog = await runBlender(
              ['--background', '--python', probePy],
              'height-probe',
            );
            logs.push(probeLog);
          } catch (probeErr) {
            const msg = String(probeErr?.message || probeErr);
            // runBlender throws on non-zero; exit 3 is our height fail.
            if (msg.includes('status') || msg.includes('failed') || msg.includes('EXIT')) {
              throw new Error(
                `Baked cloth height does not match this garment's ${expectedBindHeight.toFixed(2)} bind-space height. `
                + 'Client likely exported the wrong scale — hard-refresh, re-snap, then re-bake. '
                + msg,
              );
            }
            logs.push({
              label: 'height-probe-skip',
              stdout: '',
              stderr: msg,
            });
          }

          let standardUrl = `/assets/simoutfits/_import/${id}.glb`;
          let morphUrl = null;
          const outStandard = path.join(IMPORT_DIR, `${id}.glb`);
          const outMorph = path.join(IMPORT_DIR, `${id}.morph.glb`);
          const outRaw = path.join(IMPORT_DIR, `${id}.raw.glb`);

          // IMPORTANT: Import drafts skip Draco/optimize. gltf-transform Draco has
          // shredded dense Meshy skins in WebGPU even when raw rest-skin is fine.
          // Ship the Blender raw skinned GLB as standard; optional morph bake is
          // also left uncompressed. Copy into public/ only after Blender is done.
          if (bakeMorphs) {
            const morphSrc = path.join(tmp, `${id}.morph-src.glb`);
            const bakeArgs = [
              '--background',
              '--python', BAKE_PY,
              '--',
              '--body', bodyGlb,
              '--outfit', rawPath,
              '--output', morphSrc,
              '--max-dist', String(options.morphMaxDist ?? 0.16),
              '--ease', String(options.morphEase ?? 1.08),
            ];
            logs.push(await runBlender(bakeArgs, 'bake-morphs'));
            fs.copyFileSync(rawPath, outRaw);
            fs.copyFileSync(rawPath, outStandard);
            if (fs.existsSync(morphSrc) && fs.statSync(morphSrc).size > 64) {
              fs.copyFileSync(morphSrc, outMorph);
              morphUrl = `/assets/simoutfits/_import/${id}.morph.glb`;
            }
            logs.push({
              label: 'copy-raw-no-draco',
              stdout: 'skipped optimize/draco for import reliability',
              stderr: '',
            });
          } else {
            fs.copyFileSync(rawPath, outRaw);
            fs.copyFileSync(rawPath, outStandard);
            // morph falls back to standard
          }

          const v = Date.now();
          const bodies = {
            [bodyId]: {
              standard: `${standardUrl}?v=${v}`,
              ...(morphUrl ? { morph: `${morphUrl}?v=${v}` } : {}),
            },
          };
          // Without morph, use standard for both.
          if (!bodies[bodyId].morph) {
            bodies[bodyId].morph = bodies[bodyId].standard;
          }

          const entry = {
            id,
            name,
            description: `Imported draft (${bodyId})`,
            imported: true,
            bake: {
              poseFormat: String(pose.format || 'legacy-local-euler'),
              poseBoneCount,
            },
            bodies,
          };
          writeManifest(upsertEntry(readManifest(), entry));

          sendJson(res, 200, {
            ok: true,
            id,
            urls: {
              raw: `/assets/simoutfits/_import/${id}.raw.glb?v=${v}`,
              standard: bodies[bodyId].standard,
              morph: bodies[bodyId].morph,
            },
            bytes: {
              standard: fs.existsSync(outStandard) ? fs.statSync(outStandard).size : 0,
              morph: fs.existsSync(outMorph) ? fs.statSync(outMorph).size : 0,
            },
            manifestEntry: entry,
            log: logs.map((l) => `[${l.label}]\n${l.stdout}\n${l.stderr}`).join('\n---\n').slice(-12000),
          });
        } finally {
          busy = false;
          try {
            fs.rmSync(tmp, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (url.pathname === '/__editor/outfit/promote' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const id = sanitizeId(body.id);
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Invalid id' });
          return;
        }
        const stdIn = path.join(IMPORT_DIR, `${id}.glb`);
        const morphIn = path.join(IMPORT_DIR, `${id}.morph.glb`);
        if (!fs.existsSync(stdIn)) {
          sendJson(res, 404, { ok: false, error: 'Draft standard GLB missing' });
          return;
        }
        fs.mkdirSync(STANDARD_DIR, { recursive: true });
        fs.mkdirSync(MORPH_DIR, { recursive: true });
        fs.copyFileSync(stdIn, path.join(STANDARD_DIR, `${id}.glb`));
        if (fs.existsSync(morphIn)) {
          fs.copyFileSync(morphIn, path.join(MORPH_DIR, `${id}.glb`));
        } else {
          fs.copyFileSync(stdIn, path.join(MORPH_DIR, `${id}.glb`));
        }
        const draftEntry = readManifest().entries.find((entry) => entry.id === id) ?? null;
        const requestedBody = body.body ?? body.gender;
        const bodyId = isSimBodyId(requestedBody)
          ? String(requestedBody)
          : Object.keys(draftEntry?.bodies ?? {}).find(isSimBodyId);
        if (!bodyId) {
          sendJson(res, 400, { ok: false, error: 'Missing or unsupported outfit body' });
          return;
        }
        const version = Date.now();
        const promotedManifest = readPromotedManifest();
        const previous = promotedManifest.entries.find((entry) => entry.id === id);
        const promotedEntry = {
          id,
          name: String(body.name || draftEntry?.name || previous?.name || id).slice(0, 80),
          description: String(body.description || previous?.description || `Promoted import (${bodyId})`).slice(0, 180),
          promoted: true,
          bodies: {
            ...(previous?.bodies ?? {}),
            [bodyId]: {
              standard: `/assets/simoutfits/standard/${id}.glb?v=${version}`,
              morph: `/assets/simoutfits/morph/${id}.glb?v=${version}`,
            },
          },
        };
        writePromotedManifest(upsertEntry(promotedManifest, promotedEntry));
        sendJson(res, 200, {
          ok: true,
          id,
          urls: {
            standard: `/assets/simoutfits/standard/${id}.glb`,
            morph: `/assets/simoutfits/morph/${id}.glb`,
          },
          manifestEntry: promotedEntry,
          manifest: '/assets/simoutfits/manifest.json',
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      busy = false;
      console.error('[outfit-prepare]', error);
      const status = Number(error?.statusCode) || 500;
      sendJson(res, status, {
        ok: false,
        error: error?.message ?? String(error),
        log: [error?.stdout, error?.stderr].filter(Boolean).join('\n').slice(-8000) || undefined,
      });
    }
  };
}
