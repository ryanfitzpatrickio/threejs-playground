// officeWallTrim.js — baseboard + cove light strips proud of both wall faces.

import * as THREE from 'three';
import { getOfficeAluminumMaterial } from './officeGlassMaterial.js';
import { createCoveAreaLight, getOfficeLightStripMaterial } from './officeLighting.js';

const BASEBOARD_MATERIAL = getOfficeAluminumMaterial();
const COVE_MATERIAL = getOfficeLightStripMaterial();

const BASE_H = 0.09;
const COVE_H = 0.06;
const COVE_DEPTH = 0.035;
const FACE_OUTSET = 0.028;

function addTrimOnFace(floorGroup, cx, cy, cz, span, faceAxis, sign, isCove, lightBudget) {
  const h = isCove ? COVE_H : BASE_H;
  const mat = isCove ? COVE_MATERIAL : BASEBOARD_MATERIAL;
  const y = isCove ? cy + h * 0.5 : cy;
  const geom = faceAxis === 'z'
    ? new THREE.BoxGeometry(span, h, COVE_DEPTH)
    : new THREE.BoxGeometry(COVE_DEPTH, h, span);
  const mesh = new THREE.Mesh(geom, mat);
  if (faceAxis === 'z') {
    mesh.position.set(cx, y, cz + sign * FACE_OUTSET);
  } else {
    mesh.position.set(cx + sign * FACE_OUTSET, y, cz);
  }
  mesh.receiveShadow = !isCove;
  floorGroup.add(mesh);
  if (isCove && lightBudget) {
    // RectAreaLight width does not extend its useful wall wash far beyond the
    // emitter centre. Tile overlapping emitters along long strips so the wash
    // remains continuous instead of forming one bright patch in the middle.
    const count = Math.max(1, Math.ceil(span / 2.2));
    const segment = span / count;
    for (let i = 0; i < count; i += 1) {
      const along = -span * 0.5 + segment * (i + 0.5);
      const position = mesh.position.clone();
      if (faceAxis === 'z') position.x += along;
      else position.z += along;
      position.y -= 0.035;
      const target = position.clone();
      if (faceAxis === 'z') target.z += sign * 0.48;
      else target.x += sign * 0.48;
      target.y -= 0.38;
      if (!lightBudget.add(createCoveAreaLight({
        position,
        target,
        width: segment + 0.38,
        intensity: 5.4,
      }), floorGroup)) break;
    }
  }
}

/** Cove + baseboard on both corridor faces of an axis-aligned wall segment. */
export function addWallTrimSegment(
  floorGroup,
  cx,
  cz,
  sx,
  sz,
  floorY,
  wallHeight,
  lightBudget = null,
  includeCove = true,
) {
  const alongX = sx >= sz;
  const span = alongX ? sx : sz;
  const halfThick = (alongX ? sz : sx) * 0.5;

  if (alongX) {
    for (const sign of [-1, 1]) {
      addTrimOnFace(floorGroup, cx, floorY + BASE_H * 0.5, cz + sign * halfThick, span, 'z', sign, false, lightBudget);
      if (includeCove) addTrimOnFace(floorGroup, cx, floorY + wallHeight - COVE_H, cz + sign * halfThick, span, 'z', sign, true, lightBudget);
    }
  } else {
    for (const sign of [-1, 1]) {
      addTrimOnFace(floorGroup, cx + sign * halfThick, floorY + BASE_H * 0.5, cz, span, 'x', sign, false, lightBudget);
      if (includeCove) addTrimOnFace(floorGroup, cx + sign * halfThick, floorY + wallHeight - COVE_H, cz, span, 'x', sign, true, lightBudget);
    }
  }
}

export function addPartitionWallTrim({
  floorGroup,
  layout,
  origin,
  floorY,
  wallHeight,
  skipElevatorShell = true,
  lightBudget = null,
}) {
  for (const w of layout.walls ?? []) {
    if (w.zone === 'meeting') continue;
    if (w.zone === 'elevator' && skipElevatorShell) continue;
    addWallTrimSegment(
      floorGroup,
      origin.x + w.cx,
      origin.z + w.cz,
      w.sx,
      w.sz,
      floorY,
      wallHeight,
      lightBudget,
    );
  }
}
