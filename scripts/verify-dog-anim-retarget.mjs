import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DOG_BONE_DEFS, createDogSkeleton } from '../src/game/characters/dog/dogSkeleton.js';
import {
  DOG_GROUND_CONTACT_COMPRESSION,
  DOG_PAW_MESH_PAD,
  plantDogFeet,
} from '../src/game/characters/dog/dogFootPlant.js';
import { dogDebugState, setDogDebugField } from '../src/game/config/dogDebugConfig.js';
import {
  HORSE_TO_DOG_BONE_MAP,
  INTENTIONALLY_UNMAPPED_HORSE_BONES,
} from '../src/game/characters/dog/horseToDogBoneMap.js';
import { readGlb } from './lib/readGlb.mjs';

const dogBones = new Set(DOG_BONE_DEFS.map((definition) => definition.name));
for (const [source, target] of Object.entries(HORSE_TO_DOG_BONE_MAP)) {
  assert.ok(dogBones.has(target), `${source} maps to missing dog bone ${target}`);
}

const { json: sourceJson } = await readGlb(resolve('public/assets/models/horse-rigged.glb'));
const sourceBones = new Set((sourceJson.skins?.[0]?.joints ?? [])
  .map((nodeIndex) => sourceJson.nodes?.[nodeIndex]?.name)
  .filter(Boolean));
const allowedUnmapped = new Set(INTENTIONALLY_UNMAPPED_HORSE_BONES);
for (const name of sourceBones) {
  assert.ok(
    HORSE_TO_DOG_BONE_MAP[name] || allowedUnmapped.has(name),
    `source joint ${name} is neither mapped nor intentionally ignored`,
  );
}

const manifest = JSON.parse(await readFile(resolve('public/assets/dog-anims/manifest.json'), 'utf8'));
assert.equal(manifest.clips.length, 14);
assert.equal(manifest.rootTranslationLocked, true);
for (const required of ['Idle', 'Walk', 'Run', 'Sit', 'Jump']) {
  assert.ok(manifest.clips.some((clip) => clip.name === required), `manifest missing ${required}`);
}
for (const entry of manifest.clips) {
  const json = JSON.parse(await readFile(resolve('public/assets/dog-anims', entry.file), 'utf8'));
  const clip = THREE.AnimationClip.parse(json);
  assert.ok(clip.duration > 0, `${entry.name} has invalid duration`);
  assert.ok(clip.tracks.length >= 30, `${entry.name} has only ${clip.tracks.length} mapped tracks`);
  for (const track of clip.tracks) {
    const boneName = track.name.split('.')[0];
    assert.ok(dogBones.has(boneName), `${entry.name} targets missing dog bone ${boneName}`);
    assert.notEqual(boneName, 'Root', `${entry.name} must not override controller-owned Root`);
  }
}

// Looping clips must close: the retarget blends tails onto frame 0 so cycles
// (Run especially) do not snap at the wrap point.
const NON_LOOPING_CLIPS = new Set(['Death', 'Fall']);
for (const entry of manifest.clips) {
  if (NON_LOOPING_CLIPS.has(entry.name)) continue;
  const json = JSON.parse(await readFile(resolve('public/assets/dog-anims', entry.file), 'utf8'));
  const clip = THREE.AnimationClip.parse(json);
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const values = track.values;
    const first = new THREE.Quaternion().fromArray(values, 0);
    const last = new THREE.Quaternion().fromArray(values, values.length - 4);
    const gapDeg = THREE.MathUtils.radToDeg(first.angleTo(last));
    assert.ok(gapDeg < 1, `${entry.name}:${track.name} has a ${gapDeg.toFixed(2)}deg loop gap`);
  }
}

// The shared Dog debug toggle must bypass the final IK without disabling the
// root support pass. Compare the same Idle frame through both live states.
{
  const idleEntry = manifest.clips.find((clip) => clip.name === 'Idle');
  const idleJson = JSON.parse(await readFile(resolve('public/assets/dog-anims', idleEntry.file), 'utf8'));
  const idleClip = THREE.AnimationClip.parse(idleJson);
  const sampleFrontPawY = (enabled) => {
    setDogDebugField('footIkEnabled', enabled);
    const rig = createDogSkeleton();
    const actorRoot = new THREE.Group();
    actorRoot.add(rig.root);
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(idleClip).play();
    mixer.setTime(idleClip.duration / 2);
    plantDogFeet({ root: actorRoot, rig }, { getGroundHeight: () => 0 });
    const y = rig.bonesByName.get('PawL').getWorldPosition(new THREE.Vector3()).y;
    mixer.stopAllAction();
    mixer.uncacheClip(idleClip);
    return y;
  };
  const withoutIk = sampleFrontPawY(false);
  const withIk = sampleFrontPawY(true);
  assert.ok(dogDebugState.footIkEnabled, 'Dog Foot IK debug state did not re-enable');
  assert.ok(withIk < withoutIk - 0.01, `Dog Foot IK toggle changed front contact by only ${(withoutIk - withIk).toFixed(3)}m`);
}

