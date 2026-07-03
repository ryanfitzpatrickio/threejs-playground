import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';

// Jacket asset. Place your matching jacket.fbx (or .glb) here.
// It must be skinned to bones with the same names as the player (mixamorig*).
// The FBX should be in the same default pose as the player model.
const JACKET_MODEL_URL = '/assets/models/jacket.glb';

// Heuristic vertex coloring for cloth pinning when the asset has no vertex colors.
// Red channel: 1.0 = full cloth simulation, 0.0 = fully skinned/pinned to body.
// Paint loose parts (body of jacket, lower sleeves, hem) red.
// Paint attachment zones (collar, upper shoulders, cuffs) white/gray.
function ensureClothMask(geometry, jacketName = 'Jacket') {
  if (!geometry) return;
  if (geometry.attributes.color) {
    // Already has colors from authoring (preferred).
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

  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);

    // Normalized local height (0 at bottom hem, 1 at top collar)
    const t = (y - minY) / height;

    // Pinned (white ~0) zones:
    // - Very top (collar/shoulders)
    // - Areas very close to center-line at upper torso
    // - Optionally wrist cuffs (high |x| + medium-high y on sleeves)
    let cloth = 1.0; // default full cloth

    if (t > 0.82) {
      // collar / upper shoulder attachment band
      cloth = 0.05;
    } else if (t > 0.65 && Math.abs(x) < 0.18) {
      // center upper back/chest stays tighter
      cloth = 0.15;
    } else if (Math.abs(x) > 0.42 && t > 0.55) {
      // outer upper sleeves near shoulder - transition
      cloth = 0.35;
    } else if (t < 0.12) {
      // bottom hem flops more
      cloth = 1.0;
    }

    // Optional: make front/back (by z) slightly different for style
    if (z < -0.05 && t > 0.3 && t < 0.75) {
      cloth = Math.min(1, cloth + 0.1); // back a bit freer
    }

    // Write grayscale into RGB (lib primarily samples red, but safe)
    colors[i * 3 + 0] = cloth;
    colors[i * 3 + 1] = cloth;
    colors[i * 3 + 2] = cloth;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Mark for update in case anything reads it immediately
  geometry.attributes.color.needsUpdate = true;

  console.log(`[jacket] Applied procedural cloth mask to ${jacketName} (${count} verts)`);
}

