// officeElevator.js — 1×1 elevator shaft flush with the grid cell and partition walls.
//
// The shaft shell replaces WFC partition walls tagged `elevator` (see
// createOfficeInteriorLevel). Local +Z faces the lobby; face width/depth swap
// when the lobby is east/west so the door spans the correct cell edge.

import * as THREE from 'three';
import { DOOR_OPENING_RATIO } from './generateOfficeLayout.js';
import { getElevatorDoorMaterial, getElevatorFrameMaterial } from './officeElevatorMaterial.js';

const SHAFT_INNER_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x3a3a40, roughness: 0.92, metalness: 0.04,
});
const FALLBACK_FRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x707880, roughness: 0.5, metalness: 0.4,
});
const PANEL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x1a1a22, roughness: 0.7, metalness: 0.2,
  emissive: 0x1a3028, emissiveIntensity: 0.25,
});
const INDICATOR_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x222228, emissive: 0xfff0c8, emissiveIntensity: 0.9, roughness: 0.8,
});

function elevatorNamePlate(floorIndex) {
  if (typeof document === 'undefined') return null;
  const label = `Elevator · ${floorIndex + 1}`;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a2a30';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = '#f0f0f4';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0x333338,
    emissiveIntensity: 0.25,
    side: THREE.FrontSide,
  });
}

function pomBox(w, h, d, material, pom) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (pom) g.computeTangents();
  return new THREE.Mesh(g, material);
}

export function cellWorldCenter(gx, gz, originMinX, originMinZ, cw, cd) {
  return {
    x: originMinX + (gx + 0.5) * cw,
    z: originMinZ + (gz + 0.5) * cd,
  };
}

export function elevatorLobbySpawn(layout, originMinX, originMinZ, cw, cd, floorY) {
  const lobby = layout.elevatorLobby;
  const elev = layout.elevatorCell;
  if (lobby && elev) {
    const lc = cellWorldCenter(lobby.gx, lobby.gz, originMinX, originMinZ, cw, cd);
    const ec = cellWorldCenter(elev.x, elev.z, originMinX, originMinZ, cw, cd);
    const dx = ec.x - lc.x;
    const dz = ec.z - lc.z;
    const len = Math.hypot(dx, dz) || 1;
    const stand = Math.min(cw, cd) * 0.28;
    return new THREE.Vector3(lc.x - (dx / len) * stand, floorY, lc.z - (dz / len) * stand);
  }
  const { x, z } = elev ?? { x: 0, z: 0 };
  return new THREE.Vector3(
    originMinX + (x + 0.5) * cw,
    floorY,
    originMinZ + (z + 0.5) * cd,
  );
}

export function elevatorSpawnYaw(layout) {
  const lobby = layout.elevatorLobby;
  const elev = layout.elevatorCell;
  if (lobby && elev) {
    const dx = elev.x - lobby.gx;
    const dz = elev.z - lobby.gz;
    if (dx !== 0 || dz !== 0) return Math.atan2(dx, dz);
  }
  return 0;
}

export function elevatorTriggerAabb(layout, originMinX, originMinZ, cw, cd) {
  const lobby = layout.elevatorLobby ?? layout.elevatorCell;
  const cx = originMinX + (lobby.gx + 0.5) * cw;
  const cz = originMinZ + (lobby.gz + 0.5) * cd;
  const hx = cw * 0.38;
  const hz = cd * 0.38;
  return { minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
}

function doorLeafGeometry(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h * 0.5, 0);
  return g;
}

