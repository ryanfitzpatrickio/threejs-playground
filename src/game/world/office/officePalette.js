// officePalette.js — seeded accent color per building (docs/office-interior-fidelity-2-plan.md M5).

import * as THREE from 'three';
import { cellHash } from './officeFurniture.js';

/** Curated accent palette — one per building, repeated across chairs / feature wall / signage. */
export const OFFICE_ACCENT_PALETTE = [
  0x2a7a72, // teal
  0x9c4a38, // rust
  0xc9a227, // mustard
  0x6b8f71, // sage
  0x2c3e6b, // navy
  0x6b4a6e, // plum
];

const _accentColor = new THREE.Color();

export function getOfficeAccentIndex(seed) {
  return Math.floor(cellHash(seed | 0, 0, 0) * OFFICE_ACCENT_PALETTE.length);
}

export function getOfficeAccentHex(seed) {
  return OFFICE_ACCENT_PALETTE[getOfficeAccentIndex(seed)];
}

export function getOfficeAccentColor(seed, target = _accentColor) {
  return target.setHex(getOfficeAccentHex(seed));
}

/** Fabric / foliage tint: neutral base with a hint of the building accent. */
export function getOfficeFabricTint(seed, gx, gz, accentHex) {
  const h = cellHash(seed, gx, gz);
  const accent = _accentColor.setHex(accentHex);
  const neutral = 0.42 + h * 0.12;
  const mix = 0.22 + (h * 0.18);
  return new THREE.Color(
    neutral * (1 - mix) + accent.r * mix,
    neutral * (1 - mix) + accent.g * mix,
    neutral * (1 - mix) + accent.b * mix,
  );
}

/** Wall-art dominant block color from accent + instance hash. */
export function getOfficeArtColor(seed, propIndex, accentHex) {
  const h = cellHash(seed, propIndex + 41, propIndex + 73);
  const accent = _accentColor.setHex(accentHex);
  if (h < 0.34) return accent.clone().multiplyScalar(0.85 + h * 0.3);
  const neutral = 0.25 + h * 0.35;
  return new THREE.Color(neutral, neutral * 0.96, neutral * 1.04);
}