// Create simple invisible sphere colliders attached to bones.
// These drive collision so the jacket doesn't sink through the body.
function createBoneColliders(modelRoot) {
  // Tune radii + offsets for your exact character scale and jacket fit.
  // Attach to the bone so they move automatically with animation.
  const specs = [
    // Torso / spine (main body collider)
    { bone: 'mixamorigSpine', radius: 0.32, offset: [0, 0.05, 0.0] },
    { bone: 'mixamorigSpine1', radius: 0.28, offset: [0, 0.0, 0.0] },
    { bone: 'mixamorigSpine2', radius: 0.26, offset: [0, 0.05, 0.0] },

    // Hips / pelvis area
    { bone: 'mixamorigHips', radius: 0.30, offset: [0, 0.0, 0.0] },

    // Upper arms (shoulder area)
    { bone: 'mixamorigLeftArm', radius: 0.13, offset: [0.0, 0.0, 0.0] },
    { bone: 'mixamorigRightArm', radius: 0.13, offset: [0.0, 0.0, 0.0] },

    // Forearms
    { bone: 'mixamorigLeftForeArm', radius: 0.10, offset: [0.0, 0.0, 0.0] },
    { bone: 'mixamorigRightForeArm', radius: 0.10, offset: [0.0, 0.0, 0.0] },
  ];

  const added = [];

  for (const spec of specs) {
    const bone = findBoneFlexible(modelRoot, spec.bone);
    if (!bone) {
      // Bone names can vary slightly between exports (mixamorig vs mixamo, colon).
      continue;
    }

    const geo = new THREE.SphereGeometry(spec.radius, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const collider = new THREE.Mesh(geo, mat);
    collider.name = `ClothCollider_${spec.bone}`;
    // Use the actual bone name from the skeleton for stickto (important for the lib)
    const stickName = bone.name;
    collider.userData = {
      clothCollider: true,
      stickto: stickName,
    };

    if (spec.offset) {
      collider.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
    }

    bone.add(collider);
    added.push(collider);
  }

  if (added.length === 0) {
    console.warn('[jacket] No matching bones found for cloth colliders. Jacket may clip. Check bone names.');
  } else {
    console.log(`[jacket] Added ${added.length} bone colliders for cloth sim.`);
  }

  return added;
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

// Find a bone by name, tolerant of "mixamorigHips" vs "mixamorig:Hips" etc.
// (FBXLoader strips colon, GLTF may keep it, project code normalizes in many places)
function findBoneFlexible(root, name) {
  if (!root || !name) return null;
  let bone = root.getObjectByName(name);
  if (bone) return bone;

  // Try common Mixamo variants
  const variants = [
    name,
    name.replace(/^mixamorig:?/i, 'mixamorig'),
    name.replace(/^mixamorig:?/i, 'mixamorig:'),
    name.replace(/:/g, ''),
    name.replace(/mixamorig/i, 'mixamorig:'),
  ];
  for (const v of variants) {
    bone = root.getObjectByName(v);
    if (bone && bone.isBone) return bone;
  }

  // Last resort: fuzzy search
  const clean = name.toLowerCase().replace(/[^a-z]/g, '');
  let found = null;
  root.traverse((c) => {
    if (found) return;
    if (c.isBone) {
      const cclean = c.name.toLowerCase().replace(/[^a-z]/g, '');
      if (cclean === clean || cclean.endsWith(clean) || clean.endsWith(cclean)) {
        found = c;
      }
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

  // Share the exact skeleton instance. This is critical for the cloth sim
  // to know the current bone poses of the body underneath.
  jacketMesh.skeleton = bodySkinned.skeleton;

  // Re-bind using the body's bind matrix for consistency.
  try {
    jacketMesh.bind(bodySkinned.skeleton, bodySkinned.bindMatrix.clone());
  } catch (e) {
    // Some exports are already bound; ignore if it complains.
  }

  jacketMesh.skeleton.update();

  // Ensure we have a color attribute the cloth lib can use as the cloth/stick mask.
  ensureClothMask(jacketMesh.geometry, jacketMesh.name || 'Jacket');

  // Add the jacket mesh into the character's skinned hierarchy.
  // Skinning will now affect it using the shared skeleton.
  // Put it at the same level as the body mesh.
  modelRoot.add(jacketMesh);

  // Optional: if the jacket root brought in extra transforms, neutralize.
  jacketMesh.position.set(0, 0, 0);
  jacketMesh.rotation.set(0, 0, 0);
  jacketMesh.scale.set(1, 1, 1);

  // Compensate for the runtime scale applied to the player model (see normalizeCharacterObject)
  const modelScale = modelRoot.scale.x || 1;
  if (Math.abs(modelScale - 1) > 0.001) {
    jacketMesh.scale.setScalar(1 / modelScale);
  }

  // Create invisible bone-following sphere colliders.
  createBoneColliders(modelRoot);

  // WebGPU is required (compute shaders).
  const isWebGPU = !!renderer?.backend || (typeof renderer?.isWebGPURenderer !== 'undefined');
  if (!isWebGPU) {
    console.warn('[jacket] three-simplecloth requires WebGPURenderer. Skipping jacket cloth.');
    return null;
  }

  // Initialize the WebGPU cloth simulation.
  // three-simplecloth will rewrite the material to TSL compute cloth.
  const { SimpleCloth } = await import('three-simplecloth');

  const clothSim = SimpleCloth.onSkinnedMesh(jacketMesh, renderer, {
    collidersRoot: modelRoot,
    colorAttributeName: 'color',   // our prepared mask
    colliderRadiusMultiplier: 1.08,
    stiffness: 0.75,
    dampening: 0.88,
    // You can add wind/gravity here:
    // windPerSecond: new THREE.Vector3(0.8, 0.2, 0.0),
    // gravityPerSecond: new THREE.Vector3(0, -9.8, 0),
    logStats: false,
  });

  // Store on character for per-frame update + cleanup
  character.jacketCloth = clothSim;
  character.jacketMesh = jacketMesh;

  console.log('[jacket] three-simplecloth initialized on jacket SkinnedMesh.');

  return clothSim;
}

export function disposeJacketCloth(character) {
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
}
