// officeSignage.js — P3 room plates + exit sign (docs/office-interior-p3-plan.md).
//
// Plates mount on the door header, flush with the corridor face of the partition.
// Elevator labels live on the elevator frame (officeElevator.js).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cellHash } from './officeFurniture.js';
import { doorMountFrame } from './generateOfficeLayout.js';

const MEETING_NAMES = [
  'Summit', 'Horizon', 'Atlas', 'Meridian', 'Cedar', 'Beacon', 'Harbor', 'Crest',
  'Vista', 'Pioneer', 'Ledger', 'Forge',
];

const EXIT_SIGN_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x1a4d2e,
  emissive: 0x3dff7a,
  emissiveIntensity: 2.2,
  roughness: 0.6,
  metalness: 0.0,
});

const _compose = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);

function roomLabel(seed, zone, index, floorIndex) {
  const floorNum = floorIndex + 1;
  const num = `${floorNum}.${String(index + 1).padStart(2, '0')}`;
  if (zone === 'meeting') {
    const word = MEETING_NAMES[Math.floor(cellHash(seed, index, zone.length) * MEETING_NAMES.length)];
    return `${word} ${num}`;
  }
  return `OFFICE ${num}`;
}

function remapPlaneUV(geometry, u0, v0, u1, v1) {
  const uvs = geometry.getAttribute('uv');
  for (let i = 0; i < uvs.count; i += 1) {
    uvs.setXY(i, u0 + uvs.getX(i) * (u1 - u0), v0 + uvs.getY(i) * (v1 - v0));
  }
  uvs.needsUpdate = true;
}

function buildAtlas(labels, seed, accentHex = null) {
  const cols = 4;
  const rows = Math.ceil(labels.length / cols);
  const cellW = 256;
  const cellH = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cellW * cols;
  canvas.height = cellH * rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#141418';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const accent = accentHex != null
    ? `#${accentHex.toString(16).padStart(6, '0')}`
    : '#2a7a72';

  const uvs = [];
  labels.forEach((text, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;
    ctx.fillStyle = '#1a1a20';
    ctx.fillRect(x + 3, y + 3, cellW - 6, cellH - 6);
    ctx.fillStyle = accent;
    ctx.fillRect(x + 3, y + 3, cellW - 6, 5);
    ctx.strokeStyle = '#2e2e36';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 3, y + 3, cellW - 6, cellH - 6);
    ctx.fillStyle = '#f2f2f4';
    ctx.fillText(text, x + cellW / 2, y + cellH / 2);
    uvs.push({
      u0: col / cols,
      v0: 1 - (row + 1) / rows,
      u1: (col + 1) / cols,
      v1: 1 - row / rows,
    });
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, uvs };
}

export function getOfficeRoomPlatePlacements({
  layout,
  originMinX,
  originMinZ,
  floorY,
  wallHeight,
  cw,
  cd,
}) {
  const doors = (layout.doorEdges ?? []).filter((door) => door.zone !== 'elevator');
  const frames = doors.map((door) => doorMountFrame(door, originMinX, originMinZ, cw, cd, wallHeight));
  const plateHalfWidth = 0.275;
  return frames.map((frame, index) => {
    const tx = Math.cos(frame.yaw);
    const tz = -Math.sin(frame.yaw);
    const sideOffset = frame.opening * 0.5 + plateHalfWidth + 0.085;
    const candidates = [-1, 1].map((sign) => ({
      x: frame.plateX + tx * sideOffset * sign,
      z: frame.plateZ + tz * sideOffset * sign,
      sign,
    }));
    const overlapsOtherDoor = (candidate) => frames.some((other, otherIndex) => {
      if (otherIndex === index || Math.abs(Math.cos(frame.yaw - other.yaw)) < 0.94) return false;
      const dx = candidate.x - other.faceX;
      const dz = candidate.z - other.faceZ;
      const plane = Math.abs(dx * Math.sin(other.yaw) + dz * Math.cos(other.yaw));
      const along = Math.abs(dx * Math.cos(other.yaw) - dz * Math.sin(other.yaw));
      return plane < 0.3 && along < other.opening * 0.5 + plateHalfWidth + 0.08;
    });
    const chosen = candidates.find((candidate) => !overlapsOtherDoor(candidate)) ?? candidates[0];
    return {
      ...chosen,
      y: floorY + 1.55,
      yaw: frame.yaw,
      door: doors[index],
      frame,
    };
  });
}

/**
 * @returns {{ plates: THREE.Mesh|null, exitSign: THREE.Mesh|null, texture: THREE.Texture|null }}
 */
export function createOfficeSignage({
  layout,
  seed,
  originMinX,
  originMinZ,
  floorY,
  wallHeight,
  floorIndex = 0,
  doorFacade,
  origin,
  halfW,
  halfD,
  wallThickness = 0.3,
  cw,
  cd,
  accentHex = null,
}) {
  if (typeof document === 'undefined') {
    return { plates: null, exitSign: null, texture: null };
  }

  const cellW = cw ?? layout.cellW;
  const cellD = cd ?? layout.cellD;

  const signDoors = (layout.doorEdges ?? []).filter((d) => d.zone !== 'elevator');
  if (signDoors.length === 0) {
    return { plates: null, exitSign: null, texture: null };
  }

  const labels = signDoors.map((d, i) => roomLabel(seed, d.zone, i, floorIndex));
  const { texture, uvs } = buildAtlas(labels, seed, accentHex);

  const plateMat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const plateGeoms = [];
  const placements = getOfficeRoomPlatePlacements({
    layout,
    originMinX,
    originMinZ,
    floorY,
    wallHeight,
    cw: cellW,
    cd: cellD,
  });

  signDoors.forEach((door, i) => {
    const plateH = 0.14;
    const placement = placements[i];
    const g = new THREE.PlaneGeometry(0.55, plateH);
    remapPlaneUV(g, uvs[i].u0, uvs[i].v0, uvs[i].u1, uvs[i].v1);
    _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.yaw);
    _pos.set(placement.x, placement.y, placement.z);
    _compose.compose(_pos, _quat, _scale);
    g.applyMatrix4(_compose);
    plateGeoms.push(g);
  });

  const merged = mergeGeometries(plateGeoms, false);
  const plates = new THREE.Mesh(merged, plateMat);
  plates.name = 'Office Room Plates';
  plates.renderOrder = 8;

  let exitSign = null;
  if (floorIndex === 0 && doorFacade) {
    const inward = {
      NX: { x: 1, z: 0 }, PX: { x: -1, z: 0 }, NZ: { x: 0, z: 1 }, PZ: { x: 0, z: -1 },
    }[doorFacade] ?? { x: 0, z: 1 };
    const doorEdgeX = doorFacade === 'NX' ? origin.x - halfW : doorFacade === 'PX' ? origin.x + halfW : origin.x;
    const doorEdgeZ = doorFacade === 'NZ' ? origin.z - halfD : doorFacade === 'PZ' ? origin.z + halfD : origin.z;
    exitSign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.06), EXIT_SIGN_MATERIAL);
    exitSign.position.set(
      doorEdgeX + inward.x * (wallThickness * 0.5 + 0.2),
      floorY + wallHeight - 0.35,
      doorEdgeZ + inward.z * (wallThickness * 0.5 + 0.2),
    );
    exitSign.rotation.y = Math.atan2(inward.x, inward.z);
    exitSign.name = 'Office Exit Sign';
  }

  return { plates, exitSign, texture };
}
