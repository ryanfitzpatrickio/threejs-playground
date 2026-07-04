import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { ClothColliderEditorRuntime } from './ClothColliderEditorRuntime.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { transferSkinWeightsBySurface } from './transferSkinWeightsBySurface.js';

// Jacket asset. Place your matching jacket.fbx (or .glb) here.
// It must be skinned to bones with the same names as the player (mixamorig*).
// The FBX should be in the same default pose as the player model.
const JACKET_MODEL_URL = '/assets/models/jacket.glb';

// Dedicated simulation mask, separate from the jacket's display vertex colors.
// SimpleCloth reads its green channel: 0 is free cloth and 1 follows skinning.
function ensureClothMask(geometry, skeleton, jacketName = 'Jacket') {
  if (!geometry) return;
  if (geometry.attributes.clothWeight) {
    return;
  }

  const pos = geometry.attributes.position;
  if (!pos) return;

  const count = pos.count;
  const colors = new Float32Array(count * 3);

  // Very rough bounds-based heuristic. Tune these numbers after inspecting your jacket
  // in world units (after the player's normalize scale is applied).
  // Typical player is ~1.7m tall. Jacket torso roughly y ~0.9..1.5 .
  const box = geometry.boundingBox;
  if (!box) {
    geometry.computeBoundingBox();
  }
  const minY = (geometry.boundingBox?.min.y ?? 0);
  const maxY = (geometry.boundingBox?.max.y ?? 1.6);
  const height = Math.max(0.01, maxY - minY);
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const transferDistance = geometry.getAttribute('skinTransferDistance');

  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);

    // Normalized local height (0 at bottom hem, 1 at top collar)
    const t = (y - minY) / height;

    let pin = transferredPinWeight({ vertex: i, skinIndex, skinWeight, skeleton });
    if (pin == null) {
      pin = t > 0.82 ? 1 : t > 0.55 ? 0.86 : t > 0.18 ? 0.72 : 0.38;
    }

    // This jacket is a fitted garment first and a cloth experiment second.
    // Let only the lower hem breathe; releasing the torso/front panels makes
    // the coat explode open around the Mesh2Motion body.
    if (t < 0.08) {
      pin = Math.min(pin, 0.24);
    } else if (t < 0.18) {
      pin = Math.min(pin, 0.52);
    } else {
      pin = Math.max(pin, 0.72);
    }

    if (transferDistance) {
      const distanceRelease = THREE.MathUtils.clamp((transferDistance.getX(i) - 0.06) / 0.12, 0, 1);
      pin *= 1 - distanceRelease * 0.25;
      if (t >= 0.18) pin = Math.max(pin, 0.62);
    }

    // Let the back move slightly more freely than the front.
    if (z < -0.05 && t > 0.3 && t < 0.75) {
      pin = Math.max(0.62, pin - 0.04);
    }

    pin = THREE.MathUtils.clamp(pin, 0, 1);

    colors[i * 3 + 0] = pin;
    colors[i * 3 + 1] = pin;
    colors[i * 3 + 2] = pin;
  }

  geometry.setAttribute('clothWeight', new THREE.BufferAttribute(colors, 3));
  // Mark for update in case anything reads it immediately
  geometry.attributes.clothWeight.needsUpdate = true;

  console.log(`[jacket] Applied procedural cloth mask to ${jacketName} (${count} verts)`);
}

function findFirstSkinnedMesh(root) {
  let found = null;
  root.traverse((child) => {
    if (!found && child.isSkinnedMesh) {
      found = child;
    }
  });
  return found;
}

function assetUrl(url) {
  // Matches the logic inside createMaraFbxModel
  // In dev it works with /assets, prod serves from same.
  return url;
}

