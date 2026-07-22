/**
 * Guards hero dog active-ragdoll scheme + state machine (no full Rapier world).
 *
 * Run: node scripts/verify-dog-active-ragdoll.mjs
 * Alias: npm run verify:dog-active-ragdoll
 */
import assert from 'node:assert/strict';
import {
  DOG_RAGDOLL_PARTS,
  dogRagdollPartCount,
  DogActiveRagdoll,
  headingFromBodyForward,
} from '../src/game/characters/dog/DogActiveRagdoll.js';
import * as THREE from 'three';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  assert.ok(dogRagdollPartCount() >= 9, 'enough bodies for flop articulation');
  assert.ok(dogRagdollPartCount() <= 16, 'compact graph for hero budget');
  const names = new Set(DOG_RAGDOLL_PARTS.map((p) => p.bone));
  assert.ok(names.has('Pelvis') && names.has('Chest') && names.has('Head'));
  assert.ok(names.has('ThighL') && names.has('ShinL'));
  // Every non-root part has a parent in the scheme.
  for (const part of DOG_RAGDOLL_PARTS) {
    if (!part.parent) continue;
    assert.ok(
      DOG_RAGDOLL_PARTS.some((p) => p.bone === part.parent),
      `parent ${part.parent} missing for ${part.bone}`,
    );
  }
  ok(`scheme ${dogRagdollPartCount()} parts with valid parent graph`);
}

{
  // Side-rolled body: euler-Y of the quat drifts; +Z ground projection stays true.
  const trueYaw = 0.8;
  const roll = THREE.MathUtils.degToRad(70);
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(0, trueYaw, 0, 'YXZ'))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  const naive = Math.atan2(
    2 * (q.w * q.y + q.x * q.z),
    1 - 2 * (q.y * q.y + q.z * q.z),
  );
  const recovered = headingFromBodyForward({ x: q.x, y: q.y, z: q.z, w: q.w });
  assert.ok(Math.abs(naive - trueYaw) > 0.2, 'naive euler drifts under roll (sanity)');
  assert.ok(
    Math.abs(recovered - trueYaw) < 0.02,
    `headingFromBodyForward should keep yaw (got ${recovered}, want ${trueYaw})`,
  );
  ok('recovery heading stable under side-roll');
}

{
  // Procedural flop API on the animation facade (handoff into ragdoll at ~0.42).
  const dog = createProceduralDog({
    breedId: 'golden-retriever',
    seed: 2,
    shellCount: 4,
    budget: 'npc',
  });
  const anim = dog.animation;
  assert.equal(typeof anim.startFlop, 'function');
  assert.equal(anim.isFlopping?.(), false);
  anim.startFlop();
  assert.equal(anim.isFlopping(), true);
  assert.equal(anim.getBehavior(), 'flop');
  let p = 0;
  for (let i = 0; i < 30; i += 1) {
    p = anim.advanceFlop(1 / 60, 0.9);
    anim.update(1 / 60);
  }
  assert.ok(p > 0.4, `flop progressed past impact (${p})`);
  assert.ok(p <= 1);
  anim.clearFlop();
  assert.equal(anim.isFlopping(), false);
  dog.dispose();
  ok('procedural flop start/advance/clear');
}

