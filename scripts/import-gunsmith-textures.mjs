#!/usr/bin/env node
/**
 * Split the 2×2 PBR sheets supplied for Gunsmith into production-ready maps.
 * Each source sheet is ordered: albedo | normal / roughness | ambient occlusion.
 *
 * Source: assets-source/guns/materials/*-packed.png
 * Output: public/assets/textures/guns/<set>/{albedo,normal,roughness,ao}.png
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'assets-source/guns/materials');
const OUT_DIR = path.join(ROOT, 'public/assets/textures/guns');
const SIZE = 627;

const SETS = [
  { id: 'field-panel', source: 'field-panel-packed.png' },
  { id: 'weathered-sand', source: 'weathered-sand-packed.png' },
  { id: 'weathered-white', source: 'weathered-white-packed.png' },
  { id: 'weathered-black', source: 'weathered-black-packed.png' },
];

const QUADRANTS = [
  { map: 'albedo', top: 0, left: 0 },
  { map: 'normal', top: 0, left: SIZE },
  { map: 'roughness', top: SIZE, left: 0 },
  { map: 'ao', top: SIZE, left: SIZE },
];

for (const set of SETS) {
  const source = path.join(SOURCE_DIR, set.source);
  if (!existsSync(source)) {
    throw new Error(`Missing Gunsmith PBR source: ${path.relative(ROOT, source)}`);
  }
  const out = path.join(OUT_DIR, set.id);
  await mkdir(out, { recursive: true });
  for (const quadrant of QUADRANTS) {
    const target = path.join(out, `${quadrant.map}.png`);
    const result = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', source,
      '-vf', `crop=${SIZE}:${SIZE}:${quadrant.left}:${quadrant.top}`,
      '-frames:v', '1',
      '-update', '1',
      target,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${set.id}/${quadrant.map}: ${result.stderr || result.stdout}`);
    }
  }
  console.log(`split ${set.id}`);
}
