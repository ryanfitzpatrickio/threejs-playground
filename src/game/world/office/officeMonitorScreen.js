// officeMonitorScreen.js — emissive monitor/TV screens (reliable in WebGPU).

import * as THREE from 'three';

let _screenMaterial = null;

/** Standard emissive screen — avoids instanceIndex TSL issues that rendered solid black. */
export function getMonitorScreenMaterial() {
  if (!_screenMaterial) {
    _screenMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a0e14,
      emissive: 0x4a9cc8,
      emissiveIntensity: 1.35,
      roughness: 0.4,
      metalness: 0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    _screenMaterial.name = 'Office Monitor Screen';
    _screenMaterial.userData.officeMonitorScreen = true;
  }
  return _screenMaterial;
}

/** Node verify hook — procedural path kept for headless count checks only. */
export function createMonitorScreenMaterial() {
  return getMonitorScreenMaterial();
}

export const MONITOR_SCREEN_GEOMETRY = (() => {
  const g = new THREE.PlaneGeometry(0.48, 0.28);
  g.translate(0, 0, 0.028);
  return g;
})();
