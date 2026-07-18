// Framework-free runtime factory for the vendored vibe-human character.
//
// Ports the model-facing logic of upstream HumanModel.tsx (React) into a
// plain factory: GLB load, head/body/eye material assignment, morph-target
// application from an appearance preset, WebGPU de-interleave, and
// normalization to a real-world height with feet at y=0.
//
// The GLB has NO named materials (primitives carry no material index), so
// classification relies on the upstream geometry-Y-bounds heuristics plus
// the Eye_L / Eye_R node names. Raw model height is ~3.49 units.

import * as THREE from 'three';
import { clone as cloneSkinnedObject } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { disposeObject3D } from '../../utils/disposeObject3D.js';
import {
  createSkinMaterial,
  createBodySkinMaterial,
  createEyeMaterial,
  setSkinTextureBasePath,
} from '../../../vendor/vibe-human/skinMaterial.ts';
import { buildModelingMorphs } from '../../../vendor/vibe-human/characterModeling.ts';
import { buildFacsMorphs, createNeutralFacsValues } from '../../../vendor/vibe-human/facs.ts';
import { reparentRigifySkeleton } from './rigifySkeleton.js';

export const SIMHUMAN_MODEL_URL = '/assets/simhuman/human5.glb';
/** Optional prepared bodies under /assets/simhuman/ (see scripts/prepare-simhuman.mjs). */
export const SIMHUMAN_BODY_ALIASES = Object.freeze({
  human5: '/assets/simhuman/human5.glb',
  default: '/assets/simhuman/human5.glb',
  humanoid: '/assets/simhuman/humanoid-base.glb',
  'humanoid-base': '/assets/simhuman/humanoid-base.glb',
  male: '/assets/simhuman/ubc-male.glb',
  'ubc-male': '/assets/simhuman/ubc-male.glb',
  superhero_male: '/assets/simhuman/ubc-male.glb',
  female: '/assets/simhuman/ubc-female.glb',
  'ubc-female': '/assets/simhuman/ubc-female.glb',
  superhero_female: '/assets/simhuman/ubc-female.glb',
});
export const SIMHUMAN_TEXTURE_BASE = '/assets/simhuman/';
export const SIMHUMAN_DEFAULT_HEIGHT = 1.75;

/** Resolve a body alias, absolute asset path, or default human5 URL. */
export function resolveSimHumanModelUrl(modelUrl = null) {
  if (!modelUrl) return SIMHUMAN_MODEL_URL;
  const key = String(modelUrl).trim();
  if (SIMHUMAN_BODY_ALIASES[key]) return SIMHUMAN_BODY_ALIASES[key];
  if (key.startsWith('/')) return key;
  return SIMHUMAN_MODEL_URL;
}

// Upstream HumanModel.tsx geometry classification constants (model units).
const HEAD_GEOMETRY_MIN_Y = 2.65;
const BODY_GEOMETRY_MAX_Y = 3.0;
const BODY_GEOMETRY_MIN_HEIGHT = 1.5;
const EYE_NODE_NAMES = new Set(['Eye_L', 'Eye_R']);

// Y bounds from the raw position attribute — NOT geometry.boundingBox, which
// three expands by morph-target displacement (217 morphs inflate the head
// prim's box to ~1.2..5.1 and break the upstream min/max classification).
const boundsCache = new WeakMap();

function geometryYBounds(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) return null;
  const cached = boundsCache.get(position);
  if (cached) return cached;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const bounds = { min, max, height: max - min };
  boundsCache.set(position, bounds);
  return bounds;
}

function isHeadGeometry(mesh) {
  const bounds = geometryYBounds(mesh);
  return Boolean(bounds && bounds.min >= HEAD_GEOMETRY_MIN_Y);
}

function isBodyGeometry(mesh) {
  const bounds = geometryYBounds(mesh);
  return Boolean(
    bounds
    && bounds.min < HEAD_GEOMETRY_MIN_Y
    && bounds.max <= BODY_GEOMETRY_MAX_Y
    && bounds.height >= BODY_GEOMETRY_MIN_HEIGHT,
  );
}

