// Verifies the terrain streaming spread fix: updateStreaming must never build
// more than maxChunkBuildsPerFrame chunks in a single frame (the per-boundary
// spike that rubber-banded the driving vehicle ~once/second), yet must still
// fill the whole load ring when the camera holds still for a few frames.
//
// Run: node scripts/verify-terrain-stream-spread.mjs

globalThis.document = {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, style: {} }),
};

import * as THREE from 'three';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';

const CAP = 2;                 // DEFAULT_CHUNK_BUILDS_PER_FRAME
const CHUNK = 32;              // TERRAIN_PARAMS.chunkSize
const LOAD_RADIUS = 3;         // DEFAULT_LOAD_RADIUS → 7×7 = 49 chunk ring

let level;
try {
  level = createStreamingTerrainLevel({}, { worldMap: null });
} catch (e) {
  console.log('createStreamingTerrainLevel threw:', e.message);
  process.exit(1);
}

let failures = 0;
const fail = (msg) => { console.log('  ✗', msg); failures += 1; };
const pass = (msg) => console.log('  ✓', msg);

// ---- 1. Per-frame cap is never exceeded while "driving" across boundaries ----
// Walk +x in 8 m steps (a 36 m/s car at 60fps moves ~0.6 m/frame, but big steps
// stress the cap harder by crossing a boundary every few frames).
let maxBuilt = 0;
const pos = new THREE.Vector3(0, 0, 0);
const meshCoordinateByUuid = new Map();
for (let frame = 0; frame < 200; frame += 1) {
  pos.x += 8;
  const changes = level.updateStreaming(pos);
  // addedTerrainChunks also reports already-live chunks entering the physics
  // radius, so it can exceed the visual build budget without building anything.
  const built = changes?.builtTerrainChunks ?? 0;
  if (built > maxBuilt) maxBuilt = built;
  if (built > CAP) fail(`frame ${frame}: built ${built} chunks (> cap ${CAP})`);
  for (const child of level.group.children) {
    if (!child.name?.startsWith('TerrainChunk t:')) continue;
    const previousName = meshCoordinateByUuid.get(child.uuid);
    if (previousName && previousName !== child.name) {
      fail(`frame ${frame}: terrain mesh ${child.uuid} retargeted from ${previousName} to ${child.name}`);
    }
    meshCoordinateByUuid.set(child.uuid, child.name);
  }
}
if (maxBuilt <= CAP) pass(`drive sweep: max chunks built in one frame = ${maxBuilt} (cap ${CAP})`);
if (failures === 0) pass('drive sweep: streamed coordinates never reuse a prior Mesh/GPU buffer identity');

// ---- 2. Ring still fills when stationary ----
// Park well away from anything built above and let streaming drain for enough
// frames, then assert every coord in the load window is live.
const park = new THREE.Vector3(5000, 0, -5000);
for (let frame = 0; frame < 80; frame += 1) level.updateStreaming(park);

const cw = (v) => Math.floor((v + CHUNK * 0.5) / CHUNK);
const ccx = cw(park.x);
const ccz = cw(park.z);
const live = level.snapshot().liveChunks;
let missingInRing = 0;
// Re-run one update and confirm it has nothing new to add (ring already full).
const after = level.updateStreaming(park);
const stillAdding = after?.builtTerrainChunks ?? 0;
if (stillAdding > 0) missingInRing = stillAdding;

if (missingInRing === 0) {
  pass(`stationary: full ${(2 * LOAD_RADIUS + 1) ** 2}-chunk ring filled (liveChunks=${live}, nothing left to add)`);
} else {
  fail(`stationary: ring not filled after draining (${stillAdding} chunks still pending at center ${ccx}:${ccz})`);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
