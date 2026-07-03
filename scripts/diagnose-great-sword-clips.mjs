// Verifies the great-sword FBX clips load through the real Mara prepareClip
// pipeline and retain tracks on the key bones (arms/hands/spine). Catches the
// silent-failure mode where a clip retargets to a T-pose because its rig differs
// from climber.fbx. Run: `node scripts/diagnose-great-sword-clips.mjs`.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { prepareClip } from '../src/game/characters/mara/MaraAnimationController.js';
import { MARA_ANIMATION_MANIFEST, MARA_MODEL_URL } from '../src/game/characters/mara/maraAnimationManifest.js';

globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadStubbedTexture() {
  return new THREE.Texture();
};

const PUBLIC = path.resolve('public');
const COMBAT_STATES = [
  'drawSword',
  'sheatheSword',
  'armedIdle',
  'armedWalk',
  'armedJog',
  'armedSprint',
  // attack states (present after milestone 2 manifest edit; absent here is fine)
  'lightSlash1',
  'lightSlash2',
  'lightSlash3',
  'heavyAttack',
];
const KEY_BONES = [
  'mixamorigHips',
  'mixamorigSpine',
  'mixamorigRightArm',
  'mixamorigRightForeArm',
  'mixamorigRightHand',
  'mixamorigLeftArm',
  'mixamorigLeftHand',
];

const loader = new FBXLoader();

function loadFbx(filePath) {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return loader.parse(arrayBuffer, '');
}

const model = loadFbx(path.join(PUBLIC, MARA_MODEL_URL));
const rootBindPosition = model.getObjectByName('mixamorigHips')?.position.clone() ?? new THREE.Vector3();
const targetBindRotations = collectBindRotations(model);
const targetNames = collectTargetNames(model);

let problems = 0;

for (const state of COMBAT_STATES) {
  const entry = MARA_ANIMATION_MANIFEST[state];
  if (!entry) {
    console.log(`[${state}] (not in manifest yet — skipping)`);
    continue;
  }

  const url = path.join(PUBLIC, entry.url);
  let source;
  try {
    source = loadFbx(url);
  } catch (error) {
    console.log(`[${state}] LOAD ERROR ${entry.url}: ${error.message}`);
    problems += 1;
    continue;
  }

  const clip = source.animations[0];
  if (!clip) {
    console.log(`[${state}] NO ANIMATION CLIP in ${entry.url}`);
    problems += 1;
    continue;
  }

  const sourceBindRotations = collectBindRotations(source);
  const prepared = prepareClip({
    clip,
    state,
    rootBindPosition,
    sourceBindRotations,
    targetBindRotations,
    targetNames,
    retargetQuaternionTracks: entry.retarget !== false,
    rootPosition: entry.rootPosition ?? 'locked',
    maskedBonePrefixes: entry.maskedBonePrefixes,
    allowedBonePrefixes: entry.allowedBonePrefixes,
    endAt: entry.endAt,
    startAt: entry.startAt,
  });

  const trackBones = new Set(prepared.tracks.map((track) => track.name.split('.')[0]));
  const missing = KEY_BONES.filter((bone) => !trackBones.has(bone));
  const status = missing.length === 0 ? 'OK' : 'MISSING';
  if (missing.length > 0) {
    problems += 1;
  }
  console.log(
    `[${state}] ${status} dur=${prepared.duration.toFixed(2)}s tracks=${prepared.tracks.length}` +
      (missing.length ? ` missing=[${missing.join(', ')}]` : ` keyBones=all-present`),
  );
}

console.log(`\n${problems === 0 ? 'PASS' : `FAIL (${problems} problem(s))`}`);
process.exit(problems === 0 ? 0 : 1);

function collectBindRotations(object) {
  const rotations = new Map();
  object.traverse((child) => {
    if (child.name && child.isBone) {
      rotations.set(child.name, child.quaternion.clone().normalize());
    }
  });
  return rotations;
}

function collectTargetNames(object) {
  const names = new Set();
  object.traverse((child) => {
    if (child.name) {
      names.add(child.name);
    }
  });
  return names;
}
