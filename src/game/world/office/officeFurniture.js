// officeFurniture.js — P3 furniture + fidelity pass 2 geometry (docs/office-interior-p3-plan.md,
// docs/office-interior-fidelity-2-plan.md).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildDoorClearanceSet } from './generateOfficeLayout.js';

export function cellHash(seed, x, z) {
  let h = (seed | 0) ^ Math.imul(x + 1, 374761393) ^ Math.imul(z + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const CARDINALS = [
  { yaw: 0, fwdX: 0, fwdZ: -1 },
  { yaw: Math.PI * 0.5, fwdX: -1, fwdZ: 0 },
  { yaw: Math.PI, fwdX: 0, fwdZ: 1 },
  { yaw: -Math.PI * 0.5, fwdX: 1, fwdZ: 0 },
];

const BEVEL = 0.02;
export const OFFICE_FLOOR_FINISH_OFFSET = 0.058;

function mergeBoxes(parts) {
  const geoms = parts.map(({ sx, sy, sz, px, py, pz }) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(px, py, pz);
    return g;
  });
  return mergeGeometries(geoms, false);
}

function mergeRounded(parts) {
  const geoms = parts.map(({ sx, sy, sz, px, py, pz, bevel = BEVEL }) => {
    const g = new RoundedBoxGeometry(sx, sy, sz, 2, bevel);
    g.translate(px, py, pz);
    return g;
  });
  return mergeGeometries(geoms, false);
}

function mergeBoxesFloorAnchored(parts) {
  const merged = mergeBoxes(parts);
  merged.computeBoundingBox();
  merged.translate(0, -merged.boundingBox.min.y, 0);
  merged.computeBoundingBox();
  return merged;
}

function mergeRoundedFloorAnchored(parts) {
  const merged = mergeRounded(parts);
  // RoundedBoxGeometry merges to a non-indexed buffer, while Three's tangent
  // generator requires an index. Preserve hard edges because mergeVertices also
  // compares normal/UV attributes when deciding which vertices can be shared.
  const indexed = mergeVertices(merged);
  merged.dispose();
  indexed.computeBoundingBox();
  indexed.translate(0, -indexed.boundingBox.min.y, 0);
  indexed.computeBoundingBox();
  return indexed;
}

function halfHeight(geom) {
  geom.computeBoundingBox();
  return (geom.boundingBox.max.y - geom.boundingBox.min.y) * 0.5;
}

let _deskHalfH = null;
function deskHalfHeight() {
  if (_deskHalfH == null) {
    _deskHalfH = halfHeight(getDeskGeometry());
  }
  return _deskHalfH;
}

let _deskGeom = null;
export function getDeskGeometry() {
  if (!_deskGeom) {
    _deskGeom = mergeRoundedFloorAnchored([
      { sx: 1.2, sy: 0.74, sz: 0.62, px: 0, py: 0.37, pz: 0 },
    ]);
  }
  return _deskGeom;
}

let _deskVariantGeom = null;
export function getDeskVariantGeometry() {
  if (!_deskVariantGeom) {
    _deskVariantGeom = mergeRoundedFloorAnchored([
      { sx: 1.2, sy: 0.74, sz: 0.62, px: 0, py: 0.37, pz: 0 },
      { sx: 0.38, sy: 0.02, sz: 0.14, px: 0.12, py: 0.76, pz: 0.08, bevel: 0.004 },
      { sx: 0.08, sy: 0.1, sz: 0.08, px: -0.38, py: 0.79, pz: 0.12, bevel: 0.004 },
    ]);
  }
  return _deskVariantGeom;
}

let _monitorGeom = null;
export function getMonitorGeometry() {
  if (!_monitorGeom) {
    _monitorGeom = mergeRoundedFloorAnchored([
      { sx: 0.55, sy: 0.34, sz: 0.05, px: 0, py: 0.17, pz: 0, bevel: 0.008 },
      { sx: 0.12, sy: 0.08, sz: 0.08, px: 0, py: 0.04, pz: -0.06, bevel: 0.006 },
    ]);
  }
  return _monitorGeom;
}

let _tableGeom = null;
export function getTableGeometry() {
  if (!_tableGeom) {
    _tableGeom = mergeRoundedFloorAnchored([
      { sx: 1.9, sy: 0.74, sz: 1.05, px: 0, py: 0.37, pz: 0 },
    ]);
  }
  return _tableGeom;
}

let _plantGeom = null;
export function getPlantGeometry() {
  if (!_plantGeom) {
    const pot = new THREE.CylinderGeometry(0.14, 0.12, 0.22, 12);
    pot.translate(0, 0.11, 0);
    const fins = [];
    for (let i = 0; i < 3; i += 1) {
      const leaf = new THREE.ConeGeometry(0.22, 0.55, 4, 1, false);
      leaf.rotateZ(Math.PI * 0.5);
      leaf.rotateY((i / 3) * Math.PI * 2);
      leaf.translate(0, 0.52, 0);
      fins.push(leaf);
    }
    _plantGeom = mergeGeometries([pot, ...fins], false);
    _plantGeom.computeBoundingBox();
    _plantGeom.translate(0, -_plantGeom.boundingBox.min.y, 0);
  }
  return _plantGeom;
}

let _taskChairGeom = null;
let _taskChairHalfH = null;
export function getTaskChairGeometry() {
  if (!_taskChairGeom) {
    _taskChairGeom = mergeBoxesFloorAnchored([
      { sx: 0.07, sy: 0.38, sz: 0.07, px: 0, py: 0.19, pz: 0 },
      { sx: 0.05, sy: 0.04, sz: 0.26, px: 0, py: 0.02, pz: 0.12 },
      { sx: 0.05, sy: 0.04, sz: 0.26, px: 0, py: 0.02, pz: -0.12 },
      { sx: 0.26, sy: 0.04, sz: 0.05, px: 0.12, py: 0.02, pz: 0 },
      { sx: 0.26, sy: 0.04, sz: 0.05, px: -0.12, py: 0.02, pz: 0 },
      { sx: 0.44, sy: 0.06, sz: 0.4, px: 0, py: 0.45, pz: 0.02 },
      { sx: 0.44, sy: 0.36, sz: 0.05, px: 0, py: 0.66, pz: -0.2 },
    ]);
    _taskChairHalfH = halfHeight(_taskChairGeom);
  }
  return _taskChairGeom;
}
export function getTaskChairHalfHeight() {
  getTaskChairGeometry();
  return _taskChairHalfH;
}

let _meetingChairGeom = null;
let _meetingChairHalfH = null;
export function getMeetingChairGeometry() {
  if (!_meetingChairGeom) {
    _meetingChairGeom = mergeBoxesFloorAnchored([
      { sx: 0.06, sy: 0.34, sz: 0.06, px: 0, py: 0.17, pz: 0 },
      { sx: 0.05, sy: 0.04, sz: 0.24, px: 0, py: 0.02, pz: 0.11 },
      { sx: 0.05, sy: 0.04, sz: 0.24, px: 0, py: 0.02, pz: -0.11 },
      { sx: 0.24, sy: 0.04, sz: 0.05, px: 0.11, py: 0.02, pz: 0 },
      { sx: 0.24, sy: 0.04, sz: 0.05, px: -0.11, py: 0.02, pz: 0 },
      { sx: 0.4, sy: 0.05, sz: 0.38, px: 0, py: 0.4, pz: 0.02 },
      { sx: 0.4, sy: 0.3, sz: 0.04, px: 0, py: 0.58, pz: -0.18 },
    ]);
    _meetingChairHalfH = halfHeight(_meetingChairGeom);
  }
  return _meetingChairGeom;
}
export function getMeetingChairHalfHeight() {
  getMeetingChairGeometry();
  return _meetingChairHalfH;
}

function sofaGeometry(seats) {
  const width = seats === 3 ? 2.2 : 1.6;
  return mergeRoundedFloorAnchored([
    { sx: width, sy: 0.12, sz: 0.72, px: 0, py: 0.34, pz: 0 },
    { sx: width, sy: 0.42, sz: 0.1, px: 0, py: 0.58, pz: -0.31 },
    { sx: 0.12, sy: 0.34, sz: 0.72, px: -width / 2 + 0.06, py: 0.42, pz: 0 },
    { sx: 0.12, sy: 0.34, sz: 0.72, px: width / 2 - 0.06, py: 0.42, pz: 0 },
  ]);
}

let _sofa2Geom = null;
let _sofa3Geom = null;
export function getSofaGeometry(seats = 2) {
  if (seats === 3) return (_sofa3Geom ??= sofaGeometry(3));
  return (_sofa2Geom ??= sofaGeometry(2));
}

let _coffeeTableGeom = null;
export function getCoffeeTableGeometry() {
  if (!_coffeeTableGeom) {
    _coffeeTableGeom = mergeRoundedFloorAnchored([
      { sx: 0.9, sy: 0.06, sz: 0.5, px: 0, py: 0.22, pz: 0 },
      { sx: 0.08, sy: 0.22, sz: 0.08, px: -0.35, py: 0.11, pz: -0.15 },
      { sx: 0.08, sy: 0.22, sz: 0.08, px: 0.35, py: 0.11, pz: -0.15 },
      { sx: 0.08, sy: 0.22, sz: 0.08, px: -0.35, py: 0.11, pz: 0.15 },
      { sx: 0.08, sy: 0.22, sz: 0.08, px: 0.35, py: 0.11, pz: 0.15 },
    ]);
  }
  return _coffeeTableGeom;
}

function inExitZone(cx, cz, exitTrigger, pad = 0.4) {
  if (!exitTrigger) return false;
  return cx >= exitTrigger.minX - pad && cx <= exitTrigger.maxX + pad
    && cz >= exitTrigger.minZ - pad && cz <= exitTrigger.maxZ + pad;
}

function isEntryCell(gx, gz, entryCell) {
  return entryCell && gx === entryCell.x && gz === entryCell.z;
}

function furnitureCollider(name, cx, cz, hx, hz, bottomY, topY) {
  return { name, minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz, bottomY, topY };
}

function rotatedCollider(name, cx, cz, hx, hz, yaw, bottomY, topY) {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return furnitureCollider(name, cx, cz, hx * c + hz * s, hx * s + hz * c, bottomY, topY);
}

function blobEntry(matrix, kind) {
  return { matrix, kind };
}

function floodRegions(zones, cols, rows, zoneFilter) {
  const seen = Array.from({ length: cols }, () => new Array(rows).fill(false));
  const regions = [];
  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      if (seen[x][z] || !zoneFilter(zones[x][z])) continue;
      const zone = zones[x][z];
      const cells = [];
      const stack = [[x, z]];
      seen[x][z] = true;
      while (stack.length) {
        const [cx, cz] = stack.pop();
        cells.push({ gx: cx, gz: cz });
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          if (seen[nx][nz] || zones[nx][nz] !== zone) continue;
          seen[nx][nz] = true;
          stack.push([nx, nz]);
        }
      }
      regions.push({ zone, cells });
    }
  }
  return regions;
}

