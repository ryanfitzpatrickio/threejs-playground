/**
 * Slice office carpet 2×2 PBR atlases into per-map PNGs.
 * Variants: white, grey, office.
 *
 *   npm run slice:office-carpet
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slicePbrAtlas } from './slice-rally-pbr-atlas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  white: path.join(ROOT, 'assets-source/textures/office-carpet-white-atlas.png'),
  grey: path.join(ROOT, 'assets-source/textures/office-carpet-grey-atlas.png'),
  office: path.join(ROOT, 'assets-source/textures/office-carpet-office-atlas.png'),
};
const OUT = path.join(ROOT, 'public/assets/textures/office');

async function main() {
  for (const [name, source] of Object.entries(SOURCES)) {
    const outDir = path.join(OUT, `carpet-${name}`);
    const result = await slicePbrAtlas(source, outDir);
    console.log(`${name}: ${result.outputs.length} maps → ${outDir} (${result.tileW}×${result.tileH})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
