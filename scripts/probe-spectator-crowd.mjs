// Probe: bake the spectator crowd flipbook exactly like createSpectatorCrowd.load()
// and report per-frame bounds. Guards the "per-frame normalization shrinks
// raised-arm poses" bug: rest height must be CROWD_TARGET_HEIGHT, arms-up
// frames may exceed it, and no frame should come out tiny.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { bakeSkinnedModelGeometry } from '../src/game/geometry/bakeSkinnedModelGeometry.js';
import {
  CROWD_CLIP_DEFINITIONS,
  CROWD_MODEL_URL,
  CROWD_TARGET_HEIGHT,
  computeCrowdNormalization,
  lockRootTranslation,
  normalizeBakedCrowdGeometry,
} from '../src/game/world/spectatorCrowd.js';

globalThis.self = globalThis;
globalThis.window ??= globalThis;
URL.createObjectURL ??= () => 'blob:probe';
THREE.TextureLoader.prototype.load = function loadStub(_url, onLoad) {
  const tex = new THREE.Texture();
  queueMicrotask(() => onLoad?.(tex));
  return tex;
};
THREE.ImageLoader.prototype.load = function loadStub(_url, onLoad) {
  const tex = new THREE.Texture();
  onLoad?.(tex);
  return tex;
};

// Draco decode via gltf-transform (node-friendly), then hand three an
// uncompressed GLB — three's DRACOLoader can't fetch its wasm under node.
const modelPath = `public${CROWD_MODEL_URL}`;
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, KHRMeshQuantization])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(modelPath);
for (const extension of doc.getRoot().listExtensionsUsed()) {
  if (extension.extensionName === KHRDracoMeshCompression.EXTENSION_NAME) extension.dispose();
}
const glbBytes = await io.writeBinary(doc);

const loader = new GLTFLoader();
const gltf = await new Promise((resolve, reject) => {
  loader.parse(glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength), '', resolve, reject);
});

const crowdRoot = cloneSkeleton(gltf.scene);
crowdRoot.updateMatrixWorld(true);
crowdRoot.traverse((child) => {
  if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
});

const clips = new Map(gltf.animations.map((c) => [c.name, c]));
const mixer = new THREE.AnimationMixer(crowdRoot);

const normalizationDefinition = CROWD_CLIP_DEFINITIONS.find((def) => def.name === 'StandIdle') ?? CROWD_CLIP_DEFINITIONS[0];
const normalizationSource = clips.get(normalizationDefinition.sourceClip);
const normalizationAction = mixer.clipAction(lockRootTranslation(normalizationSource));
normalizationAction.reset().play();
normalizationAction.paused = true;
normalizationAction.time = 0;
mixer.update(0);
crowdRoot.updateMatrixWorld(true);
crowdRoot.traverse((child) => {
  if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
});
const normalizationBake = bakeSkinnedModelGeometry(crowdRoot);
normalizationBake.geometry.computeBoundingBox();
const rawRest = normalizationBake.geometry.boundingBox;
console.log('normalization pose raw bounds y:', +rawRest.min.y.toFixed(3), '→', +rawRest.max.y.toFixed(3), `(height ${(rawRest.max.y - rawRest.min.y).toFixed(3)})`);
const normalization = computeCrowdNormalization(normalizationBake.geometry);
normalization.groundEachFrame = true;
normalizationBake.geometry.dispose();
normalizationAction.stop();
console.log('shared normalization:', { scale: +normalization.scale.toFixed(4), minY: +normalization.minY.toFixed(3) });
console.log('target height:', CROWD_TARGET_HEIGHT);

let failures = 0;
for (const def of CROWD_CLIP_DEFINITIONS) {
  const source = clips.get(def.sourceClip);
  if (!source) throw new Error(`missing clip ${def.sourceClip}`);
  const locked = lockRootTranslation(source);
  const action = mixer.clipAction(locked);
  action.reset();
  action.play();
  action.paused = true;

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let minFootY = Infinity;
  let maxFootY = -Infinity;
  for (let frameIndex = 0; frameIndex < def.samples; frameIndex += 1) {
    action.time = source.duration * (frameIndex / def.samples);
    mixer.update(0);
    crowdRoot.updateMatrixWorld(true);
    crowdRoot.traverse((child) => {
      if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
    });
    const baked = bakeSkinnedModelGeometry(crowdRoot);
    const bounds = normalizeBakedCrowdGeometry(baked.geometry, CROWD_TARGET_HEIGHT, normalization);
    baked.geometry.dispose();
    minHeight = Math.min(minHeight, bounds.height);
    maxHeight = Math.max(maxHeight, bounds.height);
    minFootY = Math.min(minFootY, bounds.minY);
    maxFootY = Math.max(maxFootY, bounds.minY);
  }
  action.stop();

  const heightOk = minHeight > CROWD_TARGET_HEIGHT * 0.6 && maxHeight < CROWD_TARGET_HEIGHT * 1.6;
  const feetOk = minFootY > -0.35 && maxFootY < 0.6;
  if (!heightOk || !feetOk) failures += 1;
  console.log(`\n${def.name} (${def.sourceClip}) × ${def.samples} frames`);
  console.log(`  height range: ${minHeight.toFixed(3)} → ${maxHeight.toFixed(3)} ${heightOk ? 'ok' : 'FAIL'}`);
  console.log(`  foot y range: ${minFootY.toFixed(3)} → ${maxFootY.toFixed(3)} ${feetOk ? 'ok' : 'FAIL'}`);
}

if (failures > 0) {
  console.error(`\nprobe-spectator-crowd: ${failures} clip(s) out of expected bounds`);
  process.exit(1);
}
console.log('\nprobe-spectator-crowd ok — all clips within expected bounds');
