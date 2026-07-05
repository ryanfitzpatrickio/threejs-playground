// officeLobbyColumns.js — stone pillars + vertical light strips at the elevator lobby.

import * as THREE from 'three';
import { getOfficeColumnMaterial } from './officeContemporaryMaterials.js';
import { createCoveAreaLight, getOfficeLightStripMaterial } from './officeLighting.js';

const LIGHT_STRIP_MATERIAL = getOfficeLightStripMaterial();

function buildColumn(wallHeight, stripMaterial = LIGHT_STRIP_MATERIAL) {
  const col = new THREE.Group();
  const h = wallHeight - 0.12;
  const geometry = new THREE.BoxGeometry(0.38, h, 0.32);
  const material = getOfficeColumnMaterial();
  if (material?.isNodeMaterial) geometry.computeTangents();
  const pillar = new THREE.Mesh(geometry, material);
  pillar.position.y = h * 0.5;
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  col.add(pillar);

  const stripH = h - 0.35;
  for (const x of [-0.21, 0.21]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.045, stripH, 0.025), stripMaterial);
    strip.position.set(x, stripH * 0.5 + 0.08, 0.1);
    col.add(strip);
  }
  return col;
}

export function addLobbyColumns({
  floorGroup,
  layout,
  originMinX,
  originMinZ,
  floorY,
  wallHeight,
  cw,
  cd,
  lightBudget = null,
  accentHex = null,
}) {
  const lobby = layout.elevatorLobby;
  const elev = layout.elevatorCell;
  if (!lobby || !elev) return null;

  const lcX = originMinX + (lobby.gx + 0.5) * cw;
  const lcZ = originMinZ + (lobby.gz + 0.5) * cd;
  const ecX = originMinX + (elev.x + 0.5) * cw;
  const ecZ = originMinZ + (elev.z + 0.5) * cd;
  const dx = lcX - ecX;
  const dz = lcZ - ecZ;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;
  const spread = Math.min(cw, cd) * 0.44;

  const root = new THREE.Group();
  root.name = 'Elevator Lobby Columns';

  const stripMat = accentHex != null
    ? LIGHT_STRIP_MATERIAL.clone()
    : LIGHT_STRIP_MATERIAL;
  if (accentHex != null) {
    stripMat.color.setHex(accentHex);
    stripMat.color.multiplyScalar(2.2);
  }

  for (const sign of [-1, 1]) {
    const col = buildColumn(wallHeight, stripMat);
    col.position.set(lcX + px * spread * sign, floorY, lcZ + pz * spread * sign);
    root.add(col);
    if (lightBudget) {
      const position = new THREE.Vector3(col.position.x, floorY + wallHeight * 0.72, col.position.z + 0.22);
      const target = new THREE.Vector3(lcX, floorY + wallHeight * 0.55, lcZ);
      lightBudget.add(createCoveAreaLight({ position, target, width: 0.35, height: 0.8, intensity: 3.2 }), floorGroup);
    }
  }

  floorGroup.add(root);
  return root;
}
