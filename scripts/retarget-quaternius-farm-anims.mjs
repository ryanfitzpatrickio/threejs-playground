/**
 * Retarget Quaternius "Farm Animals Animated" FBX clips onto the procedural
 * dog skeleton (world-space rotation-delta method, same as horse/rat packs).
 *
 * Full locomotion sources (Idle, Walk, WalkSlow, Run, Jump, Death):
 *   Horse.fbx → public/assets/equid-anims/
 *   Cow.fbx   → public/assets/bovid-anims/
 *   Zebra.fbx → public/assets/equid-anims/ (optional alt; Horse is default)
 *
 * Partial sources (Idle, Jump only) can be retargeted with --animal=Pig etc.
 * but do not replace full packs for walk/run.
 *
 * Run:
 *   node scripts/retarget-quaternius-farm-anims.mjs
 *   node scripts/retarget-quaternius-farm-anims.mjs --animal=Horse
 *   node scripts/retarget-quaternius-farm-anims.mjs --animal=Cow
 *   node scripts/retarget-quaternius-farm-anims.mjs --animal=Zebra --out=equid-anims
 *
 * Input:  assets-source/models/quaternius-farm/{Animal}.fbx
 * Output: public/assets/{equid,bovid}-anims/{clip}.json + manifest.json
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { createDogSkeleton } from '../src/game/characters/dog/dogSkeleton.js';
import { resolveDogPhenotype } from '../src/game/characters/dog/dogPhenotypes.js';
import {
  QUATERNIUS_TO_DOG_BONE_MAP,
  normalizeQuaterniusClipName,
} from '../src/game/characters/dog/quaterniusToDogBoneMap.js';

const SAMPLE_RATE = 30;
const NON_LOOPING_CLIPS = new Set(['Death', 'Jump']);
const LOOP_BLEND_SECONDS = 0.18;
const GROUNDED_CLIPS = new Set(['Idle', 'Walk', 'Walk Slow', 'Run']);
const FLIGHT_CLIPS = new Set(['Run', 'Jump']);
const GROUND_CLAMP = 0.04;
const FLIGHT_FLOAT_CLAMP = 0.008;
const GROUND_SMOOTH_RADIUS = 2;
const PAW_BONES = ['PawL', 'PawR', 'HindPawL', 'HindPawR'];
/** Bones used to measure source motion energy when trimming dead-pad tails. */
const MOTION_PROBE_BONES = [
  'Body',
  'FrontLegL',
  'FrontLegR',
  'FrontLowLegL',
  'FrontLowLegR',
  'BackLegL',
  'BackLegR',
  'BackLowLegL',
  'BackLowLegR',
];
/** Quaternius Walk clips pad ~50% freeze after the real cycle; trim that out. */
const DEAD_PAD_ENERGY_FRAC = 0.08;
const DEAD_PAD_MIN_TAIL_FRAC = 0.12;
const DEAD_PAD_PROBE_STEPS = 64;

const DEFAULT_PACKS = [
  { animal: 'Horse', outDir: 'equid-anims', packLabel: 'Quaternius Farm — Horse.fbx' },
  { animal: 'Cow', outDir: 'bovid-anims', packLabel: 'Quaternius Farm — Cow.fbx' },
];

globalThis.self = globalThis;
globalThis.window = { URL: { createObjectURL: () => '', revokeObjectURL: () => {} } };
if (!globalThis.document) {
  globalThis.document = { createElementNS: () => ({ style: {} }) };
}
THREE.TextureLoader.prototype.load = function loadStubbedTexture(_url, onLoad) {
  const texture = new THREE.Texture();
  if (onLoad) queueMicrotask(() => onLoad(texture));
  return texture;
};

const args = process.argv.slice(2);
const animalArg = args.find((a) => a.startsWith('--animal='))?.slice('--animal='.length);
const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);

const packs = animalArg
  ? [{
    animal: animalArg,
    outDir: outArg
      ?? (animalArg === 'Cow' || animalArg === 'Sheep' || animalArg === 'Llama' || animalArg === 'Pig'
        ? 'bovid-anims'
        : 'equid-anims'),
    packLabel: `Quaternius Farm — ${animalArg}.fbx`,
  }]
  : DEFAULT_PACKS;