export async function attachJacketCloth(character, renderer) {
  if (!character || !renderer) return null;
  if (renderer.isWebGPURenderer !== true) {
    console.warn('[jacket] three-simplecloth requires WebGPURenderer. Skipping jacket cloth.');
    return null;
  }
  if (!character.animationController?.modelRoot) {
    console.warn('[jacket] No modelRoot on character, cannot attach cloth jacket.');
    return null;
  }

  const modelRoot = character.animationController.modelRoot;

  // Find the body skinned mesh so we can share its skeleton
  const bodySkinned = findFirstSkinnedMesh(modelRoot);
  if (!bodySkinned || !bodySkinned.skeleton) {
    console.warn('[jacket] Could not find body SkinnedMesh + skeleton to share.');
    return null;
  }

  const isGlb = JACKET_MODEL_URL.toLowerCase().endsWith('.glb') || JACKET_MODEL_URL.toLowerCase().endsWith('.gltf');
  const baseLoader = isGlb ? createGltfLoader() : new FBXLoader();

  let jacketRoot;
  try {
    const loaded = await baseLoader.loadAsync(assetUrl(JACKET_MODEL_URL));
    jacketRoot = isGlb ? (loaded.scene || loaded) : loaded;
  } catch (err) {
    console.warn(`[jacket] Failed to load jacket at ${JACKET_MODEL_URL}. Skipping cloth.`, err);
    return null;
  }

  const jacketMesh = findFirstSkinnedMesh(jacketRoot);
  if (!jacketMesh) {
    console.warn('[jacket] Loaded jacket asset but found no SkinnedMesh inside.');
    return null;
  }

  flattenObjectForWebGPU(jacketRoot);
  jacketMesh.geometry = jacketMesh.geometry.clone();
  stripUnusedColorAttributes(jacketMesh.geometry);
  styleJacketMaterial(jacketMesh);

  modelRoot.updateWorldMatrix(true, false);
  bodySkinned.updateWorldMatrix(true, false);
  const bodyToModel = new THREE.Matrix4()
    .copy(modelRoot.matrixWorld)
    .invert()
    .multiply(bodySkinned.matrixWorld);
  const jacketToBody = bodyToModel.clone().invert();

  if (character.skeletonSource === 'mesh2motion') {
    // Fit the centimeter-authored jacket geometry into the new player's meter-
    // scale torso before SimpleCloth captures its simulation buffers.
    jacketMesh.geometry.scale(0.78, 0.92, 0.82);
    jacketMesh.geometry.translate(0, 0.62, 0.035);
    jacketMesh.geometry.computeBoundingBox();
    jacketMesh.geometry.computeBoundingSphere();
    character.jacketSkinTransfer = transferSkinWeightsBySurface({
      sourceGeometry: bodySkinned.geometry,
      targetGeometry: jacketMesh.geometry,
      targetToSource: jacketToBody,
    });
    jacketMesh.geometry.applyMatrix4(jacketToBody);
    console.info('[jacket] Transferred player skin weights to jacket.', character.jacketSkinTransfer);
  } else {
    remapSkinIndices({
      geometry: jacketMesh.geometry,
      sourceSkeleton: jacketMesh.skeleton,
      targetSkeleton: bodySkinned.skeleton,
    });
  }
  jacketMesh.skeleton = bodySkinned.skeleton;
  try {
    jacketMesh.bind(bodySkinned.skeleton, bodySkinned.bindMatrix.clone());
  } catch {}
  jacketMesh.skeleton.update();

  const jacketSocket = new THREE.Group();
  jacketSocket.name = `JacketSocket_${character.modelId ?? 'player'}`;
  modelRoot.add(jacketSocket);
  jacketSocket.add(jacketMesh);
  character.jacketSocket = jacketSocket;

  bodyToModel.decompose(jacketMesh.position, jacketMesh.quaternion, jacketMesh.scale);

  // Ensure we have a color attribute the cloth lib can use as the cloth/stick mask.
  ensureClothMask(jacketMesh.geometry, bodySkinned.skeleton, jacketMesh.name || 'Jacket');

  const colliderEditor = new ClothColliderEditorRuntime({
    modelRoot,
    clothMesh: jacketMesh,
    jacketSocket,
    skinTransferStats: character.jacketSkinTransfer,
    modelId: character.modelId,
    skeletonSource: character.skeletonSource,
  });
  character.clothColliderEditor = colliderEditor;

  // Initialize the WebGPU cloth simulation.
  // three-simplecloth will rewrite the material to TSL compute cloth.
  const { SimpleCloth } = await import('three-simplecloth');

  const clothSim = SimpleCloth.onSkinnedMesh(jacketMesh, renderer, {
    collidersRoot: modelRoot,
    colorAttributeName: 'clothWeight',
    colliderRadiusMultiplier: 1.08,
    stiffness: 0.75,
    dampening: 0.88,
    // You can add wind/gravity here:
    // windPerSecond: new THREE.Vector3(0.8, 0.2, 0.0),
    // gravityPerSecond: new THREE.Vector3(0, -9.8, 0),
    logStats: false,
  });
  colliderEditor.bindCloth(clothSim);

  // Store on character for per-frame update + cleanup
  character.jacketCloth = clothSim;
  character.jacketMesh = jacketMesh;

  console.log('[jacket] three-simplecloth initialized on jacket SkinnedMesh.');

  return clothSim;
}

