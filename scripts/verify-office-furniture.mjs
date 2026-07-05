// verify-office-furniture.mjs — P3 + fidelity-2 furniture/prop checks.
// Run: npm run verify:office-furniture

import { generateOfficeLayout, buildDoorClearanceSet, doorMountFrame } from '../src/game/world/office/generateOfficeLayout.js';
import { OFFICE_FLOOR_FINISH_OFFSET, placeOfficeFurniture } from '../src/game/world/office/officeFurniture.js';
import { createOfficeInteriorLevel } from '../src/game/world/office/createOfficeInteriorLevel.js';
import { getOfficeAccentHex, getOfficeAccentIndex } from '../src/game/world/office/officePalette.js';
import { createMonitorScreenMaterial } from '../src/game/world/office/officeMonitorScreen.js';
import { placeOfficeProps } from '../src/game/world/office/officeProps.js';
import { getOfficeRoomPlatePlacements } from '../src/game/world/office/officeSignage.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

const width = 40;
const depth = 30;
const seed = 7;
const layout = generateOfficeLayout({ width, depth, seed });
const originMinX = -width / 2;
const originMinZ = -depth / 2;
const floorY = 0;
const exitTrigger = { minX: -2, maxX: 2, minZ: -16, maxZ: -12 };

const a = placeOfficeFurniture({
  layout, seed, originMinX, originMinZ, floorY, cw: layout.cellW, cd: layout.cellD,
  exitTrigger, entryCell: layout.entryCell,
});
const b = placeOfficeFurniture({
  layout, seed, originMinX, originMinZ, floorY, cw: layout.cellW, cd: layout.cellD,
  exitTrigger, entryCell: layout.entryCell,
});

const matKey = (matrices) => matrices.map((m) => [...m.elements].join(','));

if (matKey(a.deskMatrices).join('|') === matKey(b.deskMatrices).join('|')) ok('furniture matrices deterministic');
else fail('furniture determinism');

if (a.taskChairMatrices.length === a.deskMatrices.length) ok('desk↔chair pairing count matches');
else fail('desk chair pairing', `${a.deskMatrices.length} desks vs ${a.taskChairMatrices.length} chairs`);

const blobExpected = a.deskMatrices.length + a.tableMatrices.length
  + a.sofa2Matrices.length + a.sofa3Matrices.length + a.coffeeTableMatrices.length + a.plantMatrices.length;
if (a.blobEntries.length === blobExpected) ok('blob shadow count matches furniture footprint set');
else fail('blob shadow count', `${a.blobEntries.length} vs expected ${blobExpected}`);

if (a.deskPlainMatrices.length + a.deskVariantMatrices.length === a.deskMatrices.length) ok('desk variant split sums to desk total');
else fail('desk variant split');

const variantA = a.deskVariantMatrices.length;
const variantB = b.deskVariantMatrices.length;
if (variantA === variantB) ok('desk variant split deterministic');
else fail('desk variant determinism', `${variantA} vs ${variantB}`);

const interiorMinX = originMinX;
const interiorMaxX = originMinX + width;
const interiorMinZ = originMinZ;
const interiorMaxZ = originMinZ + depth;
let blobOutOfBounds = 0;
for (const { matrix } of a.blobEntries) {
  const px = matrix.elements[12];
  const pz = matrix.elements[14];
  if (px < interiorMinX || px > interiorMaxX || pz < interiorMinZ || pz > interiorMaxZ) blobOutOfBounds += 1;
}
if (blobOutOfBounds === 0) ok('blob shadows inside interior bounds');
else fail('blob bounds', `${blobOutOfBounds} outside`);

try {
  const screenMat = createMonitorScreenMaterial();
  if (screenMat.userData.officeMonitorScreen) ok('monitor screen material builds');
  else fail('monitor screen material');
} catch (err) {
  fail('monitor screen material', err.message);
}

