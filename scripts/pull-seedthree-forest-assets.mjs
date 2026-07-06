/**
 * Download forest PBR textures from upstream SeedThree.
 *
 * Bark → public/assets/textures/forest/{species}/  (base 3 species tracked in git)
 * Leaves → data/forest-leaves/  (gitignored, served via vite forest-leaves plugin)
 *
 * Upstream: https://github.com/SkyeShark/SeedThree (MIT)
 * Run: npm run pull:forest-textures
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  FOREST_SPECIES_TEXTURE_PROFILES,
  speciesTexturePrefix,
} from '../src/game/world/forest/forestSpeciesTextures.js';
import { FOREST_SPECIES_ORDER } from '../src/game/world/forest/forestSpecies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BARK_ROOT = path.resolve(__dirname, '..', 'public', 'assets', 'textures', 'forest');
const LEAVES_ROOT = path.resolve(__dirname, '..', 'data', 'forest-leaves');
const SEEDTHREE_RAW = 'https://raw.githubusercontent.com/SkyeShark/SeedThree/main';

const NEEDLE_SUFFIXES = ['needle_albedo.png', 'needle_normal.png', 'needle_roughness.png', 'needle_translucency.png'];

/** @type {Record<string, { barkPrefix: string, leafStem: string }>} */
const SEEDTHREE_FAMILIES = {
  pine: { barkPrefix: 'pine', leafStem: 'pine_needle' },
  'douglas-fir': { barkPrefix: 'douglas_fir', leafStem: 'douglas_fir_needle' },
  loblolly: { barkPrefix: 'loblolly', leafStem: 'loblolly_needle' },
};

const downloadCache = new Map();

async function download(relPath) {
  if (downloadCache.has(relPath)) return downloadCache.get(relPath);
  const url = `${SEEDTHREE_RAW}/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SeedThree fetch failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  downloadCache.set(relPath, buf);
  return buf;
}

async function processRaster(buffer, profile = {}) {
  let img = sharp(buffer);
  const { hue, saturation, brightness, scale } = profile;
  if (scale && scale !== 1) {
    const meta = await img.metadata();
    const w = Math.max(4, Math.round(meta.width * scale));
    const h = Math.max(4, Math.round(meta.height * scale));
    img = img.resize(w, h, { fit: 'fill' });
  }
  const mods = {};
  if (hue != null) mods.hue = hue;
  if (saturation != null) mods.saturation = saturation;
  if (brightness != null) mods.brightness = brightness;
  if (Object.keys(mods).length) img = img.modulate(mods);
  return img.png().toBuffer();
}

async function writeFile(outPath, buffer) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, buffer);
}

async function migrateNeedlesFromBarkDirs() {
  for (const speciesId of FOREST_SPECIES_ORDER) {
    const prefix = speciesTexturePrefix(speciesId);
    const barkDir = path.join(BARK_ROOT, speciesId);
    for (const suffix of NEEDLE_SUFFIXES) {
      const src = path.join(barkDir, `${prefix}_${suffix}`);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(LEAVES_ROOT, `${prefix}_${suffix}`);
      if (!fs.existsSync(dest)) {
        await fs.promises.mkdir(LEAVES_ROOT, { recursive: true });
        await fs.promises.rename(src, dest);
      } else {
        await fs.promises.unlink(src).catch(() => {});
      }
    }
  }
}

async function installSpecies(speciesId) {
  const profile = FOREST_SPECIES_TEXTURE_PROFILES[speciesId];
  if (!profile) {
    console.warn(`skip ${speciesId}: no texture profile`);
    return;
  }

  const family = SEEDTHREE_FAMILIES[profile.sourceFamily];
  if (!family) throw new Error(`unknown SeedThree family for ${speciesId}`);

  const outPrefix = speciesTexturePrefix(speciesId);
  const barkDir = path.join(BARK_ROOT, speciesId);
  const { barkPrefix, leafStem } = family;

  const barkPairs = [
    [`assets/bark/${barkPrefix}_albedo.png`, `${outPrefix}_albedo.png`, profile.bark ?? null],
    [`assets/bark/${barkPrefix}_normal.png`, `${outPrefix}_normal.png`, null],
    [`assets/bark/${barkPrefix}_roughness.png`, `${outPrefix}_roughness.png`, null],
  ];

  const leafPairs = [
    [`assets/leaves/${leafStem}_albedo.png`, `${outPrefix}_needle_albedo.png`, profile.leaf ?? {}],
    [`assets/leaves/${leafStem}_normal.png`, `${outPrefix}_needle_normal.png`, null],
    [`assets/leaves/${leafStem}_roughness.png`, `${outPrefix}_needle_roughness.png`, null],
    [`assets/leaves/${leafStem}_translucency.png`, `${outPrefix}_needle_translucency.png`, profile.leaf ?? null],
  ];

  for (const [relPath, outName, proc] of barkPairs) {
    const raw = await download(relPath);
    const needsProc = proc && (
      proc.hue != null || proc.saturation != null || proc.brightness != null || proc.scale
    );
    const buffer = needsProc ? await processRaster(raw, proc) : raw;
    await writeFile(path.join(barkDir, outName), buffer);
  }

  for (const [relPath, outName, proc] of leafPairs) {
    const raw = await download(relPath);
    const needsProc = proc && (
      proc.hue != null || proc.saturation != null || proc.brightness != null || proc.scale
    );
    const buffer = needsProc ? await processRaster(raw, proc) : raw;
    await writeFile(path.join(LEAVES_ROOT, outName), buffer);
  }

  for (const suffix of NEEDLE_SUFFIXES) {
    const stray = path.join(barkDir, `${outPrefix}_${suffix}`);
    await fs.promises.unlink(stray).catch(() => {});
  }

  console.log(`installed ${speciesId} (bark → public, leaves → data/forest-leaves)`);
}

await migrateNeedlesFromBarkDirs();

for (const speciesId of FOREST_SPECIES_ORDER) {
  await installSpecies(speciesId);
}

console.log(`Forest textures: bark → ${BARK_ROOT}, leaves → ${LEAVES_ROOT}`);
