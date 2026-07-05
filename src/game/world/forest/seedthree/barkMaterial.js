import { MeshStandardNodeMaterial } from 'three';
import { barkWindPosition, instancedBarkWindPosition } from './wind.js';
import { disablePbrEnvironment } from '../../../materials/disablePbrEnvironment.js';

/** Bark material for hero / archetype trees (non-instanced). */
export function makeBarkMaterial(assets = {}) {
  const mat = new MeshStandardNodeMaterial({
    map: assets.barkTexture ?? null,
    normalMap: assets.barkNormal ?? null,
    roughnessMap: assets.barkRoughness ?? null,
    color: assets.barkTexture ? 0xffffff : 0x6b5540,
    roughness: assets.barkRoughness ? 1.0 : 0.92,
    metalness: 0.0,
  });
  mat.positionNode = barkWindPosition();
  disablePbrEnvironment(mat);
  return mat;
}

const forestBarkMats = new WeakMap();

/** Instanced forest twin — NodeMaterial.clone() drops texture maps under WebGPU. */
export function forestBarkMaterial(srcMat) {
  let mat = forestBarkMats.get(srcMat);
  if (mat) return mat;
  mat = new MeshStandardNodeMaterial({
    map: srcMat.map,
    normalMap: srcMat.normalMap,
    roughnessMap: srcMat.roughnessMap,
    color: srcMat.color.clone(),
    roughness: srcMat.roughness,
    metalness: srcMat.metalness,
  });
  mat.positionNode = instancedBarkWindPosition();
  disablePbrEnvironment(mat);
  srcMat.addEventListener('dispose', () => {
    mat.dispose();
    forestBarkMats.delete(srcMat);
  });
  forestBarkMats.set(srcMat, mat);
  return mat;
}