const accent7 = getOfficeAccentHex(7);
const accent7b = getOfficeAccentHex(7);
const accent8 = getOfficeAccentHex(8);
if (accent7 === accent7b) ok('accent color deterministic per seed');
else fail('accent determinism');
if (accent7 !== accent8) ok('different seeds → different accent colors');
else fail('accent variation');

if (getOfficeAccentIndex(7) === getOfficeAccentIndex(7)) ok('accent index stable');
else fail('accent index');

if (a.colliders.length > 0) ok('furniture emits colliders for desk/table/sofa');
else fail('furniture colliders');

const level = createOfficeInteriorLevel({ width, depth, seed, floorCount: 2 });
if (level.floorCount === 2) ok('interior accepts multi-floor count');
else fail('floorCount', String(level.floorCount));
const extra = level.buildFloor(1);
if (extra.length > 0) ok('lazy floor build returns new colliders');
else fail('lazy floor build colliders');
if (level.builtFloors.has(1)) ok('floor 1 marked built after lazy build');
else fail('floor 1 built flag');

const layoutA = generateOfficeLayout({ width, depth, seed: 11, buildingSeed: 99, floorIndex: 0 });
const layoutB = generateOfficeLayout({ width, depth, seed: 22, buildingSeed: 99, floorIndex: 1 });
if (layoutA.elevatorCell.x === layoutB.elevatorCell.x && layoutA.elevatorCell.z === layoutB.elevatorCell.z) {
  ok('elevator core at identical grid coords on every floor');
} else fail('elevator core alignment');
if (layoutA.elevatorLobby?.gx === layoutB.elevatorLobby?.gx
  && layoutA.elevatorLobby?.gz === layoutB.elevatorLobby?.gz) {
  ok('elevator lobby at identical grid coords on every floor');
} else fail('elevator lobby alignment');

if (layoutA.doorEdges?.length > 0) ok('layout returns door edges for signage');
else fail('door edges');

const doorBlocked = buildDoorClearanceSet(layout.doorEdges ?? [], 1);
const meetingDoors = layout.doorEdges.filter((d) => d.zone === 'meeting');
if (meetingDoors.length === 0 || layout.zones.flat().includes('meeting')) ok('meeting zones available for TV placement check');
else fail('meeting zones');

