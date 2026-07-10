#!/usr/bin/env node
/**
 * Asset optimization script for Dreamfall models.
 * - Shrinks large GLBs (texture resize + dedup + prune + quantize)
 * - Converts FBX (e.g. climber) to compressed GLB
 *
 * Usage:
 *   node scripts/optimize-models.mjs
 *   node scripts/optimize-models.mjs --models horse,saddle,climber
 *
 * Requires dev deps: @gltf-transform/* + sharp (already added).
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco, flatten, join, textureResize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = path.resolve('.');
const MODELS_DIR = path.join(ROOT, 'public/assets/models');
const SOURCE_DIR = path.join(ROOT, 'assets-source/models');
const BACKUP_DIR = path.join(ROOT, 'assets-source/.optimized-originals');

// Blender is the proper tool for converting rigged FBX → GLB: it bakes the
// armature transform and exports correct inverse-bind matrices + materials.
// The old in-process three GLTFExporter path produced broken inverse-binds and
// stripped textures (gray mesh), so we prefer Blender when it is installed.
const BLENDER_BIN =
  process.env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/blender';
const FBX_TO_GLB_PY = path.join(ROOT, 'scripts/convert-fbx-to-glb.py');

const MODELS = {
  horse: 'horse-rigged.glb',
  saddle: 'saddle.glb',
  enemy: 'enemy1.glb',
  neonblade: 'neonblade.glb',
  climber: 'climber.fbx', // legacy Tripo body (kept as ?playerModel=climber)
  player: 'player-tpose.fbx', // default Mixamo-compatible T-pose player; → player-tpose.glb
  playernew: 'playernew.fbx', // earlier Mixamo player mesh; produces playernew.glb in public
  mesh2motionplayer: 'playernew-mesh2motion.glb',
  car: 'car-prop.glb',
  van: 'van-prop.glb',
  musclechassis: 'muscle-chasis.glb',
  musclechassis2: 'muscle-chasis-2.glb',
  tirecenter: 'tire-center.glb',
  // Bodyshop-published chassis (raw exports often exceed Cloudflare's 25 MiB limit).
  mustang67: 'mustang67.glb',
  rally2: 'rally2.glb',
};

const TARGET_SIZES = {
  // 1024 is very safe visually for these low-poly AI models; use 512 for more aggressive
  horse: [1024, 1024],
  saddle: [1024, 1024],
  enemy: [1024, 1024],
  neonblade: [512, 512],
  climber: [1024, 1024], // Tripo body/face textures
  player: [1024, 1024],
  playernew: [1024, 1024],
  mesh2motionplayer: [1024, 1024],
  car: [1024, 1024], // street prop — viewed at distance, 1K is plenty
  van: [1024, 1024],
  musclechassis: [1024, 1024],
  musclechassis2: [4096, 4096],
  // Four instances are visible at once and share GPU resources. One-kilopixel
  // PBR maps retain close garage detail without shipping three 4K PNGs (32MB).
  tirecenter: [1024, 1024],
  // Garage close-ups + body panels — 2K is enough after Draco mesh compress.
  mustang67: [2048, 2048],
  rally2: [2048, 2048],
};

const MERGE_MESH_MODELS = new Set([]);

function getAssetUrl(file) {
  return `file://${path.join(MODELS_DIR, file)}`;
}

async function ensureBackup(originalPath) {
  if (!existsSync(BACKUP_DIR)) await mkdir(BACKUP_DIR, { recursive: true });
  const name = path.basename(originalPath);
  const backupPath = path.join(BACKUP_DIR, name);
  if (!existsSync(backupPath)) {
    await copyFile(originalPath, backupPath);
    console.log(`  backed up -> ${path.relative(ROOT, backupPath)}`);
  }
  return backupPath;
}

// A NodeIO that can both read AND write Draco-compressed GLBs. Registering the
// encoder + decoder modules is required for KHR_draco_mesh_compression to work.
let _dracoIoPromise = null;
async function createDracoIO() {
  if (!_dracoIoPromise) {
    _dracoIoPromise = (async () =>
      new NodeIO()
        // Register every standard extension so we can READ inputs that already
        // use KHR_mesh_quantization / KHR_draco_mesh_compression / specular, etc.
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'draco3d.encoder': await draco3d.createEncoderModule(),
          'draco3d.decoder': await draco3d.createDecoderModule(),
        }))();
  }
  return _dracoIoPromise;
}

async function optimizeGlb(inputPath, outputPath, maxSize = [1024, 1024], { mergeMeshes = false } = {}) {
  const io = await createDracoIO();
  const doc = await io.read(inputPath);

  const beforeSize = (await readFile(inputPath)).length;

  // Core cleanup + resize textures (biggest win for Tripo exports)
  await doc.transform(
    dedup(),
    ...(mergeMeshes ? [flatten(), join({ keepNamed: false })] : []),
    prune(),
    textureResize({ size: maxSize }),
    // Draco mesh compression. Unlike KHR_mesh_quantization, the three.js
    // DRACOLoader fully DECODES Draco back to plain non-normalized Float32
    // attributes in the original coordinate space at load time. That means the
    // runtime geometry is identical to an uncompressed GLB (no node/inverse-bind
    // dequantization tricks needed), so skinned characters that rely on
    // recomputed inverse-bind matrices / WebGPU attribute flattening render
    // correctly while the file on disk stays small. JOINTS are kept lossless.
    draco({
      method: 'edgebreaker',
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      // Skinning weights need enough precision; joint indices are integer/lossless.
      quantizeGeneric: 12,
    }),
  );

  // Optional: further compress texture images with sharp (re-encode to PNG)
  // gltf-transform textureResize already downsamples the image data.
  // We can post-process for even smaller files.
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    try {
      // Re-encode as optimized PNG. Sharp gives good size savings.
      const optimized = await sharp(image)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      texture.setImage(optimized);
      texture.setMimeType('image/png');
    } catch (e) {
      console.warn('  sharp re-encode skipped for a texture:', e.message);
    }
  }

  const glb = await io.writeBinary(doc);
  await writeFile(outputPath, glb);

  const afterSize = glb.length;
  const savings = ((1 - afterSize / beforeSize) * 100).toFixed(1);
  console.log(
    `  ${path.basename(inputPath)}: ${(beforeSize / 1024 / 1024).toFixed(1)}MB -> ${(afterSize / 1024 / 1024).toFixed(1)}MB (${savings}% smaller)`
  );
  return { before: beforeSize, after: afterSize };
}

async function convertFbxToGlb(fbxPath, outputGlbPath) {
  if (existsSync(BLENDER_BIN) && existsSync(FBX_TO_GLB_PY)) {
    console.log(`  converting via Blender: ${path.basename(fbxPath)}`);
    const res = spawnSync(
      BLENDER_BIN,
      ['--background', '--python', FBX_TO_GLB_PY, '--', fbxPath, outputGlbPath],
      { stdio: 'inherit' },
    );
    if (res.status === 0 && existsSync(outputGlbPath)) {
      return outputGlbPath;
    }
    console.warn('  Blender conversion failed; falling back to in-process exporter (no textures).');
  } else {
    console.warn('  Blender not found; using in-process exporter (no textures). Set BLENDER_BIN to enable.');
  }
  return convertFbxToGlbInProcess(fbxPath, outputGlbPath);
}

async function convertFbxToGlbInProcess(fbxPath, outputGlbPath) {
  // Fallback: use the exact same Node shims + raw buffer parse pattern as retarget-animations.mjs
  globalThis.window ??= {};
  globalThis.window.URL ??= { createObjectURL: () => '' };
  globalThis.self ??= globalThis;

  // Additional shims required by GLTFExporter in Node
  globalThis.Blob ??= class Blob {
    constructor(parts, opts) { this._parts = parts; this.type = opts?.type || ''; }
    arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); }
  };
  globalThis.URL ??= {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  };
  globalThis.FileReader ??= class FileReader {
    constructor() { this.onloadend = null; this.result = null; }
    readAsArrayBuffer(blob) {
      // For our case (no real textures), just give empty buffer quickly
      setTimeout(() => {
        this.result = new ArrayBuffer(0);
        if (this.onloadend) this.onloadend({ target: this });
      }, 0);
    }
  };

  THREE.TextureLoader.prototype.load = function () {
    return new THREE.Texture();
  };

  const { readFileSync } = await import('node:fs');
  const loader = new FBXLoader();

  console.log(`  loading FBX (via parse): ${path.basename(fbxPath)}`);
  const buffer = readFileSync(fbxPath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const object = loader.parse(arrayBuffer, '');

  // Clean up for export: replace materials entirely to avoid any image handling in GLTFExporter under Node
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;

      const plainMat = new THREE.MeshStandardMaterial({
        color: 0xaaaaaa,
        metalness: 0.1,
        roughness: 0.85,
      });

      if (Array.isArray(child.material)) {
        child.material = child.material.map(() => plainMat);
      } else {
        child.material = plainMat;
      }
    }
  });

  const exporter = new GLTFExporter();

  // Use parseAsync if available (modern three), fall back to callback
  let glbBuffer;
  if (typeof exporter.parseAsync === 'function') {
    glbBuffer = await exporter.parseAsync(object, {
      binary: true,
      animations: object.animations || [],
      includeCustomExtensions: false,
    });
  } else {
    glbBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        object,
        (result) => resolve(Buffer.from(result)),
        reject,
        { binary: true, animations: object.animations || [] }
      );
    });
  }

  await writeFile(outputGlbPath, Buffer.from(glbBuffer));
  const sizeMB = (glbBuffer.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  wrote GLB: ${path.basename(outputGlbPath)} (${sizeMB}MB)`);
  return outputGlbPath;
}

async function main() {
  const args = process.argv.slice(2);
  const filterArg = args.find((a) => a.startsWith('--models='));
  const selected = filterArg
    ? filterArg.split('=')[1].split(',').map((s) => s.trim().toLowerCase())
    : Object.keys(MODELS);

  console.log('=== Dreamfall model optimizer ===');
  console.log('Selected:', selected.join(', '));
  console.log('');

  await mkdir(MODELS_DIR, { recursive: true });

  const results = [];

  for (const key of selected) {
    if (!MODELS[key]) {
      console.warn(`Unknown model key: ${key}`);
      continue;
    }
    const file = MODELS[key];
    const isFbx = file.endsWith('.fbx');
    // FBX sources live in assets-source/models (kept out of the shipped build);
    // GLB sources are optimized in place under public/assets/models.
    const sourceCandidates = isFbx
      ? [path.join(SOURCE_DIR, file), path.join(MODELS_DIR, file)]
      : [path.join(MODELS_DIR, file)];
    const fullPath = sourceCandidates.find((p) => existsSync(p));

    if (!fullPath) {
      console.warn(`  SKIP: not found ${sourceCandidates.join(' or ')}`);
      continue;
    }

    console.log(`\n→ Processing ${key} (${path.relative(ROOT, fullPath)})`);

    if (file.endsWith('.glb')) {
      await ensureBackup(fullPath);
      const maxSize = TARGET_SIZES[key] || [1024, 1024];
      const outPath = fullPath; // overwrite in place (source of truth)
      const res = await optimizeGlb(fullPath, outPath, maxSize, {
        mergeMeshes: MERGE_MESH_MODELS.has(key),
      });
      results.push({ key, ...res });
    } else if (isFbx) {
      // Convert to .glb (written into public/assets/models)
      const base = path.basename(file).replace(/\.fbx$/i, '');
      const glbName = `${base}.glb`;
      const glbPath = path.join(MODELS_DIR, glbName);

      // First convert raw (Blender preferred, keeps textures + correct rig)
      await convertFbxToGlb(fullPath, glbPath);

      // Then run the GLB optimizer on it
      if (existsSync(glbPath)) {
        const maxSize = TARGET_SIZES[key] || [1024, 1024];
        const res = await optimizeGlb(glbPath, glbPath, maxSize);
        results.push({ key, converted: true, ...res });
        // Optional: leave original fbx for retarget scripts (they need the source rig often)
        console.log(`  (kept original ${file} for retarget tooling)`);
      }
    }
  }

  console.log('\n=== Summary ===');
  let totalBefore = 0;
  let totalAfter = 0;
  for (const r of results) {
    const b = (r.before / 1024 / 1024).toFixed(1);
    const a = (r.after / 1024 / 1024).toFixed(1);
    totalBefore += r.before;
    totalAfter += r.after;
    console.log(`  ${r.key}: ${b}MB → ${a}MB`);
  }
  if (results.length) {
    const pct = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
    console.log(
      `\nTotal for processed: ${(totalBefore / 1024 / 1024).toFixed(1)}MB → ${(totalAfter / 1024 / 1024).toFixed(1)}MB (${pct}% reduction)`
    );
  }

  console.log('\nNext steps:');
  console.log('  1. Rebuild: npm run build');
  console.log('  2. If you converted climber.fbx → climber.glb, update code references (see below)');
  console.log('  3. Test in dev or with visual-smoke');
  console.log('  4. Commit the smaller assets in public/assets/models/');
  console.log('');
  console.log('If you changed the character model extension:');
  console.log('  - src/game/characters/mara/maraAnimationManifest.js : MARA_MODEL_URL');
  console.log('  - src/game/characters/mara/createMaraFbxModel.js : switch FBXLoader → GLTFLoader for base model');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
