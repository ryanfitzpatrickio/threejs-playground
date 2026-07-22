/**
 * verify-dog-gait-ik — guards the IK-driven, slope-aware, momentum-based
 * procedural walk/trot gait (dogAnimation.js updateGait/updateGroundConformance
 * + dogLegIk.js). Regression checks for:
 *  - per-leg foot placement tracking real (sloped) ground height, not a flat plane
 *    (procedural gait AND retargeted clip-driven gait, applyPostClipOverlays)
 *  - no frame-to-frame foot teleporting
 *  - whole-body pitch conforming to slope (procedural AND clip-driven gait)
 *  - stride frequency scaling with measured speed
 *  - continuous walk<->trot blend (no discrete-table jump)
 *  - sit/idle/flop poses staying untouched by ground-conform leg IK
 *
 * Run: node scripts/verify-dog-gait-ik.mjs
 */

import * as THREE from 'three';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import { DOG_LEG_CHAINS } from '../src/game/characters/dog/dogSkeleton.js';
import { DOG_PAW_MESH_PAD, DOG_GROUND_CONTACT_COMPRESSION } from '../src/game/characters/dog/dogFootPlant.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const FIXED_DT = 1 / 60;
const _p = new THREE.Vector3();

function pawWorldY(dog, pawName) {
  dog.rig.bonesByName.get(pawName).getWorldPosition(_p);
  return { x: _p.x, y: _p.y, z: _p.z };
}

/**
 * Slope sweep: constant-gradient ramp along Z (the dog's default forward
 * axis at yaw=0) so a walking dog actually climbs it.
 *
 * dogAnimation's internal root translation (externalRootMotion=false, used by
 * autopilot/studio) always pins root.y=0 — real slope-following is a
 * controller responsibility (DogPlayerController/DogNpcController/etc. set
 * position.y = floorY each frame, see e.g. DogPlayerController.js:184-202).
 * Mimic that minimal controller contract here instead of relying on autopilot.
 */
const SLOPE_BREEDS = ['golden-retriever', 'chihuahua', 'great-dane', 'domestic-horse'];
const WALK_SPEED_MPS = 0.8;

function walkOnSlope(breedId, slope, ticks = 150) {
  const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
  dog.animation.setAutopilot(false);
  dog.animation.setExternalRootMotion(true);
  const getGroundHeight = (x, z) => slope * z;
  const breedScale = dog.phenotype?.skeleton?.scale ?? 1;
  // The paw BONE sits above the actual ground-contact point by design (the
  // pad mesh hangs below it) — same supportOffset convention as
  // dogFootPlant.js's plantDogFeet, not a flat-ground assumption.
  const supportOffset = Math.max(0, (DOG_PAW_MESH_PAD - DOG_GROUND_CONTACT_COMPRESSION) * breedScale);

  const prevPawPos = new Map();
  let maxStanceErr = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    dog.animation.setMoveIntent({
      x: 0, z: 1, moving: true, sprint: false, speedMps: WALK_SPEED_MPS,
    });
    dog.root.position.z += WALK_SPEED_MPS * FIXED_DT;
    dog.root.position.y = getGroundHeight(dog.root.position.x, dog.root.position.z);
    dog.update(0, { fixed: true, getGroundHeight });

    // Skip the initial settle window before measuring steady-state contact.
    if (tick < 30) continue;

    const support = dog.animation.getFootSupport();
    for (const key of Object.keys(DOG_LEG_CHAINS)) {
      const chain = DOG_LEG_CHAINS[key];
      const pos = pawWorldY(dog, chain.paw);

      const prev = prevPawPos.get(key);
      if (prev) {
        const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
        // Swing-phase travel scales with breed size (bigger dog, bigger
        // stride in meters) — bound relative to scale, not an absolute cm figure.
        const teleportBound = 0.15 * Math.max(1, breedScale);
        assert(
          dist < teleportBound,
          `${breedId} slope=${slope} ${key} paw teleported ${dist.toFixed(3)}m in one tick`,
        );
      }
      prevPawPos.set(key, pos);

      if (support[key] === 1) {
        const groundY = getGroundHeight(pos.x, pos.z);
        maxStanceErr = Math.max(maxStanceErr, Math.abs(pos.y - supportOffset - groundY));
      }
    }
  }

  const euler = new THREE.Euler().setFromQuaternion(dog.rig.root.quaternion, 'YXZ');
  dog.dispose?.();
  return { pitch: euler.x, maxStanceErr };
}