// Placement-rule audit across varied WFC footprints/seeds.
const matrixPosition = (matrix) => ({ x: matrix.elements[12], y: matrix.elements[13], z: matrix.elements[14] });
let zoneViolations = 0;
let groundingViolations = 0;
let doorClearanceViolations = 0;
let ceilingViolations = 0;
let unsupportedWallDecor = 0;
let doorDecorOverlaps = 0;
let roomPlateViolations = 0;
let exitClearanceViolations = 0;
let sawCorridorPlant = false;
for (let auditSeed = 1; auditSeed <= 40; auditSeed += 1) {
  const auditWidth = 24 + (auditSeed % 4) * 4;
  const auditDepth = 20 + (auditSeed % 3) * 5;
  const facade = ['NZ', 'PZ', 'NX', 'PX'][auditSeed % 4];
  const L = generateOfficeLayout({ width: auditWidth, depth: auditDepth, doorFacade: facade, seed: auditSeed });
  const minX = -auditWidth * 0.5;
  const minZ = -auditDepth * 0.5;
  const blocked = buildDoorClearanceSet(L.doorEdges ?? [], 1);
  const doorHalf = 2.4 * 0.5 + 0.8;
  const auditExit = facade === 'NZ' ? { minX: -doorHalf, maxX: doorHalf, minZ: minZ - 0.5, maxZ: minZ + 2.2 }
    : facade === 'PZ' ? { minX: -doorHalf, maxX: doorHalf, minZ: minZ + auditDepth - 2.2, maxZ: minZ + auditDepth + 0.5 }
      : facade === 'NX' ? { minX: minX - 0.5, maxX: minX + 2.2, minZ: -doorHalf, maxZ: doorHalf }
        : { minX: minX + auditWidth - 2.2, maxX: minX + auditWidth + 0.5, minZ: -doorHalf, maxZ: doorHalf };
  const F = placeOfficeFurniture({
    layout: L,
    seed: auditSeed,
    originMinX: minX,
    originMinZ: minZ,
    floorY: 0,
    cw: L.cellW,
    cd: L.cellD,
    exitTrigger: auditExit,
    entryCell: L.entryCell,
  });
  const cellAt = (matrix) => {
    const p = matrixPosition(matrix);
    const gx = Math.max(0, Math.min(L.cols - 1, Math.floor((p.x - minX) / L.cellW)));
    const gz = Math.max(0, Math.min(L.rows - 1, Math.floor((p.z - minZ) / L.cellD)));
    return { gx, gz, zone: L.zones[gx][gz], p };
  };
  const checkSet = (matrices, allowed, grounded = true) => {
    for (const matrix of matrices) {
      const hit = cellAt(matrix);
      if (!allowed.has(hit.zone)) zoneViolations += 1;
      if (grounded && Math.abs(hit.p.y - OFFICE_FLOOR_FINISH_OFFSET) > 1e-5) groundingViolations += 1;
      if (blocked.has(`${hit.gx},${hit.gz}`)) doorClearanceViolations += 1;
    }
  };
  checkSet(F.deskMatrices, new Set(['office']));
  checkSet(F.taskChairMatrices, new Set(['office']));
  checkSet(F.tableMatrices, new Set(['meeting']));
  checkSet(F.meetingChairMatrices, new Set(['meeting']));
  checkSet([...F.sofa2Matrices, ...F.sofa3Matrices, ...F.coffeeTableMatrices], new Set(['open']));
  checkSet(F.plantMatrices, new Set(['open', 'corridor']));
  for (const matrix of F.plantMatrices) if (cellAt(matrix).zone === 'corridor') sawCorridorPlant = true;
  for (const collider of F.colliders) {
    const overlapsExit = collider.maxX > auditExit.minX && collider.minX < auditExit.maxX
      && collider.maxZ > auditExit.minZ && collider.minZ < auditExit.maxZ;
    if (overlapsExit) exitClearanceViolations += 1;
  }

  const trofferKeys = new Set();
  for (let gx = 0; gx < L.cols; gx += 2) {
    for (let gz = 0; gz < L.rows; gz += 2) trofferKeys.add(`${gx},${gz}`);
  }
  const ceilY = 3.2;
  const P = placeOfficeProps({
    layout: L,
    seed: auditSeed,
    originMinX: minX,
    originMinZ: minZ,
    floorY: 0,
    ceilY,
    cw: L.cellW,
    cd: L.cellD,
    trofferKeys,
  });
  for (const matrix of [...P.ventMatrices, ...P.sprinklerMatrices, ...P.detectorMatrices]) {
    const hit = cellAt(matrix);
    if (hit.zone === 'elevator' || hit.p.y < ceilY - 0.14 || hit.p.y > ceilY + 0.02) ceilingViolations += 1;
    if (trofferKeys.has(`${hit.gx},${hit.gz}`)) ceilingViolations += 1;
  }
  const wallSegments = L.walls.map((wall) => ({
    cx: wall.cx,
    cz: wall.cz,
    sx: wall.sx,
    sz: wall.sz,
  }));
  const supportedByWall = (matrix) => {
    const p = matrixPosition(matrix);
    if (Math.abs(p.x - minX) < 0.22 || Math.abs(p.x - (minX + auditWidth)) < 0.22
      || Math.abs(p.z - minZ) < 0.22 || Math.abs(p.z - (minZ + auditDepth)) < 0.22) return true;
    return wallSegments.some((wall) => {
      const wx = wall.cx;
      const wz = wall.cz;
      return wall.sx >= wall.sz
        ? Math.abs(p.z - wz) < 0.25 && Math.abs(p.x - wx) <= wall.sx * 0.5 + 0.05
        : Math.abs(p.x - wx) < 0.25 && Math.abs(p.z - wz) <= wall.sz * 0.5 + 0.05;
    });
  };
  const frames = (L.doorEdges ?? []).filter((d) => d.zone !== 'elevator')
    .map((d) => doorMountFrame(d, minX, minZ, L.cellW, L.cellD, 3.2));
  const overlapsFrame = (matrix, halfWidth) => {
    const p = matrixPosition(matrix);
    const yaw = Math.atan2(matrix.elements[8], matrix.elements[10]);
    return frames.some((frame) => {
      if (Math.abs(Math.cos(yaw - frame.yaw)) < 0.94) return false;
      const dx = p.x - frame.faceX;
      const dz = p.z - frame.faceZ;
      const plane = Math.abs(dx * Math.sin(frame.yaw) + dz * Math.cos(frame.yaw));
      const along = Math.abs(dx * Math.cos(frame.yaw) - dz * Math.sin(frame.yaw));
      return plane < 0.32 && along < frame.opening * 0.5 + halfWidth + 0.14;
    });
  };
  for (const [matrices, halfWidth] of [[P.tvBodyMatrices, 0.475], [P.whiteboardMatrices, 0.55], [P.artFrameMatrices, 0.38]]) {
    for (const matrix of matrices) {
      if (!supportedByWall(matrix)) unsupportedWallDecor += 1;
      if (overlapsFrame(matrix, halfWidth)) doorDecorOverlaps += 1;
    }
  }
  const plates = getOfficeRoomPlatePlacements({
    layout: L,
    originMinX: minX,
    originMinZ: minZ,
    floorY: 0,
    wallHeight: 3.2,
    cw: L.cellW,
    cd: L.cellD,
  });
  for (let pi = 0; pi < plates.length; pi += 1) {
    const plate = plates[pi];
    if (Math.abs(plate.y - 1.55) > 1e-6) roomPlateViolations += 1;
    for (let fi = 0; fi < frames.length; fi += 1) {
      if (fi === pi) continue;
      const frame = frames[fi];
      if (Math.abs(Math.cos(plate.yaw - frame.yaw)) < 0.94) continue;
      const dx = plate.x - frame.faceX;
      const dz = plate.z - frame.faceZ;
      const plane = Math.abs(dx * Math.sin(frame.yaw) + dz * Math.cos(frame.yaw));
      const along = Math.abs(dx * Math.cos(frame.yaw) - dz * Math.sin(frame.yaw));
      if (plane < 0.3 && along < frame.opening * 0.5 + 0.355) roomPlateViolations += 1;
    }
  }
}
if (zoneViolations === 0) ok('40-seed audit: furniture types stay in permitted zones');
else fail('furniture zone rules', `${zoneViolations} violations`);
if (groundingViolations === 0) ok('40-seed audit: floor furniture is grounded');
else fail('furniture grounding rules', `${groundingViolations} violations`);
if (doorClearanceViolations === 0) ok('40-seed audit: furniture avoids door-clearance cells');
else fail('furniture door clearance', `${doorClearanceViolations} violations`);
if (ceilingViolations === 0) ok('40-seed audit: ceiling props avoid elevators and troffers');
else fail('ceiling prop rules', `${ceilingViolations} violations`);
if (sawCorridorPlant) ok('40-seed audit: corridor-only plant rule is reachable');
else fail('corridor plant placement', 'no eligible corridor plant generated');
if (unsupportedWallDecor === 0) ok('40-seed audit: wall decor has structural wall support');
else fail('wall decor support', `${unsupportedWallDecor} unsupported props`);
if (doorDecorOverlaps === 0) ok('40-seed audit: wall decor clears every door frame');
else fail('wall decor door clearance', `${doorDecorOverlaps} overlaps`);
if (roomPlateViolations === 0) ok('40-seed audit: room plaques mount beside, never across, door frames');
else fail('room plaque placement', `${roomPlateViolations} violations`);
if (exitClearanceViolations === 0) ok('40-seed audit: large furniture colliders clear the building exit');
else fail('furniture exit clearance', `${exitClearanceViolations} overlaps`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll office-furniture checks passed.');
