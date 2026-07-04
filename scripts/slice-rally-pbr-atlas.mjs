/**
 * Slice a 2×2 PBR atlas PNG into separate map files:
 *   top-left     → albedo.png
 *   top-right    → normal.png
 *   bottom-left  → roughness.png
 *   bottom-right → height.png
 *
 * Usage:
 *   node scripts/slice-rally-pbr-atlas.mjs <atlas.png> <output-dir>
 *   npm run slice:rally-surfaces
 */

import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCES = Object.freeze({
  dirt: path.join(ROOT, 'assets-source/textures/rally-dirt-atlas.png'),
  grass: path.join(ROOT, 'assets-source/textures/rally-grass-atlas.png'),
});
const DEFAULT_OUT = path.join(ROOT, 'public/assets/textures/rally/surfaces');

const TILES = [
  { name: 'albedo', col: 0, row: 0 },
  { name: 'normal', col: 1, row: 0 },
  { name: 'roughness', col: 0, row: 1 },
  { name: 'height', col: 1, row: 1 },
];

export async function slicePbrAtlas(inputPath, outputDir) {
  const image = sharp(inputPath);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 2 || height < 2) {
    throw new Error(`Atlas too small: ${inputPath} (${width}x${height})`);
  }

  const tileW = Math.floor(width / 2);
  const tileH = Math.floor(height / 2);
  await mkdir(outputDir, { recursive: true });

  const outputs = [];
  for (const tile of TILES) {
    const outPath = path.join(outputDir, `${tile.name}.png`);
    await sharp(inputPath)
      .extract({
        left: tile.col * tileW,
        top: tile.row * tileH,
        width: tileW,
        height: tileH,
      })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    outputs.push(outPath);
  }
  return { tileW, tileH, outputs };
}

async function ensureSources() {
  const downloads = {
    dirt: '/Users/personal/Downloads/ChatGPT Image Jul 3, 2026, 01_21_52 PM.png',
    grass: '/Users/personal/Downloads/ChatGPT Image Jul 3, 2026, 01_21_57 PM.png',
  };
  await mkdir(path.dirname(DEFAULT_SOURCES.dirt), { recursive: true });
  for (const [key, src] of Object.entries(downloads)) {
    await copyFile(src, DEFAULT_SOURCES[key]);
  }
}

async function main() {
  const argv = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (argv.length >= 2) {
    const [input, output] = argv;
    const result = await slicePbrAtlas(path.resolve(input), path.resolve(output));
    console.log(`Sliced ${input} → ${output} (${result.tileW}x${result.tileH} per tile)`);
    return;
  }

  await ensureSources();
  for (const [name, source] of Object.entries(DEFAULT_SOURCES)) {
    const outDir = path.join(DEFAULT_OUT, name);
    const result = await slicePbrAtlas(source, outDir);
    console.log(`${name}: ${result.outputs.length} maps in ${outDir} (${result.tileW}x${result.tileH})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
