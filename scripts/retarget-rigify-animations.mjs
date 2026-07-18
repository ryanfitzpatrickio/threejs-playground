// Retarget Mixamo locomotion FBX clips onto the vibe-human Rigify DEF
// skeleton (public/assets/simhuman/human5.glb).
//
// Differences from retarget-animations.mjs (Mixamo->Mixamo):
//  - target is a GLB (GLTFLoader) whose flat DEF skeleton is first
//    reparented anatomically via the shared rigifySkeleton.js module (the
//    runtime factory applies the identical reparent, so bone-local tracks
//    line up);
//  - bone names differ, so retargetClip gets a names map (RIGIFY_FROM_MIXAMO);
//  - bind orientations differ (Blender bone rolls vs Mixamo), so the default
//    hierarchy-safe path transfers each source bone's animated world delta
//    onto the target bind-world rotation, then solves the target local
//    quaternion parent-first. This is required for human5 too: the legacy
//    SkeletonUtils world retarget pitched its shoulders backward in locomotion.
//  - hip position track is rescaled by the hip-height ratio and locked to
//    the target bind XZ (locomotion is driven by SimSystem, root stays put).
//
// Run: npm run retarget:rigify   (writes public/assets/animations-rigify/)

import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import {
  RIGIFY_FROM_MIXAMO,
  RIGIFY_HIP_BONE,
  reparentRigifySkeleton,
} from '../src/game/characters/simhuman/rigifySkeleton.js';

globalThis.window = globalThis.window || { URL: { createObjectURL: () => '' } };
globalThis.self = globalThis;
THREE.TextureLoader.prototype.load = function loadStubbedTexture() {
  return new THREE.Texture();
};

// CLI:
//   node scripts/retarget-rigify-animations.mjs
//   node scripts/retarget-rigify-animations.mjs --target public/assets/simhuman/ubc-male.glb --out public/assets/animations-rigify-ubc-male --mode local
//
// --target  path to DEF-named GLB (default human5)
// --out     output directory under repo (default public/assets/animations-rigify)
// --mode    local = hierarchy-safe world bind-delta map (default for all bodies)
//           world = legacy SkeletonUtils retarget (diagnostics only)
function parseArgs(argv) {
  const args = {
    target: path.resolve('public/assets/simhuman/human5.glb'),
    out: path.resolve('public/assets/animations-rigify'),
    mode: 'local',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') args.target = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/retarget-rigify-animations.mjs [--target model.glb] [--out dir] [--mode local|world]');
      process.exit(0);
    }
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const TARGET_MODEL_PATH = cli.target;
const SOURCE_ANIMATION_DIR = path.resolve('public/assets/animation-packs/locomotion-pack-2');
const OUTPUT_DIR = cli.out;
// Web URL under Vite public/: public/assets/foo → /assets/foo
const PUBLIC_OUTPUT_DIR = (() => {
  const rel = path.relative(path.resolve('.'), OUTPUT_DIR).split(path.sep).join('/');
  if (rel.startsWith('public/')) return `/${rel.slice('public/'.length)}`;
  return `/${rel}`;
})();
const MIXAMO_HIP = 'mixamorigHips';
const FPS = 30;
const PINNED_PINKY_JOINTS = Object.freeze([
  ['DEF-f_ring01L', 'DEF-f_pinky01L'],
  ['DEF-f_ring02L', 'DEF-f_pinky02L'],
  ['DEF-f_ring03L', 'DEF-f_pinky03L'],
  ['DEF-f_ring01R', 'DEF-f_pinky01R'],
  ['DEF-f_ring02R', 'DEF-f_pinky02R'],
  ['DEF-f_ring03R', 'DEF-f_pinky03R'],
]);

// Curated locomotion subset — sims only need these for now.
const CLIP_FILES = [
  'idle.fbx',
  'walking.fbx',
  'running.fbx',
  'left turn.fbx',
  'right turn.fbx',
];

const RETARGET_MODE = cli.mode;
console.log(`Retarget target: ${TARGET_MODEL_PATH}`);
console.log(`Retarget output: ${OUTPUT_DIR} (public ${PUBLIC_OUTPUT_DIR})`);
console.log(`Retarget mode:   ${RETARGET_MODE}`);

const gltf = await loadGlb(TARGET_MODEL_PATH);
const targetRoot = gltf.scene;
targetRoot.updateMatrixWorld(true);
const report = reparentRigifySkeleton(targetRoot);
// human5 has the full Rigify DEF set; UBC/UE renames only ship the locomotion
// core. Missing parent overrides (pelvis, breasts, spine.004, …) are expected.
if (report.missing.length > 0) {
  console.warn(`Rigify reparent skipped ${report.missing.length} missing pairs (ok for non-human5):`);
  for (const m of report.missing.slice(0, 12)) console.warn(`  - ${m}`);
}
console.log(`Rigify reparent: ${report.reparented} bones reparented`);