// Ground-contact loops keep the lowest paw on the floor: apply Idle mid-clip
// to the real skeleton and confirm paws sit at rest height without lateral
// (crooked-leg) drift, and that a Pelvis height channel carries the contact.
{
  const idleEntry = manifest.clips.find((clip) => clip.name === 'Idle');
  const idleJson = JSON.parse(await readFile(resolve('public/assets/dog-anims', idleEntry.file), 'utf8'));
  const idleClip = THREE.AnimationClip.parse(idleJson);
  assert.ok(
    idleClip.tracks.some((track) => track.name === 'Pelvis.position'),
    'Idle is missing the baked Pelvis.position ground-contact track',
  );
  const rig = createDogSkeleton();
  const actorRoot = new THREE.Group();
  actorRoot.add(rig.root);
  const mixer = new THREE.AnimationMixer(rig.root);
  const action = mixer.clipAction(idleClip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(idleClip.duration / 2);
  rig.root.updateMatrixWorld(true);
  for (const paw of ['PawL', 'PawR', 'HindPawL', 'HindPawR']) {
    const position = rig.bonesByName.get(paw).getWorldPosition(new THREE.Vector3());
    const rest = rig.worldBindPos.get(paw);
    // Rotation-only retargeting may leave the non-supporting end slightly high;
    // the shared post-mixer plant below resolves that final reach difference.
    assert.ok(Math.abs(position.y - rest.y) < 0.05, `Idle floats/sinks ${paw} by ${(position.y - rest.y).toFixed(3)}m before plant`);
    assert.ok(Math.abs(position.x - rest.x) < 0.03, `Idle bends ${paw} laterally by ${(position.x - rest.x).toFixed(3)}m`);
  }

  plantDogFeet({ root: actorRoot, rig }, { getGroundHeight: () => 0 });
  const contactPawY = DOG_PAW_MESH_PAD - DOG_GROUND_CONTACT_COMPRESSION;
  const plantedYs = [];
  for (const paw of ['PawL', 'PawR', 'HindPawL', 'HindPawR']) {
    const position = rig.bonesByName.get(paw).getWorldPosition(new THREE.Vector3());
    plantedYs.push(position.y);
    assert.ok(
      Math.abs(position.y - contactPawY) < 0.006,
      `Idle leaves ${paw} ${(position.y - contactPawY).toFixed(3)}m off the floor after plant`,
    );
  }
  assert.ok(
    Math.max(...plantedYs) - Math.min(...plantedYs) < 0.006,
    `Idle planted paw spread is ${(Math.max(...plantedYs) - Math.min(...plantedYs)).toFixed(3)}m`,
  );
  for (const paw of ['PawL', 'PawR']) {
    const world = rig.bonesByName.get(paw).getWorldQuaternion(new THREE.Quaternion());
    const bind = rig.worldBindQuaternions.get(paw);
    const tiltDeg = THREE.MathUtils.radToDeg(world.angleTo(bind));
    assert.ok(tiltDeg < 1, `Idle leaves ${paw} tilted ${tiltDeg.toFixed(2)}deg off its flat bind plane`);
  }

  // Head is +Z: knee/stifle forward, upper hock behind it, paw forward again.
  const joint = (name) => rig.bonesByName.get(name).getWorldPosition(new THREE.Vector3());
  const hip = joint('HipL');
  const stifle = joint('ThighL');
  const upperHock = joint('ShinL');
  const lowerHock = joint('HockL');
  const hindPaw = joint('HindPawL');
  assert.ok(stifle.z > hip.z + 0.06, 'Idle hind stifle must bend forward of hip');
  assert.ok(upperHock.z < stifle.z - 0.06, 'Idle upper hock must bend behind stifle');
  assert.ok(lowerHock.y > hindPaw.y + 0.01, 'Idle rear shin/hock must remain above paw');
  assert.ok(hindPaw.z > lowerHock.z + 0.015, 'Idle hind foot must point forward from hock');
  mixer.stopAllAction();
  mixer.uncacheClip(idleClip);
}

// The ground solver must stay on one continuous two-bone solution. The old
// Y-only Jacobian jumped the front paw 5–7cm fore/aft between valid branches.
{
  const idleEntry = manifest.clips.find((clip) => clip.name === 'Idle');
  const idleJson = JSON.parse(await readFile(resolve('public/assets/dog-anims', idleEntry.file), 'utf8'));
  const idleClip = THREE.AnimationClip.parse(idleJson);
  const rig = createDogSkeleton();
  const actorRoot = new THREE.Group();
  actorRoot.add(rig.root);
  const mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(idleClip).play();
  let previousZ = null;
  let maxStepZ = 0;
  const samples = Math.ceil(idleClip.duration * 60);
  for (let i = 0; i <= samples; i += 1) {
    mixer.setTime((i / 60) % idleClip.duration);
    plantDogFeet({ root: actorRoot, rig }, { getGroundHeight: () => 0 });
    const z = rig.bonesByName.get('PawL').getWorldPosition(new THREE.Vector3()).z;
    if (previousZ !== null) maxStepZ = Math.max(maxStepZ, Math.abs(z - previousZ));
    previousZ = z;
  }
  assert.ok(maxStepZ < 0.003, `Idle front paw jumps ${maxStepZ.toFixed(3)}m fore/aft between frames`);
  mixer.stopAllAction();
  mixer.uncacheClip(idleClip);
}

// Run must not dump body height mid-loop (suspension float used to pull the
// pelvis down ~8cm after a clamped plateau — a visible hitch every cycle).
{
  const runEntry = manifest.clips.find((clip) => clip.name === 'Run');
  const runJson = JSON.parse(await readFile(resolve('public/assets/dog-anims', runEntry.file), 'utf8'));
  const runClip = THREE.AnimationClip.parse(runJson);
  const pelvis = runClip.tracks.find((track) => track.name === 'Pelvis.position');
  assert.ok(pelvis, 'Run is missing the baked Pelvis.position ground-contact track');
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pelvis.values.length; i += 3) {
    const y = pelvis.values[i + 1];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const range = maxY - minY;
  assert.ok(range < 0.055, `Run pelvis height range ${range.toFixed(3)}m is too large (mid-loop hitch)`);
}
console.log(`verify-dog-anim-retarget: OK (${manifest.clips.length} clips, ${Object.keys(HORSE_TO_DOG_BONE_MAP).length} mapped joints)`);
