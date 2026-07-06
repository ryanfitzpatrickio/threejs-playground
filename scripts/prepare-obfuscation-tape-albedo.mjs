#!/usr/bin/env node
/**
 * Crop the dazzle albedo tile from the 2×2 PBR atlas into a standalone map.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const atlasPath = join(root, 'assets-source/textures/obfuscation-tape-atlas.png');
const outPath = join(root, 'public/assets/textures/vehicles/obfuscation-tape-albedo.png');

if (!existsSync(atlasPath)) {
  console.error(`Missing atlas: ${atlasPath}`);
  process.exit(1);
}

const meta = await sharp(atlasPath).metadata();
const halfW = Math.floor(meta.width / 2);
const halfH = Math.floor(meta.height / 2);

await sharp(atlasPath)
  .extract({ left: 0, top: 0, width: halfW, height: halfH })
  .png({ compressionLevel: 9 })
  .toFile(outPath);

const outMeta = await sharp(outPath).metadata();
console.log(`Wrote ${outPath} (${outMeta.width}×${outMeta.height})`);
