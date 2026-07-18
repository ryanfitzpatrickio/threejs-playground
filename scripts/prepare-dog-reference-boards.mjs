#!/usr/bin/env node
/**
 * Slice standardized 2x2 dog reference boards into optimized scene images.
 *
 * Source convention:
 *   assets-source/dog-ref/<breed-id>/board.(png|jpg|jpeg|webp)
 *
 * Quadrants, in reading order:
 *   standing three-quarter, standing profile, front sit, head close-up.
 */

import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AUTHORED_DOG_BREED_IDS } from '../src/game/characters/dog/dogCatalog.js';

const SOURCE_ROOT = path.resolve('assets-source/dog-ref');
const OUTPUT_ROOT = path.resolve('public/assets/dog-ref');
const VIEW_NAMES = ['three-quarter', 'profile', 'front-sit', 'head-close'];
const NEW_BREEDS = AUTHORED_DOG_BREED_IDS.filter((id) => id !== 'golden-retriever');
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const breedIds = requested.length ? requested : NEW_BREEDS;

async function findMasterBoard() {
  const files = await readdir(SOURCE_ROOT).catch(() => []);
  const filename = files.find((file) => /^master-board\.(png|jpe?g|webp)$/i.test(file));
  return filename ? path.join(SOURCE_ROOT, filename) : null;
}

async function findBoard(breedId) {
  const dir = path.join(SOURCE_ROOT, breedId);
  const files = await readdir(dir).catch(() => []);
  const filename = files.find((file) => /^board\.(png|jpe?g|webp)$/i.test(file));
  return filename ? path.join(dir, filename) : null;
}

let prepared = 0;
const masterBoard = await findMasterBoard();
const masterMetadata = masterBoard ? await sharp(masterBoard).metadata() : null;
for (const breedId of breedIds) {
  if (!NEW_BREEDS.includes(breedId)) {
    throw new Error(`Unknown or Golden source-board breed: ${breedId}`);
  }
  const source = await findBoard(breedId);
  if (!source && !masterBoard) {
    throw new Error(`Missing ${path.relative(process.cwd(), path.join(SOURCE_ROOT, breedId, 'board.png'))}`);
  }
  if (source) await access(source);
  const metadata = source ? await sharp(source).metadata() : masterMetadata;
  if (!metadata?.width || !metadata?.height || metadata.width < 800 || metadata.height < 800) {
    throw new Error(`${breedId} board must be at least 1024×1024`);
  }
  const usingMaster = !source;
  const cellWidth = Math.floor(metadata.width / (usingMaster ? 4 : 2));
  const cellHeight = Math.floor(metadata.height / (usingMaster ? NEW_BREEDS.length : 2));
  const breedRow = NEW_BREEDS.indexOf(breedId);
  const outputDir = path.join(OUTPUT_ROOT, breedId);
  await mkdir(outputDir, { recursive: true });

  for (let index = 0; index < VIEW_NAMES.length; index += 1) {
    const left = usingMaster ? index * cellWidth : (index % 2) * cellWidth;
    const top = usingMaster ? breedRow * cellHeight : Math.floor(index / 2) * cellHeight;
    const output = path.join(outputDir, `${VIEW_NAMES[index]}.jpg`);
    await sharp(source ?? masterBoard)
      .extract({ left, top, width: cellWidth, height: cellHeight })
      .resize(960, 960, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 84, chromaSubsampling: '4:2:0', progressive: true })
      .toFile(output);
  }
  prepared += 1;
  console.log(`prepared ${breedId}: ${metadata.width}×${metadata.height}${usingMaster ? ' master' : ''} → 4 views`);
}

console.log(`ok — prepared ${prepared} dog reference board${prepared === 1 ? '' : 's'}`);
