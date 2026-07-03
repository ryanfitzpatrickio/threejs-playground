import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';

globalThis.window = {
  URL: {
    createObjectURL: () => '',
  },
};

THREE.TextureLoader.prototype.load = function loadStubbedTexture() {
  return new THREE.Texture();
};

const SOURCE_MODEL_PATH = path.resolve('assets-source/models/climber.fbx');
const SOURCE_ANIMATION_DIR = path.resolve('public/assets/animations');
const OUTPUT_DIR = path.resolve('public/assets/animations-retargeted');
const PUBLIC_OUTPUT_DIR = '/assets/animations-retargeted';
const HIP_BONE = 'mixamorigHips';
const FPS = 30;

const loader = new FBXLoader();
const targetObject = loadFbx(SOURCE_MODEL_PATH);
const targetMesh = findSkinnedMesh(targetObject);
const targetHipPosition = targetObject.getObjectByName(HIP_BONE)?.position.clone() ?? new THREE.Vector3();

if (!targetMesh) {
  throw new Error(`No SkinnedMesh found in ${SOURCE_MODEL_PATH}`);
}

await mkdir(OUTPUT_DIR, { recursive: true });

const animationFiles = (await readdir(SOURCE_ANIMATION_DIR))
  .filter((fileName) => fileName.toLowerCase().endsWith('.fbx'))
  .sort((a, b) => a.localeCompare(b));

const usedSlugs = new Map();
const manifest = {
  generatedAt: new Date().toISOString(),
  model: '/assets/models/climber.glb',
  outputDir: PUBLIC_OUTPUT_DIR,
  fps: FPS,
  animations: [],
};

for (const fileName of animationFiles) {
  const sourcePath = path.join(SOURCE_ANIMATION_DIR, fileName);
  const sourceObject = loadFbx(sourcePath);
  const sourceClip = sourceObject.animations[0];

  if (!sourceClip) {
    console.warn(`Skipping ${fileName}: no animation clip found.`);
    continue;
  }

  const sourceSkeleton = createSkeletonFromObject(sourceObject);
  const retargetedClip = retargetClip(targetMesh, sourceSkeleton, sourceClip, {
    fps: FPS,
    getBoneName: (bone) => bone.name,
    hip: HIP_BONE,
    preserveBoneMatrix: true,
    preserveBonePositions: true,
    useFirstFramePosition: true,
  });
  const slug = uniqueSlug(fileName.replace(/\.fbx$/i, ''), usedSlugs);
  const outputFileName = `${slug}.json`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);

  retargetedClip.name = fileName.replace(/\.fbx$/i, '');
  retargetedClip.tracks = retargetedClip.tracks.map((track) =>
    normalizeRetargetedTrack({
      track,
      targetHipPosition,
    }),
  );
  retargetedClip.optimize();

  await writeFile(outputPath, JSON.stringify(retargetedClip.toJSON()));
  manifest.animations.push({
    name: retargetedClip.name,
    sourceUrl: `/assets/animations/${encodeAssetPath(fileName)}`,
    clipUrl: `${PUBLIC_OUTPUT_DIR}/${outputFileName}`,
    duration: Number(retargetedClip.duration.toFixed(4)),
    tracks: retargetedClip.tracks.length,
  });
  console.log(`Retargeted ${fileName} -> ${outputFileName}`);
}

await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Retargeted ${manifest.animations.length} animations into ${OUTPUT_DIR}`);

function loadFbx(filePath) {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  return loader.parse(arrayBuffer, '');
}

function findSkinnedMesh(object) {
  let skinnedMesh = null;

  object.traverse((child) => {
    if (!skinnedMesh && child.isSkinnedMesh) {
      skinnedMesh = child;
    }
  });

  return skinnedMesh;
}

function createSkeletonFromObject(object) {
  const bones = [];

  object.traverse((child) => {
    if (child.isBone) {
      bones.push(child);
    }
  });

  return new THREE.Skeleton(bones);
}

function normalizeRetargetedTrack({ track, targetHipPosition }) {
  const renamedTrack = renameSkeletonTrack(track);

  if (renamedTrack.name !== `${HIP_BONE}.position`) {
    return renamedTrack;
  }

  const values = renamedTrack.values;

  for (let index = 0; index < values.length; index += 3) {
    values[index] = targetHipPosition.x;
    values[index + 1] = targetHipPosition.y + values[index + 1];
    values[index + 2] = targetHipPosition.z;
  }

  return renamedTrack;
}

function renameSkeletonTrack(track) {
  const clonedTrack = track.clone();
  clonedTrack.name = clonedTrack.name.replace(/^\.bones\[([^\]]+)\]\./, '$1.');

  return clonedTrack;
}

function uniqueSlug(input, usedSlugs) {
  const baseSlug = slugify(input);
  const count = usedSlugs.get(baseSlug) ?? 0;
  usedSlugs.set(baseSlug, count + 1);

  return count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
}

function slugify(input) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'animation'
  );
}

function encodeAssetPath(fileName) {
  return fileName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}
