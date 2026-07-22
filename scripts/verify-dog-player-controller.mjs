import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DogClipPlayer } from '../src/game/characters/dog/DogClipPlayer.js';
import { DogPlayerController } from '../src/game/characters/dog/DogPlayerController.js';
import { DogMudContactHelper } from '../src/game/characters/dog/DogMudContactHelper.js';
import { createMudDeformField } from '../src/game/world/mudDeformField.js';

const root = new THREE.Group();
root.position.set(0, 4, 0);
const intent = { behavior: 'idle', direction: new THREE.Vector3(), external: false };
let dogUpdateOptions = null;
const dog = {
  root,
  phenotype: { skeleton: { scale: 1 }, motion: { speed: 1 } },
  animation: {
    setAutopilot() {},
    setExternalRootMotion(value) { intent.external = value; },
    setMoveIntent(next) {
      intent.behavior = next.sit ? 'sit' : next.look ? 'look' : next.moving ? (next.sprint ? 'trot' : 'walk') : 'idle';
      intent.direction.set(next.x, 0, next.z);
    },
    getBehavior: () => intent.behavior,
    getMoveSpeed: () => intent.behavior === 'trot' ? 3.9 : intent.behavior === 'walk' ? 1.85 : 0,
    getRootYaw: () => Math.PI,
  },
  update(_delta, options) { dogUpdateOptions = options; },
};
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 3, 5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);
const levelSystem = {
  level: { getSurfaceAt: () => 'grass' },
  getGroundHeightAt: () => 1.25,
  getBlockingColliderAt: () => null,
};
const controller = new DogPlayerController({ dog, levelSystem, camera });
assert.equal(intent.external, true, 'controller should own external root motion');

controller.update(0, { deferFootPlant: true });
assert.equal(dogUpdateOptions?.plantFeet, false, 'clip-driven pose must defer the procedural foot plant');

// Movement now ramps in (accel-clamped speed, real momentum) rather than
// snapping to target speed on the first tick, so hold the input over several
// frames — same as a real play session holding a stick direction — before
// asserting displacement.
// Partial stick (< 0.62) = walk; full stick or brace = run/trot.
for (let i = 0; i < 20; i += 1) controller.update(0.1, { moveZ: -0.45, moveX: 0, brace: false });
assert.equal(dogUpdateOptions?.plantFeet, true, 'procedural-only pose should plant in the controller');
assert.equal(intent.behavior, 'walk');
assert.ok(root.position.z < -0.08, `forward input should move camera-forward, z=${root.position.z}`);
assert.equal(root.position.y, 1.25, 'controller should snap world root to level ground');

const walkZ = root.position.z;
for (let i = 0; i < 20; i += 1) controller.update(0.1, { moveZ: -1, moveX: 0, brace: false });
assert.equal(intent.behavior, 'trot', 'full stick should auto-run without brace');
assert.ok(root.position.z - walkZ < -0.15, 'trot should move farther than walk');

const runZ = root.position.z;
for (let i = 0; i < 20; i += 1) controller.update(0.1, { moveZ: -1, moveX: 0, brace: true });
assert.equal(intent.behavior, 'trot');
assert.ok(root.position.z - runZ < -0.05, 'brace run keeps trot speed');

controller.update(1 / 60, { crouchHeld: true });
assert.equal(intent.behavior, 'sit');
controller.update(1 / 60, { cutModePressed: true });
assert.equal(intent.behavior, 'look');

// Jump arc: crouch anticipation plants the dog, then a launched arc that
// peaks near 0.55m and lands back on the ground. Mid-air presses are ignored.
const jumpStart = root.position.y;
controller.update(1 / 60, { jumpPressed: true });
assert.equal(controller.jumpPhase, 'crouch');
assert.equal(controller.jumpStartedThisFrame, true, 'feature syncs the Jump clip off this flag');
let apex = 0;
let sawAir = false;
let sawLand = false;
for (let i = 0; i < 240 && !sawLand; i += 1) {
  controller.update(1 / 60, i === 30 ? { jumpPressed: true } : {});
  if (controller.jumpPhase === 'crouch') {
    assert.equal(root.position.y, jumpStart, 'crouch anticipation must stay planted');
  }
  if (i === 30) {
    assert.equal(controller.jumpPhase, 'air', 'mid-air jump press must be ignored');
    assert.equal(controller.jumpStartedThisFrame, false);
  }
  if (controller.jumpPhase === 'air') sawAir = true;
  apex = Math.max(apex, root.position.y - jumpStart);
  if (sawAir && controller.jumpPhase === 'none') sawLand = true;
}
assert.ok(sawAir, 'jump should launch after the crouch');
assert.ok(sawLand, 'jump should land');
assert.ok(apex > 0.45 && apex < 0.65, `jump apex should be ~0.55m, got ${apex.toFixed(3)}`);
assert.equal(root.position.y, jumpStart, 'jump returns to ground height');

