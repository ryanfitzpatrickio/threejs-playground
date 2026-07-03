// Regression test for the sidewalk-streaming bug.
//
// Streamed city chunks are built in a Web Worker, serialized to a payload, then rebuilt on
// the main thread. The sidewalks (a raised slab + curb) are InstancedMeshes — one instance
// per block, with each block's placement stored in `instanceMatrix`. The bug: the serializer
// dropped `instanceMatrix` and the rebuilder reconstructed every mesh as a plain THREE.Mesh,
// so each streamed chunk's N sidewalk slabs collapsed onto a single mesh at the chunk's city
// center (and wore a flat fallback material). The starting chunk (0:0) is built directly on
// the main thread, so only streamed chunks were affected.
//
// This test exercises the exact worker round-trip (build -> serialize -> rebuild) in Node and
// asserts the slab/curb survive as InstancedMeshes with their per-block placements intact.
import * as THREE from 'three';

const mod = await import(new URL('../src/game/world/createGeneratorCityLevel.js', import.meta.url));
const { createGeneratorCityLevel, serializeGeneratorCityChunk, createGeneratorCityChunkFromPayload } = mod;

// A non-zero origin, like a real streamed neighbor chunk (chunk 0:0 is built directly).
const ORIGIN_X = 120;
const ORIGIN_Z = -80;

const original = createGeneratorCityLevel({
  seed: 1,
  chunkKey: '1:-1',
  chunkX: 1,
  chunkZ: -1,
  originX: ORIGIN_X,
  originZ: ORIGIN_Z,
  includeDebugOverlay: false,
});

original.group.updateMatrixWorld(true);

function findSidewalkInstanced(group) {
  const found = {};
  group.traverse((object) => {
    if (object.isInstancedMesh && (object.name === 'Sidewalk Slab' || object.name === 'Sidewalk Curb')) {
      found[object.name] = object;
    }
  });
  return found;
}

function instanceWorldTranslations(mesh) {
  const out = [];
  const m = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i += 1) {
    mesh.getMatrixAt(i, m);
    worldMatrix.multiplyMatrices(mesh.matrixWorld, m);
    out.push(new THREE.Vector3().setFromMatrixPosition(worldMatrix));
  }
  return out;
}

const originalSidewalks = findSidewalkInstanced(original.group);
const payload = serializeGeneratorCityChunk(original);
const rebuilt = createGeneratorCityChunkFromPayload(payload);
rebuilt.group.updateMatrixWorld(true);
const rebuiltSidewalks = findSidewalkInstanced(rebuilt.group);

let failures = 0;
function check(label, condition, detail = '') {
  const tag = condition ? 'ok' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('== payload sidewalk meshes ==');
for (const mesh of payload.meshes) {
  if (mesh.instanced) {
    console.log(`  ${mesh.name}: instanced count=${mesh.count} instanceMatrix=${mesh.instanceMatrix?.length ?? 0} floats`);
  }
}

console.log('\n== rebuilt sidewalk InstancedMeshes ==');
console.log(`  original slab count=${originalSidewalks['Sidewalk Slab']?.count}, curb count=${originalSidewalks['Sidewalk Curb']?.count}`);
console.log(`  rebuilt  slab count=${rebuiltSidewalks['Sidewalk Slab']?.count}, curb count=${rebuiltSidewalks['Sidewalk Curb']?.count}`);

for (const name of ['Sidewalk Slab', 'Sidewalk Curb']) {
  const orig = originalSidewalks[name];
  const reb = rebuiltSidewalks[name];

  check(`${name} present in original`, Boolean(orig));
  check(`${name} present in rebuilt`, Boolean(reb));

  if (!orig || !reb) continue;

  check(`${name} is InstancedMesh on rebuild`, reb.isInstancedMesh === true);
  check(`${name} instance count preserved`, reb.count === orig.count, `rebuilt=${reb.count} original=${orig.count}`);

  // Per-instance placements must round-trip exactly.
  const origArr = orig.instanceMatrix.array;
  const rebArr = reb.instanceMatrix.array;
  let matricesMatch = origArr.length === rebArr.length;
  for (let i = 0; matricesMatch && i < origArr.length; i += 1) {
    if (origArr[i] !== rebArr[i]) matricesMatch = false;
  }
  check(`${name} instanceMatrix round-trips exactly`, matricesMatch);

  // The mesh's own world placement must round-trip (carries the chunk origin offset).
  check(`${name} mesh world matrix round-trips`, reb.matrixWorld.equals(orig.matrixWorld));

  // End-to-end: each block's slab/curb must land at the same world position as the original.
  const origPts = instanceWorldTranslations(orig);
  const rebPts = instanceWorldTranslations(reb);
  let worst = 0;
  for (let i = 0; i < origPts.length; i += 1) {
    worst = Math.max(worst, origPts[i].distanceTo(rebPts[i] ?? new THREE.Vector3(Infinity, 0, 0)));
  }
  check(`${name} per-block world placements match (worst ${worst.toFixed(4)}m)`, worst < 1e-4);

  for (let i = 0; i < origPts.length; i += 1) {
    console.log(`    block ${i}: (${origPts[i].x.toFixed(2)}, ${origPts[i].z.toFixed(2)})`);
  }
}

// And a positive assertion that the slabs are NOT all collapsed to one point (the bug's signature).
const slab = rebuiltSidewalks['Sidewalk Slab'];
if (slab) {
  const pts = instanceWorldTranslations(slab);
  const unique = new Set(pts.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
  check(`slab instances occupy ${unique.size} distinct block positions (not collapsed)`, unique.size === pts.length, `[...${[...unique].join(' ')}]`);
}

if (failures > 0) {
  console.log(`\nRESULT: FAIL (${failures} check(s) failed)`);
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS — sidewalk InstancedMeshes round-trip with per-block placements intact.');
}

original.dispose?.();
rebuilt.dispose?.();
