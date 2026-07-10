#!/usr/bin/env node
/**
 * Import Meshy part-segmentation gun GLBs into public/assets/guns/.
 *
 * - Dequantizes KHR_mesh_quantization positions (WebGPU-safe plain floats)
 * - Generates creased normals (source has none)
 * - Normalizes longest axis to a target real-world length (~meters)
 * - Origin near grip ballpark (bounds min.y → 0, center XZ)
 *
 * Usage:
 *   node scripts/import-guns.mjs
 *   node scripts/import-guns.mjs --guns modern-ar15,midnight-glock
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { toCreasedNormals } from '../src/three-addons/utils/BufferGeometryUtils.js';
import { flattenObjectForWebGPU } from '../src/game/geometry/prepareWebGPUGeometry.js';

// Node shims for GLTFExporter (browser APIs).
globalThis.window ??= {};
globalThis.self ??= globalThis;
globalThis.Blob ??= class Blob {
  constructor(parts = [], opts = {}) {
    this._parts = parts;
    this.type = opts?.type || '';
  }
  async arrayBuffer() {
    const chunks = [];
    for (const part of this._parts) {
      if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
      else if (ArrayBuffer.isView(part)) chunks.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      else if (typeof part === 'string') chunks.push(new TextEncoder().encode(part));
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out.buffer;
  }
};
globalThis.URL ??= {
  createObjectURL: () => 'blob:mock',
  revokeObjectURL: () => {},
};
globalThis.FileReader ??= class FileReader {
  constructor() {
    this.onload = null;
    this.onloadend = null;
    this.result = null;
  }
  readAsArrayBuffer(blob) {
    Promise.resolve()
      .then(() => (blob?.arrayBuffer ? blob.arrayBuffer() : new ArrayBuffer(0)))
      .then((buf) => {
        this.result = buf;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      });
  }
};

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'assets-source/guns');
const OUT_DIR = path.join(ROOT, 'public/assets/guns');

/** Longest-axis target length in meters per gun id (fallback for rifles). */
const TARGET_LENGTH = {
  'modern-ar15': 0.9,
  'desert-ar15': 0.92,
  'desert-scar': 0.9,
  ak47: 0.88,
  'folding-stock-ar': 0.85,
  'obsidian-carbine': 0.8,
  'olive-bullpup': 0.72,
  'midnight-glock': 0.2,
  'tactical-shotgun': 1.0,
  'desert-sentinel': 1.05,
};

const CREASE_ANGLE = Math.PI / 3;

const io = await new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

/** Write binary GLB then Draco-compress (decodes to plain floats at runtime). */
async function writeCompressedGlb(arrayBuffer, outPath) {
  const tmpDoc = await io.readBinary(new Uint8Array(arrayBuffer));
  await tmpDoc.transform(
    dedup(),
    prune(),
    draco({
      method: 'edgebreaker',
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeColor: 8,
      quantizeGeneric: 12,
    }),
  );
  const compressed = await io.writeBinary(tmpDoc);
  await writeFile(outPath, compressed);
  return compressed.byteLength;
}

const only = parseOnlyArg(process.argv);
await mkdir(OUT_DIR, { recursive: true });

const files = (await readdir(SOURCE_DIR))
  .filter((name) => name.endsWith('.glb'))
  .filter((name) => !only || only.has(name.replace(/\.glb$/i, '')))
  .sort();

if (files.length === 0) {
  console.error('No source guns found in', SOURCE_DIR);
  process.exit(1);
}

const catalog = [];

for (const fileName of files) {
  const id = fileName.replace(/\.glb$/i, '');
  const sourcePath = path.join(SOURCE_DIR, fileName);
  const outPath = path.join(OUT_DIR, fileName);
  console.log(`\n→ ${id}`);

  // 1) Dequantize quantized attributes offline.
  const document = await io.read(sourcePath);
  await document.transform(dequantize(), dedup(), prune());
  const plain = await io.writeBinary(document);
  const ab = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);

  // 2) Load with three, creased normals, normalize scale/origin.
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  let meshCount = 0;
  const meshNames = [];
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    meshCount += 1;
    const name = child.name || `part_${meshCount}`;
    child.name = name;
    meshNames.push(name);

    let geo = child.geometry;
    if (geo.index) {
      geo = geo.toNonIndexed();
    }
    // Drop empty/useless attributes; keep COLOR_0 if present for later AO term.
    if (!geo.attributes.normal) {
      geo = toCreasedNormals(geo, CREASE_ANGLE);
    } else if (!geo.getAttribute('normal')) {
      geo = toCreasedNormals(geo, CREASE_ANGLE);
    } else {
      // Source often has no normals; if attribute exists but is zero, rebuild.
      const n = geo.getAttribute('normal');
      let nonZero = false;
      for (let i = 0; i < Math.min(n.count, 32); i += 1) {
        if (Math.abs(n.getX(i)) + Math.abs(n.getY(i)) + Math.abs(n.getZ(i)) > 1e-6) {
          nonZero = true;
          break;
        }
      }
      if (!nonZero) geo = toCreasedNormals(geo, CREASE_ANGLE);
    }
    child.geometry = geo;
    child.castShadow = true;
    child.receiveShadow = true;
  });

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const target = TARGET_LENGTH[id] ?? 0.9;
  const scale = target / longest;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const box2 = new THREE.Box3().setFromObject(root);
  const center = box2.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box2.min.y;
  root.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(root);
  const finalSize = finalBox.getSize(new THREE.Vector3());

  // Bake standalone float attributes before export (WebGPU-safe).
  flattenObjectForWebGPU(root);

  const glbBuffer = await exportGlb(root);
  const bytes = await writeCompressedGlb(glbBuffer, outPath);

  catalog.push({
    id,
    label: idToLabel(id),
    url: `/assets/guns/${fileName}`,
    meshCount,
    meshNames,
    size: [Number(finalSize.x.toFixed(3)), Number(finalSize.y.toFixed(3)), Number(finalSize.z.toFixed(3))],
    longestAxis: Number(Math.max(finalSize.x, finalSize.y, finalSize.z).toFixed(3)),
    bytes,
  });

  console.log(
    `  meshes=${meshCount} size=${finalSize.x.toFixed(3)}×${finalSize.y.toFixed(3)}×${finalSize.z.toFixed(3)} m `
    + `(${(bytes / 1024 / 1024).toFixed(2)} MiB) → ${path.relative(ROOT, outPath)}`,
  );
}

await writeFile(path.join(OUT_DIR, 'catalog.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), guns: catalog }, null, 2)}\n`);
console.log(`\nImported ${catalog.length} guns → ${path.relative(ROOT, OUT_DIR)}`);

function idToLabel(id) {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseOnlyArg(argv) {
  const flag = argv.find((a) => a.startsWith('--guns='));
  if (!flag) return null;
  return new Set(flag.slice('--guns='.length).split(',').map((s) => s.trim()).filter(Boolean));
}

function exportGlb(object) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      object,
      (result) => resolve(result),
      (err) => reject(err),
      { binary: true },
    );
  });
}
