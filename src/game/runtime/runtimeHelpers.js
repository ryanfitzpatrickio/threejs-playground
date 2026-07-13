import * as THREE from 'three';
import { HORSE_GROUND_OFFSET } from '../systems/HorseSystem.js';
import { BaseVehicle } from '../vehicles/BaseVehicle.js';


export function settleWithin(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).then(() => true),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export function hideUnsafeAsyncCompileObjects(scene) {
  const hidden = [];
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const unsafe = materials.some((material) =>
      material?.type === 'MeshSSSNodeMaterial'
      || material?.constructor?.name === 'MeshSSSNodeMaterial');
    if (!unsafe || object.visible === false) return;
    hidden.push(object);
    object.visible = false;
  });
  return () => {
    for (const object of hidden) object.visible = true;
  };
}

export function isRootMotionCameraSmoothingActive(character) {
  return Boolean(character?.traversalAction || character?.hang?.transition || character?.wallRun?.active || character?.wallClimb?.active || character?.rope?.active || character?.hookSwing?.active || character?.vault?.active);
}

export function horseSpawnPosition(characterPosition, levelSystem) {
  const position = new THREE.Vector3(
    (characterPosition?.x ?? 0) + 4.2,
    characterPosition?.y ?? 0,
    (characterPosition?.z ?? 0) - 3.6,
  );
  const ground = horseGroundHeight(levelSystem, position);

  if (Number.isFinite(ground)) {
    position.y = ground + HORSE_GROUND_OFFSET;
  }

  return position;
}

export function horseGroundHeight(levelSystem, position) {
  return levelSystem.getGroundHeightAt(position, 0.7, {
    // Reject roofs and other tall city geometry near the spawn footprint while
    // still allowing ordinary terrain/road variation beneath the horse.
    maxStepUp: 0.65,
    maxSnapDown: 8,
    requiredInset: 0.12,
  });
}

export function carSpawnPosition(horseSystem, characterPosition) {
  const horse = horseSystem.group;
  const position = horse?.position.clone() ?? characterPosition?.clone() ?? new THREE.Vector3();
  const side = new THREE.Vector3(1, 0, 0);

  if (horse) side.applyQuaternion(horse.quaternion).setY(0).normalize();
  return position.addScaledVector(side, 4.2);
}

export const COLLISION_TEST_MAP_NAME = 'collision test track';

export function isCollisionTestMap(worldMap) {
  return (worldMap?.name ?? '').trim().toLowerCase() === COLLISION_TEST_MAP_NAME;
}

export async function spawnCollisionTestVehicles(vehicleSystem) {
  const target = { x: 0, z: 0 };
  const specs = [
    { name: 'West Runner', position: new THREE.Vector3(-80, 0, 0), rotationY: Math.PI / 2 },
    { name: 'East Runner', position: new THREE.Vector3(80, 0, 0), rotationY: -Math.PI / 2 },
  ];
  for (const spec of specs) {
    await vehicleSystem.spawnVehicle({
      vehicle: new BaseVehicle({
        name: spec.name,
        position: spec.position,
        rotationY: spec.rotationY,
        autopilot: { target, throttle: 1 },
      }),
    });
  }
}

export function findChassisDebugVehicle(vehicleSystem, vehicleId = null) {
  const vehicles = vehicleSystem?.vehicles ?? [];
  if (vehicleId) {
    return vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
  }
  if (vehicleSystem?.activeVehicle) return vehicleSystem.activeVehicle;
  return vehicles.find((vehicle) => vehicle.chassisOverlay) ?? vehicles[0] ?? null;
}

export function normalizeHorseBoneCommandOptions(boneNameOrOptions, options = {}) {
  const normalized = typeof boneNameOrOptions === 'string'
    ? { ...options, boneName: boneNameOrOptions }
    : { ...(boneNameOrOptions ?? {}) };

  if (!normalized.rotationDegrees && normalized.rotation) {
    normalized.rotationDegrees = normalized.rotation;
  }

  if (!normalized.position && normalized.pos) {
    normalized.position = normalized.pos;
  }

  return normalized;
}

export function normalizeSaddleCommandOptions(boneNameOrOptions, options = {}) {
  const normalized = normalizeHorseBoneCommandOptions(boneNameOrOptions, options);

  if (!normalized.position && normalized.offset) {
    normalized.position = normalized.offset;
  }

  return normalized;
}

export function normalizeGripCommandOptions(boneNameOrOptions, options = {}) {
  return normalizeSaddleCommandOptions(boneNameOrOptions, options);
}

export function vectorFromObject(source) {
  return new THREE.Vector3(source.x, source.y, source.z);
}

export const riderEuler = new THREE.Euler(0, 0, 0, 'XYZ');

export function riderTransformEuler(object) {
  const quaternion = object.quaternion;
  riderEuler.setFromQuaternion(quaternion, 'XYZ');
  const deg = (value) => Number(THREE.MathUtils.radToDeg(value).toFixed(2));

  return {
    quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    yawDeg: deg(riderEuler.y),
    pitchDeg: deg(riderEuler.x),
    rollDeg: deg(riderEuler.z),
  };
}

export function riderBoneDump(character) {
  const controller = character?.animationController;
  const modelRoot = controller?.modelRoot;

  if (!modelRoot) {
    return { error: 'no rider model root' };
  }

  const bones = [];
  modelRoot.traverse((object) => {
    if (object.isBone) {
      const quaternion = object.quaternion;
      bones.push({ name: object.name, q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
    }
  });

  return {
    mountState: character?.mount?.state ?? null,
    animState: controller.currentState,
    group: riderTransformEuler(character.group),
    modelRoot: riderTransformEuler(modelRoot),
    bones,
  };
}
