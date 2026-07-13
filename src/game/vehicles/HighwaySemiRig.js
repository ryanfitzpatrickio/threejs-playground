/**
 * HighwaySemiRig — articulated cab + trailer for highway traffic semis.
 *
 * Cab is a normal traffic BaseVehicle (cruise, hijack). Trailer is a
 * kinematicPositionBased companion posed each fixed step from the cab hitch
 * (same pattern as PlatformRiding scripted decks). That avoids dynamic
 * joint↔road thrash that made trailers jump vertically.
 *
 * Trailer box top is a PlatformRiding fight deck. Visuals: TSL shells
 * semiCab (cab.group) + semiTrailer (trailer.group).
 *
 * Frame convention (matches BaseVehicle): rotationY=0 faces world −Z;
 * local +Z is the rear, local −Z is the nose.
 */

import * as THREE from 'three';
import { HIGHWAY_Y } from '../config/highwayRunManifest.js';

/** Cab physics footprint [w, h, l] metres. */
export const SEMI_CAB_SIZE = Object.freeze([2.55, 1.85, 4.4]);

/** Trailer box footprint [w, h, l] metres (COM / visual / hitch frame). */
export const SEMI_TRAILER_SIZE = Object.freeze([2.5, 1.75, 12.0]);

/**
 * Hitch anchors in body-local space.
 * Cab hitch at rear (+Z); trailer hitch at nose (−Z).
 */
export const SEMI_HITCH = Object.freeze({
  cab: Object.freeze({ x: 0, y: 0.45, z: SEMI_CAB_SIZE[2] * 0.46 }),
  trailer: Object.freeze({ x: 0, y: 0.45, z: -SEMI_TRAILER_SIZE[2] * 0.46 }),
});

/** Exact COM separation along body +Z when hitch points coincide (straight). */
export const SEMI_COM_SEPARATION =
  SEMI_HITCH.cab.z - SEMI_HITCH.trailer.z; // positive: trailer COM is +Z of cab COM

/** Trailer bed surface (body-local Y of the fight deck). */
export const SEMI_TRAILER_BED_Y = SEMI_TRAILER_SIZE[1] * 0.48;

/** Deck half-extents for PlatformRiding. */
export const SEMI_TRAILER_BED_HALF = Object.freeze({
  x: SEMI_TRAILER_SIZE[0] * 0.42,
  y: 0.12,
  z: SEMI_TRAILER_SIZE[2] * 0.42,
});

/**
 * Crash envelope for the cargo volume — raised so the floor stays clear of the
 * deck at cab ride height (mirrors BaseVehicle raycast chassisColliderOffset).
 * Hitch + bed stay in the body COM frame; only the collider is lifted.
 */
const TRAILER_COLLIDER_HALF = Object.freeze({
  x: SEMI_TRAILER_SIZE[0] * 0.48,
  y: SEMI_TRAILER_SIZE[1] * 0.32,
  // Leave the fifth-wheel end clear of the dynamic cab. A full-length centred
  // cuboid overlapped the tractor collider, so the kinematic trailer launched
  // its cab sideways whenever the rig articulated.
  z: SEMI_TRAILER_SIZE[2] * 0.44,
});
const TRAILER_COLLIDER_OFFSET_Y = 0.35;
const TRAILER_COLLIDER_OFFSET_Z = 0.35;

const ROAD_PARK_X = 80;

const _quat = new THREE.Quaternion();
const _quatCab = new THREE.Quaternion();
const _quatCabYaw = new THREE.Quaternion();
const _hitchLocal = new THREE.Vector3();
const _trailerHitchLocal = new THREE.Vector3();
const _hitchWorld = new THREE.Vector3();
const _trailerCom = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const TRAILER_YAW_RESPONSE = 2.4;
const TRAILER_MAX_YAW_RATE = 0.42;