{
  // Fake physics world that records body creates/removes.
  const bodies = [];
  const joints = [];
  const fakeWorld = {
    createRigidBody(desc) {
      const body = {
        _t: { x: 0, y: 0.4, z: 0 },
        _r: { x: 0, y: 0, z: 0, w: 1 },
        _lin: { x: 0, y: 0, z: 0 },
        _ang: { x: 0, y: 0, z: 0 },
        translation() { return { ...this._t }; },
        rotation() { return this._r; },
        linvel() { return { ...this._lin }; },
        setLinvel(v) {
          this._lin = { x: v.x, y: v.y, z: v.z };
        },
        angvel() { return this._ang; },
        setAngvel(v) {
          this._ang = { x: v.x, y: v.y, z: v.z };
        },
        setTranslation(t) {
          this._t = { x: t.x, y: t.y, z: t.z };
        },
        mass() { return 1; },
        applyImpulse() {},
        applyTorqueImpulse() {},
        addTorque() {},
        isSleeping() { return false; },
      };
      // Capture spawn pose from the fluent desc used by activate().
      if (desc?._spawn) {
        body._t = { ...desc._spawn };
      }
      if (desc?._rot) {
        body._r = { ...desc._rot };
      }
      bodies.push(body);
      return body;
    },
    createCollider() { return {}; },
    createImpulseJoint() {
      const j = {};
      joints.push(j);
      return j;
    },
    removeImpulseJoint(j) {
      const i = joints.indexOf(j);
      if (i >= 0) joints.splice(i, 1);
    },
    removeRigidBody(b) {
      const i = bodies.indexOf(b);
      if (i >= 0) bodies.splice(i, 1);
    },
  };
  const fakeRAPIER = {
    RigidBodyDesc: {
      dynamic() {
        return {
          _spawn: { x: 0, y: 0.4, z: 0 },
          _rot: { x: 0, y: 0, z: 0, w: 1 },
          setTranslation(x, y, z) {
            this._spawn = { x, y, z };
            return this;
          },
          setRotation(r) {
            this._rot = { x: r.x, y: r.y, z: r.z, w: r.w };
            return this;
          },
          setLinearDamping() { return this; },
          setAngularDamping() { return this; },
          setCanSleep() { return this; },
          setGravityScale() { return this; },
          setCcdEnabled() { return this; },
        };
      },
    },
    ColliderDesc: {
      cuboid() {
        return {
          setMass() { return this; },
          setFriction() { return this; },
          setRestitution() { return this; },
          setCollisionGroups() { return this; },
          setSolverGroups() { return this; },
        };
      },
    },
    JointData: {
      spherical() { return {}; },
    },
  };
  const physics = { world: fakeWorld, RAPIER: fakeRAPIER };

  const dog = createProceduralDog({
    breedId: 'golden-retriever',
    seed: 1,
    shellCount: 4,
    budget: 'npc',
  });
  dog.root.position.set(1, 0, 2);
  dog.rig.root.updateMatrixWorld(true);

  const ragdoll = new DogActiveRagdoll(dog, physics);
  // Flat ground at y=0 — settle must pin high bone centers down.
  ragdoll.setGroundSampler(() => 0);
  assert.equal(ragdoll.active, false);
  const okActivate = ragdoll.activate({ headingX: 0, headingZ: 1, impulse: 4 });
  assert.equal(okActivate, true, 'activate succeeds with fake physics');
  assert.equal(ragdoll.mode, 'limp');
  assert.ok(ragdoll.records.length >= 9, `bodies ${ragdoll.records.length}`);
  assert.ok(bodies.length === ragdoll.records.length);
  ok(`activate creates ${ragdoll.records.length} bodies`);

  // After settle, core (Pelvis/Chest) rests on the floor — limbs may sit
  // slightly under/over; continuous pin + gravity clean that up in-game.
  for (const record of ragdoll.records.filter((r) => r.isCore)) {
    const t = record.body.translation();
    const bottom = t.y - record.supportR;
    assert.ok(
      bottom <= 0.05,
      `${record.name} still floating: bottom=${bottom.toFixed(3)} y=${t.y.toFixed(3)} r=${record.supportR.toFixed(3)}`,
    );
    assert.ok(
      bottom >= -0.04,
      `${record.name} buried: bottom=${bottom.toFixed(3)}`,
    );
  }
  ok('activate settles torso onto ground (no float)');

  // Point torso along +X so recovery yaw must land near +π/2 (not pre-flop 0).
  for (const record of ragdoll.records) {
    if (record.name === 'Pelvis') record.body.setTranslation({ x: 1, y: 0.15, z: 2 });
    if (record.name === 'Chest') record.body.setTranslation({ x: 1.35, y: 0.16, z: 2 });
  }
  const expectedYaw = Math.atan2(0.35, 0); // +X

  // Drive limp → blend (pose slerp) → inactive. No spring recover.
  ragdoll.timer = 0.01;
  ragdoll.update(0.05);
  assert.equal(ragdoll.mode, 'blend', 'limp ends in pose blend, not spring recover');
  assert.equal(bodies.length, 0, 'physics torn down when blend starts');
  assert.equal(joints.length, 0, 'joints removed at blend start');
  const blendYaw = dog.animation.getRootYaw();
  assert.ok(
    Math.abs(blendYaw - expectedYaw) < 0.05,
    `blend start yaw from spine (got ${blendYaw.toFixed(3)}, want ~${expectedYaw.toFixed(3)})`,
  );
  ok('limp transitions to blend and frees physics');

  // Finish blend over blendDuration — facing must stay locked.
  for (let i = 0; i < 30; i += 1) ragdoll.update(0.05);
  assert.equal(ragdoll.active, false);
  assert.equal(ragdoll.mode, 'inactive');
  const endYaw = dog.animation.getRootYaw();
  assert.ok(
    Math.abs(endYaw - blendYaw) < 1e-4,
    `finish yaw matches get-up yaw (start ${blendYaw.toFixed(3)}, end ${endYaw.toFixed(3)})`,
  );
  const aim = dog.animation.getDesiredDirection();
  const aimYaw = Math.atan2(aim.x, aim.z);
  assert.ok(
    Math.abs(aimYaw - endYaw) < 0.05,
    `desiredDir matches finish yaw (aim ${aimYaw.toFixed(3)}, yaw ${endYaw.toFixed(3)})`,
  );
  ok('blend completes to inactive standing with locked facing');

  ragdoll.dispose();
  dog.dispose();
}

console.log(`\n${passed} passed`);
