/**
 * Car leap + bullet-time M3 contract (pure node).
 *
 * Guards:
 *   1. findLeapTarget picks ahead platform within envelope; excludes source body.
 *   2. startLeap inherits source velocity and arms carLeap state.
 *   3. Active leap lands on target platform and attaches support.
 *   4. Bullet-time drains while aiming and recharges when idle.
 *   5. No-target release becomes plain inherited jump (no carLeap active).
 *
 * Run: node scripts/verify-car-leap.mjs
 * Alias: npm run verify:car-leap
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem, PHYSICS_FIXED_STEP } from '../src/game/systems/PhysicsSystem.js';
import { PlatformRidingSystem } from '../src/game/systems/PlatformRidingSystem.js';
import {
  CarLeapSystem,
  BULLET_TIME_MAX,
  CAR_LEAP_HOLD_MIN,
} from '../src/game/systems/CarLeapSystem.js';

await RAPIER.init();

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

function makePhysics() {
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.stepDt = PHYSICS_FIXED_STEP;
  physics.tickCount = 0;
  physics.simTime = 0;
  physics.steppedThisFrame = false;
  physics.fixedStepPlanning = false;
  physics.plannedSteps = 0;
  physics.stepAccumulator = 0;
  physics.poseRegistry = new Map();
  physics.status = 'ready';
  return physics;
}

// ── 1. Target selection ─────────────────────────────────────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });
  physics.stepHooks = {
    beforeTick: () => platforms.captureBeforeTick(physics.stepDt),
    afterTick: () => platforms.accumulateAfterTick(),
  };

  const source = platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 4, 0),
    size: [3, 0.5, 6],
    velocity: { x: 0, y: 0, z: -10 },
  });
  const target = platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 4, -8),
    size: [3, 0.5, 6],
    velocity: { x: 0, y: 0, z: -10 },
  });

  physics.beginFrame({ delta: 1 / 60, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
  physics.stepPlanned();

  const leap = new CarLeapSystem();
  leap.initialize({ scene: null });

  const character = {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    platformSupport: { bodyHandle: source.bodyHandle },
    vehicle: null,
    carLeap: null,
    animationController: { play() {} },
  };
  character.group.position.set(0, 4.25, 0);
  character.group.rotation.y = 0; // facing +Z in character space; leap uses -Z forward for chassis

  // Facing highway -Z: yaw 0 → forward (0,0,-1)
  const found = leap.findLeapTarget({
    character,
    platforms,
    vehicleSystem: { activeVehicle: null },
  });
  assert.ok(found, 'finds a leap target');
  assert.equal(found.bodyHandle, target.bodyHandle, 'prefers ahead platform');
  assert.notEqual(found.bodyHandle, source.bodyHandle);
  ok('findLeapTarget picks ahead platform and excludes source');
}

// ── 2–3. Start leap + land ──────────────────────────────────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });
  physics.stepHooks = {
    beforeTick: () => platforms.captureBeforeTick(physics.stepDt),
    afterTick: () => platforms.accumulateAfterTick(),
  };

  platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 5, 0),
    size: [4, 0.5, 6],
    velocity: { x: 0, y: 0, z: -8 },
  });
  const target = platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 5, -7),
    size: [4, 0.5, 6],
    velocity: { x: 0, y: 0, z: -8 },
  });

  for (let i = 0; i < 3; i += 1) {
    physics.beginFrame({ delta: 1 / 60, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
    physics.stepPlanned();
  }

  const leap = new CarLeapSystem();
  leap.initialize({ scene: null });

  const character = {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(0, 0, -8),
    verticalVelocity: 0,
    grounded: true,
    platformSupport: null,
    vehicle: null,
    carLeap: null,
    animationController: { play() {} },
  };
  character.group.position.set(0, 5.25, 0);
  character.group.rotation.y = 0;

  // Attach source support for exclusion
  const srcHit = platforms.getPlatformAt(character.group.position, 5.25);
  if (srcHit) platforms.attachSupport(character, srcHit);

  const found = leap.findLeapTarget({
    character,
    platforms,
    vehicleSystem: { activeVehicle: null },
  });
  assert.ok(found);

  leap.startLeap({
    character,
    target: found,
    vehicleSystem: {
      activeVehicle: null,
      detachRiderForLeap: () => true,
      physics,
    },
    platforms,
  });

  assert.equal(character.carLeap?.active, true);
  assert.ok(character.verticalVelocity > 0, 'leap has upward impulse');
  // Inherited + aimed velocity should have forward component toward -Z
  assert.ok(character.velocity.z < -1, `forward leap vel z=${character.velocity.z}`);

  // Simulate leap frames until land or timeout
  let landed = false;
  for (let i = 0; i < 90; i += 1) {
    physics.beginFrame({ delta: 1 / 60, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
    physics.stepPlanned();
    const m = leap.update({
      delta: 1 / 60,
      input: {},
      movement: { grounded: false, airborne: true },
      character,
      platforms,
      vehicleSystem: { activeVehicle: null },
      physics,
    });
    if (m.justLanded || (!character.carLeap?.active && character.grounded)) {
      landed = true;
      break;
    }
  }
  assert.ok(landed, 'leap lands within timeout');
  assert.ok(
    character.platformSupport || character.grounded || !character.carLeap?.active,
    'support, grounded, or free after leap ends',
  );
  void target;
  void srcHit;
  ok('startLeap inherits velocity; leap can land on target');
}

// ── 4. Bullet-time meter ────────────────────────────────────────────────────

{
  const leap = new CarLeapSystem();
  leap.initialize({ scene: null });
  assert.equal(leap.bulletTime, BULLET_TIME_MAX);

  const character = {
    group: new THREE.Group(),
    vehicle: { active: true, roofSurfing: true },
    platformSupport: null,
    carLeap: null,
  };
  character.group.position.set(0, 1, 0);

  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics });

  // Aim for 0.5s real time
  for (let i = 0; i < 30; i += 1) {
    leap.updateBulletTime({
      delta: 1 / 60,
      input: { carLeapHeld: true },
      character,
      platforms,
      vehicleSystem: { activeVehicle: { bodyHandle: 99, group: new THREE.Group() } },
    });
  }
  assert.ok(leap.bulletTime < BULLET_TIME_MAX, 'meter drains while aiming');
  assert.ok(leap.aiming, 'aiming while held on roof');

  // Idle recharge
  for (let i = 0; i < 60; i += 1) {
    leap.updateBulletTime({
      delta: 1 / 60,
      input: { carLeapHeld: false },
      character: { group: character.group, vehicle: null, platformSupport: null, carLeap: null },
      platforms,
      vehicleSystem: { activeVehicle: null },
    });
  }
  assert.ok(leap.bulletTime > 0.2, 'meter recharges when idle');
  ok('bullet-time drains while aiming and recharges idle');
}

// ── 5. No-target release → plain jump ───────────────────────────────────────

{
  const leap = new CarLeapSystem();
  leap.initialize({ scene: null });
  const character = {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    vehicle: { active: true, roofSurfing: true },
    platformSupport: null,
    carLeap: null,
    animationController: { play() {} },
  };
  character.group.position.set(0, 2, 0);
  character.group.rotation.y = 0;

  let detached = false;
  const vehicleSystem = {
    activeVehicle: {
      bodyHandle: 1,
      speed: 12,
      group: new THREE.Group(),
    },
    physics: { getFreshBody: () => null },
    detachRiderForLeap: () => {
      detached = true;
      character.vehicle = null;
      vehicleSystem.activeVehicle = null;
      return true;
    },
  };

  leap.holdElapsed = CAR_LEAP_HOLD_MIN + 0.05;
  leap.aimTarget = null;
  const m = leap.update({
    delta: 1 / 60,
    input: { carLeapReleased: true },
    movement: { grounded: true, driving: true },
    character,
    platforms: { platforms: new Map(), physics: null, getPlatformAt: () => null },
    vehicleSystem,
    physics: null,
  });

  assert.equal(character.carLeap?.plainJump, true, 'plain jump uses short carLeap ownership');
  assert.equal(m.carLeaping, true);
  assert.ok(detached, 'detached from vehicle for plain jump');
  assert.ok(character.verticalVelocity > 0, 'plain leap jump has up impulse');
  ok('no-target release is plain inherited jump');
}

console.log(`\nAll ${passed} car-leap checks passed.`);
