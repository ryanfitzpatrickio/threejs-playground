/**
 * Retarget horse-rigged.glb animations onto the procedural dog skeleton.
 *
 * Method: world-space rotation deltas against a shared reference stance.
 *   worldDelta(t)   = srcWorld(t) * srcWorld(rest)^-1
 *   targetWorld(t)  = worldDelta(t) * targetRestWorld
 *   targetLocal(t)  = targetParentWorld(t)^-1 * targetWorld(t)
 *
 * Why not local deltas: horse bone local axes (Blender-style, arbitrary rolls)
 * have no relation to the dog's pure-local-X leg convention, so local-space
 * deltas bent legs off-axis. And the GLB node rest TRS is NOT the stance the
 * clips were authored against (idle stood permanently crooked), so the source
 * reference is the horse's own "Rest Pose" clip at t=0, which maps to the
 * dog's authored standing rest pose.
 *
 * Source translation is dropped — the kinematic dog controller owns root
 * motion (walk/run locomotion and the jump arc). The only baked position is a
 * Pelvis height channel on ground-contact loops, keeping the lowest paw on
 * the floor (horse/dog leg proportions differ, and Sit carries its height
 * drop entirely in the source Hips translation).
 *
 * Looping clips get their tails blended back onto frame 0 (the source Run
 * cycle ends 40+deg away from its first key and snapped every loop).
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
import { HORSE_TO_DOG_BONE_MAP } from '../src/game/characters/dog/horseToDogBoneMap.js';

const SAMPLE_RATE = 30;
const REFERENCE_CLIP = 'Rest Pose';
// One-shots whose final pose must NOT be blended back to frame 0.
const NON_LOOPING_CLIPS = new Set(['Death', 'Fall']);
const LOOP_BLEND_SECONDS = 0.2;
// Clips played as ground-contact loops. Rotation-only retargeting cannot
// reproduce absolute foot placement across species (and the horse carries
// essential height in its dropped Hips translation — e.g. Sit), so these get
// a baked Pelvis.position track that keeps the lowest paw on the ground.
// Jump/Death/Fall are excluded: leaving the ground is the point there.
const GROUNDED_CLIPS = new Set(['Idle', 'Idle Alert', 'Walk', 'Run', 'Sit', 'Sneak']);
// Locomotion with an aerial / suspension phase. Pulling the body down to plant
// floating paws creates a mid-loop height hitch (Run especially).
const FLIGHT_CLIPS = new Set(['Run']);
const GROUND_CLAMP = 0.04;
// Tiny float pull-down even on flight clips so a single planted paw still
// settles without reintroducing the suspension dump.
const FLIGHT_FLOAT_CLAMP = 0.008;
const GROUND_SMOOTH_RADIUS = 2;
const PAW_BONES = ['PawL', 'PawR', 'HindPawL', 'HindPawR'];

// GLTFLoader image stubs — textures are stripped before parse (Node has no DOM).
globalThis.self = globalThis;
globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadStubbedTexture(_url, onLoad) {
  const texture = new THREE.Texture();
  if (onLoad) queueMicrotask(() => onLoad(texture));
  return texture;
};

const source = resolve('public/assets/models/horse-rigged.glb');
const outputDir = resolve('public/assets/dog-anims');

const gltf = await loadGlb(source);
const scene = gltf.scene;
const sourceBones = new Map();
scene.traverse((node) => {
  if (node.name) sourceBones.set(node.name, node);
});

// Target: default dog skeleton rest (shared across breeds — positions vary per
// breed, but the standing rotations are the contract clips are baked against).
const rig = createDogSkeleton();
rig.root.updateMatrixWorld(true);
const targetRestWorld = new Map();
const targetRestLocal = new Map();
for (const bone of rig.bones) {
  targetRestWorld.set(bone.name, bone.getWorldQuaternion(new THREE.Quaternion()));
  targetRestLocal.set(bone.name, bone.quaternion.clone());
}
const dogToHorse = new Map();
for (const [horseName, dogName] of Object.entries(HORSE_TO_DOG_BONE_MAP)) {
  // The kinematic controller owns the dog Root translation and yaw.
  if (dogName !== 'Root') dogToHorse.set(dogName, horseName);
}

const clipsByName = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
const referenceClip = clipsByName.get(REFERENCE_CLIP);
if (!referenceClip) throw new Error(`source is missing the "${REFERENCE_CLIP}" reference clip`);

const sourceRestWorld = sampleWorldRotations(referenceClip, [0]).get(0);

await mkdir(outputDir, { recursive: true });
const manifest = {
  version: 2,
  source: '/assets/models/horse-rigged.glb',
  retarget: 'world-space-rotation-delta',
  reference: `${REFERENCE_CLIP} clip @ t=0`,
  rootTranslationLocked: true,
  groundContactClips: [...GROUNDED_CLIPS],
  clips: [],
};

const identity = new THREE.Quaternion();
for (const clip of gltf.animations ?? []) {
  // GLTFLoader leaves duration at -1; derive it from the track times.
  if (!(clip.duration > 0)) clip.resetDuration();
  const sampleCount = Math.max(2, Math.round(clip.duration * SAMPLE_RATE) + 1);
  const times = [];
  for (let i = 0; i < sampleCount; i += 1) times.push((i * clip.duration) / (sampleCount - 1));
  const frames = sampleWorldRotations(clip, times);

  // Per-track flat key values, dog hierarchy order (parents before children).
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
      const horseName = dogToHorse.get(bone.name);
      const sourcePose = horseName ? frame.get(horseName) : null;
      const sourceRest = horseName ? sourceRestWorld.get(horseName) : null;
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
        // Unmapped dog bones hold rest so mapped descendants get correct parents.
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
    if (!NON_LOOPING_CLIPS.has(clip.name)) blendTrackTailToLoop(values, times, clip.duration);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  }

  if (GROUNDED_CLIPS.has(clip.name)) {
    tracks.push(buildGroundContactTrack(pawLiftPerFrame, times, {
      flight: FLIGHT_CLIPS.has(clip.name),
    }));
  }

  const output = new THREE.AnimationClip(clip.name, -1, tracks);
  output.resetDuration();
  const file = `${slug(clip.name)}.json`;
  await writeFile(resolve(outputDir, file), `${JSON.stringify(THREE.AnimationClip.toJSON(output))}\n`);
  manifest.clips.push({ name: clip.name, file, duration: output.duration, tracks: tracks.length });
}

await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`retarget-dog-anims: wrote ${manifest.clips.length} clips to ${outputDir}`);

/** Sample a clip on a fresh mixer, returning Map<frameIndex, Map<boneName, worldQuat>>. */
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
    frames.set(f, frame);
  }
  mixer.stopAllAction();
  mixer.uncacheClip(clip);
  return frames;
}

