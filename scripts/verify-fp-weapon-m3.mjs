#!/usr/bin/env node
/**
 * M3: chooseLocomotion mapping, spine aim helpers, FirstPersonWeaponSystem
 * processInput gating + animationOverride wiring (no browser).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyFirstPersonBodyYaw,
  applySpineAimPitch,
  cameraYawToBodyYaw,
  chooseLocomotion,
  isFirstPersonForwardIntent,
  mapLocomotionToPlaybackState,
  resolveSpineAimBones,
  setHeadHidden,
  shortestAngleDelta,
  stripHorizontalRootMotion,
} from '../src/game/characters/player/firstPersonRig.js';
import { FirstPersonWeaponSystem } from '../src/game/systems/FirstPersonWeaponSystem.js';

// --- chooseLocomotion ---
assert.equal(chooseLocomotion({ forward: 0, strafe: 0, grounded: true }), 'idle');
assert.equal(chooseLocomotion({ forward: 1, strafe: 0, running: false, grounded: true }), 'walk');
assert.equal(chooseLocomotion({ forward: 1, strafe: 0, running: true, grounded: true }), 'run');
assert.equal(chooseLocomotion({ forward: -1, strafe: 0, running: true, grounded: true }), 'runBackward');
assert.equal(chooseLocomotion({ forward: 0, strafe: 1, running: false, grounded: true }), 'strafeRight');
assert.equal(chooseLocomotion({ forward: 0.5, strafe: 0.5, running: true, grounded: true }), 'runArcRight');
assert.equal(chooseLocomotion({ forward: 0, strafe: 0, grounded: false }), 'jump');

assert.equal(mapLocomotionToPlaybackState('idle'), 'armedIdle');
assert.equal(mapLocomotionToPlaybackState('run'), 'armedJog');
assert.equal(mapLocomotionToPlaybackState('walk', { hasWeaponPack: true }), 'fp_walk');

// --- stripHorizontalRootMotion ---
{
  const clip = new THREE.AnimationClip('test', 1, [
    new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 0.5, 1], [
      1, 0.9, 2,
      3, 0.95, 4,
      5, 1.0, 6,
    ]),
  ]);
  stripHorizontalRootMotion(clip);
  const v = clip.tracks[0].values;
  assert.equal(v[0], 1);
  assert.equal(v[2], 2);
  assert.equal(v[3], 1); // x locked
  assert.equal(v[5], 2); // z locked
  assert.ok(Math.abs(v[4] - 0.95) < 1e-5); // y free
}

// --- spine aim + head/neck hide ---
{
  const root = new THREE.Group();
  const spine = new THREE.Bone();
  spine.name = 'mixamorigSpine';
  const spine1 = new THREE.Bone();
  spine1.name = 'mixamorigSpine1';
  const neck = new THREE.Bone();
  neck.name = 'mixamorigNeck';
  const head = new THREE.Bone();
  head.name = 'mixamorigHead';
  root.add(spine);
  spine.add(spine1);
  spine1.add(neck);
  neck.add(head);

  const layers = resolveSpineAimBones(root);
  assert.ok(layers.length >= 2);
  const q0 = spine.quaternion.clone();
  applySpineAimPitch(layers, 0.5);
  assert.ok(spine.quaternion.angleTo(q0) > 1e-6);

  setHeadHidden(root, true);
  assert.ok(head.scale.x < 0.01);
  assert.ok(neck.scale.x < 0.2, 'neck should shrink to hide stump');
  setHeadHidden(root, false);
  assert.ok(Math.abs(head.scale.x - 1) < 1e-6);
  assert.ok(Math.abs(neck.scale.x - 1) < 1e-6);
}

// --- body yaw neck clamp ---
{
  assert.ok(Math.abs(shortestAngleDelta(0, Math.PI) - Math.PI) < 1e-9
    || Math.abs(Math.abs(shortestAngleDelta(0, Math.PI)) - Math.PI) < 1e-9);
  const body = new THREE.Object3D();
  body.rotation.y = cameraYawToBodyYaw(0); // facing camera look dir at yaw 0
  // Small look within neck range: body stays
  const maxNeck = 0.72;
  applyFirstPersonBodyYaw(body, 0.3, { maxNeckYaw: maxNeck });
  assert.ok(Math.abs(shortestAngleDelta(body.rotation.y, cameraYawToBodyYaw(0))) < 1e-6);

  // Look past neck range: body must follow so |relative| === maxNeck
  const far = applyFirstPersonBodyYaw(body, 1.5, { maxNeckYaw: maxNeck });
  assert.equal(far.turned, true);
  assert.ok(Math.abs(Math.abs(far.relativeYaw) - maxNeck) < 1e-6);
  const rel = shortestAngleDelta(body.rotation.y, cameraYawToBodyYaw(1.5));
  assert.ok(Math.abs(Math.abs(rel) - maxNeck) < 1e-6);

  // Straighten (forward move): body fully faces camera after enough blend time
  body.rotation.y = cameraYawToBodyYaw(0);
  applyFirstPersonBodyYaw(body, 0.5, { maxNeckYaw: maxNeck }); // offset within neck
  assert.ok(Math.abs(shortestAngleDelta(body.rotation.y, cameraYawToBodyYaw(0))) < 1e-5);
  // apply offset by faking body left while camera looks 0.5
  body.rotation.y = cameraYawToBodyYaw(0);
  const straight = applyFirstPersonBodyYaw(body, 0.5, {
    maxNeckYaw: maxNeck,
    straighten: true,
    delta: 1,
    straightenSmoothing: 40,
  });
  assert.equal(straight.straightened, true);
  assert.ok(
    Math.abs(shortestAngleDelta(body.rotation.y, cameraYawToBodyYaw(0.5))) < 0.02,
    'forward straighten should face look yaw',
  );
  assert.equal(isFirstPersonForwardIntent({ moveZ: -1 }), true);
  assert.equal(isFirstPersonForwardIntent({ moveZ: 1 }), false);
  assert.equal(isFirstPersonForwardIntent({ moveX: 1 }), false);
}

// --- FirstPersonWeaponSystem ---
{
  const system = new FirstPersonWeaponSystem();
  const character = {
    group: new THREE.Group(),
    combat: {
      weapon: 'sheathed',
      armed: false,
      animationOverride: null,
      attack: null,
    },
  };
  const head = new THREE.Bone();
  head.name = 'mixamorigHead';
  character.group.add(head);
  character.animationController = { modelRoot: character.group };

  const cameraOn = { usesOnFootFirstPerson: () => true, pitch: 0.2 };
  const cameraOff = { usesOnFootFirstPerson: () => false, pitch: 0 };

  system.start({ character });

  // No gun drawn → traversal is NOT gated and the head stays visible, even in FP
  // (gun stance / head-hide only apply once a firearm is the drawn loadout weapon).
  const ungated = system.processInput({
    input: { vaultPressed: true, forward: 1, moveY: 1 },
    character,
    cameraSystem: cameraOn,
  });
  assert.equal(ungated.vaultPressed, true);
  assert.equal(system.armed, false);

  // No gun equipped → natural unarmed locomotion (no armed override).
  system.update({
    delta: 0.016,
    // moveZ: -1 = forward (InputSystem convention), sprint → run
    input: { moveZ: -1, sprintHeld: true },
    movement: { speed: 5, airborne: false },
    character,
    cameraSystem: cameraOn,
  });
  assert.ok(!character.combat.fpWeaponStance);
  assert.equal(character.combat.animationOverride, null);
  assert.equal(character.combat.armed, false);
  // locomotionKey now holds the resolved *weapon* state; with no gun it is idle.
  assert.equal(system.locomotionKey, 'idle');
  system.postAnimation({ character, cameraSystem: cameraOn });
  assert.ok(head.scale.x > 0.5, 'head stays visible when no gun is drawn');

  // Leaving the gun stance clears the weapon override the FP system had set
  // (fpWeaponStance marks it as ours; a sword's own override is left untouched).
  character.combat.fpWeaponStance = true;
  character.combat.animationOverride = 'rifle_run_fwd';
  system.update({
    delta: 0.016,
    input: { moveZ: -1, sprintHeld: true },
    movement: { speed: 5, airborne: false },
    character,
    cameraSystem: cameraOn,
  });
  assert.equal(character.combat.animationOverride, null);

  // Gun equipped + rifle pack present → fp_* full-body locomotion.
  system.gunView = { root: new THREE.Group() };
  system.setHolstered(false);
  character.animationController.hasState = (s) => s === 'fp_idle' || s === 'fp_run';
  system.update({
    delta: 0.016,
    input: { moveZ: -1, sprintHeld: true },
    movement: { speed: 5, airborne: false },
    character,
    cameraSystem: cameraOn,
  });
  assert.equal(character.combat.fpWeaponStance, true);
  assert.equal(character.combat.animationOverride, 'fp_run');
  assert.equal(character.combat.weaponClass, 'rifle');
  assert.ok(head.scale.x < 0.01, 'head hidden in FP with a gun drawn');

  // THIRD PERSON with the same gun drawn: gun hold still runs (weaponClass set,
  // head visible), but the full-body FP override is left for AnimationStateSystem's
  // weaponClass branch to resolve.
  system.update({
    delta: 0.016,
    input: { moveZ: -1, sprintHeld: true },
    movement: { speed: 5, airborne: false },
    character,
    cameraSystem: cameraOff,
  });
  assert.equal(system.armed, true, 'armed in third person when a gun is drawn');
  assert.equal(system.fp, false, 'not FP in third person');
  assert.equal(character.combat.weaponClass, 'rifle', 'weaponClass drives TP locomotion');
  assert.equal(character.combat.fpWeaponStance, false);
  assert.equal(character.combat.animationOverride, null, 'no FP override in third person');
  assert.ok(head.scale.x > 0.5, 'head visible in third person');
  // Restore FP for the remaining checks.
  character.animationController.hasState = (s) => s === 'fp_idle' || s === 'fp_run';
  system.update({
    delta: 0.016,
    input: { moveZ: -1, sprintHeld: true },
    movement: { speed: 5, airborne: false },
    character,
    cameraSystem: cameraOn,
  });

  // Gun without fp pack but with armedIdle available → armed fallback.
  character.animationController.hasState = (s) => s === 'armedIdle' || s === 'armedWalk' || s === 'armedJog';
  system.update({
    delta: 0.016,
    input: { moveZ: 0, moveX: 0 },
    movement: { speed: 0, airborne: false },
    character,
    cameraSystem: cameraOn,
  });
  assert.equal(character.combat.animationOverride, 'armedIdle');

  // Drop gun for deactivation checks.
  system.gunView = null;
  delete character.animationController.hasState;

  // postCamera clamps body past neck limit so FP never looks into the chest.
  character.group.rotation.y = cameraYawToBodyYaw(0);
  system.active = true;
  system.postCamera({
    character,
    cameraSystem: { usesOnFootFirstPerson: () => true, yaw: 2.0, pitch: 0 },
  });
  assert.equal(character.fpBodyYawLocked, true);
  const neckRel = shortestAngleDelta(character.group.rotation.y, cameraYawToBodyYaw(2.0));
  assert.ok(Math.abs(neckRel) <= 0.72 + 1e-5);

  // A visible gun is view-yaw locked: an FPS rifle cannot remain at the
  // unarmed neck-limit offset or the whole hold points out of frame.
  system.gunView = { root: new THREE.Group() };
  system.visibleWeapon = true;
  character.group.rotation.y = cameraYawToBodyYaw(0);
  system.postCamera({
    character,
    cameraSystem: { usesOnFootFirstPerson: () => true, yaw: 0.6, pitch: 0 },
    delta: 1,
  });
  assert.ok(
    Math.abs(shortestAngleDelta(character.group.rotation.y, cameraYawToBodyYaw(0.6))) < 0.02,
    'visible rifle should align body yaw to camera yaw',
  );
  system.gunView = null;
  system.visibleWeapon = false;

  system.update({
    delta: 0.016,
    input: {},
    movement: { speed: 0, airborne: false },
    character,
    cameraSystem: cameraOff,
  });
  assert.equal(system.active, false);
  assert.equal(character.combat.fpWeaponStance, false);

  system.dispose();
}

console.log('verify-fp-weapon-m3: all checks passed');
