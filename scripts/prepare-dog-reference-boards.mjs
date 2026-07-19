#!/usr/bin/env node
/**
 * Slice standardized 2x2 dog reference boards into optimized scene images.
 *
 * Source convention:
 *   assets-source/dog-ref/<breed-id>/board.(png|jpg|jpeg|webp)                 — default variant
 *   assets-source/dog-ref/<breed-id>/<variant-id>/board.(png|jpg|jpeg|webp)    — named variant
 *
 * Quadrants, in reading order:
 *   standing three-quarter, standing profile, front sit, head close-up.
 *
 * Usage: npm run prepare:dog-ref [-- <breed-id>[/<variant-id>] ...]
 * e.g.   npm run prepare:dog-ref -- dachshund/longhaired dachshund/wirehaired
 */

import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AUTHORED_DOG_BREED_IDS, getDogBreed, normalizeDogVariantId } from '../src/game/characters/dog/dogCatalog.js';

const SOURCE_ROOT = path.resolve('assets-source/dog-ref');
const OUTPUT_ROOT = path.resolve('public/assets/dog-ref');
const VIEW_NAMES = ['three-quarter', 'profile', 'front-sit', 'head-close'];
const NEW_BREEDS = AUTHORED_DOG_BREED_IDS.filter((id) => id !== 'golden-retriever');
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
// `breed` or `breed/variant`; bare breed always means its default variant
// (e.g. dachshund's default variant id is 'smooth', not the literal 'default').
const targets = (requested.length ? requested : NEW_BREEDS).map((arg) => {
  const [breedId, explicitVariantId] = arg.split('/');
  return { breedId, variantId: normalizeDogVariantId(breedId, explicitVariantId) };
});

async function findMasterBoard() {
  const files = await readdir(SOURCE_ROOT).catch(() => []);
  const filename = files.find((file) => /^master-board\.(png|jpe?g|webp)$/i.test(file));
  return filename ? path.join(SOURCE_ROOT, filename) : null;
}

/** Only the breed's own default variant keeps the legacy root-level path. */
function isDefaultVariant(breedId, variantId) {
  return (getDogBreed(breedId)?.defaultVariantId ?? 'default') === variantId;
}

async function findBoard(breedId, variantId) {
  const dir = isDefaultVariant(breedId, variantId)
    ? path.join(SOURCE_ROOT, breedId)
    : path.join(SOURCE_ROOT, breedId, variantId);
  const files = await readdir(dir).catch(() => []);
  const filename = files.find((file) => /^board\.(png|jpe?g|webp)$/i.test(file));
  return filename ? path.join(dir, filename) : null;
}

let prepared = 0;
const masterBoard = await findMasterBoard();
const masterMetadata = masterBoard ? await sharp(masterBoard).metadata() : null;
for (const { breedId, variantId } of targets) {
  if (!NEW_BREEDS.includes(breedId)) {
    throw new Error(`Unknown or Golden source-board breed: ${breedId}`);
  }
  if (!getDogBreed(breedId).variants.some((variant) => variant.id === variantId)) {
    throw new Error(`Unknown variant '${variantId}' for ${breedId}`);
  }
  const isDefault = isDefaultVariant(breedId, variantId);
  // Only the default variant falls back to the shared master-board sheet —
  // named variants must have their own per-breed board (no master row for them).
  const source = await findBoard(breedId, variantId);
  const usingMaster = !source && isDefault;
  if (!source && !usingMaster) {
    const rel = path.relative(process.cwd(), path.join(SOURCE_ROOT, breedId, isDefault ? '' : variantId, 'board.png'));
    throw new Error(`Missing ${rel}`);
  }
  if (source) await access(source);
  const metadata = source ? await sharp(source).metadata() : masterMetadata;
  if (!metadata?.width || !metadata?.height || metadata.width < 800 || metadata.height < 800) {
    throw new Error(`${breedId} board must be at least 1024×1024`);
  }
  const cellWidth = Math.floor(metadata.width / (usingMaster ? 4 : 2));
  const cellHeight = Math.floor(metadata.height / (usingMaster ? NEW_BREEDS.length : 2));
  const breedRow = NEW_BREEDS.indexOf(breedId);
  const outputDir = isDefault
    ? path.join(OUTPUT_ROOT, breedId)
    : path.join(OUTPUT_ROOT, breedId, variantId);
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
  const label = isDefault ? breedId : `${breedId}/${variantId}`;
  console.log(`prepared ${label}: ${metadata.width}×${metadata.height}${usingMaster ? ' master' : ''} → 4 views`);
}

console.log(`ok — prepared ${prepared} dog reference board${prepared === 1 ? '' : 's'}`);