// Bake against the breed the pack actually plays on: the equid pack targets
// the horse rig (cursorial hind, raised neck), which no longer matches the
// default dog rest pose. Baking against the wrong rig leaves clips that
// swing whole legs but lose the authored knee/hock bends at runtime.
const packPhenotypeId = args.find((a) => a.startsWith('--phenotype='))?.slice('--phenotype='.length)
  ?? (packs.every((p) => p.outDir === 'equid-anims') ? 'domestic-horse'
    : packs.every((p) => p.outDir === 'bovid-anims') ? null
      : null);
const packPhenotype = packPhenotypeId
  ? resolveDogPhenotype({ breedId: packPhenotypeId, seed: 1 })
  : null;
const rig = createDogSkeleton(packPhenotype ? { phenotype: packPhenotype } : {});
if (packPhenotypeId) console.log(`baking against phenotype: ${packPhenotypeId}`);
rig.root.updateMatrixWorld(true);
const targetRestWorld = new Map();
const targetRestLocal = new Map();
for (const bone of rig.bones) {
  targetRestWorld.set(bone.name, bone.getWorldQuaternion(new THREE.Quaternion()));
  targetRestLocal.set(bone.name, bone.quaternion.clone());
}

const dogToSource = new Map();
for (const [srcName, dogName] of Object.entries(QUATERNIUS_TO_DOG_BONE_MAP)) {
  if (dogName !== 'Root' && !dogToSource.has(dogName)) dogToSource.set(dogName, srcName);
}

const identity = new THREE.Quaternion();
const loader = new FBXLoader();

