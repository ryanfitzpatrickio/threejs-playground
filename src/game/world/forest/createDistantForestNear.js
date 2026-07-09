/**
 * Infinite-terrain SeedThree forest ring.
 *
 * Prairie shelterbelt placement — linear tree breaks along field edges, like
 * farm windbreaks on the plains (not scattered noise forest). Full forest LOD
 * chain only: hero (LOD1) → near LOD2 clusters → far impostor billboards.
 *
 * Impostors bake lazily (same path as forest zones). Until a bake lands, those
 * instances stay on LOD2 so the ring never goes empty.
 */

import * as THREE from 'three';
import { buildForestArchetypes } from './forestArchetypes.js';
import {
  createForestLodState,
  disposeForestLodState,
  installForestLodImpostor,
  rebinForestLod,
} from './forestLod.js';
import { buildForestSpatialIndex } from './forestSpatialIndex.js';
import { syncForestEnvironment } from './forestEnvironment.js';

// Prairie field / shelterbelt metrics (metres, world-stable).
const FIELD_SPACING = 150;   // typical field width between breaks
const TREE_SPACING = 7.5;    // spacing along a break
const BELT_JITTER = 1.8;     // lateral wobble so lines aren't laser-straight
const DOUBLE_ROW_GAP = 4.5;  // second row offset for double windbreaks
const REBIN_MOVE = 12;
const REBIN_MS = 140;

/**
 * @param {object} opts
 * @param {(wx:number, wz:number) => number} opts.sampleHeight
 * @param {(x:number, z:number) => boolean} [opts.isExcluded]
 * @param {object} [opts.qualityPreset]
 * @param {number} [opts.loadedReach]
 * @param {import('three').WebGPURenderer | null} [opts.renderer]
 * @param {{ x:number, y:number, z:number } | null} [opts.initialCameraPosition]
 */
