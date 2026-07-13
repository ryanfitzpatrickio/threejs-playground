// Pure-node contract for Horde distance-proxy GLBs ({bot}-proxy.glb).
// These feed HordeProxySystem pose baking (must stay under the runtime vertex limit).

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { HORDE_PROXY_VERTEX_LIMIT } from '../src/game/config/hordePerformanceConfig.js';
import { HORDE_PROXY_POSE_CATALOG } from '../src/game/config/hordeProxyPoses.js';
import { ENEMY_ARCHETYPES } from '../src/game/config/enemyArchetypes.js';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const HORDE_DIR = path.join(REPO_ROOT, 'public/assets/models/horde');
const BOTS = ['cyclop', 'tessy', 'faceless'];

// Exported rendered verts must fit the bake budget with headroom for UV splits.
const MAX_PROXY_VERTS = HORDE_PROXY_VERTEX_LIMIT;
const MAX_PROXY_BYTES = 3 * 1024 * 1024;

// Clips sampled by HORDE_PROXY_POSE_CATALOG.
const REQUIRED_CLIPS = new Set(HORDE_PROXY_POSE_CATALOG.map((entry) => entry.clipName));

function parseGltfJson(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 12) throw new Error(`${filePath}: too small to be a GLB`);
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  assert.equal(magic, 0x46546c67, `${filePath}: bad GLB magic`);
  assert.equal(version, 2, `${filePath}: unsupported GLB version ${version}`);
  const chunk0Len = buf.readUInt32LE(12);
  const chunk0Type = buf.readUInt32LE(16);
  assert.equal(chunk0Type, 0x4e4f534a, `${filePath}: first chunk is not JSON`);
  const jsonStr = buf.subarray(20, 20 + chunk0Len).toString('utf8');
  return { json: JSON.parse(jsonStr), totalBytes: buf.length };
}

function countRenderedVerts(json) {
  let maxVerts = 0;
  for (const mesh of json.meshes ?? []) {
    let meshVerts = 0;
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (acc) meshVerts += acc.count;
    }
    maxVerts = Math.max(maxVerts, meshVerts);
  }
  // Multi-mesh bots: sum all mesh verts (proxy bake merges via skin bake).
  let total = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (acc) total += acc.count;
    }
  }
  return { maxVerts, totalVerts: total };
}

function verifyProxy(bot) {
  const filePath = path.join(HORDE_DIR, `${bot}-proxy.glb`);
  const failures = [];
  if (!existsSync(filePath)) {
    return {
      stats: { bot, missing: true },
      failures: [`missing ${filePath} — run: npm run build:horde-proxy`],
    };
  }

  const { json, totalBytes } = parseGltfJson(filePath);
  const { maxVerts, totalVerts } = countRenderedVerts(json);
  const anims = json.animations ?? [];
  const clipNames = new Set(anims.map((a) => a.name));
  const stats = {
    bot,
    bytes: totalBytes,
    maxVerts,
    totalVerts,
    clips: anims.length,
    clipNames: [...clipNames],
    materials: (json.materials ?? []).length,
    textures: (json.images ?? []).length,
  };

  if (totalBytes > MAX_PROXY_BYTES) {
    failures.push(`file size ${(totalBytes / 1024 / 1024).toFixed(2)} MB > 3 MB`);
  }
  // Bake samples one skinned mesh tree; total verts after bake ≈ mesh verts (merged).
  if (totalVerts > MAX_PROXY_VERTS) {
    failures.push(`verts ${totalVerts.toLocaleString()} > ${MAX_PROXY_VERTS.toLocaleString()} bake budget`);
  }
  for (const name of REQUIRED_CLIPS) {
    if (!clipNames.has(name)) failures.push(`missing clip '${name}'`);
  }

  const config = ENEMY_ARCHETYPES[bot];
  if (!config?.proxyUrl?.endsWith(`${bot}-proxy.glb`)) {
    failures.push(`enemyArchetypes.${bot}.proxyUrl must point at ${bot}-proxy.glb`);
  }

  return { stats, failures };
}

function main() {
  console.log(`Verifying Horde proxy GLBs in ${HORDE_DIR}`);
  console.log(`Bake budget: ${MAX_PROXY_VERTS.toLocaleString()} verts  pose clips: ${[...REQUIRED_CLIPS].join(', ')}\n`);

  let allOk = true;
  for (const bot of BOTS) {
    const { stats, failures } = verifyProxy(bot);
    const ok = failures.length === 0;
    allOk = allOk && ok;
    if (stats.missing) {
      console.log(`✗ ${bot}: MISSING`);
    } else {
      console.log(
        `${ok ? '✓' : '✗'} ${bot}: verts=${stats.totalVerts.toLocaleString()} `
        + `clips=${stats.clips} size=${(stats.bytes / 1024).toFixed(0)}KB `
        + `mat=${stats.materials} tex=${stats.textures}`,
      );
    }
    for (const f of failures) console.log(`    FAIL: ${f}`);
  }

  console.log(`\n${allOk ? 'PASS: proxy GLBs ready for real robot instancing.' : 'FAIL: see above.'}`);
  process.exit(allOk ? 0 : 1);
}

main();