// Animated paw contacts: only moving, grounded paws on mud stamp; spatial and
// cooldown gates prevent stationary re-digging.
const mudField = createMudDeformField({ cellSize: 0.05, resolution: 128, maxDepth: 0.12 });
const pawRoot = new THREE.Group();
const bonesByName = new Map();
for (const [name, x, z] of [
  ['PawL', -0.15, 0.3],
  ['PawR', 0.15, 0.3],
  ['HindPawL', -0.15, -0.3],
  ['HindPawR', 0.15, -0.3],
]) {
  const bone = new THREE.Object3D();
  bone.position.set(x, 0.025, z);
  pawRoot.add(bone);
  bonesByName.set(name, bone);
}
pawRoot.updateMatrixWorld(true);
let pawSurface = 'mud';
const pawLevelSystem = {
  level: { getSurfaceAt: () => pawSurface },
  getGroundHeightAt: () => 0,
};
const mudContacts = new DogMudContactHelper({
  dog: {
    rig: { root: pawRoot, bonesByName },
    phenotype: { skeleton: { scale: 1 } },
  },
  levelSystem: pawLevelSystem,
  mudField,
});
assert.equal(mudContacts.update(0.1, {
  moving: true,
  surfaceClass: 'mud',
  headingX: 1,
  headingZ: 0,
}), 4, 'four grounded paws stamp while moving through mud');
assert.equal(mudField.dogPawStampCount, 4);
assert.equal(mudContacts.update(0.1, { moving: false, surfaceClass: 'mud' }), 0, 'stationary dog does not dig');
assert.equal(mudContacts.update(0.1, { moving: true, airborne: true, surfaceClass: 'mud' }), 0, 'airborne dog does not stamp');
pawSurface = 'grass';
assert.equal(mudContacts.update(0.1, { moving: true, surfaceClass: 'grass' }), 0, 'non-mud paws do not stamp');
pawSurface = 'mud';
bonesByName.get('PawL').position.y = 0.5;
for (const bone of bonesByName.values()) bone.position.z += 0.2;
const groundedTrailCount = mudContacts.update(0.1, {
  moving: true,
  surfaceClass: 'mud',
  headingX: 1,
  headingZ: 0,
});
assert.equal(groundedTrailCount, 3, 'raised paw is excluded while other moved paws extend the trail');
assert.equal(mudField.dogPawStampCount, 7);
assert.equal(mudField.sampleDepthAt(20, 20), 0, 'dog-paw trail remains bounded');
assert.ok(Array.from(mudField._buffers.directionX).some((value) => value > 0.9), 'paw stamps retain heading orientation');

// Death one-shot emits one impact edge at ~45%, then never repeats while held.
const clipRoot = new THREE.Group();
const clipPlayer = new DogClipPlayer({ rig: { root: clipRoot, skeleton: { update() {} } } });
const deathClip = new THREE.AnimationClip('Death', 1, []);
const idleClip = new THREE.AnimationClip('Idle', 1, []);
clipPlayer.actions.set('Death', clipPlayer.mixer.clipAction(deathClip));
clipPlayer.actions.set('Idle', clipPlayer.mixer.clipAction(idleClip));
// Clips are default; still force-enable for this headless stub (no library load).
clipPlayer.enabled = true;
clipPlayer.ready = true;
assert.equal(clipPlayer.playPuddleSplash(), true);
let impactEdges = 0;
for (let frame = 0; frame < 30; frame += 1) {
  clipPlayer.update(0.05, 'idle');
  if (clipPlayer.consumePuddleImpact()) impactEdges += 1;
}
assert.equal(impactEdges, 1, 'Death flop emits exactly one impact edge');
assert.equal(clipPlayer.impactSequence, 1);
clipPlayer.dispose();

console.log('verify-dog-player-controller: intent, gait speed, sit/look, jump arc, and gated mud paw contacts OK');