function remapSkinIndices({ geometry, sourceSkeleton, targetSkeleton }) {
  const skinIndex = geometry?.getAttribute?.('skinIndex');
  const skinWeight = geometry?.getAttribute?.('skinWeight');
  if (!skinIndex || !skinWeight || !sourceSkeleton?.bones?.length || !targetSkeleton?.bones?.length) {
    return;
  }

  const targetIndexByName = new Map(
    targetSkeleton.bones.map((bone, index) => [normalizeBoneName(bone.name), index]),
  );
  const indexMap = sourceSkeleton.bones.map((bone) => targetIndexByName.get(normalizeBoneName(bone.name)) ?? null);
  const remappedIndices = new Uint16Array(skinIndex.count * 4);
  const remappedWeights = new Float32Array(skinIndex.count * 4);

  for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
    let total = 0;
    for (let component = 0; component < Math.min(4, skinIndex.itemSize); component += 1) {
      const mapped = indexMap[skinIndex.getComponent(vertex, component)];
      const weight = mapped == null ? 0 : skinWeight.getComponent(vertex, component);
      if (mapped != null) remappedIndices[vertex * 4 + component] = mapped;
      remappedWeights[vertex * 4 + component] = weight;
      total += weight;
    }
    if (total > 0) {
      for (let component = 0; component < 4; component += 1) remappedWeights[vertex * 4 + component] /= total;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(remappedIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(remappedWeights, 4));
}

function transferredPinWeight({ vertex, skinIndex, skinWeight, skeleton }) {
  if (!skinIndex || !skinWeight || !skeleton) return null;
  let dominantIndex = 0;
  let dominantWeight = -1;
  for (let component = 0; component < Math.min(4, skinWeight.itemSize); component += 1) {
    const weight = skinWeight.getComponent(vertex, component);
    if (weight > dominantWeight) {
      dominantWeight = weight;
      dominantIndex = skinIndex.getComponent(vertex, component);
    }
  }
  const bone = normalizeBoneName(skeleton.bones[dominantIndex]?.name);
  if (/spine2|neck|shoulder/.test(bone)) return 1;
  if (/spine1|spine/.test(bone)) return 0.9;
  if (/hips/.test(bone)) return 0.82;
  if (/forearm/.test(bone)) return 0.88;
  if (/hand/.test(bone)) return 0.8;
  if (/arm/.test(bone)) return 0.92;
  return 0.65;
}

function stripUnusedColorAttributes(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (/^color(?:_\d+)?$/i.test(name)) geometry.deleteAttribute(name);
  }
}

function styleJacketMaterial(jacketMesh) {
  const materials = Array.isArray(jacketMesh.material) ? jacketMesh.material : [jacketMesh.material];
  const styled = materials.map((material) => {
    const next = material?.clone?.() ?? new THREE.MeshStandardMaterial();
    next.name = material?.name || 'JacketMaterial';
    next.color?.set?.(0x25272a);
    if ('metalness' in next) next.metalness = 0.04;
    if ('roughness' in next) next.roughness = 0.86;
    next.side = THREE.DoubleSide;
    next.transparent = false;
    next.opacity = 1;
    next.depthWrite = true;
    next.needsUpdate = true;
    return next;
  });
  jacketMesh.material = Array.isArray(jacketMesh.material) ? styled : styled[0];
}

function normalizeBoneName(name) {
  return String(name).replace(/^mixamorig:?/i, '').toLowerCase();
}

export function disposeJacketCloth(character) {
  character?.clothColliderEditor?.dispose?.();
  if (character) character.clothColliderEditor = null;
  if (character?.jacketCloth) {
    // The lib owns some resources (compute pipelines, buffers). Best effort dispose.
    try {
      character.jacketCloth.dispose?.();
    } catch {}
    character.jacketCloth = null;
  }
  if (character?.jacketMesh) {
    character.jacketMesh.removeFromParent();
    character.jacketMesh.geometry?.dispose?.();
    if (character.jacketMesh.material) {
      // May be replaced by the lib; dispose what we can.
      character.jacketMesh.material.dispose?.();
    }
    character.jacketMesh = null;
  }
  if (character?.jacketSocket) {
    character.jacketSocket.removeFromParent();
    character.jacketSocket = null;
  }
}
