// Pure-node asset-contract verifier for the three Horde robot GLBs.
//
// Parses each GLB's glTF JSON chunk directly (no Draco decode, no three.js,
// no browser) and asserts the runtime contract that EnemySystem +
// soldierPartialCut.js depend on:
//   - all 13 expected clip names present, each with >=1 channel (non-empty);
//   - every bone in REGION_SEVERANCE_BONES + hips/spine1 resolves on the
//     skeleton (normalized like normalizeMixamoBoneName);
//   - no primitive uses JOINTS_1 / WEIGHTS_1 (i.e. <=4 skin influences/vertex);
//   - rendered vertices <= 50k per bot;
//   - file size <= 8 MB.
//
// This is the data-layer guard for M0's "clip/bone/weight/size checks" exit
// gate. The "representative cut within frame budget" gate is a runtime/browser
// measurement (headless can't measure frame hitches — see CLAUDE.md) and is
// covered by a browser smoke check + M4's verify-horde-cut.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const HORDE_DIR = path.join(REPO_ROOT, 'public/assets/models/horde');
const BOTS = ['cyclop', 'tessy', 'faceless'];

const MAX_VERTS = 50000;
const MAX_BYTES = 8 * 1024 * 1024;

// Clip names the runtime expects. Rifle-pack (5) + disability-pack (8), matching
// SOLDIER_LOCOMOTION_CLIPS + the rifle Idle/Walk/Run/Idle Alert/Bite contract.
const EXPECTED_CLIPS = new Set([
  'Idle', 'Walk', 'Run', 'Idle Alert', 'Bite',
  'Head Missing', 'Head Missing 2',
  'Left Arm Missing Walk', 'Right Arm Missing Walk',
  'Left Leg Missing', 'Right Leg Missing',
  'Crawl Forward', 'Crawl Back',
]);

// Mirrors soldierPartialCut.js REGION_SEVERANCE_BONES (+ torso bones the file
// reads via bones.get). Normalized: mixamorig prefix stripped, lowercased.
const REQUIRED_REGION = {
  head: ['headtop_end', 'head', 'neck'],
  armL: ['lefthand', 'leftforearm', 'leftarm', 'leftshoulder'],
  armR: ['righthand', 'rightforearm', 'rightarm', 'rightshoulder'],
  legL: ['lefttoe_end', 'lefttoebase', 'leftfoot', 'leftleg', 'leftupleg'],
  legR: ['righttoe_end', 'righttoebase', 'rightfoot', 'rightleg', 'rightupleg'],
  torso: ['hips', 'spine1', 'spine'],
};
const REQUIRED_BONES = new Set(
  Object.values(REQUIRED_REGION).flat(),
);

// Match normalizeMixamoBoneName in soldierPartialCut.js.
function normalizeBoneName(name) {
  return String(name).replace(/^mixamorig\d*:?/, '').toLowerCase();
}

// Minimal GLB parser: header (12 bytes) + JSON chunk + (optional) BIN chunk.
function parseGltfJson(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 12) throw new Error(`${filePath}: too small to be a GLB`);
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  assert.equal(magic, 0x46546c67, `${filePath}: bad GLB magic`);
  assert.equal(version, 2, `${filePath}: unsupported GLB version ${version}`);

  // First chunk (JSON).
  let offset = 12;
  const chunk0Len = buf.readUInt32LE(offset);
  const chunk0Type = buf.readUInt32LE(offset + 4);
  assert.equal(chunk0Type, 0x4e4f534a, `${filePath}: first chunk is not JSON`);
  const jsonStr = buf.subarray(offset + 8, offset + 8 + chunk0Len).toString('utf8');
  const json = JSON.parse(jsonStr);

  // Collect BIN chunk(s) for image byte-size reporting.
  offset += 8 + chunk0Len;
  const binChunks = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) { // 'BIN\0'
      binChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 8 + len;
    // chunks are 4-byte aligned
    if (offset % 4 !== 0) offset += 4 - (offset % 4);
  }
  return { json, totalBytes: buf.length, bin: Buffer.concat(binChunks) };
}

