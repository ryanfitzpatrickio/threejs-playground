// Warm, neutral office IBL shared by every cached interior.

import * as THREE from 'three';
import { PMREMGenerator } from 'three/webgpu';

const cache = new WeakMap();

function addPanel(scene, position, scale, color, intensity = 1) {
  const material = new THREE.MeshBasicMaterial({ color });
  material.color.multiplyScalar(intensity);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale[0], scale[1]), material);
  mesh.position.fromArray(position);
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);
}

export function createInteriorEnvironment(renderer, { size = 64 } = {}) {
  if (!renderer) return null;
  const cached = cache.get(renderer);
  if (cached) return cached.texture;

  const room = new THREE.Scene();
  room.background = new THREE.Color(0x8d8c89);
  addPanel(room, [0, 3.8, 0], [8, 8], 0xffe5bd, 2.2);
  addPanel(room, [-4, 0.8, 0], [6, 5], 0xd8d5ce, 0.9);
  addPanel(room, [4, 0.8, 0], [6, 5], 0x9aa5ad, 0.7);
  addPanel(room, [0, 0.8, -4], [8, 5], 0xb9b5ad, 0.75);
  addPanel(room, [0, 0.8, 4], [8, 5], 0x6c7076, 0.55);

  const generator = new PMREMGenerator(renderer);
  try {
    const target = generator.fromScene(room, 0.08, 0.1, 20, { size });
    target.texture.name = 'Office Interior PMREM';
    cache.set(renderer, target);
    return target.texture;
  } finally {
    generator.dispose();
    room.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
  }
}

export function installInteriorEnvironment(scene, renderer, options) {
  const texture = createInteriorEnvironment(renderer, options);
  if (!scene || !texture) return null;
  scene.environment = texture;
  scene.environmentIntensity = 0.82;
  scene.environmentRotation.y = Math.PI * 0.08;
  return texture;
}