/** Advance trailer heading toward the cab without snapping the long box sideways. */
export function advanceSemiTrailerYaw(currentYaw, cabYaw, dt) {
  if (!Number.isFinite(cabYaw)) return Number.isFinite(currentYaw) ? currentYaw : 0;
  if (!Number.isFinite(currentYaw) || !(dt > 0)) return cabYaw;
  const delta = Math.atan2(Math.sin(cabYaw - currentYaw), Math.cos(cabYaw - currentYaw));
  const responseStep = delta * (1 - Math.exp(-dt * TRAILER_YAW_RESPONSE));
  const maxStep = TRAILER_MAX_YAW_RATE * dt;
  const step = THREE.MathUtils.clamp(responseStep, -maxStep, maxStep);
  const next = currentYaw + step;
  return Math.atan2(Math.sin(next), Math.cos(next));
}

/**
 * Create a dormant trailer companion for a cab vehicle (pool init).
 */
export function createSemiRig({ physics, cabVehicle, scene = null, poolIndex = 0 } = {}) {
  if (!physics?.world || !physics?.RAPIER || !cabVehicle) {
    return null;
  }
  const RAPIER = physics.RAPIER;
  const world = physics.world;
  const half = TRAILER_COLLIDER_HALF;

  const group = new THREE.Group();
  group.name = `Highway Semi Trailer ${poolIndex}`;
  group.visible = false;
  group.matrixAutoUpdate = false;
  group.matrixWorldAutoUpdate = false;
  group.position.set(ROAD_PARK_X, -500, poolIndex * 8);
  scene?.add?.(group);

  // Kinematic hitch-follow — no gravity, no joint, no road bounce.
  const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(group.position.x, group.position.y, group.position.z)
    .setCcdEnabled(true)
    .setCanSleep(false);
  const body = world.createRigidBody(bodyDesc);

  const edge = Math.min(0.06, half.x * 0.35, half.y * 0.35, half.z * 0.35);
  const collDesc = RAPIER.ColliderDesc.roundCuboid(
    Math.max(0.05, half.x - edge),
    Math.max(0.05, half.y - edge),
    Math.max(0.05, half.z - edge),
    edge,
  )
    .setTranslation(0, TRAILER_COLLIDER_OFFSET_Y, TRAILER_COLLIDER_OFFSET_Z)
    .setFriction(0.6)
    .setRestitution(0.0);
  world.createCollider(collDesc, body);

  return {
    cab: cabVehicle,
    group,
    bodyHandle: body.handle,
    joint: null, // legacy field; kinematic hitch does not use a joint
    platformRegistered: false,
    guards: [],
    active: false,
    poolIndex,
    visualProxy: null,
    /** Last scripted cruise velocity for platform detach inherit. */
    cruiseVelocity: { x: 0, y: 0, z: 0 },
    /** Level trailer heading, advanced independently from the cab heading. */
    trailerYaw: null,
  };
}

/**
 * Compute trailer COM + level yaw from cab body (optional velocity prediction).
 * Writes into module scratch `_trailerCom` / `_quat`.
 */
function computeTrailerPoseFromCab(cabBody, dt = 0, trailerYaw = null) {
  const cabT = cabBody.translation();
  const cabR = cabBody.rotation();
  _quatCab.set(cabR.x ?? 0, cabR.y ?? 0, cabR.z ?? 0, cabR.w ?? 1);
  const cabYaw = extractYawY(_quatCab);
  const resolvedTrailerYaw = Number.isFinite(trailerYaw) ? trailerYaw : cabYaw;
  _quatCabYaw.setFromAxisAngle(UP, cabYaw);
  _quat.setFromAxisAngle(UP, resolvedTrailerYaw);

  let cx = cabT.x;
  let cy = cabT.y;
  let cz = cabT.z;
  if (dt > 0) {
    try {
      const lv = cabBody.linvel?.();
      if (lv) {
        cx += (lv.x ?? 0) * dt;
        cy += (lv.y ?? 0) * dt;
        cz += (lv.z ?? 0) * dt;
      }
    } catch { /* */ }
  }

  _hitchLocal.set(SEMI_HITCH.cab.x, SEMI_HITCH.cab.y, SEMI_HITCH.cab.z);
  _hitchLocal.applyQuaternion(_quatCabYaw);
  _hitchWorld.set(cx, cy, cz).add(_hitchLocal);

  _trailerHitchLocal.set(SEMI_HITCH.trailer.x, SEMI_HITCH.trailer.y, SEMI_HITCH.trailer.z);
  _trailerHitchLocal.applyQuaternion(_quat);
  _trailerCom.copy(_hitchWorld).sub(_trailerHitchLocal);

  if (!Number.isFinite(_trailerCom.y)) {
    _trailerCom.y = Number.isFinite(cy) ? cy : HIGHWAY_Y + 1.2;
  }

  return {
    position: _trailerCom,
    rotation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
    yaw: resolvedTrailerYaw,
    cabYaw,
  };
}