function verifyBot(bot) {
  const filePath = path.join(HORDE_DIR, `${bot}.glb`);
  const { json, totalBytes } = parseGltfJson(filePath);
  const failures = [];
  const stats = { bot, clips: 0, bones: 0, verts: 0, materials: 0, textures: 0, bytes: totalBytes };

  // --- file size ---
  if (totalBytes > MAX_BYTES) {
    failures.push(`file size ${(totalBytes / 1024 / 1024).toFixed(2)} MB > 8 MB`);
  }

  // --- clips: names present + non-empty (>=1 channel) ---
  const anims = json.animations ?? [];
  const clipByName = new Map(anims.map((a) => [a.name, a]));
  for (const name of EXPECTED_CLIPS) {
    const a = clipByName.get(name);
    if (!a) { failures.push(`missing clip '${name}'`); continue; }
    const channels = a.channels ?? [];
    if (channels.length === 0) {
      failures.push(`clip '${name}' has 0 channels (empty animation)`);
    }
  }
  // Report any unexpected clips (informational).
  const extra = anims.map((a) => a.name).filter((n) => !EXPECTED_CLIPS.has(n));
  stats.clips = anims.length;
  stats.extraClips = extra;

  // --- bones: every required region bone resolves on the skeleton ---
  const nodeNames = (json.nodes ?? []).map((n) => n?.name ?? '').filter(Boolean);
  const normalized = new Set(nodeNames.map(normalizeBoneName));
  const missingBones = [...REQUIRED_BONES].filter((b) => !normalized.has(b));
  if (missingBones.length) {
    failures.push(`missing required bones: ${missingBones.join(', ')}`);
  }
  // Confirm at least one skin exists and its joints cover the required set.
  const skins = json.skins ?? [];
  if (skins.length === 0) {
    failures.push('no skin in glTF (unsinneded mesh?)');
  } else {
    const jointNodeIds = new Set();
    for (const s of skins) for (const j of s.joints ?? []) jointNodeIds.add(j);
    const jointNames = [...jointNodeIds].map((i) => json.nodes?.[i]?.name ?? '').filter(Boolean);
    const jointNorm = new Set(jointNames.map(normalizeBoneName));
    const missingInSkin = [...REQUIRED_BONES].filter((b) => !jointNorm.has(b));
    if (missingInSkin.length) {
      failures.push(`required bones not in skin joints: ${missingInSkin.join(', ')}`);
    }
    stats.bones = jointNodeIds.size;
  }

  // --- weights <=4 per vertex: no JOINTS_1 / WEIGHTS_1 attribute ---
  // --- vert count from POSITION accessor ---
  const accessors = json.accessors ?? [];
  let maxVerts = 0;
  let over4 = false;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const attrs = prim.attributes ?? {};
      if ('JOINTS_1' in attrs || 'WEIGHTS_1' in attrs) {
        over4 = true;
        failures.push(`mesh '${mesh.name}' primitive has JOINTS_1/WEIGHTS_1 (>4 influences)`);
      }
      const posIdx = attrs.POSITION;
      if (posIdx != null && accessors[posIdx]) {
        const c = accessors[posIdx].count ?? 0;
        if (c > maxVerts) maxVerts = c;
      }
    }
  }
  stats.verts = maxVerts;
  if (over4 === false && (json.meshes ?? []).length === 0) {
    failures.push('no meshes in glTF');
  }
  if (maxVerts > MAX_VERTS) {
    failures.push(`verts ${maxVerts.toLocaleString()} > ${MAX_VERTS.toLocaleString()}`);
  }

  // --- textures (informational; build caps to 1024px) ---
  const images = json.images ?? [];
  stats.textures = images.length;
  stats.materials = (json.materials ?? []).length;

  return { stats, failures };
}

function main() {
  console.log(`Verifying Horde GLBs in ${HORDE_DIR}\n`);
  let allOk = true;
  const rows = [];
  for (const bot of BOTS) {
    let result;
    try {
      result = verifyBot(bot);
    } catch (err) {
      console.error(`✗ ${bot}: ${err.message}`);
      allOk = false;
      continue;
    }
    const { stats, failures } = result;
    rows.push(stats);
    const ok = failures.length === 0;
    allOk = allOk && ok;
    console.log(`${ok ? '✓' : '✗'} ${bot}: clips=${stats.clips} bones=${stats.bones} verts=${stats.verts.toLocaleString()} tex=${stats.textures} mat=${stats.materials} size=${(stats.bytes / 1024 / 1024).toFixed(2)}MB${stats.extraClips?.length ? ` extraClips=[${stats.extraClips.join(',')}]` : ''}`);
    for (const f of failures) console.log(`    FAIL: ${f}`);
  }

  console.log('\n' + (allOk ? 'PASS: all three Horde GLBs meet the asset contract.' : 'FAIL: see above.'));
  process.exit(allOk ? 0 : 1);
}

main();
