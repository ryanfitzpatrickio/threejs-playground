// Pure-node asset-contract verifier for the vendored vibe-human GLB.
//
// Guards the data contract that createVibeHumanModel + the sim character
// creator depend on (and that any future optimize-models.mjs pass must
// preserve):
//   - GLB parses and stays under the 25 MiB Cloudflare Pages file cap;
//   - the Rigify deform skeleton is intact (DEF-* bone count + named
//     sentinels used by the Mixamo->Rigify retarget map);
//   - the main mesh keeps its morph-target dictionary: FACS units
//     (browDownLeft, ...) and id.* modeling morphs with .pos/.neg pairs
//     referenced by MODELING_CONTROLS in src/vendor/vibe-human;
//   - exactly one skin, and no embedded images (textures ship as separate
//     files under public/assets/simhuman/textures/).
//
// Run:
//   node scripts/verify-simhuman-asset.mjs
//   node scripts/verify-simhuman-asset.mjs --path public/assets/simhuman/custom.glb
//   node scripts/verify-simhuman-asset.mjs --path out.glb --relaxed
//   npm run verify:simhuman-asset

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GLB = path.join(REPO_ROOT, 'public/assets/simhuman/human5.glb');

const MAX_BYTES = 25 * 1024 * 1024;

// Sentinel bones: one per limb chain the rigify retarget map + garment
// avatar-collision regions rely on.
const SENTINEL_BONES = [
  'DEF-spine', 'DEF-spine.006',
  'DEF-upper_arm.L', 'DEF-forearm.L.001', 'DEF-hand.L',
  'DEF-upper_arm.R', 'DEF-forearm.R.001', 'DEF-hand.R',
  'DEF-thigh.L', 'DEF-foot.L', 'DEF-thigh.R', 'DEF-foot.R',
];

// Sentinel morphs: FACS + modeling controls (positive/negative pair).
const SENTINEL_MORPHS = [
  'browDownLeft', 'jawOpen',
  'id.skull.browRidge.width.pos', 'id.skull.browRidge.width.neg',
  'id.body.global.mass.pos',
];

function parseArgs(argv) {
  let glbPath = DEFAULT_GLB;
  let relaxed = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--path' || a === '-p') {
      glbPath = path.resolve(argv[++i]);
    } else if (a === '--relaxed') {
      relaxed = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/verify-simhuman-asset.mjs [--path file.glb] [--relaxed]
  --relaxed  Lower DEF/morph thresholds for WIP prepare-simhuman outputs`);
      process.exit(0);
    }
  }
  return { glbPath, relaxed };
}

function parseGlbJson(filePath) {
  const buf = readFileSync(filePath);
  if (buf.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new Error('GLB magic mismatch');
  }
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) {
    throw new Error('first chunk is not JSON');
  }
  return { gltf: JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')), bytes: buf.length };
}

const { glbPath: GLB_PATH, relaxed } = parseArgs(process.argv.slice(2));
const EXPECTED_DEF_BONES = relaxed ? 40 : 163;
const MIN_MAIN_MESH_MORPHS = relaxed ? 1 : 217;
const requireExactDefCount = !relaxed;
const requireAllSentinelMorphs = !relaxed;
const requireSingleSkin = true;
const requireNoImages = !relaxed;

const { gltf, bytes } = parseGlbJson(GLB_PATH);
const failures = [];
const warnings = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const warn = (ok, msg) => { if (!ok) warnings.push(msg); };

check(bytes <= MAX_BYTES, `file size ${bytes} exceeds 25 MiB cap`);

const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name ?? ''));
const defCount = [...nodeNames].filter((n) => n.startsWith('DEF-')).length;
if (requireExactDefCount) {
  check(defCount === EXPECTED_DEF_BONES, `expected ${EXPECTED_DEF_BONES} DEF-* bones, found ${defCount}`);
} else {
  check(defCount >= EXPECTED_DEF_BONES, `expected ≥${EXPECTED_DEF_BONES} DEF-* bones, found ${defCount}`);
}
for (const bone of SENTINEL_BONES) {
  if (relaxed) warn(nodeNames.has(bone), `missing sentinel bone ${bone}`);
  else check(nodeNames.has(bone), `missing sentinel bone ${bone}`);
}

const skinCount = (gltf.skins ?? []).length;
if (requireSingleSkin) {
  check(skinCount === 1, `expected 1 skin, found ${skinCount}`);
} else {
  warn(skinCount === 1, `expected 1 skin, found ${skinCount}`);
}

const imageCount = (gltf.images ?? []).length;
if (requireNoImages) {
  check(imageCount === 0, 'expected no embedded images (textures are external files)');
} else {
  warn(imageCount === 0, `embedded images present (${imageCount}) — runtime prefers external textures`);
}

const morphNames = new Set();
let maxMeshMorphs = 0;
for (const mesh of gltf.meshes ?? []) {
  const targetNames = mesh.extras?.targetNames
    ?? mesh.primitives?.[0]?.extras?.targetNames
    ?? [];
  maxMeshMorphs = Math.max(maxMeshMorphs, targetNames.length);
  for (const name of targetNames) morphNames.add(name);
  // targetNames must stay in sync with the actual morph accessors.
  for (const prim of mesh.primitives ?? []) {
    const targets = prim.targets ?? [];
    if (targetNames.length > 0) {
      check(
        targets.length === targetNames.length,
        `mesh ${mesh.name}: ${targets.length} morph targets vs ${targetNames.length} targetNames`,
      );
    }
  }
}
check(
  maxMeshMorphs >= MIN_MAIN_MESH_MORPHS,
  `main mesh morph count ${maxMeshMorphs} < expected ${MIN_MAIN_MESH_MORPHS}`,
);
for (const morph of SENTINEL_MORPHS) {
  if (requireAllSentinelMorphs) check(morphNames.has(morph), `missing sentinel morph ${morph}`);
  else warn(morphNames.has(morph), `missing sentinel morph ${morph}`);
}

const label = path.relative(REPO_ROOT, GLB_PATH) || GLB_PATH;
if (failures.length > 0) {
  console.error(`verify-simhuman-asset: FAIL (${failures.length}) — ${label}${relaxed ? ' [relaxed]' : ''}`);
  for (const f of failures) console.error(`  - ${f}`);
  for (const w of warnings) console.warn(`  warn: ${w}`);
  process.exit(1);
}
if (warnings.length > 0) {
  for (const w of warnings) console.warn(`verify-simhuman-asset warn: ${w}`);
}
console.log(
  `verify-simhuman-asset: OK (${(bytes / 1024 / 1024).toFixed(1)} MiB, ${defCount} DEF bones, `
  + `${morphNames.size} unique morphs) — ${label}${relaxed ? ' [relaxed]' : ''}`,
);