/**
 * Drive kinematic trailer to hitch pose.
 * @param {'immediate'|'next'} mode immediate = setTranslation (activate/park);
 *   next = setNextKinematic* (fixed-step advance).
 */
function applyTrailerPose(trailerBody, pose, mode = 'immediate') {
  const p = {
    x: pose.position.x,
    y: pose.position.y,
    z: pose.position.z,
  };
  const r = pose.rotation;
  if (mode === 'next') {
    try {
      trailerBody.setNextKinematicTranslation?.(p);
    } catch {
      trailerBody.setTranslation?.(p, true);
    }
    try {
      trailerBody.setNextKinematicRotation?.(r);
    } catch {
      trailerBody.setRotation?.(r, true);
    }
  } else {
    trailerBody.setTranslation?.(p, true);
    trailerBody.setRotation?.(r, true);
  }
}

/**
 * Place trailer on the cab hitch and register fight deck + visuals.
 */
export function activateSemiRig(rig, {
  physics,
  platformRiding = null,
  carVisuals = null,
  enemySystem = null,
  color = 0x3a4a5c,
  velocity = null,
  spawnGuards = false,
} = {}) {
  if (!rig?.cab || !physics?.world || !physics?.RAPIER) return false;
  const cab = rig.cab;
  const cabBody = physics.getFreshBody?.(cab.bodyHandle);
  const trailerBody = physics.getFreshBody?.(rig.bodyHandle);
  if (!cabBody || !trailerBody) return false;

  // Drop any legacy impulse joint from older sessions / hot reloads.
  if (rig.joint && physics.world) {
    try {
      physics.world.removeImpulseJoint(rig.joint, true);
    } catch { /* */ }
    rig.joint = null;
  }

  const pose = computeTrailerPoseFromCab(cabBody, 0);
  rig.trailerYaw = pose.cabYaw;
  try {
    trailerBody.setEnabled(true);
  } catch { /* */ }
  applyTrailerPose(trailerBody, pose, 'immediate');

  const lv = velocity ?? cabBody.linvel?.() ?? { x: 0, y: 0, z: 0 };
  rig.cruiseVelocity = {
    x: lv.x ?? 0,
    y: lv.y ?? 0,
    z: lv.z ?? 0,
  };

  rig.group.position.copy(_trailerCom);
  rig.group.quaternion.copy(_quat);
  rig.group.updateMatrix();
  rig.group.matrixWorld.copy(rig.group.matrix);
  rig.group.visible = false;

  // Fight deck on trailer box top.
  if (platformRiding && !rig.platformRegistered) {
    platformRiding.register?.(rig.bodyHandle, {
      owner: cab,
      localCenter: { x: 0, y: 0, z: 0 },
      halfExtents: { ...SEMI_TRAILER_BED_HALF },
      surfaceY: SEMI_TRAILER_BED_Y,
      kind: 'semiTrailerBed',
      hijackable: false,
    });
    // Kinematic bodies report zero linvel — seed scripted velocity for jump inherit.
    if (Array.isArray(platformRiding.scripted)) {
      const existing = platformRiding.scripted.find((s) => s.bodyHandle === rig.bodyHandle);
      if (existing) {
        existing.velocity = rig.cruiseVelocity;
        existing.position?.set?.(_trailerCom.x, _trailerCom.y, _trailerCom.z);
        existing._semiRig = true; // skip free-advance; we pose from cab
      } else {
        platformRiding.scripted.push({
          bodyHandle: rig.bodyHandle,
          mesh: null,
          velocity: rig.cruiseVelocity,
          position: _trailerCom.clone(),
          size: [...SEMI_TRAILER_SIZE],
          _semiRig: true,
        });
      }
    }
    rig.platformRegistered = true;
  }

  cab.userData = {
    ...(cab.userData ?? {}),
    highwayArchetype: 'semi',
    highwayBodyType: 'semiCab',
    highwayColor: color,
    highwayProxyVisual: true,
    semiRig: rig,
  };
  if (!rig.visualProxy) {
    rig.visualProxy = {
      group: rig.group,
      userData: {
        highwayArchetype: 'semiTrailer',
        highwayBodyType: 'semiTrailer',
        highwayProxyVisual: true,
      },
    };
  }
  carVisuals?.attach?.(cab, color, 'semiCab');
  carVisuals?.attach?.(rig.visualProxy, color, 'semiTrailer');

  clearSemiGuards(rig, enemySystem, physics);
  if (spawnGuards && enemySystem?.status === 'ready' && enemySystem.getArchetypeAsset?.('highwayGangMember')) {
    spawnSemiGuards(rig, { enemySystem, physics });
  }

  rig.active = true;
  return true;
}