/** Flip key signs so consecutive keys take the short interpolation path. */
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

/** Blend the tail of a looping clip back onto frame 0 so cycles close without a snap. */
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

/**
 * Bake a Pelvis.position track that keeps the lowest paw near rest height.
 *
 * lift = lowestPawY - restY after rotation-only retarget.
 *   lift < 0 → paws dig  → raise pelvis
 *   lift > 0 → paws float → lower pelvis (stance clips only)
 *
 * Flight clips (Run) almost skip the float pull-down. The old bidirectional
 * clamp held the body high while paws penetrated, then dumped ~8cm when the
 * suspension phase floated every foot — the visible mid-loop hitch.
 *
 * The per-frame signal is circularly smoothed (grounded clips all loop, and
 * paw-swap steps in the min signal would otherwise click). The tail is blended
 * back to frame 0 to match the rotation tracks' loop closure.
 * Pelvis's parent is the unrotated Root bone, so local Y is world Y.
 *
 * @param {number[]} pawLiftPerFrame
 * @param {number[]} times
 * @param {{ flight?: boolean }} [opts]
 */
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
    // Asymmetric: always fix digs; float pull-down is clipped (near-zero on Run).
    const raise = smoothed < 0
      ? THREE.MathUtils.clamp(-smoothed, 0, GROUND_CLAMP)
      : -THREE.MathUtils.clamp(smoothed, 0, floatClamp);
    values.push(pelvisRest.x, pelvisRest.y + raise, pelvisRest.z);
  }
  // Loop closure on the height channel (lerp tail onto frame 0).
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
  // The GLB is Draco-compressed; decode to plain accessors via gltf-transform
  // (same pattern as scripts/_verify-size.mjs) so GLTFLoader can parse in Node.
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
  const doc = await io.read(path);
  await doc.transform(dequantize());
  doc.getRoot().listExtensionsUsed()
    .find((ext) => ext.extensionName === 'KHR_draco_mesh_compression')
    ?.dispose();
  // Textures are irrelevant to retargeting; drop them so GLTFLoader never
  // touches image decoding in Node.
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
