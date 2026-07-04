// verify-office-entry.mjs
//
// P0 of docs/office-interior-wfc-plan.md: the pure "walk up to any building and
// enter" geometry (nearest building + auto-door on the facing facade) and the
// placeholder interior level factory. Node-only — proves the door math and that
// the interior builds and exposes the level interface the runtime consumes.
// (The enter/exit runtime swap + HUD is browser-verified separately.)
//
// Run: node scripts/verify-office-entry.mjs  (or npm run verify:office-entry)

import * as THREE from 'three';
import {
  distanceToAabbXZ,
  isEnterableBuilding,
  findNearestEnterableBuilding,
  computeDoorAnchor,
  isFacingDoor,
} from '../src/game/world/office/buildingEntry.js';
import { createOfficeInteriorLevel } from '../src/game/world/office/createOfficeInteriorLevel.js';
import { BuildingEntrySystem } from '../src/game/systems/BuildingEntrySystem.js';
import { generateOfficeLayout } from '../src/game/world/office/generateOfficeLayout.js';
import { createOfficeWallMaterial } from '../src/game/world/office/officeWallMaterial.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A 16×16 building, 30 m tall, centred at origin.
const building = { name: 'B', minX: -8, maxX: 8, minZ: -8, maxZ: 8, bottomY: 0, topY: 30 };
const tiny = { name: 'prop', minX: 0, maxX: 1, minZ: 0, maxZ: 1, bottomY: 0, topY: 1 };

// --- distance + classification ---
if (near(distanceToAabbXZ({ x: 0, z: 12 }, building), 4)) ok('distanceToAabbXZ outside → edge distance');
else fail('distanceToAabbXZ outside', String(distanceToAabbXZ({ x: 0, z: 12 }, building)));
if (near(distanceToAabbXZ({ x: 0, z: 0 }, building), 0)) ok('distanceToAabbXZ inside → 0');
else fail('distanceToAabbXZ inside');

if (isEnterableBuilding(building)) ok('big box is enterable');
else fail('big box is enterable');
if (!isEnterableBuilding(tiny)) ok('tiny prop is not enterable');
else fail('tiny prop is not enterable');

// --- nearest building within range ---
const nearest = findNearestEnterableBuilding({ colliders: [tiny, building], position: { x: 0, z: 12 }, range: 6 });
if (nearest && nearest.building === building && near(nearest.distance, 4)) ok('findNearestEnterableBuilding picks the reachable big box');
else fail('findNearestEnterableBuilding', JSON.stringify(nearest?.distance));
const outOfRange = findNearestEnterableBuilding({ colliders: [building], position: { x: 0, z: 40 }, range: 6 });
if (outOfRange === null) ok('findNearestEnterableBuilding returns null out of range');
else fail('findNearestEnterableBuilding out of range');

// --- door anchor on the facing facade ---
const door = computeDoorAnchor({ building, position: { x: 0, z: 12 }, groundY: 0 });
if (door.facade === 'PZ') ok('door lands on the facade facing the player (PZ)');
else fail('door facade', door.facade);
if (near(door.anchor.z, 8) && near(door.anchor.x, 0)) ok('door anchor sits on the facade plane, centred to player');
else fail('door anchor position', JSON.stringify(door.anchor));
if (door.inwardNormal.x === 0 && door.inwardNormal.z === -1) ok('inward normal points into the building');
else fail('inward normal', JSON.stringify(door.inwardNormal));

// Player beyond a corner → door clamped off the corner by edgeMargin.
const corner = computeDoorAnchor({ building, position: { x: 40, z: 40 }, groundY: 0, edgeMargin: 1.2 });
if (corner.facade === 'PX' || corner.facade === 'PZ') ok('corner approach still resolves to a side');
else fail('corner facade', corner.facade);
const clampedOk = corner.facade === 'PX'
  ? near(corner.anchor.z, 8 - 1.2)
  : near(corner.anchor.x, 8 - 1.2);
if (clampedOk) ok('door is kept off the corner by edgeMargin');
else fail('door corner clamp', JSON.stringify(corner.anchor));

