// officeProps.js — ceiling micro-props, meeting TVs/whiteboards, wall art (M4).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cellHash } from './officeFurniture.js';
import { buildDoorClearanceSet, doorMountFrame } from './generateOfficeLayout.js';
import { getOfficeAluminumMaterial } from './officeGlassMaterial.js';
import { getOfficeArtColor } from './officePalette.js';

const FRAME_FALLBACK = new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.38, metalness: 0.82 });
const TV_BODY_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x1a1c22, roughness: 0.4, metalness: 0.15,
  emissive: 0x3a6a8a, emissiveIntensity: 1.0,
});
function createVentTexture() {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const slat = y % 6 < 2;
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      const value = edge ? 110 : slat ? 30 : 74;
      const i = (y * size + x) * 4;
      data[i] = value;
      data[i + 1] = value + 3;
      data[i + 2] = value + 6;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
const VENT_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: createVentTexture(),
  roughness: 0.78,
  metalness: 0.15,
});
const SPRINKLER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xc8c2b8, roughness: 0.35, metalness: 0.7 });
const DETECTOR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xe8e8ec, roughness: 0.5, metalness: 0.05 });

let _ventGeom = null;
function ventGeometry() {
  if (!_ventGeom) {
    const shell = new THREE.BoxGeometry(0.55, 0.04, 0.55);
    shell.translate(0, 0.02, 0);
    const slats = [];
    for (let i = -2; i <= 2; i += 1) {
      const s = new THREE.BoxGeometry(0.48, 0.008, 0.04);
      s.translate(0, 0.035, i * 0.09);
      slats.push(s);
    }
    _ventGeom = mergeGeometries([shell, ...slats], false);
  }
  return _ventGeom;
}

let _sprinklerGeom = null;
function sprinklerGeometry() {
  if (!_sprinklerGeom) {
    const disc = new THREE.CylinderGeometry(0.045, 0.045, 0.012, 10);
    disc.translate(0, 0.006, 0);
    const pipe = new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6);
    pipe.translate(0, 0.05, 0);
    _sprinklerGeom = mergeGeometries([disc, pipe], false);
  }
  return _sprinklerGeom;
}

const DETECTOR_GEOMETRY = new THREE.CylinderGeometry(0.09, 0.09, 0.035, 12);
const TV_BODY_GEOMETRY = new THREE.BoxGeometry(0.95, 0.54, 0.04);

const WHITEBOARD_GEOMETRY = new THREE.PlaneGeometry(1.1, 0.72);
const ART_FRAME_GEOMETRY = new THREE.BoxGeometry(0.76, 0.56, 0.03);
const ART_PLATE_GEOMETRY = new THREE.PlaneGeometry(0.64, 0.44);
const CLOCK_GEOMETRY = new THREE.CircleGeometry(0.14, 24);

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

function compose(cx, cy, cz, yaw, sx = 1, sy = 1, sz = 1) {
  _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw ?? 0);
  _s.set(sx, sy, sz);
  return _m.compose(_p.set(cx, cy, cz), _q, _s).clone();
}

function floodMeetingRegions(zones, cols, rows) {
  const seen = Array.from({ length: cols }, () => new Array(rows).fill(false));
  const regions = [];
  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      if (seen[x][z] || zones[x][z] !== 'meeting') continue;
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
          if (seen[nx][nz] || zones[nx][nz] !== 'meeting') continue;
          seen[nx][nz] = true;
          stack.push([nx, nz]);
        }
      }
      regions.push(cells);
    }
  }
  return regions;
}

/**
 * @param {Set<string>} trofferKeys — `${gx},${gz}` cells with troffers
 */
