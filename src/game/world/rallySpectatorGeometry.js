import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function setGeomColor(geometry, hex) {
  const color = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function coloredBox(w, h, d, cx, cy, cz, hex) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(cx, cy, cz);
  setGeomColor(geometry, hex);
  return geometry;
}

/** Low-poly static rally spectator — used for low-quality crowd and far imposters. */
export function createRallySpectatorGeometry() {
  const parts = [
    coloredBox(0.38, 0.68, 0.24, 0, 1.18, 0, 0xd8d2c3),
    coloredBox(0.16, 0.68, 0.17, -0.12, 0.5, 0, 0x34383c),
    coloredBox(0.16, 0.68, 0.17, 0.12, 0.5, 0, 0x34383c),
    coloredBox(0.13, 0.62, 0.13, -0.31, 1.35, 0, 0xd8d2c3),
    coloredBox(0.13, 0.82, 0.13, 0.29, 1.58, 0, 0xd8d2c3),
    coloredBox(0.27, 0.27, 0.25, 0, 1.72, 0, 0xd8b08a),
  ];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
}