// --- facing test ---
if (isFacingDoor({ x: 0, z: -1 }, door.inwardNormal)) ok('isFacingDoor true when walking into the door');
else fail('isFacingDoor toward');
if (!isFacingDoor({ x: 0, z: 1 }, door.inwardNormal)) ok('isFacingDoor false when walking away');
else fail('isFacingDoor away');

// --- placeholder interior factory ---
const level = createOfficeInteriorLevel({ width: 16, depth: 16, doorFacade: 'NZ', origin: { x: 0, y: 5, z: 0 } });
if (level.group && level.group.isObject3D) ok('interior builds a group');
else fail('interior group');

// floor + 3 solid perimeter walls + 2 door segments (+ WFC partitions) ≥ 6.
const wallNZ = level.colliders.filter((c) => c.name.startsWith('Office Wall NZ'));
if (level.colliders.length >= 6) ok('interior has floor + perimeter + partition colliders (>= 6)');
else fail('interior collider count', String(level.colliders.length));
if (wallNZ.length === 2) ok('door facade wall is split into two segments (a gap)');
else fail('door facade split', String(wallNZ.length));

const g = level.getGroundHeightAt({ x: 0, y: 6.5, z: 0 });
if (near(g, 5, 0.5)) ok('getGroundHeightAt returns the interior floor height');
else fail('interior ground height', String(g));

const b = level.interiorBounds;
const sp = level.spawnPoint;
if (sp.x >= b.minX && sp.x <= b.maxX && sp.z >= b.minZ && sp.z <= b.maxZ && near(sp.y, b.floorY)) ok('spawn point sits inside the room on the floor');
else fail('spawn point', JSON.stringify(sp));

let disposed = true;
try { level.dispose(); } catch (e) { disposed = false; fail('interior dispose', e.message); }
if (disposed) ok('interior disposes cleanly');

// --- BuildingEntrySystem wiring (flat-collider fallback, no camera) ---
const entrySystem = new BuildingEntrySystem();
const fakeLevel = { colliders: [tiny, building], colliderIndex: null };

const nearState = entrySystem.update({ level: fakeLevel, position: new THREE.Vector3(0, 0, 10) });
if (nearState.prompt === true && nearState.building === building) ok('BuildingEntrySystem raises prompt near a building');
else fail('BuildingEntrySystem near', JSON.stringify(entrySystem.snapshot()));

const farState = entrySystem.update({ level: fakeLevel, position: new THREE.Vector3(0, 0, 60) });
if (farState.prompt === false) ok('BuildingEntrySystem clears prompt when far away');
else fail('BuildingEntrySystem far');

const disabledState = entrySystem.update({ level: fakeLevel, position: new THREE.Vector3(0, 0, 10), enabled: false });
if (disabledState.prompt === false) ok('BuildingEntrySystem stays silent when disabled (driving/mounted)');
else fail('BuildingEntrySystem disabled');

const snap = entrySystem.snapshot();
if (typeof snap.prompt === 'boolean' && 'distance' in snap && 'facade' in snap) ok('BuildingEntrySystem.snapshot has the HUD fields');
else fail('BuildingEntrySystem snapshot shape', JSON.stringify(snap));

// --- exit trigger is valid on ALL facades (PZ/PX had a zero-width collapse) ---
for (const facade of ['NZ', 'PZ', 'NX', 'PX']) {
  const lvl = createOfficeInteriorLevel({ width: 16, depth: 16, doorFacade: facade, origin: { x: 0, y: 0, z: 0 } });
  const t = lvl.exitTrigger;
  const nonDegenerate = t.maxX > t.minX && t.maxZ > t.minZ;
  if (nonDegenerate) ok(`exit trigger is non-degenerate on facade ${facade}`);
  else fail(`exit trigger non-degenerate ${facade}`, JSON.stringify(t));
  // Spawn should sit inside the exit zone so the prompt shows on entry.
  const sp = lvl.spawnPoint;
  const spawnInside = sp.x >= t.minX && sp.x <= t.maxX && sp.z >= t.minZ && sp.z <= t.maxZ;
  if (spawnInside) ok(`spawn is inside the exit zone on facade ${facade}`);
  else fail(`spawn inside exit zone ${facade}`, `spawn=${JSON.stringify(sp)} trigger=${JSON.stringify(t)}`);
}