export function addElevatorVisuals({
  floorGroup,
  layout,
  originMinX,
  originMinZ,
  floorY,
  floorIndex,
  floorCount,
  cw,
  cd,
  wallHeight = 3.2,
  wallThickness = 0.22,
  shellMaterial = null,
  pomMeshes = false,
  buildOnly,
  lightBudget = null,
}) {
  if (buildOnly) return null;

  const lobby = layout.elevatorLobby;
  const elev = layout.elevatorCell;
  if (!lobby || !elev) return null;

  const shellMat = shellMaterial ?? FALLBACK_FRAME_MATERIAL;
  const doorMat = getElevatorDoorMaterial();
  const frameMat = getElevatorFrameMaterial();
  const pomShell = pomMeshes;
  const pomFrame = pomMeshes && frameMat?.isNodeMaterial === true;

  const wt = wallThickness;
  const frameD = 0.12;

  const lobbyDx = lobby.gx - elev.x;
  const lobbyDz = lobby.gz - elev.z;
  const lobbyEastWest = lobbyDx !== 0;
  const faceW = lobbyEastWest ? cd : cw;
  const faceD = lobbyEastWest ? cw : cd;

  const halfW = faceW * 0.5;
  const halfD = faceD * 0.5;
  const doorOpenW = faceW * DOOR_OPENING_RATIO;
  const doorH = Math.min(2.2, wallHeight - 0.22);
  const leafW = doorOpenW * 0.48;
  const jambW = (faceW - doorOpenW) * 0.5;
  const frontZ = halfD - frameD * 0.5;
  const backZ = -halfD + wt * 0.5;
  const plateZ = frontZ + frameD * 0.5 + 0.03;
  const sideFrontZ = frontZ - frameD * 0.5 - 0.01;
  const sideDepth = sideFrontZ - backZ;
  const sideCenterZ = backZ + sideDepth * 0.5;

  const ec = cellWorldCenter(elev.x, elev.z, originMinX, originMinZ, cw, cd);
  const lc = cellWorldCenter(lobby.gx, lobby.gz, originMinX, originMinZ, cw, cd);
  const yaw = Math.atan2(lc.x - ec.x, lc.z - ec.z);

  const root = new THREE.Group();
  root.position.set(ec.x, floorY, ec.z);
  root.rotation.y = yaw;
  root.name = `Elevator F${floorIndex}`;
  root.updateMatrixWorld(true);

  const back = pomBox(faceW, wallHeight, wt, shellMat, pomShell);
  back.position.set(0, wallHeight * 0.5, backZ);
  back.castShadow = true;
  back.receiveShadow = true;
  root.add(back);

  const leftWall = pomBox(wt, wallHeight, sideDepth, shellMat, pomShell);
  leftWall.position.set(-halfW + wt * 0.5, wallHeight * 0.5, sideCenterZ);
  leftWall.castShadow = true;
  leftWall.receiveShadow = true;
  root.add(leftWall);

  const rightWall = pomBox(wt, wallHeight, sideDepth, shellMat, pomShell);
  rightWall.position.set(halfW - wt * 0.5, wallHeight * 0.5, sideCenterZ);
  rightWall.castShadow = true;
  rightWall.receiveShadow = true;
  root.add(rightWall);

  const headerH = wallHeight - doorH;
  const header = pomBox(doorOpenW, headerH, frameD, frameMat, pomFrame);
  header.position.set(0, doorH + headerH * 0.5, frontZ);
  root.add(header);

  const sill = pomBox(doorOpenW, 0.06, frameD, frameMat, pomFrame);
  sill.position.set(0, 0.03, frontZ);
  root.add(sill);

  if (jambW > 0.04) {
    const jambL = pomBox(jambW, wallHeight, frameD, frameMat, pomFrame);
    jambL.position.set(-halfW + jambW * 0.5, wallHeight * 0.5, frontZ);
    root.add(jambL);

    const jambR = pomBox(jambW, wallHeight, frameD, frameMat, pomFrame);
    jambR.position.set(halfW - jambW * 0.5, wallHeight * 0.5, frontZ);
    root.add(jambR);
  }

  const innerBack = new THREE.Mesh(
    new THREE.BoxGeometry(faceW - wt * 2, wallHeight - 0.04, wt * 0.5),
    SHAFT_INNER_MATERIAL,
  );
  innerBack.position.set(0, wallHeight * 0.5, backZ + wt * 0.35);
  root.add(innerBack);

  const leftDoor = new THREE.Mesh(doorLeafGeometry(leafW, doorH, 0.05), doorMat);
  leftDoor.position.set(-leafW * 0.5 - 0.008, 0, frontZ + frameD * 0.5 + 0.02);
  root.add(leftDoor);

  const rightDoor = new THREE.Mesh(doorLeafGeometry(leafW, doorH, 0.05), doorMat);
  rightDoor.position.set(leafW * 0.5 + 0.008, 0, frontZ + frameD * 0.5 + 0.02);
  root.add(rightDoor);

  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.04), PANEL_MATERIAL);
  panel.position.set(doorOpenW * 0.5 + 0.14, doorH * 0.52, frontZ + frameD * 0.5 + 0.022);
  root.add(panel);

  const indicator = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.04), INDICATOR_MATERIAL);
  indicator.position.set(0, doorH + 0.05, frontZ + frameD * 0.5 + 0.02);
  root.add(indicator);

  const nameMat = elevatorNamePlate(floorIndex);
  if (nameMat) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.13), nameMat);
    plate.position.set(0, doorH + headerH * 0.42, plateZ);
    plate.renderOrder = 8;
    root.add(plate);
  }

  for (const child of root.children) {
    if (child.material === frameMat || child.material === doorMat || child.material === shellMat) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  }

  floorGroup.add(root);
  return root;
}