export async function createDistantForestNear({
  sampleHeight,
  isExcluded = null,
  qualityPreset = {},
  loadedReach = 280,
  renderer = null,
  initialCameraPosition = null,
}) {
  const nearCount = clampInt(qualityPreset.distantForestNearCount ?? 48, 8, 160);
  const heroCount = clampInt(qualityPreset.distantForestHeroCount ?? 10, 0, 32);
  const nearRadius = qualityPreset.distantForestNearRadius
    ?? qualityPreset.forestNearRadius
    ?? 110;
  // Impostor ring should reach the loaded terrain edge so the horizon is SeedThree.
  const farRadius = qualityPreset.distantForestFarRadius
    ?? qualityPreset.forestFarRadius
    ?? Math.max(nearRadius + 80, Math.min(Math.max(96, loadedReach) * 0.96, 520));
  const heroRadius = qualityPreset.distantForestHeroRadius
    ?? Math.min(50, nearRadius * 0.48);
  const species = qualityPreset.distantForestSpecies ?? 'pine';
  const castShadow = qualityPreset.shadows === true;
  const foliageShadows = qualityPreset.forestFoliageShadows === true;
  // How often a field edge gets a tree break (0..1). Lower = more open prairie.
  const breakDensity = qualityPreset.distantForestDensity ?? 0.72;
  // Along-break spacing; tighter packs the horizon wall more solidly.
  const treeSpacing = qualityPreset.distantForestTreeSpacing ?? TREE_SPACING;
  const fieldSpacing = qualityPreset.distantForestFieldSpacing ?? FIELD_SPACING;

  // Pool = near clusters + far impostors. Cap keeps WebGPU instance budgets safe.
  // Linear belts are denser along edges than scatter, so size from perimeter length.
  const poolSize = clampInt(
    qualityPreset.distantForestPoolSize
      ?? Math.max(nearCount * 5, Math.ceil((farRadius * 4) / treeSpacing)),
    nearCount + 16,
    480,
  );

  const pack = await buildForestArchetypes({
    species,
    count: 4,
    speciesSeed: 91,
    castShadow,
    bakeImpostors: false,
    renderer,
  });
  const archetypes = pack.archetypes;
  if (!archetypes.length) return emptyNear();

  // Placeholder placements — positions rewritten every rebin from the world grid.
  const placements = [];
  for (let i = 0; i < poolSize; i += 1) {
    placements.push({
      x: 0,
      y: -1000,
      z: 0,
      rotY: 0,
      scale: 1,
      archetypeIndex: i % archetypes.length,
    });
  }

  const lodState = createForestLodState(archetypes, placements, {
    nearCount,
    nearRadius,
    farRadius,
    heroCount,
    heroRadius,
    castShadow,
    foliageShadows,
    lodMode: 'blend',
    fadeBand: qualityPreset.distantForestFadeBand ?? 0.14,
  });
  lodState.bounds = { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 };
  lodState.group.name = 'Distant Forest SeedThree';

  const group = new THREE.Group();
  group.name = 'Distant Forest Group';
  group.userData.noCollision = true;
  group.add(lodState.group);

  let disposed = false;
  let impostorBakeStatus = renderer ? 'pending' : 'disabled';
  let lastX = Infinity;
  let lastZ = Infinity;
  let lastRebinAt = 0;
  let stats = { near: 0, hero: 0, far: 0, culled: 0, candidates: 0 };
  const _cam = new THREE.Vector3();

  // Lazy impostor bake — same pattern as forest zones. As each archetype lands,
  // billboard buckets come online and far trees fade onto cards.
  if (renderer) {
    requestAnimationFrame(async () => {
      if (disposed) return;
      impostorBakeStatus = 'baking';
      try {
        await pack.ensureImpostors(renderer, {
          onArchetype: (archetype) => {
            if (!disposed) installForestLodImpostor(lodState, archetype);
          },
        });
        if (!disposed) {
          impostorBakeStatus = 'ready';
          // Force rebin so newly installed billboards pick up far slots.
          if (Number.isFinite(lastX)) refill(lastX, lastZ, true);
        }
      } catch (error) {
        impostorBakeStatus = 'error';
        console.warn('[distant-forest] impostor bake failed; keeping LOD2 fallback', error);
      }
    });
  }

  const refill = (cx, cz, force = false) => {
    const moved = Math.hypot(cx - lastX, cz - lastZ);
    const now = performance.now();
    if (!force && Number.isFinite(lastX) && moved < REBIN_MOVE && now - lastRebinAt < REBIN_MS) {
      _cam.set(cx, 0, cz);
      stats = rebinForestLod(lodState, _cam) ?? stats;
      return;
    }
    lastX = cx;
    lastZ = cz;
    lastRebinAt = now;

    const candidates = samplePrairieBreakCandidates({
      cx,
      cz,
      sampleHeight,
      isExcluded,
      radius: farRadius,
      fieldSpacing,
      treeSpacing,
      breakDensity,
      max: poolSize,
      archetypeCount: archetypes.length,
    });
    stats.candidates = candidates.length;

    const slots = lodState.slots;
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      const c = candidates[i];
      if (!c) {
        slot.x = cx + 1e5;
        slot.y = -1000;
        slot.z = cz + 1e5;
        slot.rotY = 0;
        slot.scale = 0.01;
        slot.pos.set(slot.x, slot.y, slot.z);
        continue;
      }
      slot.x = c.x;
      slot.y = c.y;
      slot.z = c.z;
      slot.rotY = c.rotY;
      slot.scale = c.scale;
      slot.archetypeIndex = c.archetypeIndex;
      slot.pos.set(c.x, c.y, c.z);
    }

    lodState.spatialIndex = buildForestSpatialIndex(slots);
    _cam.set(cx, 0, cz);
    stats = rebinForestLod(lodState, _cam, { force: true }) ?? stats;
  };

  if (initialCameraPosition) {
    refill(initialCameraPosition.x, initialCameraPosition.z, true);
  }

  return {
    group,
    nearRadius,
    farRadius,
    update(cameraX, cameraZ, { force = false } = {}) {
      refill(cameraX, cameraZ, force);
    },
    updateEnvironment(env) {
      syncForestEnvironment(env ?? {});
    },
    dispose() {
      disposed = true;
      disposeForestLodState(lodState);
      pack.dispose?.();
      group.clear();
    },
    snapshot: () => ({
      distantForestNear: stats.near ?? 0,
      distantForestHero: stats.hero ?? 0,
      distantForestImpostors: stats.far ?? 0,
      distantForestCandidates: stats.candidates ?? 0,
      distantForestNearRadius: nearRadius,
      distantForestFarRadius: farRadius,
      distantForestImpostorBake: impostorBakeStatus,
      distantForestPoolSize: poolSize,
      ...(pack.snapshot?.() ?? {}),
    }),
  };
}

function emptyNear() {
  return {
    group: null,
    nearRadius: 0,
    farRadius: 0,
    update() {},
    updateEnvironment() {},
    dispose() {},
    snapshot: () => ({
      distantForestNear: 0,
      distantForestHero: 0,
      distantForestImpostors: 0,
    }),
  };
}

/**
 * Prairie shelterbelt candidates — linear tree breaks along field edges.
 *
 * World is partitioned into large rectangular fields. Trees only sit on the
 * parcel boundaries (windbreaks), regularly spaced along each edge, with small
 * lateral jitter, occasional double rows, and deterministic gaps so belts feel
 * farmed rather than a plantation grid.
 */