const targetMesh = findSkinnedMesh(targetRoot);
if (!targetMesh) throw new Error(`No SkinnedMesh in ${TARGET_MODEL_PATH}`);
targetMesh.skeleton.pose();
targetRoot.updateMatrixWorld(true);

const targetBones = new Map();
for (const bone of targetMesh.skeleton.bones) targetBones.set(bone.name, bone);
const targetBindLocalQuaternions = new Map(
  [...targetBones].map(([name, bone]) => [name, bone.quaternion.clone().normalize()]),
);
const targetHip = targetBones.get(RIGIFY_HIP_BONE);
if (!targetHip) throw new Error(`Target hip bone ${RIGIFY_HIP_BONE} not found`);
const targetHipBindLocal = targetHip.position.clone();
const targetHipBindWorldY = targetHip.getWorldPosition(new THREE.Vector3()).y;

await mkdir(OUTPUT_DIR, { recursive: true });

const fbxLoader = new FBXLoader();
const available = new Set(await readdir(SOURCE_ANIMATION_DIR));
const publicModelPath = `/${path.relative(path.resolve('.'), TARGET_MODEL_PATH).split(path.sep).join('/')}`;
const manifest = {
  generatedAt: new Date().toISOString(),
  model: publicModelPath.startsWith('/public/')
    ? publicModelPath.replace(/^\/public/, '')
    : publicModelPath.replace(/^\//, '/'),
  outputDir: PUBLIC_OUTPUT_DIR.startsWith('/public/')
    ? PUBLIC_OUTPUT_DIR.replace(/^\/public/, '')
    : PUBLIC_OUTPUT_DIR,
  fps: FPS,
  retargetSpace: RETARGET_MODE === 'local' ? 'world-bind-delta' : 'skeleton-utils-world',
  animations: [],
};
// Normalize public URLs: repo-relative public/assets/... → /assets/...
if (manifest.model.includes('public/assets/')) {
  manifest.model = `/${manifest.model.split('public/').pop()}`;
}
if (manifest.outputDir.includes('public/assets/')) {
  manifest.outputDir = `/${manifest.outputDir.split('public/').pop()}`;
}
// Fix clip URLs below to use manifest.outputDir

for (const fileName of CLIP_FILES) {
  if (!available.has(fileName)) {
    console.warn(`Skipping ${fileName}: not in ${SOURCE_ANIMATION_DIR}`);
    continue;
  }
  const sourceObject = loadFbx(path.join(SOURCE_ANIMATION_DIR, fileName));
  const sourceClip = sourceObject.animations[0];
  if (!sourceClip) {
    console.warn(`Skipping ${fileName}: no animation clip.`);
    continue;
  }

  sourceObject.updateMatrixWorld(true);
  // Reset source to bind before sampling bind locals (clip may have dirtied pose).
  sourceObject.traverse((child) => {
    if (child.isBone) {
      // FBX rest is already in bone.position/quaternion before mixer runs
    }
  });
  const sourceBones = new Map();
  sourceObject.traverse((child) => {
    if (child.isBone) sourceBones.set(child.name, child);
  });
  const sourceHip = sourceBones.get(MIXAMO_HIP);
  if (!sourceHip) {
    console.warn(`Skipping ${fileName}: no ${MIXAMO_HIP}.`);
    continue;
  }
  const sourceHipWorldY = sourceHip.getWorldPosition(new THREE.Vector3()).y;
  const hipScale = sourceHipWorldY > 1e-4 ? targetHipBindWorldY / sourceHipWorldY : 1;

  let retargeted;
  if (RETARGET_MODE === 'local') {
    // Hierarchy-order world bind-delta transfer with target bind positions kept
    // intact (absolute world rotation copy collapses UE shoulders/clavicles).
    retargeted = retargetClipWorldBindSafe({
      targetMesh,
      targetRoot,
      sourceObject,
      sourceClip,
      nameMap: RIGIFY_FROM_MIXAMO,
      hipSource: MIXAMO_HIP,
      hipTarget: targetHip.name,
      hipScale,
      targetHipBindLocal,
      fps: FPS,
    });
  } else {
    // Legacy SkeletonUtils world retarget retained only for comparison probes.
    const localOffsets = {};
    const srcQ = new THREE.Quaternion();
    const tgtQ = new THREE.Quaternion();
    for (const [targetName, sourceName] of Object.entries(RIGIFY_FROM_MIXAMO)) {
      const tgtBone = targetBones.get(targetName);
      const srcBone = sourceBones.get(sourceName);
      if (!tgtBone || !srcBone) continue;
      srcBone.getWorldQuaternion(srcQ);
      tgtBone.getWorldQuaternion(tgtQ);
      const delta = srcQ.clone().invert().multiply(tgtQ);
      localOffsets[targetName] = new THREE.Matrix4().makeRotationFromQuaternion(delta);
    }

    const sourceSkeleton = new THREE.Skeleton([...sourceBones.values()]);
    retargeted = retargetClip(targetMesh, sourceSkeleton, sourceClip, {
      fps: FPS,
      names: { ...RIGIFY_FROM_MIXAMO },
      getBoneName: (bone) => RIGIFY_FROM_MIXAMO[bone.name] ?? bone.name,
      hip: MIXAMO_HIP,
      scale: hipScale,
      localOffsets,
      preserveBoneMatrix: true,
      preserveBonePositions: true,
      useFirstFramePosition: true,
    });

    retargeted.tracks = retargeted.tracks
      .map((track) => renameSkeletonTrack(track))
      .filter((track) => {
        const boneName = track.name.replace(/\.(position|quaternion|scale)$/, '');
        return targetBones.has(boneName);
      })
      .map((track) => normalizeHipTrack(track));
  }

  const pinnedPinkyTracks = pinPinkyToRingFinger(
    retargeted,
    targetBones,
    targetBindLocalQuaternions,
  );
  retargeted.name = fileName.replace(/\.fbx$/i, '');
  retargeted.optimize();

  const slug = slugify(retargeted.name);
  const outputFileName = `${slug}.json`;
  await writeFile(path.join(OUTPUT_DIR, outputFileName), JSON.stringify(retargeted.toJSON()));
  manifest.animations.push({
    name: retargeted.name,
    sourceUrl: `/assets/animation-packs/locomotion-pack-2/${encodeURIComponent(fileName)}`,
    clipUrl: `${manifest.outputDir}/${outputFileName}`,
    duration: Number(retargeted.duration.toFixed(4)),
    tracks: retargeted.tracks.length,
  });
  console.log(
    `Retargeted ${fileName} -> ${outputFileName} (${retargeted.tracks.length} tracks`
    + (pinnedPinkyTracks ? `, ${pinnedPinkyTracks} pinky tracks pinned to ring` : '')
    + ')',
  );
}

await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Retargeted ${manifest.animations.length} clips into ${OUTPUT_DIR}`);

function loadFbx(filePath) {
  const buffer = readFileSync(filePath);
  return fbxLoader.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    '',
  );
}

async function loadGlb(filePath) {
  // human5.glb uses KHR_draco_mesh_compression. Three's DRACOLoader relies on
  // browser Workers, so decode through the repository's existing glTF-Transform
  // toolchain and hand an in-memory, uncompressed GLB to GLTFLoader. Disposing
  // the extension only changes the temporary document; the source asset is not
  // rewritten.
  //
  // Also strip textures/images: UBC GLBs embed multi‑MB maps and Three's
  // GLTFLoader never settles under Node without a full Image/DOM polyfill.
  // Retarget only needs the skeleton + bind pose.
  const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.SILENT))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
  const document = await io.read(filePath);
  const root = document.getRoot();
  for (const extension of root.listExtensionsUsed()) {
    extension.dispose();
  }
  for (const texture of [...root.listTextures()]) texture.dispose();
  for (const material of root.listMaterials()) {
    material.setBaseColorTexture(null);
    material.setMetallicRoughnessTexture(null);
    material.setNormalTexture(null);
    material.setOcclusionTexture(null);
    material.setEmissiveTexture(null);
  }
  const buffer = await io.writeBinary(document);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new GLTFLoader().parseAsync(arrayBuffer, '');
}

function findSkinnedMesh(object) {
  let found = null;
  object.traverse((child) => {
    if (!found && child.isSkinnedMesh) found = child;
  });
  return found;
}

/**
 * Some Mixamo locomotion FBXs omit the pinky chain entirely. Fill missing (or
 * effectively static) pinky tracks from the matching ring-finger motion delta.
 * Applying the delta to the pinky's own bind quaternion avoids snapping the two
 * fingers onto the same local orientation when their authored bone rolls differ.
 */
function pinPinkyToRingFinger(clip, targetBoneMap, bindLocalQuaternions) {
  const trackByName = new Map(clip.tracks.map((track) => [track.name, track]));
  let pinned = 0;

  for (const [ringBone, pinkyBone] of PINNED_PINKY_JOINTS) {
    if (!targetBoneMap.has(pinkyBone)) continue;
    const ringTrack = trackByName.get(`${ringBone}.quaternion`);
    if (!ringTrack) continue;

    const pinkyTrackName = `${pinkyBone}.quaternion`;
    const existing = trackByName.get(pinkyTrackName);
    if (existing && quaternionTrackMotion(existing) > 1e-5) continue;

    const ringBind = bindLocalQuaternions.get(ringBone);
    const pinkyBind = bindLocalQuaternions.get(pinkyBone);
    if (!ringBind || !pinkyBind) continue;

    const ringBindInverse = ringBind.clone().invert();
    const values = new Float32Array(ringTrack.values.length);
    const ringAnimated = new THREE.Quaternion();
    const ringDelta = new THREE.Quaternion();
    const pinkyAnimated = new THREE.Quaternion();
    for (let i = 0; i < ringTrack.values.length; i += 4) {
      ringAnimated.fromArray(ringTrack.values, i).normalize();
      ringDelta.copy(ringAnimated).multiply(ringBindInverse).normalize();
      pinkyAnimated.copy(ringDelta).multiply(pinkyBind).normalize().toArray(values, i);
    }

    const replacement = new THREE.QuaternionKeyframeTrack(
      pinkyTrackName,
      ringTrack.times.slice(),
      values,
      ringTrack.getInterpolation(),
    );
    if (existing) clip.tracks = clip.tracks.filter((track) => track !== existing);
    clip.tracks.push(replacement);
    trackByName.set(pinkyTrackName, replacement);
    pinned += 1;
  }

  return pinned;
}

function quaternionTrackMotion(track) {
  if (track.values.length <= 4) return 0;
  const first = new THREE.Quaternion().fromArray(track.values, 0).normalize();
  const sample = new THREE.Quaternion();
  let maxAngle = 0;
  for (let i = 4; i < track.values.length; i += 4) {
    sample.fromArray(track.values, i).normalize();
    maxAngle = Math.max(maxAngle, first.angleTo(sample));
  }
  return maxAngle;
}

// Lock hip XZ to bind (in-place locomotion). retargetClip's
// useFirstFramePosition makes Y relative to zero, so restore the target bind Y
// while retaining authored vertical bobbing.
function normalizeHipTrack(track) {
  if (track.name !== `${RIGIFY_HIP_BONE}.position`) return track;
  const values = track.values;
  for (let i = 0; i < values.length; i += 3) {
    values[i] = targetHipBindLocal.x;
    values[i + 1] += targetHipBindLocal.y;
    values[i + 2] = targetHipBindLocal.z;
  }
  return track;
}

function renameSkeletonTrack(track) {
  const cloned = track.clone();
  cloned.name = cloned.name.replace(/^\.bones\[([^\]]+)\]\./, '$1.');
  return cloned;
}

function parseTrackBoneAndProperty(trackName) {
  // "mixamorigLeftArm.quaternion" | ".bones[mixamorigLeftArm].quaternion"
  const cleaned = trackName.replace(/^\.bones\[([^\]]+)\]\./, '$1.');
  const idx = cleaned.lastIndexOf('.');
  if (idx < 0) return null;
  return {
    bone: cleaned.slice(0, idx),
    prop: cleaned.slice(idx + 1),
  };
}

/**
 * World-rotation retarget that keeps target bind bone lengths/offsets without
 * the SkeletonUtils bug: that helper decomposes a matrix then overwrites
 * position, which invalidates the quaternion and explodes elbows on A-pose
 * UE rigs.
 *
 * Per frame, hierarchy order:
 *   1. sample the source bone's world-space delta from its bind rotation
 *   2. apply that delta to the target bone's bind-world rotation
 *   3. restore target bone.position = bind position
 *   4. bone.quaternion = inv(parent.worldQuat) * target.worldQuat
 *   5. updateMatrixWorld
 *
 * Hip position: bind XZ + scaled vertical bob from source hip.
 */
function retargetClipWorldBindSafe({
  targetMesh,
  targetRoot,
  sourceObject,
  sourceClip,
  nameMap,
  hipSource,
  hipTarget,
  hipScale,
  targetHipBindLocal,
  fps,
}) {
  const targetBonesList = targetMesh.skeleton.bones;
  const targetBones = new Map(targetBonesList.map((b) => [b.name, b]));
  const sourceBones = new Map();
  sourceObject.traverse((c) => {
    if (c.isBone) sourceBones.set(c.name, c);
  });

  const tgtToSrc = new Map();
  for (const [tgt, src] of Object.entries(nameMap)) {
    if (targetBones.has(tgt) && sourceBones.has(src)) tgtToSrc.set(tgt, src);
  }

  targetMesh.skeleton.pose();
  targetRoot.updateMatrixWorld(true);
  const bindPos = new Map();
  const bindQuat = new Map();
  const bindWorldQuat = new Map();
  for (const bone of targetBonesList) {
    bindPos.set(bone.name, bone.position.clone());
    bindQuat.set(bone.name, bone.quaternion.clone());
    bindWorldQuat.set(bone.name, bone.getWorldQuaternion(new THREE.Quaternion()));
  }

  // Capture the FBX rest pose before the mixer writes the first animation frame.
  // UBC bones use UE bind axes, so copying Mixamo's absolute world quaternion
  // folds the shoulder into the torso. Transferring only the animated delta keeps
  // the target's authored shoulder/clavicle orientation and skinning intact.
  sourceObject.updateMatrixWorld(true);
  const sourceBindWorldQuatInverse = new Map();
  for (const [name, bone] of sourceBones) {
    sourceBindWorldQuatInverse.set(
      name,
      bone.getWorldQuaternion(new THREE.Quaternion()).invert(),
    );
  }

  const numFrames = Math.max(2, Math.round(sourceClip.duration * fps) + 1);
  const times = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i += 1) {
    times[i] = (i / (numFrames - 1)) * sourceClip.duration;
  }

  const quatBuffers = new Map();
  for (const tgt of tgtToSrc.keys()) {
    quatBuffers.set(tgt, new Float32Array(numFrames * 4));
  }
  const hipPosBuffer = new Float32Array(numFrames * 3);

  const mixer = new THREE.AnimationMixer(sourceObject);
  mixer.clipAction(sourceClip).play();

  const srcWorldQ = new THREE.Quaternion();
  const srcDeltaQ = new THREE.Quaternion();
  const targetWorldQ = new THREE.Quaternion();
  const parentWorldQ = new THREE.Quaternion();
  const localQ = new THREE.Quaternion();
  const srcHipPos = new THREE.Vector3();
  const srcHipPos0 = new THREE.Vector3();

  mixer.setTime(0);
  sourceObject.updateMatrixWorld(true);
  sourceBones.get(hipSource)?.getWorldPosition(srcHipPos0);

  for (let f = 0; f < numFrames; f += 1) {
    mixer.setTime(times[f]);
    sourceObject.updateMatrixWorld(true);

    for (const bone of targetBonesList) {
      bone.position.copy(bindPos.get(bone.name));
      bone.quaternion.copy(bindQuat.get(bone.name));
    }
    targetRoot.updateMatrixWorld(true);

    for (const bone of targetBonesList) {
      const srcName = tgtToSrc.get(bone.name);
      if (!srcName) continue;
      const srcBone = sourceBones.get(srcName);
      if (!srcBone) continue;

      srcBone.getWorldQuaternion(srcWorldQ);
      srcDeltaQ.copy(srcWorldQ)
        .multiply(sourceBindWorldQuatInverse.get(srcName))
        .normalize();
      targetWorldQ.copy(srcDeltaQ)
        .multiply(bindWorldQuat.get(bone.name))
        .normalize();
      bone.position.copy(bindPos.get(bone.name));

      if (bone.parent && bone.parent.isBone) {
        bone.parent.getWorldQuaternion(parentWorldQ);
        localQ.copy(parentWorldQ).invert().multiply(targetWorldQ).normalize();
      } else {
        localQ.copy(targetWorldQ).normalize();
      }
      bone.quaternion.copy(localQ);
      bone.updateMatrixWorld(true);

      const buf = quatBuffers.get(bone.name);
      const o = f * 4;
      buf[o] = bone.quaternion.x;
      buf[o + 1] = bone.quaternion.y;
      buf[o + 2] = bone.quaternion.z;
      buf[o + 3] = bone.quaternion.w;
    }

    sourceBones.get(hipSource)?.getWorldPosition(srcHipPos);
    const o = f * 3;
    hipPosBuffer[o] = targetHipBindLocal.x;
    hipPosBuffer[o + 1] = targetHipBindLocal.y + (srcHipPos.y - srcHipPos0.y) * hipScale;
    hipPosBuffer[o + 2] = targetHipBindLocal.z;
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(sourceObject);

  const tracks = [];
  for (const [tgt, buf] of quatBuffers) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${tgt}.quaternion`, times, buf));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${hipTarget}.position`, times, hipPosBuffer));

  return new THREE.AnimationClip(sourceClip.name || 'retargeted', sourceClip.duration, tracks);
}

function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'clip';
}
