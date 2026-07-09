import * as THREE from 'three';
import { PMREMGenerator } from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const SRGB_MAP_KEYS = ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'];

export function applyBodyshopMaterialMaps(material) {
  if (!material) return material;
  for (const key of SRGB_MAP_KEYS) {
    const map = material[key];
    if (map) map.colorSpace = THREE.SRGBColorSpace;
  }
  material.side = THREE.DoubleSide;
  material.needsUpdate = true;
  return material;
}

export function prepareBodyshopGltfMaterials(root) {
  if (!root) return;
  root.traverse((child) => {
    if (!child.isMesh) return;
    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => {
        if (!material) return material;
        return applyBodyshopMaterialMaps(material.clone());
      });
      return;
    }
    child.material = applyBodyshopMaterialMaps(child.material.clone());
  });
}

export function setBodyshopMeshWireframe(root, enabled = false) {
  if (!root) return;
  root.traverse((child) => {
    if (!child.isMesh || child.userData._builderHelper || child.userData._frameReference) return;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      if (enabled) {
        if (material.userData._bodyshopWireframeSaved == null) {
          material.userData._bodyshopWireframeSaved = {
            wireframe: material.wireframe === true,
            transparent: material.transparent === true,
            opacity: material.opacity ?? 1,
            depthWrite: material.depthWrite !== false,
          };
        }
        material.wireframe = true;
        material.transparent = true;
        material.opacity = 0.42;
        material.depthWrite = false;
      } else if (material.userData._bodyshopWireframeSaved) {
        const saved = material.userData._bodyshopWireframeSaved;
        material.wireframe = saved.wireframe;
        material.transparent = saved.transparent;
        material.opacity = saved.opacity;
        material.depthWrite = saved.depthWrite;
        delete material.userData._bodyshopWireframeSaved;
      } else {
        material.wireframe = false;
        material.transparent = false;
        material.opacity = 1;
        material.depthWrite = true;
      }
      material.needsUpdate = true;
    }
  });
}

export async function installBodyshopEnvironment(renderer, scene, {
  intensity = 0.9,
} = {}) {
  if (!renderer || !scene) return null;
  const pmrem = new PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const target = pmrem.fromScene(environment, 0.04);
  scene.environment = target.texture;
  scene.environmentIntensity = intensity;
  pmrem.dispose();
  environment.dispose?.();
  return target;
}

export function configureBodyshopRenderer(renderer, {
  exposure = 1.05,
} = {}) {
  if (!renderer) return;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
}

export function liftObjectToFloor(object, floorY = 0, clearance = 0.04) {
  if (!object) return 0;
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return 0;
  const lift = floorY - bounds.min.y + clearance;
  object.position.y += lift;
  object.updateMatrixWorld(true);
  return lift;
}
