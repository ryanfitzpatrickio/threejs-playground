// Headless visibility probe for the volumetric cloud-type presets.
//
// The GPU raymarch can't run under Node, but its inputs CAN: cloudNoise.js's
// weather + base-shape generators are plain JS, and sampleCloudDensity (in
// cloudDensity.js) is a straight-line TSL expression we can mirror faithfully in
// JS. This replays the real generated textures, ports the density field, and
// integrates a top-down optical-depth column per XZ cell to estimate how much
// cloud each preset actually renders — so preset tuning has a real, repeatable
// metric instead of eyeballing in the browser.
//
// Metric per preset: `coverage` = fraction of columns whose opacity > 0.08,
// `meanOpacity` = average column opacity. A preset that reads as "grey sky, no
// clouds" lands near coverage 0 / meanOpacity 0.

import { generateBaseShape3D, generateWeatherMap } from '../src/game/render/cloud/cloudNoise.js';
import { resolveCloudTypePreset, listCloudTypePresets } from '../src/game/render/cloud/cloudConfig.js';

const BASE_DIMS = 32;      // provider default (vc.baseShapeDims ?? 32)
const WEATHER_DIMS = 512;  // provider default (vc.weatherMapResolution ?? 512)
const BASE_WEIGHTS = [0.7, 0.41, 0.23];
const EROSION_WEIGHTS = [0.113, 0.04, 0.02];

const baseTex = generateBaseShape3D(BASE_DIMS);
const weatherTex = generateWeatherMap(WEATHER_DIMS, 0);
const baseData = baseTex.image.data;
const weatherData = weatherTex.image.data;

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const wrap01 = (x) => x - Math.floor(x);

