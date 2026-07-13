#!/usr/bin/env node
/**
 * M0 regression: the normalized weapon-locomotion packs load against the runtime
 * player skeleton exactly like weapon-rifle/ (retarget:false + useBakedClip:false).
 *
 * Guards: the new Mixamo FBX clips bind to `newplayerv3.fbx` (mixamorig* names,
 * no numbered mixamorig6 prefixes), retain the full body + both arm chains, and
 * the moving locomotion clips carry root translation (so drive:'locomotion' has
 * something to sample). Regenerate the dirs with `npm run import:loco-packs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  collectBindRotations,
  collectTargetNames,
  normalizeMixamoAnimationSource,
} from '../src/game/characters/mara/createMaraFbxModel.js';
import { prepareClip } from '../src/game/characters/mara/MaraAnimationController.js';

globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadTextureStub() {
  return new THREE.Texture();
};

const loader = new FBXLoader();
const loadFbx = (filePath) => {
  const bytes = readFileSync(filePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return loader.parse(buffer, '');
};

const root = path.resolve('.');
const target = loadFbx(path.join(root, 'assets-source/models/newplayerv3.fbx'));
const targetNames = collectTargetNames(target);
const targetBindRotations = collectBindRotations(target);
const rootBindPosition = target.getObjectByName('mixamorigHips')?.position.clone()
  ?? new THREE.Vector3();

const PACKS = 'public/assets/animation-packs';
// One representative clip per family kind: an in-place idle and a travelling clip
// (rifle 8-way + crouch, pistol strafe + arc). `moves` clips must show root travel.
const SAMPLES = [
  { file: `${PACKS}/weapon-rifle-8way/idle.fbx`, moves: false },
  { file: `${PACKS}/weapon-rifle-8way/run_fwd_left.fbx`, moves: true },
  { file: `${PACKS}/weapon-rifle-8way/sprint_bwd.fbx`, moves: true },
  { file: `${PACKS}/weapon-rifle-8way/crouch_walk_left.fbx`, moves: true },
  { file: `${PACKS}/weapon-rifle-8way/aim_idle.fbx`, moves: false },
  { file: `${PACKS}/weapon-rifle-8way/turn_left.fbx`, moves: false },
  { file: `${PACKS}/weapon-pistol/idle.fbx`, moves: false },
  { file: `${PACKS}/weapon-pistol/walk_fwd.fbx`, moves: true },
  { file: `${PACKS}/weapon-pistol/run_fwd_left.fbx`, moves: true, loopBlend: 0.12 },
  { file: `${PACKS}/weapon-pistol/run_fwd_right.fbx`, moves: true, loopBlend: 0.12 },
  { file: `${PACKS}/weapon-pistol/run_bwd_left.fbx`, moves: true, loopBlend: 0.12 },
  { file: `${PACKS}/weapon-pistol/run_bwd_right.fbx`, moves: true, loopBlend: 0.12 },
  { file: `${PACKS}/weapon-pistol/strafe_left.fbx`, moves: true },
  { file: `${PACKS}/weapon-rifle-8way/reload.fbx`, moves: false },
];

const ARM_BONES = ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand'];

for (const { file, moves, loopBlend } of SAMPLES) {
  const source = loadFbx(path.join(root, file));
  normalizeMixamoAnimationSource(source, targetNames);
  const sourceClip = source.animations[0];
  assert.ok(sourceClip, `${file} must contain an animation clip`);

  // Root travel is read from the RAW hips track before prepareClip locks it.
  const hips = sourceClip.tracks.find((t) => /Hips\.position$/.test(t.name));
  assert.ok(hips, `${file} must have a hips position track`);
  const v = hips.values;
  const travel = Math.hypot(v[v.length - 3] - v[0], v[v.length - 1] - v[2]);

  const prepared = prepareClip({
    clip: sourceClip,
    state: path.basename(file, '.fbx'),
    rootBindPosition,
    sourceBindRotations: collectBindRotations(source),
    targetBindRotations,
    targetNames,
    retargetQuaternionTracks: false,
    rootPosition: 'locked',
    loopBlend,
  });

  assert.ok(prepared.tracks.length >= 20, `${file} retained only ${prepared.tracks.length} tracks`);
  assert.ok(
    prepared.tracks.every((t) => !t.name.startsWith('mixamorig6')),
    `${file} must normalize numbered Mixamo track prefixes`,
  );
  for (const bone of ARM_BONES) {
    assert.ok(
      prepared.tracks.some((t) => t.name === `mixamorig${bone}.quaternion`),
      `${file} must animate mixamorig${bone}`,
    );
  }
  if (moves) {
    assert.ok(travel > 5, `${file} is a travelling clip but hips barely move (${travel.toFixed(1)})`);
  }
  if (loopBlend) {
    const hipsRotation = prepared.tracks.find((t) => t.name === 'mixamorigHips.quaternion');
    assert.ok(hipsRotation, `${file} must retain hips rotation for loop blending`);
    const size = hipsRotation.getValueSize();
    const values = hipsRotation.values;
    const seam = Math.max(...Array.from({ length: size }, (_, i) =>
      Math.abs(values[values.length - size + i] - values[i])));
    assert.ok(seam < 1e-3, `${file} loop seam remains visible (${seam.toFixed(4)})`);
  }
}

console.log(`verify-loco-clips: ${SAMPLES.length} weapon-locomotion clips bind to the player skeleton`);