// Body pitch is a whole-body rotation, not leg-reach-limited — verified exact
// (not just "close") across the full slope range and every breed, including
// the cursorial (equid-like) horse variant.
for (const breedId of SLOPE_BREEDS) {
  let prevPitch = Infinity;
  for (const slope of [-0.36, -0.18, 0, 0.18, 0.36]) {
    const { pitch } = walkOnSlope(breedId, slope, 60);
    // Nose-up (climbing a positive slope, ground rising with +Z) is a
    // NEGATIVE X-axis rotation here — see the sign comment in
    // updateGroundConformance (dogAnimation.js).
    const expectedPitch = -Math.atan(slope);
    assert(
      Math.abs(pitch - expectedPitch) < 0.02,
      `${breedId} slope=${slope} body pitch=${pitch.toFixed(3)} rad, expected ~${expectedPitch.toFixed(3)}`,
    );
    assert(
      pitch < prevPitch + 1e-4,
      `${breedId} body pitch not monotonic across slope sweep (${prevPitch.toFixed(3)} -> ${pitch.toFixed(3)})`,
    );
    prevPitch = pitch;
  }
}

// Whole-body pitch must ALSO conform when the retargeted clip library owns
// the legs (dogAnimation's clipDriven === true path) — a slope should tilt
// the dog regardless of which system is animating its legs.
{
  const slope = 0.2;
  const getGroundHeight = (x, z) => slope * z;
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  dog.animation.setAutopilot(false);
  dog.animation.setExternalRootMotion(true);
  dog.animation.setClipDriven(true);
  dog.animation.setBehavior('walk');
  for (let tick = 0; tick < 90; tick += 1) {
    dog.root.position.z += WALK_SPEED_MPS * FIXED_DT;
    dog.root.position.y = getGroundHeight(dog.root.position.x, dog.root.position.z);
    dog.update(0, { fixed: true, getGroundHeight });
  }
  const euler = new THREE.Euler().setFromQuaternion(dog.rig.root.quaternion, 'YXZ');
  const expectedPitch = -Math.atan(slope);
  assert(
    Math.abs(euler.x - expectedPitch) < 0.02,
    `clip-driven body pitch=${euler.x.toFixed(3)} rad, expected ~${expectedPitch.toFixed(3)}`,
  );
  dog.dispose?.();
}

// Per-leg IK ALSO runs on top of the retargeted clip pose now (walk/trot
// only, via applyPostClipOverlays + dogDebugState.clipLegIkEnabled) — same
// solver as the procedural path, same reach-limit caveat, gentler slope
// range here since there's no synthetic FK swing to re-fight the correction
// every tick (it converges once and holds).
{
  const slope = 0.06;
  const getGroundHeight = (x, z) => slope * z;
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  dog.animation.setAutopilot(false);
  dog.animation.setExternalRootMotion(true);
  dog.animation.setClipDriven(true);
  dog.animation.setBehavior('walk');
  const breedScale = dog.phenotype?.skeleton?.scale ?? 1;
  const supportOffset = Math.max(0, (DOG_PAW_MESH_PAD - DOG_GROUND_CONTACT_COMPRESSION) * breedScale);
  for (let tick = 0; tick < 90; tick += 1) {
    dog.root.position.z += WALK_SPEED_MPS * FIXED_DT;
    dog.root.position.y = getGroundHeight(dog.root.position.x, dog.root.position.z);
    dog.update(0, { fixed: true, getGroundHeight });
    dog.animation.applyPostClipOverlays();
  }
  for (const key of Object.keys(DOG_LEG_CHAINS)) {
    const chain = DOG_LEG_CHAINS[key];
    const pos = pawWorldY(dog, chain.paw);
    const err = Math.abs(pos.y - supportOffset - getGroundHeight(pos.x, pos.z));
    assert(err < 0.04, `clip-driven ${key} paw off ground by ${err.toFixed(3)}m`);
  }
  dog.dispose?.();
}

// Per-leg stance alignment IS leg-reach-limited (a leg is a fixed-length
// two-bone chain; body pitch above absorbs most of a slope, but a steep
// enough grade relative to a breed's leg length still leaves a residual —
// same real-world tradeoff a physical quadruped has). Use a modest,
// dog-park-ramp-scale grade for the standard breeds; the cursorial horse
// variant's much straighter stance leaves less reach headroom even on
// gentle grades, so it gets a looser tolerance rather than a stricter slope.
for (const breedId of ['golden-retriever', 'chihuahua', 'great-dane']) {
  for (const slope of [-0.05, 0, 0.05]) {
    const { maxStanceErr } = walkOnSlope(breedId, slope);
    assert(
      maxStanceErr < 0.04,
      `${breedId} slope=${slope} worst stance paw off ground by ${maxStanceErr.toFixed(3)}m`,
    );
  }
}
for (const slope of [-0.05, 0, 0.05]) {
  const { maxStanceErr } = walkOnSlope('domestic-horse', slope);
  assert(
    maxStanceErr < 0.09,
    `domestic-horse slope=${slope} worst stance paw off ground by ${maxStanceErr.toFixed(3)}m`,
  );
}