export function placeOfficeProps({
  layout,
  seed,
  originMinX,
  originMinZ,
  floorY,
  ceilY,
  cw,
  cd,
  trofferKeys = new Set(),
  accentHex,
}) {
  const ventMatrices = [];
  const sprinklerMatrices = [];
  const detectorMatrices = [];
  const tvBodyMatrices = [];
  const whiteboardMatrices = [];
  const artFrameMatrices = [];
  const artPlateEntries = [];
  const clockMatrices = [];
  const doorBlocked = buildDoorClearanceSet(layout.doorEdges ?? [], 1);
  const wallHeight = ceilY - floorY;
  const doorFrames = (layout.doorEdges ?? [])
    .filter((door) => door.zone !== 'elevator')
    .map((door) => doorMountFrame(door, originMinX, originMinZ, cw, cd, wallHeight));
  const overlapsDoorFrame = (x, z, yaw, halfWidth) => doorFrames.some((door) => {
    // Plane local +Z is its facing normal; reject only props mounted on the same
    // wall plane, then compare their distance along that wall to the opening.
    const normalDot = Math.cos(yaw - door.yaw);
    if (Math.abs(normalDot) < 0.94) return false;
    const nx = Math.sin(door.yaw);
    const nz = Math.cos(door.yaw);
    const tx = Math.cos(door.yaw);
    const tz = -Math.sin(door.yaw);
    const dx = x - door.faceX;
    const dz = z - door.faceZ;
    const planeDistance = Math.abs(dx * nx + dz * nz);
    const alongDistance = Math.abs(dx * tx + dz * tz);
    return planeDistance < 0.32
      && alongDistance < door.opening * 0.5 + halfWidth + 0.14;
  });

  for (let gx = 0; gx < layout.cols; gx += 1) {
    for (let gz = 0; gz < layout.rows; gz += 1) {
      const zone = layout.zones[gx][gz];
      if (zone === 'elevator') continue;
      const key = `${gx},${gz}`;
      if (trofferKeys.has(key)) continue;
      const h = cellHash(seed, gx + 19, gz + 23);
      if (h < 0.84) continue;
      const cx = originMinX + (gx + 0.5) * cw;
      const cz = originMinZ + (gz + 0.5) * cd;
      const cy = ceilY - 0.06;
      const pick = Math.floor(h * 48) % 3;
      if (pick === 0) ventMatrices.push(compose(cx, cy, cz, (h * 6.28) % (Math.PI * 2)));
      else if (pick === 1) sprinklerMatrices.push(compose(cx, cy - 0.02, cz, 0));
      else detectorMatrices.push(compose(cx, cy - 0.04, cz, 0));
    }
  }

  const meetingRegions = floodMeetingRegions(layout.zones, layout.cols, layout.rows);
  for (let ri = 0; ri < meetingRegions.length; ri += 1) {
    const cells = meetingRegions[ri];
    const door = (layout.doorEdges ?? []).find((d) =>
      d.zone === 'meeting' && cells.some((c) => c.gx === d.roomGx && c.gz === d.roomGz));
    if (!door) continue;

    const originX = originMinX + layout.cols * cw * 0.5;
    const originZ = originMinZ + layout.rows * cd * 0.5;
    const cellCenters = cells.map(({ gx, gz }) => ({
      x: originMinX + (gx + 0.5) * cw,
      z: originMinZ + (gz + 0.5) * cd,
    }));
    const candidates = (layout.walls ?? [])
      .filter((wall) => wall.zone === 'meeting')
      .map((wall) => {
        const x = originX + wall.cx;
        const z = originZ + wall.cz;
        let nearest = null;
        let nearestDistance = Infinity;
        for (const center of cellCenters) {
          const distance = Math.hypot(center.x - x, center.z - z);
          if (distance < nearestDistance) {
            nearest = center;
            nearestDistance = distance;
          }
        }
        if (!nearest || nearestDistance > Math.max(cw, cd) * 0.8) return null;
        const horizontal = wall.sx >= wall.sz;
        const nx = horizontal ? 0 : Math.sign(nearest.x - x);
        const nz = horizontal ? Math.sign(nearest.z - z) : 0;
        return {
          x: x + nx * 0.125,
          z: z + nz * 0.125,
          yaw: Math.atan2(nx, nz),
          span: horizontal ? wall.sx : wall.sz,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.span - a.span);

    const doorFrame = doorMountFrame(door, originMinX, originMinZ, cw, cd, wallHeight);
    const eligibleTv = candidates.filter((candidate) => candidate.span >= 1.2
      && !overlapsDoorFrame(candidate.x, candidate.z, candidate.yaw, 0.475));
    // TV belongs opposite the entrance: maximize distance from the door plane.
    eligibleTv.sort((a, b) => (
      Math.hypot(b.x - doorFrame.faceX, b.z - doorFrame.faceZ)
      - Math.hypot(a.x - doorFrame.faceX, a.z - doorFrame.faceZ)
    ));
    const tvMount = eligibleTv[0];
    if (tvMount) {
      tvBodyMatrices.push(compose(tvMount.x, floorY + 1.55, tvMount.z, tvMount.yaw));
    }
    // Whiteboard belongs on a side wall, perpendicular to the TV when possible.
    const eligibleWhiteboards = candidates.filter((candidate) => candidate !== tvMount
      && candidate.span >= 1.35
      && !overlapsDoorFrame(candidate.x, candidate.z, candidate.yaw, 0.55));
    const wbMount = eligibleWhiteboards.find((candidate) => tvMount
      && Math.abs(Math.cos(candidate.yaw - tvMount.yaw)) < 0.3)
      ?? eligibleWhiteboards[0];
    if (wbMount) {
      whiteboardMatrices.push(compose(wbMount.x, floorY + 1.35, wbMount.z, wbMount.yaw));
    }
  }

  let artIdx = 0;
  for (let gx = 0; gx < layout.cols; gx += 1) {
    for (let gz = 0; gz < layout.rows; gz += 1) {
      const zone = layout.zones[gx][gz];
      if (zone !== 'office' && zone !== 'open') continue;
      const perimeter = gx === 0 || gz === 0 || gx === layout.cols - 1 || gz === layout.rows - 1;
      if (!perimeter) continue;
      if (doorBlocked.has(`${gx},${gz}`)) continue;
      const h = cellHash(seed, gx, gz + 101);
      if (h < 0.82) continue;
      artIdx += 1;
      const cx = originMinX + (gx + 0.5) * cw;
      const cz = originMinZ + (gz + 0.5) * cd;
      let px = cx;
      let pz = cz;
      let yaw = 0;
      if (gz === 0) {
        pz = originMinZ + 0.125;
        yaw = 0;
      } else if (gz === layout.rows - 1) {
        pz = originMinZ + layout.rows * cd - 0.125;
        yaw = Math.PI;
      } else if (gx === 0) {
        px = originMinX + 0.125;
        yaw = Math.PI * 0.5;
      } else {
        px = originMinX + layout.cols * cw - 0.125;
        yaw = -Math.PI * 0.5;
      }
      if (overlapsDoorFrame(px, pz, yaw, 0.38)) continue;
      artFrameMatrices.push(compose(px, floorY + 1.45, pz, yaw));
      const nx = Math.sin(yaw);
      const nz = Math.cos(yaw);
      artPlateEntries.push({
        matrix: compose(px + nx * 0.02, floorY + 1.45, pz + nz * 0.02, yaw),
        color: getOfficeArtColor(seed, artIdx, accentHex),
      });
    }
  }

  if (layout.elevatorLobby && layout.elevatorCell) {
    const lobby = layout.elevatorLobby;
    const elevator = layout.elevatorCell;
    const cx = originMinX + (lobby.gx + 0.5) * cw;
    const cz = originMinZ + (lobby.gz + 0.5) * cd;
    const dx = Math.sign(elevator.x - lobby.gx);
    const dz = Math.sign(elevator.z - lobby.gz);
    const px = cx + dx * (cw * 0.5 - 0.13);
    const pz = cz + dz * (cd * 0.5 - 0.13);
    clockMatrices.push(compose(px, floorY + 2.48, pz, Math.atan2(-dx, -dz)));
  }

  return {
    ventMatrices,
    sprinklerMatrices,
    detectorMatrices,
    tvBodyMatrices,
    whiteboardMatrices,
    artFrameMatrices,
    artPlateEntries,
    clockMatrices,
  };
}

export function getOfficePropGeometries() {
  return {
    vent: ventGeometry(),
    sprinkler: sprinklerGeometry(),
    detector: DETECTOR_GEOMETRY,
    tvBody: TV_BODY_GEOMETRY,
    whiteboard: WHITEBOARD_GEOMETRY,
    artFrame: ART_FRAME_GEOMETRY,
    artPlate: ART_PLATE_GEOMETRY,
    clock: CLOCK_GEOMETRY,
  };
}

export function getOfficePropMaterials({ buildOnly = false, pomWall = null } = {}) {
  const frameMat = buildOnly ? FRAME_FALLBACK : (getOfficeAluminumMaterial() ?? FRAME_FALLBACK);
  const whiteboardMat = pomWall ?? new THREE.MeshStandardMaterial({
    color: 0xf2f2ee, roughness: 0.88, metalness: 0,
  });
  return {
    vent: VENT_MATERIAL,
    sprinkler: SPRINKLER_MATERIAL,
    detector: DETECTOR_MATERIAL,
    tvBody: TV_BODY_MATERIAL,
    whiteboard: whiteboardMat,
    artFrame: frameMat,
    artPlate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, vertexColors: true }),
    clock: new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.4, metalness: 0.2 }),
  };
}
