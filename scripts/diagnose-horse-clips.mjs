// Temporary diagnostic: reproduces the Mara clip build pipeline for the horse
// states and dumps exactly which tracks survive into each prepared clip, plus
// the modelRoot -> mixamorigHips ancestor chain. Answers: does ridingHorse
// leak any non-leg (torso/root/armature) track, and is there an uncorrected
// Object3D between modelRoot and the hips?
import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { prepareClip } from '../src/game/characters/mara/MaraAnimationController.js';

globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadStubbedTexture() {
  return new THREE.Texture();
};

const ROOT = path.resolve('.');
const PUBLIC = path.resolve('public');
const SOURCE_MODEL_PATH = path.join(ROOT, 'assets-source/models/climber.fbx');
const HIP_BONE = 'mixamorigHips';
const TARGET_CHARACTER_HEIGHT = 1.72;

const HORSE_RIDER_STABLE_POSE_PREFIXES = [
  'mixamorigLeftUpLeg',
  'mixamorigLeftLeg',
  'mixamorigLeftFoot',
  'mixamorigLeftToeBase',
  'mixamorigRightUpLeg',
  'mixamorigRightLeg',
  'mixamorigRightFoot',
  'mixamorigRightToeBase',
];
const HORSE_RIDER_ARM_PREFIXES = [
  'mixamorigLeftShoulder',
  'mixamorigLeftArm',
  'mixamorigLeftForeArm',
  'mixamorigLeftHand',
  'mixamorigRightShoulder',
  'mixamorigRightArm',
  'mixamorigRightForeArm',
  'mixamorigRightHand',
];
const HORSE_MANIFEST = {
  getOnHorse: {
    url: '/assets/animation-packs/horse/get-on-horse.fbx',
    rootPosition: 'locked',
    trackOverrideSourceState: 'ridingHorse',
    trackOverrideBonePrefixes: HORSE_RIDER_ARM_PREFIXES,
  },
  ridingHorse: {
    url: '/assets/animation-packs/horse/riding.fbx',
    rootPosition: 'locked',
    allowedBonePrefixes: HORSE_RIDER_STABLE_POSE_PREFIXES,
  },
  getOffHorse: {
    url: '/assets/animation-packs/horse/get-off-horse.fbx',
    rootPosition: 'locked',
    trackOverrideSourceState: 'ridingHorse',
    trackOverrideBonePrefixes: HORSE_RIDER_ARM_PREFIXES,
  },
};

const loader = new FBXLoader();

function loadFbx(filePath) {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return loader.parse(arrayBuffer, '');
}

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
    if (child.name) names.add(child.name);
  });
  return names;
}

function normalizeCharacterObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = TARGET_CHARACTER_HEIGHT / size.y;
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  return scale;
}

function buildClip(state, entry, shared) {
  const source = loadFbx(path.join(PUBLIC, entry.url));
  const clip = source.animations[0];
  if (!clip) throw new Error(`No clip for ${state}`);
  const prepared = prepareClip({
    clip,
    state,
    rootBindPosition: shared.rootBindPosition,
    sourceBindRotations: collectBindRotations(source),
    targetBindRotations: shared.targetBindRotations,
    targetNames: shared.targetNames,
    retargetQuaternionTracks: entry.retarget !== false,
    rootPosition: entry.rootPosition,
    maskedBonePrefixes: entry.maskedBonePrefixes,
    allowedBonePrefixes: entry.allowedBonePrefixes,
    endAt: entry.endAt,
    startAt: entry.startAt,
    rootMotion: entry.rootMotion,
    rootMotionScale: shared.modelScale,
  });
  return { prepared, sourceClip: clip };
}

function trackBone(track) {
  return track.name.split('.')[0];
}

function applyOverrides(clips) {
  for (const [state, entry] of Object.entries(HORSE_MANIFEST)) {
    if (!entry.trackOverrideSourceState || !entry.trackOverrideBonePrefixes?.length) continue;
    const target = clips.get(state)?.prepared;
    const source = clips.get(entry.trackOverrideSourceState)?.prepared;
    if (!target || !source) continue;
    const matches = (track) =>
      entry.trackOverrideBonePrefixes.some((prefix) => trackBone(track).startsWith(prefix));
    target.tracks = [
      ...target.tracks.filter((track) => !matches(track)),
      ...source.tracks.filter((track) => matches(track)).map((track) => track.clone()),
    ];
    target.optimize();
  }
}

function dumpAncestorChain(modelRoot) {
  const hips = modelRoot.getObjectByName(HIP_BONE);
  if (!hips) {
    console.log('  (mixamorigHips not found)');
    return;
  }
  const chain = [];
  let node = hips;
  while (node && node !== modelRoot.parent) {
    chain.unshift(node);
    if (node === modelRoot) break;
    node = node.parent;
  }
  console.log('  modelRoot -> mixamorigHips ancestor chain (name | isBone | rest rotation deg XYZ):');
  for (const node of chain) {
    const r = node.rotation;
    const deg = (v) => THREE.MathUtils.radToDeg(v).toFixed(1).padStart(6);
    console.log(
      `    ${node.name.padEnd(22)} isBone=${String(node.isBone).padEnd(5)} ` +
      `r=(${deg(r.x)} ${deg(r.y)} ${deg(r.z)})`,
    );
  }
}