// --- WFC office layout (P1) ---
const ROOMS = new Set(['meeting', 'office']);
function roomOpenViolations(L) {
  let bad = 0;
  for (let x = 0; x < L.cols; x += 1) {
    for (let z = 0; z < L.rows; z += 1) {
      const a = L.zones[x][z];
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const nx = x + dx; const nz = z + dz;
        if (nx >= L.cols || nz >= L.rows) continue;
        const b = L.zones[nx][nz];
        if ((ROOMS.has(a) && b === 'open') || (ROOMS.has(b) && a === 'open')) bad += 1;
      }
    }
  }
  return bad;
}

let wfcAllSolved = true;
let wfcViolations = 0;
let sawWalls = false;
for (let s = 1; s <= 20; s += 1) {
  const L = generateOfficeLayout({ width: 40, depth: 30, doorFacade: 'NZ', seed: s });
  if (!L.solved) wfcAllSolved = false;
  wfcViolations += roomOpenViolations(L);
  if (L.walls.length > 0) sawWalls = true;
}
if (wfcAllSolved) ok('WFC solves without contradiction across 20 seeds');
else fail('WFC solves across seeds');
if (wfcViolations === 0) ok('WFC respects sockets — no room cell adjacent to open (20 seeds)');
else fail('WFC socket adjacency', `${wfcViolations} room↔open violations`);
if (sawWalls) ok('WFC produces interior partition walls (rooms are carved)');
else fail('WFC produces partition walls');

// Every partition wall is tagged with its enclosed room zone (glass vs solid).
const taggedOk = [1, 2, 3].every((s) => {
  const L = generateOfficeLayout({ width: 40, depth: 30, seed: s });
  return L.walls.every((w) => ROOMS.has(w.zone));
});
if (taggedOk) ok('partition walls are tagged with their room zone (meeting→glass / office→solid)');
else fail('partition wall zone tags');

const la = generateOfficeLayout({ width: 40, depth: 30, seed: 7 });
const lb = generateOfficeLayout({ width: 40, depth: 30, seed: 7 });
if (JSON.stringify(la.zones) === JSON.stringify(lb.zones) && JSON.stringify(la.walls) === JSON.stringify(lb.walls)) {
  ok('WFC layout is deterministic (seed → identical zones + walls)');
} else fail('WFC determinism');
const lc = generateOfficeLayout({ width: 40, depth: 30, seed: 8 });
if (JSON.stringify(la.zones) !== JSON.stringify(lc.zones)) ok('different seeds give different layouts');
else fail('WFC seed variation');

// The interior factory now includes the WFC partitions → more than the 6 box colliders.
const bigInterior = createOfficeInteriorLevel({ width: 40, depth: 30, doorFacade: 'NZ', origin: { x: 0, y: 0, z: 0 }, seed: 7 });
if (bigInterior.colliders.length > 6) ok('interior factory adds WFC partition colliders');
else fail('interior partition colliders', String(bigInterior.colliders.length));

// --- POM wall material (P2) ---
try {
  const wallMat = createOfficeWallMaterial({ parallaxOcclusion: { enabled: true, scale: 0.03 } });
  if (wallMat.colorNode != null && wallMat.normalNode != null && wallMat.roughnessNode != null) {
    ok('POM wall material builds and assigns colour/normal/roughness nodes');
  } else fail('POM wall material nodes', 'a slot is unset');
} catch (err) {
  fail('POM wall material builds', err.message);
}
// Wall geometry is an indexed box with uv → tangents compute (POM needs them).
try {
  const box = new THREE.BoxGeometry(2, 3, 0.2);
  box.computeTangents();
  const tangent = box.getAttribute('tangent');
  if (tangent && tangent.itemSize === 4) ok('wall box geometry computes tangents for POM');
  else fail('wall box tangents', 'no vec4 tangent attribute');
} catch (err) {
  fail('wall box tangents', err.message);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll office-entry P0 checks passed.');