// Trilinear sample of the RGB base-shape volume (repeat wrap, LinearFilter,
// texel-centre convention matching the GPU sampler).
function sampleBase(u, v, w) {
  const size = BASE_DIMS;
  const s = (coord) => {
    const p = wrap01(coord) * size - 0.5;
    const i0 = Math.floor(p);
    return [((i0 % size) + size) % size, (((i0 + 1) % size) + size) % size, p - i0];
  };
  const [x0, x1, fx] = s(u);
  const [y0, y1, fy] = s(v);
  const [z0, z1, fz] = s(w);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (x, y, z) => baseData[(z * size * size + y * size + x) * 4 + c] / 255;
    const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
    const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
    const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
    const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[c] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

// Bilinear sample of the weather map's red channel (coverage).
function sampleWeatherR(u, v) {
  const size = WEATHER_DIMS;
  const s = (coord) => {
    const p = wrap01(coord) * size - 0.5;
    const i0 = Math.floor(p);
    return [((i0 % size) + size) % size, (((i0 + 1) % size) + size) % size, p - i0];
  };
  const [x0, x1, fx] = s(u);
  const [y0, y1, fy] = s(v);
  const at = (x, y) => weatherData[(y * size + x) * 4] / 255;
  const c0 = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const c1 = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return c0 * (1 - fy) + c1 * fy;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Faithful JS mirror of cloudDensity.js sampleCloudDensity at rest (windOffset =
// evolution = 0). `s` is the resolved preset shape; erosionScale is derived as
// the provider does.
function density(x, y, z, s, erosionScale) {
  const hf = (y - s.altitude) / s.thickness;
  const wr = sampleWeatherR(x / s.weatherScale, z / s.weatherScale);
  // Height-skew along wind (heading→dir) so taller samples lean, matching shader.
  const skew = s.skew * Math.max(hf, 0);
  const sx = x - s.windDirX * skew;
  const sz = z - s.windDirZ * skew;
  const base = sampleBase(sx / s.baseScale, y / s.baseScale, sz / s.baseScale);
  let baseMass = dot3(base, BASE_WEIGHTS) * s.baseStrength;
  const eroded = sampleBase(sx / erosionScale, y / erosionScale, sz / erosionScale);
  const erosionField = s.erosionShape >= 1 ? eroded : eroded.map((e, i) => e * s.erosionShape + (1 - e) * (1 - s.erosionShape));
  const erosionWeight = s.erosionStrengthBase + (s.erosionStrengthPeak - s.erosionStrengthBase) * hf;
  const erosion = -dot3(erosionField, EROSION_WEIGHTS) * erosionWeight;
  baseMass += erosion;
  const coverageField = wr + (s.coverage - 1) + baseMass * s.coverage;
  const heightMetres = Math.max(hf, 0) * s.thickness * 0.001;
  const softness = Math.max(
    s.edgeSoftness / Math.pow(Math.max(s.edgeSoftnessFalloff, 0.001), heightMetres),
    0.012,
  );
  // Match cloudDensity.js: sub-linear height cut + softer bottoms.
  const heightCut = Math.pow(Math.max(hf, 0), 0.78);
  const top = smoothstep(-softness, softness, coverageField - heightCut);
  const bottom = smoothstep(-softness * 1.35, softness * 1.15, hf - erosion * s.coverage * 1.25);
  return Math.max(top * bottom, 0);
}

const REGION = 30000;   // metres spanned in XZ (covers several weather tiles)
const COLS = 72;        // XZ columns per axis
const HEIGHT_SAMPLES = 28;

function probe(name) {
  const p = resolveCloudTypePreset(name);
  const s = { ...p.shape };
  // Wind heading → XZ direction (matches headingToVector in the provider).
  const h = (s.wind = undefined, p.wind);
  const rad = (h.heading * Math.PI) / 180;
  s.windDirX = Math.sin(rad);
  s.windDirZ = Math.cos(rad);
  s.skew = h.skew;
  const erosionScale = s.baseScale * (s.erosionScaleBaseMultiplier ?? 0.28);
  const extinction = s.density;

  let covered = 0;
  let opacitySum = 0;
  const dz = s.thickness / HEIGHT_SAMPLES;
  for (let ix = 0; ix < COLS; ix++) {
    for (let iz = 0; iz < COLS; iz++) {
      const x = (ix / COLS - 0.5) * REGION;
      const z = (iz / COLS - 0.5) * REGION;
      let od = 0;
      for (let iy = 0; iy < HEIGHT_SAMPLES; iy++) {
        const y = s.altitude + (iy + 0.5) * dz;
        od += density(x, y, z, s, erosionScale) * extinction * dz;
      }
      const opacity = 1 - Math.exp(-od);
      opacitySum += opacity;
      if (opacity > 0.08) covered += 1;
    }
  }
  const total = COLS * COLS;
  return { coverage: covered / total, meanOpacity: opacitySum / total };
}

const rows = listCloudTypePresets().map(({ id, label }) => {
  const { coverage, meanOpacity } = probe(id);
  const flag = coverage < 0.06 ? ' <-- INVISIBLE' : coverage < 0.15 ? ' <-- faint' : '';
  return { id, label, coverage: coverage.toFixed(3), meanOpacity: meanOpacity.toFixed(3), flag };
});

console.log('preset               coverage  meanOpacity');
for (const r of rows) {
  console.log(`${r.id.padEnd(16)} ${String(r.coverage).padStart(8)} ${String(r.meanOpacity).padStart(12)}${r.flag}`);
}

// Regression guard: every cloud type must render *something* (the weather-map
// hash bug regressing would drop these back to ~0). Overhead columns are the
// conservative case — grazing rays toward the horizon only add cover.
const invisible = rows.filter((r) => Number(r.coverage) < 0.06);
if (invisible.length > 0) {
  console.error(`\nINVISIBLE presets: ${invisible.map((r) => r.id).join(', ')}`);
  process.exit(1);
}

// Tileability guard: the weather map is sampled with RepeatWrapping, so its
// coverage channel must be seamless at the wrap boundary. A non-periodic FBM
// regressing here draws a straight coverage seam across the sky every
// `weatherScale` metres. Compare the mean |Δ| across the wrap edge to the mean
// |Δ| between adjacent interior columns.
const R = (x, y) => weatherData[((((y % WEATHER_DIMS) + WEATHER_DIMS) % WEATHER_DIMS) * WEATHER_DIMS + (((x % WEATHER_DIMS) + WEATHER_DIMS) % WEATHER_DIMS)) * 4] / 255;
let seam = 0;
let interior = 0;
for (let y = 0; y < WEATHER_DIMS; y++) {
  seam += Math.abs(R(WEATHER_DIMS - 1, y) - R(0, y));
  interior += Math.abs(R(100, y) - R(101, y));
}
seam /= WEATHER_DIMS;
interior /= WEATHER_DIMS;
console.log(`\nweather-map wrap seam Δ ${seam.toFixed(4)} vs interior Δ ${interior.toFixed(4)}`);
if (seam > interior * 3 + 0.01) {
  console.error('WEATHER MAP NOT SEAMLESS — coverage seam will show as a line across the sky');
  process.exit(1);
}
console.log('probe-cloud-visibility: all presets render clouds + weather map tiles cleanly');
