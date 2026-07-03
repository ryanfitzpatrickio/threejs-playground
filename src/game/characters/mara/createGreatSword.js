import * as THREE from 'three';
import { flattenGeometryForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';

// Great sword. Loads neonblade.glb (a static mesh) and sockets it to the right
// hand. Default socket (position/rotation) and scale correction in attachSword
// are tuned for correct placement in the player's hand.
// Carries two helper objects (bladeBase / bladeTip) at the blade ends that
// CombatSystem sweeps for hit casts. Falls back to a procedural sword if the GLB
// fails to load.

const SWORD_URL = '/assets/models/neonblade.glb';
const SWORD_SCALE = 1.5; // ~1.5m total on a 1.72m character (great sword proportions)

// Geometry of neonblade.glb in its native model space (see scripts/diagnose-neonblade.mjs):
// the blade lies along +X, flat in Y, with the round grip at the -X end and tip at +X.
const GRIP_X = -0.32; // model-space X where the hand grips (just behind the guard)
const GRIP_Y = 0.083; // blade centerline Y (model spans Y 0..0.165)
const GRIP_Z = 0;
const BLADE_BASE_X = -0.12; // start of the cutting blade (near the guard)
const TIP_X = 0.5; // model max X = tip

// Socket rotation (child of mixamorigRightHand) that points the blade (+X) to
// world-up in the armed-idle pose.
// Default tuned values (as of 2026-06-20):
// position: { x: 0, y: 5, z: 2 },
// rotationDegrees: { x: 180, y: 0, z: -44 },
// scale is handled by attachSword inherited-scale correction (~50).
// These are applied in loadNeonBlade and createProceduralSword.

export async function createGreatSword() {
  try {
    return await loadNeonBlade();
  } catch (error) {
    console.warn('neonblade.glb failed to load; falling back to procedural sword.', error);
    return createProceduralSword();
  }
}

async function loadNeonBlade() {
  const loader = createGltfLoader();
  const gltf = await loader.loadAsync(SWORD_URL);
  const mesh = gltf.scene;
  mesh.name = 'Neon Blade';

  // Translate so the grip sits at the group origin, then scale.
  // Note: group-level socket (position/rot) is applied after for the hand attachment default.
  mesh.position.set(-GRIP_X * SWORD_SCALE, -GRIP_Y * SWORD_SCALE, -GRIP_Z * SWORD_SCALE);
  mesh.scale.setScalar(SWORD_SCALE);
  mesh.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.visible = true;
      child.frustumCulled = false;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        material.roughness = Math.max(material.roughness ?? 0.6, 0.45);
        material.transparent = false;
        material.depthWrite = true;
      }
      if (child.geometry) flattenGeometryForWebGPU(child.geometry);
    }
  });

  const group = new THREE.Group();
  group.name = 'Great Sword';
  // Default socket tuned for hand attachment (good defaults as of 2026-06-20)
  group.position.set(0, 5, 2);
  group.quaternion.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(180),
    0,
    THREE.MathUtils.degToRad(-44),
    'XYZ'
  ));
  group.add(mesh);

  const bladeBase = new THREE.Object3D();
  bladeBase.name = 'Great Sword Blade Base';
  bladeBase.position.set((BLADE_BASE_X - GRIP_X) * SWORD_SCALE, 0, 0);

  const bladeTip = new THREE.Object3D();
  bladeTip.name = 'Great Sword Blade Tip';
  bladeTip.position.set((TIP_X - GRIP_X) * SWORD_SCALE, 0, 0);

  group.add(bladeBase, bladeTip);

  return { group, bladeBase, bladeTip, source: 'glb' };
}

// Procedural fallback (only if the GLB is missing). Blade along +Y, socketed
// with its own rotation so it points up from the hand.
const FALLBACK_BLADE_LENGTH = 1.42;

const FALLBACK_MATERIALS = {
  blade: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.28, metalness: 0.85 }),
  guard: new THREE.MeshStandardMaterial({ color: 0x6b5a3a, roughness: 0.5, metalness: 0.45 }),
  grip: new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.82 }),
  pommel: new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.45, metalness: 0.6 }),
};

function createProceduralSword() {
  const group = new THREE.Group();
  group.name = 'Great Sword (Procedural)';
  // Default socket tuned for hand attachment (good defaults as of 2026-06-20)
  group.position.set(0, 5, 2);
  group.quaternion.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(180),
    0,
    THREE.MathUtils.degToRad(-44),
    'XYZ'
  ));

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.22, 10), FALLBACK_MATERIALS.grip);
  grip.position.y = -0.11;
  grip.castShadow = true;

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), FALLBACK_MATERIALS.pommel);
  pommel.position.y = -0.22;
  pommel.castShadow = true;

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.07), FALLBACK_MATERIALS.guard);
  guard.position.y = 0.02;
  guard.castShadow = true;

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, FALLBACK_BLADE_LENGTH, 0.02), FALLBACK_MATERIALS.blade);
  blade.position.y = FALLBACK_BLADE_LENGTH * 0.5;
  blade.castShadow = true;

  group.add(grip, pommel, guard, blade);

  const bladeBase = new THREE.Object3D();
  bladeBase.position.set(0, 0.08, 0);
  const bladeTip = new THREE.Object3D();
  bladeTip.position.set(0, FALLBACK_BLADE_LENGTH + 0.16, 0);
  group.add(bladeBase, bladeTip);

  return { group, bladeBase, bladeTip, source: 'procedural' };
}