function summarizeClip(state, clip) {
  const byBone = new Map();
  const byType = new Map();
  for (const track of clip.tracks) {
    byBone.set(trackBone(track), true);
    byType.set(track.ValueTypeName, (byType.get(track.ValueTypeName) ?? 0) + 1);
  }
  const bones = [...byBone.keys()];
  const legBones = new Set(HORSE_RIDER_STABLE_POSE_PREFIXES);
  const suspicious = clip.tracks
    .filter((track) => track.ValueTypeName === 'quaternion')
    .filter((track) => !legBones.has(trackBone(track)))
    .filter((track) => !HORSE_RIDER_ARM_PREFIXES.includes(trackBone(track)))
    .map((track) => track.name);
  console.log(`\n=== ${state} (${clip.tracks.length} tracks) ===`);
  console.log(`  types:`, Object.fromEntries(byType));
  console.log(`  bones (${bones.length}):`, bones.join(', '));
  console.log(`  NON-leg/non-arm QUATERNION tracks:`, suspicious.length ? suspicious : '(none)');
}

async function main() {
  const modelObject = loadFbx(SOURCE_MODEL_PATH);
  const rootBindPosition = modelObject.getObjectByName(HIP_BONE)?.position.clone() ?? new THREE.Vector3();
  const modelScale = normalizeCharacterObject(modelObject);
  const shared = {
    rootBindPosition,
    targetBindRotations: collectBindRotations(modelObject),
    targetNames: collectTargetNames(modelObject),
    modelScale,
  };

  console.log('## modelRoot -> mixamorigHips ancestor chain (climber.fbx)');
  dumpAncestorChain(modelObject);

  console.log('\n## bind (rest) rotations of torso + arm bones (deg XYZ) — what the stabilizer restores to');
  const inspected = [
    'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2',
    'mixamorigNeck', 'mixamorigHead',
    'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm',
    'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm',
  ];
  for (const name of inspected) {
    const q = shared.targetBindRotations.get(name);
    if (!q) { console.log(`  ${name.padEnd(24)} (not found)`); continue; }
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const d = (v) => THREE.MathUtils.radToDeg(v).toFixed(1).padStart(6);
    console.log(`  ${name.padEnd(24)} bind=(${d(e.x)} ${d(e.y)} ${d(e.z)})`);
  }

  const clips = new Map();
  for (const [state, entry] of Object.entries(HORSE_MANIFEST)) {
    const filePath = path.join(PUBLIC, entry.url);
    try {
      const built = buildClip(state, entry, shared);
      clips.set(state, built);
    } catch (error) {
      console.log(`\n!!! could not build ${state} from ${filePath}: ${error.message}`);
    }
  }
  applyOverrides(clips);

  for (const state of Object.keys(HORSE_MANIFEST)) {
    const built = clips.get(state);
    if (built) summarizeClip(state, built.prepared);
  }

  // Raw riding.fbx source tracks, for comparison (before prepareClip filtering).
  const ridingRaw = clips.get('ridingHorse')?.sourceClip;
  if (ridingRaw) {
    const rawBones = new Set();
    for (const track of ridingRaw.tracks) rawBones.add(trackBone(track));
    console.log('\n=== riding.fbx RAW source (before prepareClip) ===');
    console.log(`  bones (${rawBones.size}):`, [...rawBones].join(', '));
  }

  // Leftover-state analysis: what final-frame pose do getOnHorse / getOffHorse
  // leave on the bones that ridingHorse does NOT touch and the stabilizer does
  // NOT cover (arms/shoulders/hands + torso)? These freeze into ridingHorse.
  console.log('\n## Leftover final-frame pose (deg rotation from bind) inherited by ridingHorse');
  const legSet = new Set(HORSE_RIDER_STABLE_POSE_PREFIXES);
  const torsoSet = new Set([
    'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2',
    'mixamorigNeck', 'mixamorigHead',
  ]);
  for (const state of ['getOnHorse', 'getOffHorse']) {
    const clip = clips.get(state)?.prepared;
    if (!clip) continue;
    console.log(`\n  -- ${state} final-frame deviation (only non-leg bones shown) --`);
    const rows = [];
    for (const track of clip.tracks) {
      if (track.ValueTypeName !== 'quaternion') continue;
      const bone = trackBone(track);
      if (legSet.has(bone)) continue;
      const vs = track.values;
      const last = new THREE.Quaternion().fromArray(vs, vs.length - 4).normalize();
      const bind = shared.targetBindRotations.get(bone);
      const delta = bind ? last.clone().multiply(bind.clone().invert()) : last.clone();
      const e = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
      const d = (v) => THREE.MathUtils.radToDeg(v).toFixed(1).padStart(6);
      const angleDeg = THREE.MathUtils.radToDeg(2 * Math.acos(THREE.MathUtils.clamp(Math.abs(delta.w), 0, 1)));
      const covered = torsoSet.has(bone) ? '[stabilizer covers]' : '[UNMANAGED in riding]';
      rows.push({ angleDeg, line: `    ${bone.padEnd(24)} |${d(e.x)} ${d(e.y)} ${d(e.z)}|  ${angleDeg.toFixed(1).padStart(5)}deg  ${covered}` });
    }
    rows.sort((a, b) => b.angleDeg - a.angleDeg);
    for (const r of rows) console.log(r.line);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
