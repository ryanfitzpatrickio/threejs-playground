/**
 * Retarget Easy Animated Enemy Pack Rat.fbx (exported GLB) onto the procedural
 * dog skeleton for Rodentia breeds.
 *
 * Same world-space rotation-delta method as retarget-dog-anims.mjs (horse path),
 * with RAT_TO_DOG_BONE_MAP and Idle@t=0 as the stance reference (no Rest Pose).
 *
 * Run:
 *   node scripts/retarget-rodent-anims.mjs
 *
 * Input:  public/assets/models/rat-rigged.glb
 * Output: public/assets/rodent-anims/{clip}.json + manifest.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { createDogSkeleton } from '../src/game/characters/dog/dogSkeleton.js';
import {
  RAT_TO_DOG_BONE_MAP,
  normalizeRatClipName,
} from '../src/game/characters/dog/ratToDogBoneMap.js';

const SAMPLE_RATE = 30;
const REFERENCE_CLIP_SUFFIX = 'Rat_Idle';
const NON_LOOPING_CLIPS = new Set(['Death', 'Jump', 'Attack']);
const LOOP_BLEND_SECONDS = 0.18;
const GROUNDED_CLIPS = new Set(['Idle', 'Walk', 'Run']);
const FLIGHT_CLIPS = new Set(['Run', 'Jump']);
const GROUND_CLAMP = 0.04;
const FLIGHT_FLOAT_CLAMP = 0.008;
const GROUND_SMOOTH_RADIUS = 2;
const PAW_BONES = ['PawL', 'PawR', 'HindPawL', 'HindPawR'];

globalThis.self = globalThis;
globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadStubbedTexture(_url, onLoad) {
  const texture = new THREE.Texture();
  if (onLoad) queueMicrotask(() => onLoad(texture));
  return texture;
};

const source = resolve('public/assets/models/rat-rigged.glb');
const outputDir = resolve('public/assets/rodent-anims');

const gltf = await loadGlb(source);
const scene = gltf.scene;
const sourceBones = new Map();
scene.traverse((node) => {
  if (node.name) sourceBones.set(node.name, node);
});

const rig = createDogSkeleton();
rig.root.updateMatrixWorld(true);
const targetRestWorld = new Map();
const targetRestLocal = new Map();
for (const bone of rig.bones) {
  targetRestWorld.set(bone.name, bone.getWorldQuaternion(new THREE.Quaternion()));
  targetRestLocal.set(bone.name, bone.quaternion.clone());
}
// Prefer whichever source bone name actually exists on the loaded scene
// (dotted FBX names vs undotted glTF round-trip names).
const dogToRat = new Map();
for (const [ratName, dogName] of Object.entries(RAT_TO_DOG_BONE_MAP)) {
  if (dogName === 'Root') continue;
  if (!sourceBones.has(ratName)) continue;
  // First matching source name wins; undotted forms are listed after dotted.
  if (!dogToRat.has(dogName)) dogToRat.set(dogName, ratName);
}

const mappedDogBones = [...dogToRat.keys()];
const missingLegDogs = ['ShoulderL', 'UpperArmL', 'ForearmL', 'PawL', 'HipL', 'ThighL', 'ShinL', 'HindPawL']
  .filter((n) => !dogToRat.has(n));
if (missingLegDogs.length) {
  console.warn('retarget-rodent-anims: leg bones missing from source map:', missingLegDogs.join(', '));
  console.warn('  source bone names:', [...sourceBones.keys()].filter((n) => /leg|foot|hip|front|back/i.test(n)).join(', '));
} else {
  console.log(`retarget-rodent-anims: mapped ${mappedDogBones.length} dog bones (incl. legs)`);
}

const clipsByName = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
const referenceClip = [...clipsByName.values()].find((clip) => clip.name.includes(REFERENCE_CLIP_SUFFIX));
if (!referenceClip) {
  throw new Error(`source is missing an Idle clip containing "${REFERENCE_CLIP_SUFFIX}"`);
}

const sourceRestWorld = sampleWorldRotations(referenceClip, [0]).get(0);

await mkdir(outputDir, { recursive: true });
const manifest = {
  version: 1,
  source: '/assets/models/rat-rigged.glb',
  pack: 'Easy Animated Enemy Pack — Rat.fbx',
  retarget: 'world-space-rotation-delta',
  reference: 'Rat_Idle clip @ t=0',
  rootTranslationLocked: true,
  groundContactClips: [...GROUNDED_CLIPS],
  clips: [],
};

const identity = new THREE.Quaternion();
const seenOutputNames = new Set();

for (const clip of gltf.animations ?? []) {
  const outName = normalizeRatClipName(clip.name);
  if (!outName || seenOutputNames.has(outName)) continue;
  seenOutputNames.add(outName);

  if (!(clip.duration > 0)) clip.resetDuration();
  const sampleCount = Math.max(2, Math.round(clip.duration * SAMPLE_RATE) + 1);
  const times = [];
  for (let i = 0; i < sampleCount; i += 1) times.push((i * clip.duration) / (sampleCount - 1));
  const frames = sampleWorldRotations(clip, times);

  const trackValues = new Map();
  const pawLiftPerFrame = [];
  for (const frame of frames.values()) {
    const dogWorld = new Map();
    const dogWorldPos = new Map([['Root', new THREE.Vector3()]]);
    let framePawLift = Infinity;
    for (const bone of rig.bones) {
      const parentWorld = (bone.parent && dogWorld.get(bone.parent.name)) || identity;
      const parentPos = (bone.parent && dogWorldPos.get(bone.parent.name)) || dogWorldPos.get('Root');
      const restPos = rig.restPositions.get(bone.name);
      const worldPos = restPos.clone().applyQuaternion(parentWorld).add(parentPos);
      dogWorldPos.set(bone.name, worldPos);
      const ratName = dogToRat.get(bone.name);
      const sourcePose = ratName ? frame.get(ratName) : null;
      const sourceRest = ratName ? sourceRestWorld.get(ratName) : null;
      let world;
      if (sourcePose && sourceRest) {
        const delta = sourcePose.clone().multiply(sourceRest.clone().invert());
        world = delta.multiply(targetRestWorld.get(bone.name).clone());
        const local = parentWorld.clone().invert().multiply(world);
        let values = trackValues.get(bone.name);
        if (!values) {
          values = [];
          trackValues.set(bone.name, values);
        }
        values.push(local.x, local.y, local.z, local.w);
      } else {
        world = parentWorld.clone().multiply(targetRestLocal.get(bone.name));
      }
      dogWorld.set(bone.name, world);
      if (PAW_BONES.includes(bone.name)) {
        framePawLift = Math.min(framePawLift, worldPos.y - rig.worldBindPos.get(bone.name).y);
      }
    }
    pawLiftPerFrame.push(framePawLift);
  }

  const tracks = [];
  for (const [boneName, values] of trackValues) {
    enforceQuaternionContinuity(values);
    if (!NON_LOOPING_CLIPS.has(outName)) blendTrackTailToLoop(values, times, clip.duration);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  }

  if (GROUNDED_CLIPS.has(outName)) {
    tracks.push(buildGroundContactTrack(pawLiftPerFrame, times, {
      flight: FLIGHT_CLIPS.has(outName),
    }));
  }

  const output = new THREE.AnimationClip(outName, -1, tracks);
  output.resetDuration();
  const file = `${slug(outName)}.json`;
  await writeFile(resolve(outputDir, file), `${JSON.stringify(THREE.AnimationClip.toJSON(output))}\n`);
  manifest.clips.push({ name: outName, file, duration: output.duration, tracks: tracks.length });
}

// Studio catalog order preference.
const ORDER = ['Idle', 'Walk', 'Run', 'Jump', 'Attack', 'Death'];
manifest.clips.sort((a, b) => {
  const ia = ORDER.indexOf(a.name);
  const ib = ORDER.indexOf(b.name);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
});

await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`retarget-rodent-anims: wrote ${manifest.clips.length} clips → ${outputDir}`);
console.log('  ', manifest.clips.map((c) => c.name).join(', '));

function sampleWorldRotations(clip, times) {
  if (!(clip.duration > 0)) clip.resetDuration();
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const frames = new Map();
  const animated = new Set(
    clip.tracks
      .filter((track) => track.name.endsWith('.quaternion'))
      .map((track) => track.name.slice(0, -'.quaternion'.length)),
  );
  for (let f = 0; f < times.length; f += 1) {
    mixer.setTime(Math.min(times[f], clip.duration - 1e-4));
    scene.updateMatrixWorld(true);
    const frame = new Map();
    for (const name of animated) {
      const bone = sourceBones.get(name);
      if (bone) frame.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
    }
    // Also capture unmapped-but-named hierarchy bones from scene (bind pose).
    for (const [name, bone] of sourceBones) {
      if (!frame.has(name)) frame.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
    }
    frames.set(f, frame);
  }
  mixer.stopAllAction();
  mixer.uncacheClip(clip);
  return frames;
}

function enforceQuaternionContinuity(values) {
  for (let i = 4; i < values.length; i += 4) {
    const dot = values[i] * values[i - 4]
      + values[i + 1] * values[i - 3]
      + values[i + 2] * values[i - 2]
      + values[i + 3] * values[i - 1];
    if (dot < 0) {
      values[i] *= -1;
      values[i + 1] *= -1;
      values[i + 2] *= -1;
      values[i + 3] *= -1;
    }
  }
}

function blendTrackTailToLoop(values, times, duration) {
  const window = Math.min(LOOP_BLEND_SECONDS, duration * 0.25);
  const start = duration - window;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] <= start) continue;
    const x = Math.min(1, (times[i] - start) / window);
    const alpha = x * x * x * (x * (x * 6 - 15) + 10);
    THREE.Quaternion.slerpFlat(values, i * 4, values, i * 4, values, 0, alpha);
  }
}

function buildGroundContactTrack(pawLiftPerFrame, times, { flight = false } = {}) {
  const count = pawLiftPerFrame.length;
  const pelvisRest = rig.restPositions.get('Pelvis');
  const floatClamp = flight ? FLIGHT_FLOAT_CLAMP : GROUND_CLAMP;
  const values = [];
  for (let f = 0; f < count; f += 1) {
    let sum = 0;
    let samples = 0;
    for (let k = -GROUND_SMOOTH_RADIUS; k <= GROUND_SMOOTH_RADIUS; k += 1) {
      sum += pawLiftPerFrame[(f + k + count) % count];
      samples += 1;
    }
    const smoothed = sum / samples;
    const raise = smoothed < 0
      ? THREE.MathUtils.clamp(-smoothed, 0, GROUND_CLAMP)
      : -THREE.MathUtils.clamp(smoothed, 0, floatClamp);
    values.push(pelvisRest.x, pelvisRest.y + raise, pelvisRest.z);
  }
  const duration = times[times.length - 1];
  const window = Math.min(LOOP_BLEND_SECONDS, duration * 0.25);
  const start = duration - window;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] <= start) continue;
    const x = Math.min(1, (times[i] - start) / window);
    const alpha = x * x * x * (x * (x * 6 - 15) + 10);
    for (let c = 0; c < 3; c += 1) {
      values[i * 3 + c] += (values[c] - values[i * 3 + c]) * alpha;
    }
  }
  return new THREE.VectorKeyframeTrack('Pelvis.position', times, values);
}

async function loadGlb(path) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
  const doc = await io.read(path);
  await doc.transform(dequantize());
  doc.getRoot().listExtensionsUsed()
    .find((ext) => ext.extensionName === 'KHR_draco_mesh_compression')
    ?.dispose();
  for (const texture of doc.getRoot().listTextures()) texture.dispose();
  const glb = await io.writeBinary(doc);
  const arrayBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  return new Promise((resolvePromise, rejectPromise) => {
    new GLTFLoader().parse(arrayBuffer, '', resolvePromise, rejectPromise);
  });
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