for (const pack of packs) {
  const sourcePath = resolve(`assets-source/models/quaternius-farm/${pack.animal}.fbx`);
  const outputDir = resolve(`public/assets/${pack.outDir}`);
  console.log(`\nretarget-quaternius-farm: ${pack.animal} → ${pack.outDir}`);

  const buf = await readFile(sourcePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const scene = loader.parse(ab, resolve('assets-source/models/quaternius-farm/'));
  const sourceBones = new Map();
  scene.traverse((node) => {
    if (node.name) sourceBones.set(node.name, node);
  });

  const mapped = [...dogToSource.entries()].filter(([, src]) => sourceBones.has(src));
  const missingLegs = ['ShoulderL', 'UpperArmL', 'ForearmL', 'PawL', 'HipL', 'ThighL', 'ShinL', 'HindPawL']
    .filter((n) => !mapped.some(([d]) => d === n));
  if (missingLegs.length) {
    console.warn('  missing leg maps:', missingLegs.join(', '));
  } else {
    console.log(`  mapped ${mapped.length} dog bones`);
  }

  const clips = scene.animations ?? [];
  if (!clips.length) throw new Error(`${pack.animal}: no animations`);

  // Idle @ t=0 is the stance reference (no Rest Pose clip in Quaternius pack).
  const idleClip = clips.find((c) => /Idle/i.test(c.name));
  if (!idleClip) throw new Error(`${pack.animal}: missing Idle clip`);
  if (!(idleClip.duration > 0)) idleClip.resetDuration();
  const sourceRestWorld = sampleWorldRotations(scene, sourceBones, idleClip, [0]).get(0);

  await mkdir(outputDir, { recursive: true });
  const manifest = {
    version: 1,
    source: `/assets/models/quaternius-farm/${pack.animal}.fbx`,
    pack: pack.packLabel,
    retarget: 'world-space-rotation-delta',
    reference: 'Idle clip @ t=0',
    rootTranslationLocked: true,
    groundContactClips: [...GROUNDED_CLIPS],
    clips: [],
  };

  const seen = new Set();
  for (const clip of clips) {
    const outName = normalizeQuaterniusClipName(clip.name);
    if (!outName || seen.has(outName)) continue;
    seen.add(outName);
    if (!(clip.duration > 0)) clip.resetDuration();

    // Quaternius Walk (Horse/Cow/Zebra) is authored as one real stride then a
    // frozen pad for the rest of the FBX duration — looping the full clip
    // hitches hard at mid-cycle. Trim looping clips to the last active frame.
    let duration = clip.duration;
    if (!NON_LOOPING_CLIPS.has(outName)) {
      const active = detectActiveLoopDuration(scene, sourceBones, clip);
      if (active < clip.duration * (1 - DEAD_PAD_MIN_TAIL_FRAC)) {
        console.log(
          `  ${outName}: trim dead pad ${clip.duration.toFixed(3)}s → ${active.toFixed(3)}s`,
        );
        duration = active;
      }
    }

    const sampleCount = Math.max(2, Math.round(duration * SAMPLE_RATE) + 1);
    const times = [];
    for (let i = 0; i < sampleCount; i += 1) times.push((i * duration) / (sampleCount - 1));
    const frames = sampleWorldRotations(scene, sourceBones, clip, times);

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
        const srcName = dogToSource.get(bone.name);
        const sourcePose = srcName ? frame.get(srcName) : null;
        const sourceRest = srcName ? sourceRestWorld.get(srcName) : null;
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
      if (!NON_LOOPING_CLIPS.has(outName)) blendTrackTailToLoop(values, times, duration);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
    }

    if (GROUNDED_CLIPS.has(outName)) {
      tracks.push(buildGroundContactTrack(pawLiftPerFrame, times, {
        flight: FLIGHT_CLIPS.has(outName),
      }));
    }

    const output = new THREE.AnimationClip(outName, duration, tracks);
    const file = `${slug(outName)}.json`;
    await writeFile(resolve(outputDir, file), `${JSON.stringify(THREE.AnimationClip.toJSON(output))}\n`);
    manifest.clips.push({ name: outName, file, duration: output.duration, tracks: tracks.length });
  }

  const ORDER = ['Idle', 'Walk', 'Walk Slow', 'Run', 'Jump', 'Death'];
  manifest.clips.sort((a, b) => {
    const ia = ORDER.indexOf(a.name);
    const ib = ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  wrote ${manifest.clips.length} clips: ${manifest.clips.map((c) => c.name).join(', ')}`);
}

console.log('\nretarget-quaternius-farm: done');

/**
 * Find the end of real motion in a Quaternius loop.
 * Walk clips hold a near-static pose for ~half their duration; using that full
 * length produces a mid-loop hitch when AnimationMixer loops.
 *
 * @returns {number} active duration in seconds (≤ clip.duration)
 */
function detectActiveLoopDuration(scene, sourceBones, clip) {
  if (!(clip.duration > 0)) clip.resetDuration();
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const prevQ = new Map();
  const prevP = new Map();
  const energy = [];
  const steps = DEAD_PAD_PROBE_STEPS;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * clip.duration;
    mixer.setTime(Math.min(t, clip.duration - 1e-4));
    scene.updateMatrixWorld(true);
    let e = 0;
    for (const name of MOTION_PROBE_BONES) {
      const bone = sourceBones.get(name);
      if (!bone) continue;
      const q = bone.getWorldQuaternion(new THREE.Quaternion());
      const p = bone.getWorldPosition(new THREE.Vector3());
      if (prevQ.has(name)) {
        const pq = prevQ.get(name);
        const qq = q.clone();
        if (pq.dot(qq) < 0) qq.set(-qq.x, -qq.y, -qq.z, -qq.w);
        e += pq.angleTo(qq);
        e += p.distanceTo(prevP.get(name)) * 0.01;
      }
      prevQ.set(name, q);
      prevP.set(name, p);
    }
    energy.push({ t, e });
  }
  mixer.stopAllAction();
  mixer.uncacheClip(clip);

  const maxE = Math.max(...energy.map((row) => row.e), 0);
  if (!(maxE > 1e-6)) return clip.duration;
  const thresh = maxE * DEAD_PAD_ENERGY_FRAC;

  // Require a sustained dead tail (not a single quiet frame mid-stride).
  const minDeadSteps = Math.max(4, Math.floor(steps * DEAD_PAD_MIN_TAIL_FRAC));
  let lastActive = clip.duration;
  let deadRun = 0;
  let deadStart = null;
  for (let i = 1; i < energy.length; i += 1) {
    if (energy[i].e > thresh) {
      lastActive = energy[i].t;
      deadRun = 0;
      deadStart = null;
    } else {
      if (deadStart == null) deadStart = energy[i - 1].t;
      deadRun += 1;
    }
  }
  if (deadRun >= minDeadSteps && deadStart != null && deadStart > clip.duration * 0.25) {
    // Snap slightly past the last active sample so the final pose is included.
    const step = clip.duration / steps;
    return Math.min(clip.duration, Math.max(step * 2, lastActive + step * 0.5));
  }
  return clip.duration;
}

function sampleWorldRotations(scene, sourceBones, clip, times) {
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
      values[i * 3 + c] = values[i * 3 + c] * (1 - alpha) + values[c] * alpha;
    }
  }
  return new THREE.VectorKeyframeTrack('Pelvis.position', times, values);
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
