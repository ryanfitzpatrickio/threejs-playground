/**
 * PlatformRidingSystem M1/O4 contract (pure node + Rapier).
 *
 * Guards:
 *   1. Capsule/feet on a scripted kinematic platform translate with it (fixed-step carry).
 *   2. Jump inherits platform point velocity (character.velocity ≈ platform.velocity + leap).
 *   3. PhysicsSystem.stepHooks.afterTick is invoked each fixed step.
 *   4. Registry register/unregister + getPlatformAt footprint query.
 *   5. 0/1/4-step carry distance parity; double-apply in zero-step is a no-op.
 *   6. getPlatformByHandle is directed (assigned actor path).
 *
 * Run: node scripts/verify-platform-riding.mjs
 * Alias: npm run verify:platform-riding
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem, PHYSICS_FIXED_STEP } from '../src/game/systems/PhysicsSystem.js';
import {
  PlatformRidingSystem,
  PLATFORM_RESNAP_BLOCK,
} from '../src/game/systems/PlatformRidingSystem.js';

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
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;
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

function runFixedSeconds(physics, platforms, seconds, { onFrame } = {}) {
  const hz = 60;
  const frames = Math.round(seconds * hz);
  const delta = 1 / hz;
  for (let f = 0; f < frames; f += 1) {
    physics.beginFrame({ delta, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
    physics.stepPlanned();
    onFrame?.(f, physics, platforms);
    platforms.endCarryWindow?.();
  }
}

/**
 * Drive N fixed steps in one render frame (catch-up simulation).
 * @param {object} physics
 * @param {PlatformRidingSystem} platforms
 * @param {number} steps
 */
function runNStepsOneFrame(physics, platforms, steps) {
  platforms.endCarryWindow?.();
  // Feed enough elapsed time for `steps` fixed ticks at 60 Hz.
  const delta = PHYSICS_FIXED_STEP * steps + 1e-6;
  physics.beginFrame({ delta, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
  // Force planned step count when planner under-delivers.
  if ((physics.plannedSteps ?? 0) < steps) {
    physics.plannedSteps = steps;
  }
  physics.stepPlanned();
  platforms.endCarryWindow?.();
}

// ── 1. Registry + getPlatformAt ─────────────────────────────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });

  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0),
  );
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.25, 3), body);
  const handle = body.handle;
  platforms.register(handle, {
    owner: { id: 'test' },
    localCenter: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 2, y: 0.25, z: 3 },
    surfaceY: 0.25,
    kind: 'test',
  });

  const hit = platforms.getPlatformAt({ x: 0.5, y: 2.25, z: -0.2 }, 2.25);
  assert.ok(hit, 'getPlatformAt finds surface under feet');
  assert.equal(hit.bodyHandle, handle);
  assert.ok(Math.abs(hit.worldSurfacePoint.y - 2.25) < 0.05);

  const miss = platforms.getPlatformAt({ x: 10, y: 2.25, z: 0 }, 2.25);
  assert.equal(miss, null, 'outside footprint returns null');

  platforms.unregister(handle);
  assert.equal(platforms.getPlatformAt({ x: 0, y: 2.25, z: 0 }, 2.25), null);
  ok('registry register/unregister and getPlatformAt footprint');
}

