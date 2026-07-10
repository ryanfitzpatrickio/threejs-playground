#!/usr/bin/env node

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
const rifleDir = path.join(root, 'public/assets/animation-packs/weapon-rifle');
const clips = [
  'idle.fbx',
  'walk.fbx',
  'run.fbx',
  'walkBackward.fbx',
  'runBackward.fbx',
  'strafeLeft.fbx',
  'strafeRight.fbx',
  'jump.fbx',
];

for (const file of clips) {
  const source = loadFbx(path.join(rifleDir, file));
  normalizeMixamoAnimationSource(source, targetNames);
  const sourceClip = source.animations[0];
  assert.ok(sourceClip, `${file} must contain an animation clip`);
  const prepared = prepareClip({
    clip: sourceClip,
    state: `fp_${path.basename(file, '.fbx')}`,
    rootBindPosition,
    sourceBindRotations: collectBindRotations(source),
    targetBindRotations,
    targetNames,
    retargetQuaternionTracks: false,
    rootPosition: 'locked',
  });

  // Some locomotion exports omit fingers, but every clip must retain the body
  // and both complete arm chains. The broken prefix path retained zero tracks.
  assert.ok(prepared.tracks.length >= 20, `${file} retained only ${prepared.tracks.length} tracks`);
  assert.ok(
    prepared.tracks.every((track) => !track.name.startsWith('mixamorig6')),
    `${file} must normalize numbered Mixamo track prefixes that bind to the player`,
  );
  for (const bone of ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand']) {
    assert.ok(
      prepared.tracks.some((track) => track.name === `mixamorig${bone}.quaternion`),
      `${file} must animate mixamorig${bone}`,
    );
  }
}

console.log(`verify-fp-rifle-clips: ${clips.length} clips bind to the player skeleton`);