// 4. Stride frequency scales with measured speed (paw-Y zero-crossing rate).
function measureStrideHz(speedMps) {
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  dog.animation.setAutopilot(false);
  dog.animation.setMoveIntent({
    x: 0, z: 1, moving: true, sprint: false, speedMps,
  });
  // Settle.
  for (let i = 0; i < 30; i += 1) dog.update(0, { fixed: true, getGroundHeight: () => 0 });

  const samples = [];
  const measureTicks = 240;
  for (let i = 0; i < measureTicks; i += 1) {
    dog.update(0, { fixed: true, getGroundHeight: () => 0 });
    samples.push(pawWorldY(dog, 'PawL').y);
  }
  dog.dispose?.();

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1] <= mean && samples[i] > mean) crossings += 1;
  }
  return crossings / (measureTicks * FIXED_DT);
}

{
  const slowHz = measureStrideHz(0.35);
  const midHz = measureStrideHz(1.0);
  const fastHz = measureStrideHz(2.4);
  assert(
    slowHz < midHz && midHz < fastHz,
    `stride frequency not monotonic with speed: slow=${slowHz.toFixed(2)}Hz mid=${midHz.toFixed(2)}Hz fast=${fastHz.toFixed(2)}Hz`,
  );
}

// 5. Continuous walk<->trot blend: ramping speedMps through the crossover
// must not jump the internal gait speed (old discrete table swap would).
{
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  dog.animation.setAutopilot(false);
  let prevMoveSpeed = null;
  let maxDelta = 0;
  const steps = 300;
  for (let i = 0; i < steps; i += 1) {
    const speedMps = THREE.MathUtils.lerp(0.3, 2.2, i / (steps - 1));
    dog.animation.setMoveIntent({
      x: 0, z: 1, moving: true, sprint: false, speedMps,
    });
    dog.update(0, { fixed: true, getGroundHeight: () => 0 });
    const moveSpeed = dog.animation.getMoveSpeed();
    if (prevMoveSpeed !== null) {
      maxDelta = Math.max(maxDelta, Math.abs(moveSpeed - prevMoveSpeed));
    }
    prevMoveSpeed = moveSpeed;
  }
  assert(maxDelta < 0.02, `walk/trot blend not continuous, max per-tick delta=${maxDelta.toFixed(4)}`);
  dog.dispose?.();
}

// 7. Sit/idle/flop leg poses must not be affected by ground-conform tilt —
// only the whole-body root should differ between flat and sloped ground.
{
  const legBoneNames = Object.values(DOG_LEG_CHAINS)
    .flatMap((chain) => [chain.upper, chain.lower, chain.pastern, chain.paw]);

  function assertLegPoseUnaffectedBySlope(setup, perTick, label) {
    const dogFlat = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
    const dogSlope = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
    dogFlat.animation.setAutopilot(false);
    dogSlope.animation.setAutopilot(false);
    setup(dogFlat);
    setup(dogSlope);

    for (let i = 0; i < 90; i += 1) {
      perTick?.(dogFlat);
      perTick?.(dogSlope);
      dogFlat.update(0, { fixed: true, getGroundHeight: () => 0 });
      dogSlope.update(0, { fixed: true, getGroundHeight: (x, z) => 0.3 * z });
    }

    for (const name of legBoneNames) {
      const qa = dogFlat.rig.bonesByName.get(name).quaternion;
      const qb = dogSlope.rig.bonesByName.get(name).quaternion;
      const dot = Math.abs(qa.dot(qb));
      assert(dot > 0.999999, `${label} leg bone ${name} affected by ground slope (dot=${dot.toFixed(8)})`);
    }
    dogFlat.dispose?.();
    dogSlope.dispose?.();
  }

  assertLegPoseUnaffectedBySlope((dog) => dog.animation.setBehavior('sit'), null, 'sit');
  assertLegPoseUnaffectedBySlope((dog) => dog.animation.setBehavior('idle'), null, 'idle');
  assertLegPoseUnaffectedBySlope(
    (dog) => dog.animation.startFlop(),
    (dog) => dog.animation.advanceFlop(FIXED_DT),
    'flop',
  );
}

console.log(
  `ok — dog gait IK: slope pitch tracks atan(slope) across ${SLOPE_BREEDS.length} breeds `
  + '(procedural + clip-driven), per-leg IK grounds procedural AND clip-driven walk/trot, '
  + 'stride frequency scales with speed, walk<->trot blend continuous, sit/idle/flop untouched by slope',
);