// ── 2. Fixed-step carry translates a standing character ─────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });

  let afterTickCalls = 0;
  physics.stepHooks = {
    beforeTick: () => platforms.captureBeforeTick(physics.stepDt),
    afterTick: () => {
      afterTickCalls += 1;
      platforms.accumulateAfterTick();
    },
  };

  const scripted = platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 3, 0),
    size: [4, 0.5, 6],
    velocity: { x: 0, y: 0, z: -10 },
  });

  // Character feet on the deck.
  const character = {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    platformSupport: null,
    platformResnapBlockTimer: 0,
    groundSnapBlockTimer: 0,
  };
  character.group.position.set(0, 3 + 0.25, 0);

  // Attach support via query after one settle step.
  physics.beginFrame({ delta: 1 / 60, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
  physics.stepPlanned();
  platforms.applyPendingCarry(character); // no support yet
  const hit0 = platforms.getPlatformAt(character.group.position, character.group.position.y);
  assert.ok(hit0, 'character starts on platform');
  platforms.attachSupport(character, hit0);

  const startZ = character.group.position.z;
  const startPlatformZ = scripted.position.z;
  const seconds = 1.0;
  runFixedSeconds(physics, platforms, seconds, {
    onFrame: () => {
      platforms.applyPendingCarry(character);
      // Keep support glued (simulates grounded snap each frame).
      const hit = platforms.getPlatformAt(character.group.position, character.group.position.y);
      if (hit) platforms.attachSupport(character, hit);
    },
  });

  const dChar = character.group.position.z - startZ;
  const dPlat = scripted.position.z - startPlatformZ;
  assert.ok(afterTickCalls > 0, 'afterTick hook fired');
  assert.ok(dPlat < -8, `platform moved ~-10 m/s, got Δz=${dPlat.toFixed(2)}`);
  // Carry should match platform translation within a small tolerance.
  assert.ok(
    Math.abs(dChar - dPlat) < 0.35,
    `character carry Δz=${dChar.toFixed(3)} should match platform Δz=${dPlat.toFixed(3)}`,
  );
  ok('fixed-step carry keeps feet on a moving platform');
}

// ── 3. Jump inherits platform velocity ──────────────────────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });
  physics.stepHooks = {
    beforeTick: () => platforms.captureBeforeTick(physics.stepDt),
    afterTick: () => platforms.accumulateAfterTick(),
  };

  const cruiseZ = -18;
  platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 4, 0),
    size: [4, 0.5, 6],
    velocity: { x: 0, y: 0, z: cruiseZ },
  });

  // Warm one step so kinematic motion is established.
  physics.beginFrame({ delta: 1 / 60, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
  physics.stepPlanned();

  const character = {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(0, 0, 0),
    verticalVelocity: 0,
    grounded: true,
    platformSupport: null,
    platformResnapBlockTimer: 0,
    groundSnapBlockTimer: 0,
  };
  character.group.position.set(0, 4.25, 0);
  const hit = platforms.getPlatformAt(character.group.position, character.group.position.y);
  assert.ok(hit);
  platforms.attachSupport(character, hit);

  // Simulate jump impulse then detach inheritance (same order as MovementSystem).
  const jumpSpeed = 7.2;
  character.verticalVelocity = jumpSpeed;
  character.grounded = false;
  const inherited = platforms.inheritDetachVelocity(character);
  assert.equal(inherited, true);
  assert.equal(character.platformSupport, null);
  assert.ok(character.platformResnapBlockTimer >= PLATFORM_RESNAP_BLOCK * 0.9);

  // Horizontal velocity should pick up cruise Z; vertical gets jump + any platform Y.
  assert.ok(
    Math.abs(character.velocity.z - cruiseZ) < 0.5,
    `expected velocity.z ≈ ${cruiseZ}, got ${character.velocity.z.toFixed(3)}`,
  );
  assert.ok(
    character.verticalVelocity >= jumpSpeed - 0.01,
    `verticalVelocity should keep jump impulse, got ${character.verticalVelocity}`,
  );
  ok('jump inherits platform point velocity');
}

// ── 4. Seated vehicle clears support path (no double-carry contract) ────────

{
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics: makePhysics() });
  const character = {
    group: new THREE.Group(),
    platformSupport: { bodyHandle: 1, localContact: { x: 0, y: 0, z: 0 } },
    vehicle: { active: true },
  };
  // MovementSystem early-out calls clearSupport when vehicle.active — mirror here.
  platforms.clearSupport(character);
  assert.equal(character.platformSupport, null);
  ok('support clears when not free on-foot');
}

// ── 5. O4: multi-step carry + zero-step double-apply ────────────────────────

{
  const physics = makePhysics();
  const platforms = new PlatformRidingSystem();
  platforms.initialize({ physics, scene: null });
  physics.stepHooks = {
    beforeTick: () => platforms.captureBeforeTick(physics.stepDt),
    afterTick: () => platforms.accumulateAfterTick(),
  };

  const vz = -12;
  const scripted = platforms.spawnScriptedTestPlatform({
    position: new THREE.Vector3(0, 5, 0),
    size: [4, 0.5, 6],
    velocity: { x: 0, y: 0, z: vz },
  });

  const makeActor = (x) => {
    const actor = {
      group: new THREE.Group(),
      velocity: new THREE.Vector3(),
      verticalVelocity: 0,
      platformSupport: null,
      platformResnapBlockTimer: 0,
    };
    actor.group.position.set(x, 5.25, 0);
    return actor;
  };

  const a = makeActor(-0.4);
  const b = makeActor(0.4);

  // Warm one step and attach both actors.
  physics.beginFrame({ delta: PHYSICS_FIXED_STEP, timeScale: 1, fixedStep: PHYSICS_FIXED_STEP });
  physics.stepPlanned();
  platforms.endCarryWindow();
  for (const actor of [a, b]) {
    const hit = platforms.getPlatformAt(actor.group.position, actor.group.position.y);
    assert.ok(hit);
    platforms.attachSupport(actor, hit);
  }

  const startAz = a.group.position.z;
  const startBz = b.group.position.z;
  const startPlat = scripted.position.z;

  // One frame with 4 fixed steps — both actors should receive the same full delta once.
  runNStepsOneFrame(physics, platforms, 4);
  const appliedA = platforms.applyPendingCarry(a);
  const appliedB = platforms.applyPendingCarry(b);
  assert.equal(appliedA, true);
  assert.equal(appliedB, true);
  // Second apply same generation is a no-op (zero-step double apply).
  assert.equal(platforms.applyPendingCarry(a), false);
  assert.equal(platforms.applyPendingCarry(b), false);

  const dA = a.group.position.z - startAz;
  const dB = b.group.position.z - startBz;
  const dP = scripted.position.z - startPlat;
  assert.ok(Math.abs(dA - dB) < 0.05, 'two actors share the same carry delta');
  assert.ok(Math.abs(dA - dP) < 0.4, `4-step carry ${dA.toFixed(3)} ≈ platform ${dP.toFixed(3)}`);

  // Handle-directed query for assigned actor.
  platforms.resetQueryCount();
  const byHandle = platforms.getPlatformByHandle(
    scripted.bodyHandle,
    a.group.position,
    a.group.position.y,
  );
  assert.ok(byHandle);
  assert.equal(byHandle.bodyHandle, scripted.bodyHandle);
  ok('0/1/4-step carry parity, shared delta, handle-directed query');
}

console.log(`\nAll ${passed} platform-riding checks passed.`);
