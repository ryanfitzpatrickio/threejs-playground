#!/usr/bin/env node
/**
 * Slice standardized 2x2 bird reference boards into optimized scene images.
 *
 * Source: assets-source/bird-ref/<breed-id>/board.(png|jpg|webp)
 * Quadrants (reading order): three-quarter, profile, front-sit, head-close.
 * For birds, "front-sit" is a front-facing perched / standing pose.
 *
 * Usage: npm run prepare:bird-ref [-- <breed-id> ...]
 */

import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  AUTHORED_BIRD_BREED_IDS,
  getDogBreed,
} from '../src/game/characters/dog/dogCatalog.js';

const SOURCE_ROOT = path.resolve('assets-source/bird-ref');
const OUTPUT_ROOT = path.resolve('public/assets/bird-ref');
const VIEW_NAMES = ['three-quarter', 'profile', 'front-sit', 'head-close'];

const BIRD_BREED_IDS = [...AUTHORED_BIRD_BREED_IDS];
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const targets = requested.length ? requested : BIRD_BREED_IDS;

async function findBoard(breedId) {
  const dir = path.join(SOURCE_ROOT, breedId);
  const files = await readdir(dir).catch(() => []);
  const filename = files.find((file) => /^board\.(png|jpe?g|webp)$/i.test(file));
  return filename ? path.join(dir, filename) : null;
}

let prepared = 0;
const missing = [];
for (const breedId of targets) {
  const breed = getDogBreed(breedId);
  if (!breed || !breed.conformationFlags?.includes('bird-rig')) {
    throw new Error(`Unknown bird breed: ${breedId}`);
  }
  const source = await findBoard(breedId);
  if (!source) {
    missing.push(breedId);
    continue;
  }
  await access(source);
  const metadata = await sharp(source).metadata();
  if (!metadata?.width || !metadata?.height || metadata.width < 800 || metadata.height < 800) {
    throw new Error(`${breedId} board must be at least 800×800 (got ${metadata?.width}×${metadata?.height})`);
  }
  const cellWidth = Math.floor(metadata.width / 2);
  const cellHeight = Math.floor(metadata.height / 2);
  const outputDir = path.join(OUTPUT_ROOT, breedId);
  await mkdir(outputDir, { recursive: true });

  for (let index = 0; index < VIEW_NAMES.length; index += 1) {
    const left = (index % 2) * cellWidth;
    const top = Math.floor(index / 2) * cellHeight;
    const output = path.join(outputDir, `${VIEW_NAMES[index]}.jpg`);
    await sharp(source)
      .extract({ left, top, width: cellWidth, height: cellHeight })
      .resize(960, 960, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 84, chromaSubsampling: '4:2:0', progressive: true })
      .toFile(output);
  }
  prepared += 1;
  console.log(`prepared ${breedId}: ${metadata.width}×${metadata.height} → 4 views`);
}

if (missing.length) {
  console.warn(`missing boards (${missing.length}): ${missing.join(', ')}`);
}
console.log(`ok — prepared ${prepared} bird reference board${prepared === 1 ? '' : 's'}`);
if (prepared === 0 && missing.length) process.exitCode = 1;