/**
 * Park trailer, clear platform + guards + TSL.
 */
export function deactivateSemiRig(rig, {
  physics,
  platformRiding = null,
  carVisuals = null,
  enemySystem = null,
  parkPosition = null,
} = {}) {
  if (!rig) return;

  clearSemiGuards(rig, enemySystem, physics);

  if (rig.platformRegistered && platformRiding) {
    platformRiding.unregister?.(rig.bodyHandle);
    if (Array.isArray(platformRiding.scripted)) {
      platformRiding.scripted = platformRiding.scripted.filter(
        (s) => s.bodyHandle !== rig.bodyHandle,
      );
    }
    rig.platformRegistered = false;
  }

  if (rig.joint && physics?.world) {
    try {
      physics.world.removeImpulseJoint(rig.joint, true);
    } catch { /* */ }
    rig.joint = null;
  }

  carVisuals?.detach?.(rig.cab);
  if (rig.visualProxy) carVisuals?.detach?.(rig.visualProxy);

  const trailerBody = physics?.getFreshBody?.(rig.bodyHandle);
  const park = parkPosition ?? {
    x: ROAD_PARK_X,
    y: -500,
    z: (rig.poolIndex ?? 0) * 8,
  };
  if (trailerBody) {
    try {
      trailerBody.setEnabled(true);
    } catch { /* */ }
    trailerBody.setTranslation(park, true);
    try {
      trailerBody.setNextKinematicTranslation?.(park);
    } catch { /* */ }
  }
  if (rig.group) {
    rig.group.position.set(park.x, park.y, park.z);
    rig.group.visible = false;
    rig.group.updateMatrix();
  }
  rig.cruiseVelocity = { x: 0, y: 0, z: 0 };
  rig.trailerYaw = null;
  rig.active = false;
}

/**
 * Fixed-step: pose kinematic trailer from predicted cab hitch.
 * Call from physics stepHooks.beforeTick (alongside platform capture).
 */
export function stepSemiRig(rig, physics, dt = 1 / 60) {
  if (!rig?.active) return;
  const trailerBody = physics?.getFreshBody?.(rig.bodyHandle);
  const cabBody = physics?.getFreshBody?.(rig.cab?.bodyHandle);
  if (!trailerBody || !cabBody) return;

  const cabRotation = cabBody.rotation();
  _quatCab.set(
    cabRotation.x ?? 0,
    cabRotation.y ?? 0,
    cabRotation.z ?? 0,
    cabRotation.w ?? 1,
  );
  const cabYaw = extractYawY(_quatCab);
  rig.trailerYaw = advanceSemiTrailerYaw(rig.trailerYaw, cabYaw, dt);
  const pose = computeTrailerPoseFromCab(cabBody, dt > 0 ? dt : 0, rig.trailerYaw);
  applyTrailerPose(trailerBody, pose, 'next');

  try {
    const lv = cabBody.linvel?.();
    if (lv) {
      rig.cruiseVelocity.x = lv.x ?? 0;
      rig.cruiseVelocity.y = lv.y ?? 0;
      rig.cruiseVelocity.z = lv.z ?? 0;
    }
  } catch { /* */ }
}

