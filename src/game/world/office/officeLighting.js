import * as THREE from 'three';

export const OFFICE_COVE_COLOR = 0xffd9a0;

let stripMaterial = null;

/** Uniform warm LED diffuser. Unlit so every centimetre remains equally bright. */
export function getOfficeLightStripMaterial() {
  if (stripMaterial) return stripMaterial;
  const width = 64;
  const height = 8;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const edge = Math.min(y + 0.5, height - y - 0.5) / (height * 0.5);
    const diffuser = 0.72 + Math.sin(Math.min(1, edge) * Math.PI * 0.5) * 0.28;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = Math.round(255 * diffuser);
      data[i + 1] = Math.round(218 * diffuser);
      data[i + 2] = Math.round(158 * diffuser);
      data[i + 3] = 255;
    }
  }
  const map = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  map.name = 'Office Warm LED Diffuser';
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  stripMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  // HDR multiplier keeps the diffuser above the bloom threshold without making
  // it dependent on scene lights or exposure-derived standard shading.
  stripMaterial.color.setRGB(2.6, 2.6, 2.6);
  stripMaterial.name = 'Office Emissive LED Strip';
  stripMaterial.userData.officeEmissiveStrip = true;
  return stripMaterial;
}

export function createOfficeLightBudget(maxLights = 14) {
  return {
    maxLights,
    used: 0,
    add(light, parent) {
      if (!light || !parent || this.used >= this.maxLights) return false;
      parent.add(light);
      this.used += 1;
      return true;
    },
  };
}

export function createCoveAreaLight({
  position,
  target,
  width = 1.8,
  height = 0.12,
  intensity = 6.0,
} = {}) {
  const light = new THREE.RectAreaLight(OFFICE_COVE_COLOR, intensity, width, height);
  light.position.copy(position);
  light.lookAt(target);
  light.name = 'Office Cove RectAreaLight';
  light.userData.officeCoveLight = true;
  return light;
}