function isEyeMesh(object) {
  if (!object.isMesh) return false;
  for (let node = object; node; node = node.parent) {
    if (EYE_NODE_NAMES.has(node.name)) return true;
  }
  return false;
}

// Head/body materials are shared across model instances (they hold ~8
// textures each); created once, never disposed by instances.
let sharedMaterialsPromise = null;

function loadSharedMaterials() {
  if (!sharedMaterialsPromise) {
    setSkinTextureBasePath(SIMHUMAN_TEXTURE_BASE);
    sharedMaterialsPromise = Promise.all([
      createSkinMaterial(),
      createBodySkinMaterial(),
      createEyeMaterial(),
    ]).then(([head, body, eye]) => ({ head, body, eye }));
  }
  return sharedMaterialsPromise;
}

function createSolidMaterials() {
  const solid = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.25, metalness: 0 });
  return { head: solid, body: solid, eye };
}

/** True when the loaded scene already carries textured materials worth keeping. */
function gltfHasTexturedMaterials(root) {
  let found = false;
  root.traverse((child) => {
    if (found || !child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.emissiveMap) {
        found = true;
        return;
      }
    }
  });
  return found;
}

/** Ensure source GLB materials render under WebGPU (color space, side, shadows). */
function prepareSourceMaterial(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if (!mat) continue;
    mat.side = THREE.FrontSide;
    if (mat.map) {
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.needsUpdate = true;
    }
    if (mat.emissiveMap) {
      mat.emissiveMap.colorSpace = THREE.SRGBColorSpace;
    }
    // glTF roughness/metalness maps stay linear
    mat.needsUpdate = true;
  }
}

/**
 * @param {object} [options]
 * @param {object|null} [options.appearance] sanitized sim appearance preset
 * @param {number} [options.targetHeight] world height in meters (feet at y=0)
 * @param {'skin'|'solid'|'source'|'auto'} [options.materials]
 *   - 'skin': vibe-human TSL head/body/eye materials (human5 UVs)
 *   - 'solid': flat standard materials (probes / no textures)
 *   - 'source': keep materials embedded in the GLB (UBC etc.)
 *   - 'auto': 'source' when the GLB already has textured materials, else 'skin'
 * @param {string|null} [options.modelUrl] body alias (`humanoid`) or `/assets/...` path
 */