/**
 * @returns {{
 *   deskPlainMatrices, deskVariantMatrices, monitorMatrices, tableMatrices, plantMatrices,
 *   taskChairMatrices, meetingChairMatrices, sofa2Matrices, sofa3Matrices, coffeeTableMatrices,
 *   blobEntries, tintCells: { gx, gz, kind }[],
 *   colliders: object[],
 * }}
 */
export function placeOfficeFurniture({
  layout,
  seed,
  originMinX,
  originMinZ,
  floorY,
  cw,
  cd,
  exitTrigger,
  entryCell,
}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();

  const deskPlainMatrices = [];
  const deskVariantMatrices = [];
  const monitorMatrices = [];
  const tableMatrices = [];
  const plantMatrices = [];
  const taskChairMatrices = [];
  const meetingChairMatrices = [];
  const sofa2Matrices = [];
  const sofa3Matrices = [];
  const coffeeTableMatrices = [];
  const blobEntries = [];
  const tintCells = [];
  const colliders = [];
  const surfaceY = floorY + OFFICE_FLOOR_FINISH_OFFSET;

  const cellCenter = (gx, gz) => ({
    cx: originMinX + (gx + 0.5) * cw,
    cz: originMinZ + (gz + 0.5) * cd,
  });

  const doorBlocked = buildDoorClearanceSet(layout.doorEdges ?? [], 1);
  const usedCells = new Set();

  const canPlace = (gx, gz) => {
    const zone = layout.zones[gx]?.[gz];
    if (!zone || zone === 'corridor' || zone === 'elevator') return false;
    if (isEntryCell(gx, gz, entryCell)) return false;
    if (doorBlocked.has(`${gx},${gz}`)) return false;
    if (usedCells.has(`${gx},${gz}`)) return false;
    const { cx, cz } = cellCenter(gx, gz);
    return !inExitZone(cx, cz, exitTrigger);
  };

  const canPlaceCorridorPlant = (gx, gz) => {
    if (layout.zones[gx]?.[gz] !== 'corridor') return false;
    if (isEntryCell(gx, gz, entryCell) || doorBlocked.has(`${gx},${gz}`)
      || usedCells.has(`${gx},${gz}`)) return false;
    const { cx, cz } = cellCenter(gx, gz);
    return !inExitZone(cx, cz, exitTrigger, 0.65);
  };

  const claimCells = (gx, gz, spanX = 1, spanZ = 1) => {
    for (let dx = 0; dx < spanX; dx += 1) {
      for (let dz = 0; dz < spanZ; dz += 1) {
        usedCells.add(`${gx + dx},${gz + dz}`);
      }
    }
  };

  const composeAt = (cx, cy, cz, yaw) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw ?? 0);
    s.set(1, 1, 1);
    return m.compose(p.set(cx, cy, cz), q, s).clone();
  };

  const faceYaw = (fromX, fromZ, toX, toZ) => Math.atan2(toX - fromX, toZ - fromZ);

  const deskH = deskHalfHeight();

  const regions = floodRegions(layout.zones, layout.cols, layout.rows, (z) => z === 'office' || z === 'meeting' || z === 'open');

  for (const region of regions) {
    const regionKey = region.cells.reduce((best, c) => {
      const k = c.gx * 1000 + c.gz;
      return k < best ? k : best;
    }, Infinity);
    const orient = CARDINALS[Math.floor(cellHash(seed, regionKey, region.zone.charCodeAt(0)) * 4) % 4];

    if (region.zone === 'office') {
      const sorted = [...region.cells].sort((a, b) => a.gx * 1000 + a.gz - (b.gx * 1000 + b.gz));
      for (let i = 0; i < sorted.length; i += 2) {
        const { gx, gz } = sorted[i];
        if (!canPlace(gx, gz)) continue;
        const h = cellHash(seed, gx, gz);
        if (h >= 0.65) continue;
        claimCells(gx, gz);
        const { cx, cz } = cellCenter(gx, gz);
        const deskMat = composeAt(cx, surfaceY, cz, orient.yaw);
        if (cellHash(seed, gx + 3, gz + 7) < 0.5) {
          deskPlainMatrices.push(deskMat);
        } else {
          deskVariantMatrices.push(deskMat);
        }
        blobEntries.push(blobEntry(deskMat, 'desk'));
        monitorMatrices.push(composeAt(
          cx + orient.fwdX * 0.2,
          surfaceY + deskH * 2,
          cz + orient.fwdZ * 0.2,
          orient.yaw,
        ));
        const chairX = cx - orient.fwdX * 0.62;
        const chairZ = cz - orient.fwdZ * 0.62;
        taskChairMatrices.push(composeAt(
          chairX,
          surfaceY,
          chairZ,
          faceYaw(chairX, chairZ, cx, cz),
        ));
        tintCells.push({ gx, gz, kind: 'taskChair' });
        colliders.push(rotatedCollider('office-desk', cx, cz, 0.62, 0.35, orient.yaw, surfaceY, surfaceY + 0.74));
      }
    } else if (region.zone === 'meeting') {
      const interior = region.cells.filter(({ gx, gz }) => !doorBlocked.has(`${gx},${gz}`));
      const tableCell = interior[Math.floor(interior.length / 2)]
        ?? region.cells[Math.floor(region.cells.length / 2)];
      if (!tableCell || !canPlace(tableCell.gx, tableCell.gz)) continue;
      claimCells(tableCell.gx, tableCell.gz);
      const { cx, cz } = cellCenter(tableCell.gx, tableCell.gz);
      const tableMat = composeAt(cx, surfaceY, cz, orient.yaw);
      tableMatrices.push(tableMat);
      blobEntries.push(blobEntry(tableMat, 'table'));

      const chairCount = Math.min(6, Math.max(4, region.cells.length));
      // Keep chairs inside even a one-cell meeting room. Table half-width is
      // 0.95 m and chair depth is ~0.4 m, so ~1.15 m gives useful clearance.
      const dist = Math.min(1.15, Math.min(cw, cd) * 0.34);
      for (let i = 0; i < chairCount; i += 1) {
        const angle = (i / chairCount) * Math.PI * 2 + orient.yaw;
        const ccx = cx + Math.sin(angle) * dist;
        const ccz = cz + Math.cos(angle) * dist;
        if (inExitZone(ccx, ccz, exitTrigger)) continue;
        meetingChairMatrices.push(composeAt(
          ccx,
          surfaceY,
          ccz,
          faceYaw(ccx, ccz, cx, cz),
        ));
        tintCells.push({ gx: tableCell.gx, gz: tableCell.gz, kind: 'meetingChair', index: i });
      }
      colliders.push(rotatedCollider('meeting-table', cx, cz, 0.98, 0.58, orient.yaw, surfaceY, surfaceY + 0.74));
    } else if (region.zone === 'open') {
      const perimeter = region.cells.filter(({ gx, gz }) =>
        gx === 0 || gz === 0 || gx === layout.cols - 1 || gz === layout.rows - 1);
      const clusterStride = Math.max(3, Math.floor(region.cells.length / 2.5));
      let clusterIdx = 0;
      for (let i = 0; i < perimeter.length && clusterIdx < 3; i += clusterStride) {
        const { gx, gz } = perimeter[i];
        if (!canPlace(gx, gz)) continue;
        const h = cellHash(seed, gx + 11, gz + 17);
        if (h > 0.55) continue;
        claimCells(gx, gz);
        const { cx, cz } = cellCenter(gx, gz);
        const seats = h < 0.25 ? 3 : 2;
        let clusterOrient = orient;
        if (gx === 0) clusterOrient = CARDINALS[3];
        else if (gx === layout.cols - 1) clusterOrient = CARDINALS[1];
        else if (gz === 0) clusterOrient = CARDINALS[2];
        else if (gz === layout.rows - 1) clusterOrient = CARDINALS[0];
        const sofaW = seats === 3 ? 1.1 : 0.8;
        const sofaMat = composeAt(cx, surfaceY, cz, clusterOrient.yaw);
        if (seats === 3) sofa3Matrices.push(sofaMat);
        else sofa2Matrices.push(sofaMat);
        blobEntries.push(blobEntry(sofaMat, seats === 3 ? 'sofa3' : 'sofa2'));
        tintCells.push({ gx, gz, kind: seats === 3 ? 'sofa3' : 'sofa2' });
        colliders.push(rotatedCollider('office-sofa', cx, cz, sofaW, 0.38, clusterOrient.yaw, surfaceY, surfaceY + 0.68));
        const coffeeMat = composeAt(
          cx + clusterOrient.fwdX * 0.9,
          surfaceY,
          cz + clusterOrient.fwdZ * 0.9,
          clusterOrient.yaw,
        );
        coffeeTableMatrices.push(coffeeMat);
        blobEntries.push(blobEntry(coffeeMat, 'coffee'));
        const plantMat = composeAt(
          cx - clusterOrient.fwdX * 0.7,
          surfaceY,
          cz - clusterOrient.fwdZ * 0.7,
          clusterOrient.yaw,
        );
        plantMatrices.push(plantMat);
        blobEntries.push(blobEntry(plantMat, 'plant'));
        tintCells.push({ gx, gz, kind: 'plant' });
        clusterIdx += 1;
      }
    }
  }

  for (let gx = 0; gx < layout.cols; gx += 1) {
    for (let gz = 0; gz < layout.rows; gz += 1) {
      const zone = layout.zones[gx][gz];
      if (zone !== 'corridor' && zone !== 'open') continue;
      const h = cellHash(seed, gx, gz);
      if (h <= 0.92) continue;
      if (zone === 'open' && !canPlace(gx, gz)) continue;
      if (zone === 'corridor' && !canPlaceCorridorPlant(gx, gz)) continue;
      const { cx, cz } = cellCenter(gx, gz);
      if (inExitZone(cx, cz, exitTrigger)) continue;
      const plantMat = composeAt(cx, surfaceY, cz, 0);
      plantMatrices.push(plantMat);
      blobEntries.push(blobEntry(plantMat, 'plant'));
      tintCells.push({ gx, gz, kind: 'plant' });
    }
  }

  return {
    deskPlainMatrices,
    deskVariantMatrices,
    deskMatrices: [...deskPlainMatrices, ...deskVariantMatrices],
    monitorMatrices,
    tableMatrices,
    plantMatrices,
    taskChairMatrices,
    meetingChairMatrices,
    sofa2Matrices,
    sofa3Matrices,
    coffeeTableMatrices,
    blobEntries,
    tintCells,
    colliders,
  };
}
