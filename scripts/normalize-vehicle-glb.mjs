#!/usr/bin/env node
/**
 * Scale glTF vertex positions so the longest axis fits in `targetLength` metres.
 * Meshy part-segmentation exports use 0..16k vertex coordinates without a root scale.
 */
import fs from 'node:fs';

const [input, output, targetLength = '1'] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: normalize-vehicle-glb.mjs <input.glb> <output.glb> [targetLengthMetres]');
  process.exit(1);
}

const target = Number(targetLength);
if (!Number.isFinite(target) || target <= 0) {
  console.error('targetLength must be a positive number');
  process.exit(1);
}

const buf = fs.readFileSync(input);
const jsonLen = buf.readUInt32LE(12);
const jsonStart = 20;
const json = JSON.parse(buf.slice(jsonStart, jsonStart + jsonLen).toString());
const binOffset = jsonStart + jsonLen + 8;

let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (const accessor of json.accessors ?? []) {
  if (accessor.type !== 'VEC3' || !accessor.min || !accessor.max) continue;
  for (let i = 0; i < 3; i += 1) {
    min[i] = Math.min(min[i], accessor.min[i]);
    max[i] = Math.max(max[i], accessor.max[i]);
  }
}
const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
const scale = target / extent;
const center = min.map((value, index) => (value + max[index]) * 0.5);

const outBin = Buffer.from(buf.slice(binOffset));
for (const accessor of json.accessors ?? []) {
  if (accessor.type !== 'VEC3' || accessor.componentType !== 5126) continue;
  const view = json.bufferViews[accessor.bufferView];
  const stride = view.byteStride || 12;
  const start = view.byteOffset + (accessor.byteOffset ?? 0);
  const count = accessor.count;
  for (let i = 0; i < count; i += 1) {
    const offset = start + i * stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = outBin.readFloatLE(offset + axis * 4);
      outBin.writeFloatLE((value - center[axis]) * scale, offset + axis * 4);
    }
  }
}

const outJson = JSON.stringify(json);
const outJsonBuf = Buffer.from(outJson);
const outJsonPad = (4 - (outJsonBuf.length % 4)) % 4;
const outBinPad = (4 - (outBin.length % 4)) % 4;
const totalLen = 12 + 8 + outJsonBuf.length + outJsonPad + 8 + outBin.length + outBinPad;
const out = Buffer.alloc(totalLen);
let o = 0;
out.writeUInt32LE(0x46546C67, o); o += 4;
out.writeUInt32LE(2, o); o += 4;
out.writeUInt32LE(outJsonBuf.length + outJsonPad, o); o += 4;
out.writeUInt32LE(0x4E4F534A, o); o += 4;
outJsonBuf.copy(out, o); o += outJsonBuf.length;
o += outJsonPad;
out.writeUInt32LE(0x004E4942, o); o += 4;
outBin.copy(out, o); o += outBin.length;
fs.writeFileSync(output, out);
console.log(`Normalized ${input} → ${output} (extent ${extent.toFixed(2)} → ${target} m, scale ${scale.toExponential(3)})`);