export async function createVibeHumanModel({
  appearance = null,
  targetHeight = SIMHUMAN_DEFAULT_HEIGHT,
  materials: materialMode = 'auto',
  modelUrl = null,
} = {}) {
  const resolvedUrl = resolveSimHumanModelUrl(modelUrl);
  // Always load the GLB first so 'auto' can inspect embedded materials.
  const gltf = await createGltfLoader().loadAsync(resolvedUrl);
  const object = gltf.scene;
  if (!object) throw new Error(`Sim human model has no glTF scene: ${resolvedUrl}`);

  let mode = materialMode;
  if (mode === 'auto') {
    mode = gltfHasTexturedMaterials(object) ? 'source' : 'skin';
  }

  const mats = mode === 'skin'
    ? await loadSharedMaterials()
    : mode === 'solid'
      ? createSolidMaterials()
      : null;

  object.name = 'vibe-human';
  object.updateMatrixWorld(true);
  flattenObjectForWebGPU(object);

  // The export ships a flat DEF skeleton; rebuild the anatomical hierarchy so
  // bone-local animation propagates (world transforms preserved — skinning
  // and inverseBindMatrices are unaffected). See rigifySkeleton.js.
  const reparentReport = reparentRigifySkeleton(object);
  if (reparentReport.missing.length > 0) {
    console.warn('[simhuman] skeleton reparent missing bones:', reparentReport.missing);
  }

  const morphMeshes = [];
  const skinnedMeshes = [];
  const bones = {};
  let headMeshCount = 0;
  let bodyMeshCount = 0;

  object.traverse((child) => {
    if (child.isSkinnedMesh) {
      skinnedMeshes.push(child);
      for (const bone of child.skeleton?.bones ?? []) bones[bone.name] = bone;
    }
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.frustumCulled = false;

    if (child.morphTargetDictionary && child.morphTargetInfluences) {
      morphMeshes.push(child);
    }

    // 'source' keeps GLB materials (author albedo/normal/roughness).
    if (mode === 'source') {
      prepareSourceMaterial(child);
      if (isHeadGeometry(child)) headMeshCount += 1;
      else if (isBodyGeometry(child) || !isEyeMesh(child)) bodyMeshCount += 1;
      return;
    }

    if (isEyeMesh(child)) {
      child.material = mats.eye;
    } else if (isHeadGeometry(child)) {
      child.material = mats.head;
      headMeshCount += 1;
    } else if (isBodyGeometry(child)) {
      child.material = mats.body;
      bodyMeshCount += 1;
    } else {
      child.material = mats.body;
    }
  });

  if (mode !== 'source' && (headMeshCount === 0 || bodyMeshCount === 0)) {
    console.warn(`[simhuman] mesh classification unexpected: head=${headMeshCount} body=${bodyMeshCount}`);
  }

  for (const mesh of skinnedMeshes) mesh.skeleton?.update();

  // Normalize: wrap so feet sit at y=0 and total height is targetHeight.
  // Bounds from position attributes (morph-inflation-safe, see geometryYBounds).
  let rawMinY = Infinity;
  let rawMaxY = -Infinity;
  for (const mesh of skinnedMeshes) {
    const bounds = geometryYBounds(mesh);
    if (!bounds) continue;
    rawMinY = Math.min(rawMinY, bounds.min);
    rawMaxY = Math.max(rawMaxY, bounds.max);
  }
  if (!Number.isFinite(rawMinY)) {
    rawMinY = 0;
    rawMaxY = 1;
  }
  const rawHeight = Math.max(1e-6, rawMaxY - rawMinY);
  const scale = targetHeight / rawHeight;

  const group = new THREE.Group();
  group.name = 'sim-human';
  object.scale.setScalar(scale);
  object.position.y = -rawMinY * scale;
  group.add(object);

  function applyAppearance(nextAppearance) {
    applyAppearanceToMeshes(morphMeshes, nextAppearance);
  }

  if (appearance) applyAppearance(appearance);

  return {
    group,
    object,
    skinnedMeshes,
    morphMeshes,
    bones,
    rawHeight,
    scale,
    animations: gltf.animations ?? [],
    applyAppearance,
    materialMode: mode,
    dispose() {
      group.removeFromParent();
      for (const mesh of skinnedMeshes) mesh.skeleton?.dispose?.();
      if (mode === 'skin') {
        // Shared skin materials must survive other instances — geometry only.
        group.traverse((child) => child.geometry?.dispose?.());
      } else {
        disposeObject3D(group);
      }
    },
  };
}

/** Clone one loaded/flattened template while preserving independent skeletons and morph weights. */
export function cloneVibeHumanModel(template, appearance = null) {
  const group = cloneSkinnedObject(template.group);
  const object = group.getObjectByName('vibe-human') ?? group.children[0];
  const skinnedMeshes = [];
  const morphMeshes = [];
  const bones = {};
  group.traverse((child) => {
    if (child.isSkinnedMesh) {
      skinnedMeshes.push(child);
      for (const bone of child.skeleton?.bones ?? []) bones[bone.name] = bone;
    }
    if (child.morphTargetDictionary && child.morphTargetInfluences) morphMeshes.push(child);
  });
  const applyAppearance = (nextAppearance) => applyAppearanceToMeshes(morphMeshes, nextAppearance);
  if (appearance) applyAppearance(appearance);
  return {
    group,
    object,
    skinnedMeshes,
    morphMeshes,
    bones,
    rawHeight: template.rawHeight,
    scale: template.scale,
    applyAppearance,
    dispose() {
      group.removeFromParent();
      for (const mesh of skinnedMeshes) mesh.skeleton?.dispose?.();
    },
  };
}

function applyAppearanceToMeshes(morphMeshes, appearance) {
  const morphTargets = {
    ...buildModelingMorphs(appearance?.morphs ?? {}),
    ...buildFacsMorphs({ ...createNeutralFacsValues(), ...(appearance?.facs ?? {}) }),
  };
  for (const mesh of morphMeshes) {
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      mesh.morphTargetInfluences[index] = morphTargets[name] ?? 0;
    }
  }
}
