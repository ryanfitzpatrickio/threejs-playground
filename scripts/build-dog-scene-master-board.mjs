#!/usr/bin/env node
/** Build a four-view contact sheet from deterministic dog-scene probe captures. */

import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const BATCHES = {
  1: [
    'french-bulldog',
    'german-shepherd-dog',
    'dachshund',
    'rottweiler',
    'miniature-schnauzer',
    'pomeranian',
    'chihuahua',
  ],
  2: [
    'labrador-retriever',
    'poodle',
    'beagle',
    'german-shorthaired-pointer',
    'bulldog',
    'cane-corso',
    'cavalier-king-charles-spaniel',
    'yorkshire-terrier',
  ],
  3: [
    'australian-shepherd',
    'doberman-pinscher',
    'pembroke-welsh-corgi',
    'boxer',
    'bernese-mountain-dog',
    'shih-tzu',
    'great-dane',
    'boston-terrier',
  ],
  4: ['siberian-husky'],
};
const batch = Number(process.argv.find((arg) => arg.startsWith('--batch='))?.slice('--batch='.length) ?? 1);
const BREEDS = BATCHES[batch];
if (!BREEDS) throw new Error(`Unknown dog scene board batch ${batch}`);
const VIEWS = ['three-quarter', 'profile', 'front-sit', 'head-close'];
const INPUT_ROOT = path.resolve('.codex-tmp/dog-head');
const OUTPUT = path.resolve(batch === 1
  ? 'assets-source/dog-ref/scene-master-board.png'
  : `assets-source/dog-ref/scene-master-board-batch-${batch}.png`);
const CELL = 420;
const GUTTER = 4;
const WIDTH = VIEWS.length * CELL + (VIEWS.length - 1) * GUTTER;
const HEIGHT = BREEDS.length * CELL + (BREEDS.length - 1) * GUTTER;

const layers = [];
for (let row = 0; row < BREEDS.length; row += 1) {
  for (let column = 0; column < VIEWS.length; column += 1) {
    const input = path.join(INPUT_ROOT, `${BREEDS[row]}-${VIEWS[column]}.png`);
    await access(input);
    const metadata = await sharp(input).metadata();
    const chromeCrop = Math.min(96, Math.max(0, (metadata.height ?? 0) - 1));
    const image = await sharp(input)
      .extract({
        left: 0,
        top: chromeCrop,
        width: metadata.width,
        height: metadata.height - chromeCrop,
      })
      .resize(CELL, CELL, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    layers.push({
      input: image,
      left: column * (CELL + GUTTER),
      top: row * (CELL + GUTTER),
    });
  }
}

await mkdir(path.dirname(OUTPUT), { recursive: true });
await sharp({
  create: {
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    background: '#eef0eb',
  },
})
  .composite(layers)
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(OUTPUT);

console.log(`wrote ${path.relative(process.cwd(), OUTPUT)} (${WIDTH}x${HEIGHT})`);
