// CPU generators for the cloud noise textures (analysis §4.1).
//
// `generateBaseShape3D` produces the 3-channel Worley "base shape" volume whose
// R/G/B are three frequency bands of inverted multi-octave Worley noise. The
// density shader combines them additively for the base mass and subtractively
// for erosion (analysis §4.2). `generateWeatherMap` produces a 2D RGBA coverage
// map (R = FBM coverage + detail, B = precipitation) for the large-scale cloud
// distribution.
//
// These run synchronously on the provider thread at init. For dims=32 it is
// sub-100 ms; dims=64 ~1 s. M6 can move generation to a worker or ship
// pre-baked blobs. Mip levels are NOT generated here (LinearFilter, base level
// only) — distance-LOD arrives with the temporal pass (M3/M6).

import * as THREE from 'three';
import { Data3DTexture } from 'three/webgpu';

const WORLEY_WEIGHTS = [0.625, 0.25, 0.125];

function hash3(x, y, z) {
  let n = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  // `^=` yields a *signed* int32; coerce back to unsigned before dividing, or
  // `a` lands in [-0.5, 0.5) instead of [0, 1). valueNoise2 (the weather map's
  // coverage FBM) uses only this first component, so the signed range collapsed
  // weather.r to ~0 everywhere and starved every low-coverage cloud preset.
  n = (n ^ (n >>> 16)) >>> 0;
  const a = n / 4294967296;
  const m = Math.imul(n, 2246822519) >>> 0;
  const b = m / 4294967296;
  const m2 = Math.imul(m, 3266489917) >>> 0;
  return [a, b, m2 / 4294967296];
}

// F1 Worley: distance to the nearest feature point, in cell units, clamped to
// [0,1]. Periodic in `cells` so the volume tiles seamlessly.
function worleyF1(u, v, w, cells) {
  const px = u * cells, py = v * cells, pz = w * cells;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const fx = px - ix, fy = py - iy, fz = pz - iz;
  let minSq = 8;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = (((iz + dz) % cells) + cells) % cells;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = (((iy + dy) % cells) + cells) % cells;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = (((ix + dx) % cells) + cells) % cells;
        const h = hash3(cx, cy, cz);
        const ax = fx - (dx + h[0]);
        const ay = fy - (dy + h[1]);
        const az = fz - (dz + h[2]);
        const d = ax * ax + ay * ay + az * az;
        if (d < minSq) minSq = d;
      }
    }
  }
  return Math.min(Math.sqrt(minSq), 1);
}

// Build the RGB base-shape 3D texture. Each channel is an independent 3-octave
// inverted Worley field at a rising frequency band (low/mid/high → R/G/B).
export function generateBaseShape3D(dims) {
  const size = Math.max(8, Math.floor(dims));
  const base = Math.max(2, Math.round(size / 16));
  const clampCell = (c) => Math.min(Math.max(2, c), size);
  // Adjacent channels share octave frequencies. Evaluate the five unique
  // fields once per voxel instead of evaluating nine fields; this cuts ultra's
  // synchronous 64³ startup work by roughly 44% without changing the texture.
  const cells = [1, 2, 4, 8, 16].map((factor) => clampCell(base * factor));

  const data = new Uint8Array(size * size * size * 4);
  let p = 0;
  for (let z = 0; z < size; z++) {
    const w = z / size;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const f0 = worleyF1(u, v, w, cells[0]);
        const f1 = worleyF1(u, v, w, cells[1]);
        const f2 = worleyF1(u, v, w, cells[2]);
        const f3 = worleyF1(u, v, w, cells[3]);
        const f4 = worleyF1(u, v, w, cells[4]);
        data[p] = toByte(1 - (WORLEY_WEIGHTS[0] * f0 + WORLEY_WEIGHTS[1] * f1 + WORLEY_WEIGHTS[2] * f2));
        data[p + 1] = toByte(1 - (WORLEY_WEIGHTS[0] * f1 + WORLEY_WEIGHTS[1] * f2 + WORLEY_WEIGHTS[2] * f3));
        data[p + 2] = toByte(1 - (WORLEY_WEIGHTS[0] * f2 + WORLEY_WEIGHTS[1] * f3 + WORLEY_WEIGHTS[2] * f4));
        data[p + 3] = 255;
        p += 4;
      }
    }
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.name = 'cloud.baseShape';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// --- 2D weather map ----------------------------------------------------------

// Value noise whose integer lattice wraps modulo `period`, so the field tiles
// seamlessly over a [0, period)-cell domain. The weather DataTexture uses
// RepeatWrapping; without this the non-periodic lattice left a hard coverage
// seam (Δ≈0.33) every `weatherScale` metres — a straight line across the sky.
function valueNoise2(x, y, seed, period) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const wrap = (i) => ((i % period) + period) % period;
  const h = (sx, sy) => hash3(wrap(ix + sx), wrap(iy + sy), seed)[0];
  const a = h(0, 0), b = h(1, 0), c = h(0, 1), d = h(1, 1);
  const ux = fade(fx), uy = fade(fy);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}
const fade = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// Tileable FBM over the unit domain: octave i covers `period` lattice cells
// across [0,1], so wrapping that octave modulo `period` makes the whole sum
// periodic on [0,1] (requires integer periods — true for lacunarity 2).
// `basePeriod` must be >= 2: a period-1 base octave wraps to a single cell and
// goes constant, flattening the large-scale coverage. Constant offsets to x/y
// stay periodic because they shift the wrapped lattice by whole cells.
function fbm2(x, y, seed, octaves, lacunarity = 2, gain = 0.5, basePeriod = 2) {
  let sum = 0, amp = 1, period = basePeriod, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * period, y * period, seed + i * 101, period);
    norm += amp;
    amp *= gain;
    period *= lacunarity;
  }
  return sum / norm;
}

// R = coverage (mainMass FBM recentered + detail), B = precipitation FBM.
export function generateWeatherMap(size, seed = 0) {
  const s = Math.max(32, Math.floor(size));
  const data = new Uint8Array(s * s * 4);
  let p = 0;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = x / s, v = y / s;
      const mainMass = fbm2(u, v, seed, 5, 2, 0.5);
      const detail = fbm2(u + 7.3, v + 3.1, seed + 1, 6, 2, 0.5);
      const coverage = (mainMass - 0.5) * 1.3 + 0.5 + (detail - 0.5) * 0.13;
      // Full unit domain (not u*0.5) so precip tiles too; 2 octaves keeps it low-freq.
      const precip = fbm2(u, v, seed + 5, 2, 2, 0.5);
      data[p] = toByte(coverage);
      data[p + 1] = 0;
      data[p + 2] = toByte(precip);
      data[p + 3] = 255;
      p += 4;
    }
  }
  const texture = new THREE.DataTexture(data, s, s);
  texture.name = 'cloud.weather';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function toByte(x) {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