/**
 * Render-frame: sync trailer visual group from kinematic body (or re-hitch).
 */
export function syncSemiRig(rig, physics) {
  if (!rig?.active || !rig.group) return;
  const trailerBody = physics?.getFreshBody?.(rig.bodyHandle);
  const cabBody = physics?.getFreshBody?.(rig.cab?.bodyHandle);
  if (!trailerBody) return;

  // Re-hitch from cab when available so TSL never lags a full step behind.
  if (cabBody) {
    const pose = computeTrailerPoseFromCab(cabBody, 0, rig.trailerYaw);
    applyTrailerPose(trailerBody, pose, 'immediate');
    rig.group.position.copy(_trailerCom);
    rig.group.quaternion.copy(_quat);
  } else {
    const t = trailerBody.translation();
    const r = trailerBody.rotation();
    const yaw = extractYawY(r);
    _quat.setFromAxisAngle(UP, yaw);
    rig.group.position.set(t.x, t.y, t.z);
    rig.group.quaternion.copy(_quat);
  }
  rig.group.updateMatrix();
  rig.group.matrixWorld.copy(rig.group.matrix);
}

export function disposeSemiRig(rig, {
  physics,
  platformRiding = null,
  carVisuals = null,
  enemySystem = null,
  scene = null,
} = {}) {
  if (!rig) return;
  deactivateSemiRig(rig, { physics, platformRiding, carVisuals, enemySystem });
  if (physics?.world && Number.isFinite(rig.bodyHandle)) {
    try {
      const body = physics.world.bodies?.get?.(rig.bodyHandle)
        ?? physics.getFreshBody?.(rig.bodyHandle);
      if (body) physics.world.removeRigidBody(body);
    } catch { /* */ }
  }
  if (rig.group) {
    scene?.remove?.(rig.group);
    rig.group.clear?.();
  }
  rig.bodyHandle = null;
  rig.group = null;
}

function extractYawY(q) {
  const x = q.x ?? 0;
  const y = q.y ?? 0;
  const z = q.z ?? 0;
  const w = q.w ?? 1;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

function spawnSemiGuards(rig, { enemySystem, physics }) {
  const body = physics?.getFreshBody?.(rig.bodyHandle);
  if (!body || !enemySystem) return;
  const t = body.translation();
  const r = body.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const localSpawns = [
    { x: -0.55, y: SEMI_TRAILER_BED_Y + 0.05, z: -1.5 },
    { x: 0.55, y: SEMI_TRAILER_BED_Y + 0.05, z: 2.0 },
  ];
  for (let i = 0; i < localSpawns.length; i += 1) {
    const local = localSpawns[i];
    const world = new THREE.Vector3(local.x, local.y, local.z).applyQuaternion(q);
    world.x += t.x;
    world.y += t.y;
    world.z += t.z;
    const enemy = enemySystem.spawnEnemy?.('highwayGangMember', world, {
      yaw: extractYawY(r) + Math.PI,
      platformBodyHandle: rig.bodyHandle,
      id: `semi-guard-${rig.poolIndex ?? 0}-${i}`,
    });
    if (enemy) {
      physics?.addEnemyCollider?.(enemy);
      rig.guards.push(enemy);
    }
  }
}

function clearSemiGuards(rig, enemySystem, physics) {
  if (!rig?.guards?.length) {
    if (rig) rig.guards = [];
    return;
  }
  for (const enemy of rig.guards) {
    try {
      enemySystem?.despawnEnemy?.(enemy, { physicsSystem: physics });
    } catch {
      try {
        enemySystem?.markDefeated?.(enemy, 'despawn');
      } catch { /* */ }
    }
  }
  rig.guards = [];
}