export function samplePrairieBreakCandidates({
  cx,
  cz,
  sampleHeight,
  isExcluded,
  radius,
  fieldSpacing = FIELD_SPACING,
  treeSpacing = TREE_SPACING,
  breakDensity = 0.72,
  max = 64,
  archetypeCount = 4,
}) {
  const r2 = radius * radius;
  const pad = fieldSpacing;
  const minX = cx - radius - pad;
  const maxX = cx + radius + pad;
  const minZ = cz - radius - pad;
  const maxZ = cz + radius + pad;

  const i0 = Math.floor(minX / fieldSpacing);
  const i1 = Math.ceil(maxX / fieldSpacing);
  const j0 = Math.floor(minZ / fieldSpacing);
  const j1 = Math.ceil(maxZ / fieldSpacing);

  const out = [];
  const tryPush = (wx, wz, salt) => {
    if (out.length >= max * 2) return;
    const dx = wx - cx;
    const dz = wz - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq > r2 || distSq < 4) return;
    if (isExcluded?.(wx, wz)) return;

    const gy = sampleHeight(wx, wz);
    const e = 3;
    const hx = sampleHeight(wx + e, wz) - sampleHeight(wx - e, wz);
    const hz = sampleHeight(wx, wz + e) - sampleHeight(wx, wz - e);
    const flat = (2 * e) / Math.sqrt(hx * hx + 4 * e * e + hz * hz);
    if (flat < 0.42) return;

    const h0 = hash2(Math.round(wx * 2), Math.round(wz * 2) + salt);
    const h1 = hash2(Math.round(wx * 2) + 7, Math.round(wz * 2) + 11 + salt);
    // Mild size variety; squared bias keeps giants rare.
    const scale = 0.72 + h0 * h1 * 0.8;
    out.push({
      x: wx,
      y: gy - 0.25,
      z: wz,
      rotY: hash2(Math.round(wx), Math.round(wz) + 13 + salt) * Math.PI * 2,
      scale,
      archetypeIndex: Math.floor(hash2(Math.round(wx) + 41, Math.round(wz) + 43 + salt) * archetypeCount) % archetypeCount,
      distSq,
    });
  };

  // --- Vertical breaks (N–S windbreaks along field east/west edges) ---
  for (let i = i0; i <= i1; i += 1) {
    // Some field lines are open prairie (no belt) — deterministic skip.
    if (hash2(i, 901) > breakDensity) continue;
    const baseX = i * fieldSpacing;
    // Soft warp of the line so parcels aren't a perfect cadastre.
    const lineWarp = (hash2(i, 17) - 0.5) * 10;
    const doubleRow = hash2(i, 33) > 0.55;
    // Walk Z along this break.
    const zStart = Math.floor(minZ / treeSpacing) * treeSpacing;
    for (let z = zStart; z <= maxZ; z += treeSpacing) {
      // Segment gaps — missing stretches of fence-line trees.
      const seg = Math.floor(z / (treeSpacing * 8));
      if (hash2(i, seg + 501) < 0.18) continue;
      // Occasional single-tree skip for irregularity.
      if (hash2(i * 31 + Math.round(z), 77) < 0.08) continue;

      const lat = (hash2(i, Math.round(z / treeSpacing) + 44) - 0.5) * BELT_JITTER * 2;
      const wx = baseX + lineWarp + lat;
      const wz = z + (hash2(Math.round(z), i + 19) - 0.5) * (treeSpacing * 0.25);
      tryPush(wx, wz, 1);
      if (doubleRow) {
        tryPush(wx + DOUBLE_ROW_GAP, wz + (hash2(i, Math.round(z)) - 0.5) * 1.2, 2);
      }
    }
  }

  // --- Horizontal breaks (E–W along field north/south edges) ---
  for (let j = j0; j <= j1; j += 1) {
    if (hash2(701, j) > breakDensity * 0.9) continue; // slightly fewer E–W belts
    const baseZ = j * fieldSpacing;
    const lineWarp = (hash2(29, j) - 0.5) * 10;
    const doubleRow = hash2(55, j) > 0.62;
    const xStart = Math.floor(minX / treeSpacing) * treeSpacing;
    for (let x = xStart; x <= maxX; x += treeSpacing) {
      const seg = Math.floor(x / (treeSpacing * 8));
      if (hash2(seg + 801, j) < 0.18) continue;
      if (hash2(Math.round(x) + j * 17, 88) < 0.08) continue;

      const lat = (hash2(Math.round(x / treeSpacing) + 44, j) - 0.5) * BELT_JITTER * 2;
      const wx = x + (hash2(Math.round(x), j + 23) - 0.5) * (treeSpacing * 0.25);
      const wz = baseZ + lineWarp + lat;
      tryPush(wx, wz, 3);
      if (doubleRow) {
        tryPush(wx + (hash2(Math.round(x), j) - 0.5) * 1.2, wz + DOUBLE_ROW_GAP, 4);
      }
    }
  }

  // Prefer trees nearest the camera when the pool is full.
  out.sort((a, b) => a.distSq - b.distSq);
  return out.slice(0, max);
}

// Back-compat aliases.
export const sampleGridCandidates = samplePrairieBreakCandidates;
export const sampleNearCandidates = samplePrairieBreakCandidates;

function hash2(x, z) {
  let value = Math.imul(x ^ (z * 374761393), 668265263)
    ^ Math.imul(z ^ (x * 1274126177), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v | 0));
}
