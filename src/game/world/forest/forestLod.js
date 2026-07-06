import * as THREE from 'three';
import { forestBarkMaterial } from './seedthree/barkMaterial.js';
import { WIND_DIR } from './seedthree/wind.js';
import { cloneImpostorFadeMaterial } from './seedthree/impostor.js';
import { buildForestSpatialIndex, queryForestSpatialIndex } from './forestSpatialIndex.js';

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _yAxis = new THREE.Vector3(0, 1, 0);

const REBIN_INTERVAL_MS = 200;
const REBIN_MOVE_SQ = 225; // 15 m
const DORMANT_MARGIN = 100; // m beyond farRadius before hiding the whole forest group
// Node-based instanced tree materials can exhaust WebGPU's vertex-buffer slots.
// Three then exposes the instance data through a uniform buffer, whose binding
// limit is commonly 64 KiB. A 512-entry mat4 buffer is 32 KiB and leaves safe
// headroom for the forest's additional per-instance attributes.
import {
  computeFoliageInstancingBudget,
  sampleFoliageSourceIndex,
  MAX_FOREST_FOLIAGE_INSTANCES,
} from './forestFoliageBudget.js';
import { createHeroForestPool } from './forestHero.js';

const MAX_INSTANCES_PER_DRAW = MAX_FOREST_FOLIAGE_INSTANCES;

function smoothstep01(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function hasSameSlots(previous, next) {
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function touchInstancedBounds(im) {
  if (!im?.isInstancedMesh || im.count <= 0) return;
  im.computeBoundingSphere();
}

function forestBoundsFromPlacements(placements) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function distSqOutsideBounds(x, z, bounds) {
  const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
  const dz = z < bounds.minZ ? bounds.minZ - z : z > bounds.maxZ ? z - bounds.maxZ : 0;
  return dx * dx + dz * dz;
}

function stripInstancedAttributes(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (geo.attributes[name].isInstancedBufferAttribute) {
      geo.deleteAttribute(name);
    }
  }
}

function cloneLodInstancedMesh(sourceChild, capacity, bark = false) {
  capacity = Math.min(capacity, MAX_INSTANCES_PER_DRAW);
  const geo = sourceChild.geometry.clone();
  stripInstancedAttributes(geo);
  geo.userData.forestClone = true;
  geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  const mat = bark ? forestBarkMaterial(sourceChild.material) : sourceChild.material;
  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.frustumCulled = true;
  im.userData.noCollision = true;
  im.count = 0;
  return im;
}

function cloneFoliageInstancedMesh(sourceChild, treeCapacity) {
  const budget = computeFoliageInstancingBudget(sourceChild.count, treeCapacity);
  if (!budget) return null;

  const { trees: treeCapacityFit, k, srcK, maxInstances } = budget;
  const geo = sourceChild.geometry.clone();
  stripInstancedAttributes(geo);
  geo.userData.forestClone = true;
  geo.setAttribute('aThickness', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances), 1));
  geo.setAttribute('aTreeOrigin', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));
  geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));
  geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));
  const rebuilt = new Set(['aThickness', 'aTreeOrigin', 'aWindVec', 'aAnchorPos']);
  for (const [name, attr] of Object.entries(sourceChild.geometry.attributes)) {
    if (!attr.isInstancedBufferAttribute || rebuilt.has(name)) continue;
    const arr = new attr.array.constructor(maxInstances * attr.itemSize);
    for (let slot = 0; slot < treeCapacityFit; slot += 1) {
      arr.set(attr.array.subarray(0, k * attr.itemSize), slot * k * attr.itemSize);
    }
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, attr.itemSize));
  }
  const im = new THREE.InstancedMesh(geo, sourceChild.material, maxInstances);
  im.frustumCulled = true;
  im.userData.noCollision = true;
  im.userData.k = k;
  im.userData.treeCapacity = treeCapacityFit;
  im.userData.srcMatrices = new Float32Array(k * 16);
  for (let j = 0; j < k; j += 1) {
    sourceChild.getMatrixAt(sampleFoliageSourceIndex(srcK, k, j), _mtx);
    im.userData.srcMatrices.set(_mtx.elements, j * 16);
  }
  im.count = 0;
  return im;
}

function writeSlotWind(bwv, bap, i, slot) {
  const cos = Math.cos(-slot.rotY);
  const sin = Math.sin(-slot.rotY);
  bwv.setXYZ(
    i,
    (WIND_DIR.x * cos + WIND_DIR.z * sin) / slot.scale,
    0,
    (WIND_DIR.z * cos - WIND_DIR.x * sin) / slot.scale,
  );
  bap.setXYZ(i, slot.x, slot.y, slot.z);
}

function foliageInstanceLimit(im) {
  const k = im.userData.k;
  let limit = im.instanceMatrix.count;
  for (const attr of Object.values(im.geometry.attributes)) {
    if (!attr.isInstancedBufferAttribute) continue;
    limit = Math.min(limit, attr.count);
  }
  return { limit, maxTrees: Math.floor(limit / k) };
}

function writeFoliageInstances(im, slots) {
  const k = im.userData.k;
  const snap = im.userData.srcMatrices;
  const orig = im.geometry.attributes.aTreeOrigin;
  const wvec = im.geometry.attributes.aWindVec;
  const apos = im.geometry.attributes.aAnchorPos;
  const { limit, maxTrees } = foliageInstanceLimit(im);
  const activeSlots = slots.length > maxTrees ? slots.slice(0, maxTrees) : slots;
  if (hasSameSlots(im.userData.assignedSlots, activeSlots)) {
    im.count = activeSlots.length * k;
    im.visible = activeSlots.length > 0;
    return;
  }
  const slotMtx = new THREE.Matrix4();
  const cardMtx = new THREE.Matrix4();
  const outMtx = new THREE.Matrix4();
  let flat = 0;
  for (const slot of activeSlots) {
    if (flat >= limit) break;
    _q.setFromAxisAngle(_yAxis, slot.rotY);
    _scale.set(slot.scale, slot.scale, slot.scale);
    _pos.set(slot.x, slot.y, slot.z);
    slotMtx.compose(_pos, _q, _scale);
    const cos = Math.cos(-slot.rotY);
    const sin = Math.sin(-slot.rotY);
    const wvx = (WIND_DIR.x * cos + WIND_DIR.z * sin) / slot.scale;
    const wvz = (WIND_DIR.z * cos - WIND_DIR.x * sin) / slot.scale;
    for (let j = 0; j < k; j += 1) {
      if (flat >= limit) break;
      cardMtx.fromArray(snap, j * 16);
      outMtx.multiplyMatrices(slotMtx, cardMtx);
      im.setMatrixAt(flat, outMtx);
      orig.setXYZ(flat, slot.x, slot.y + 6 * slot.scale, slot.z);
      wvec.setXYZ(flat, wvx, 0, wvz);
      apos.setXYZ(flat, slot.x, slot.y, slot.z);
      flat += 1;
    }
  }
  orig.needsUpdate = true;
  wvec.needsUpdate = true;
  apos.needsUpdate = true;
  im.count = flat;
  im.userData.assignedSlots = activeSlots.slice();
  im.instanceMatrix.needsUpdate = true;
  touchInstancedBounds(im);
}

function addLodBuckets(group, lodGroup, capacity, castShadow, namePrefix) {
  const buckets = { branches: null, foliage: [] };
  for (const child of lodGroup.children) {
    if (child.isMesh && !child.isInstancedMesh) {
      buckets.branches = cloneLodInstancedMesh(child, capacity, true);
      buckets.branches.name = `${namePrefix} Bark`;
      buckets.branches.castShadow = castShadow;
      buckets.branches.receiveShadow = castShadow;
      group.add(buckets.branches);
    } else if (child.isInstancedMesh) {
      const im = cloneFoliageInstancedMesh(child, capacity);
      if (!im) continue;
      im.name = `${namePrefix} Foliage`;
      // Cluster foliage NEVER shadows: it sits in WebGPU's >8-vertex-buffer
      // uniform-fallback regime, and rendering its SSS node material (with the
      // wind positionNode) through a depth/shadow pass poisoned the command
      // buffer (GPUValidationError). Hero foliage (vertex-buffer path) is the
      // only opt-in shadow caster — see forestHero.js / forestFoliageShadows.
      im.castShadow = false;
      im.receiveShadow = false;
      buckets.foliage.push(im);
      group.add(im);
    }
  }
  return buckets;
}

function addBillboardBuckets(state, entry) {
  const archetype = entry.archetype;
  if (!archetype.impostorGroup || entry.billboards.length) return false;
  entry.impostorHalfH = archetype.impostorHalfH ?? 8;
  const cards = archetype.impostorGroup.children.filter((child) => child.userData?.isBillboardCard);
  for (const card of cards) {
    const material = cloneImpostorFadeMaterial(card.material);
    for (let batchStart = 0; batchStart < entry.capacity; batchStart += MAX_INSTANCES_PER_DRAW) {
      const batchCapacity = Math.min(MAX_INSTANCES_PER_DRAW, entry.capacity - batchStart);
      const geo = card.geometry.clone();
      stripInstancedAttributes(geo);
      geo.userData.forestClone = true;
      geo.setAttribute('aImpostorFade', new THREE.InstancedBufferAttribute(
        new Float32Array(batchCapacity), 1,
      ));
      const im = new THREE.InstancedMesh(geo, material, batchCapacity);
      im.frustumCulled = true;
      im.userData.noCollision = true;
      im.userData.rotY = card.rotation.y;
      im.userData.batchStart = batchStart;
      im.count = 0;
      im.castShadow = false;
      im.receiveShadow = false;
      entry.billboards.push(im);
      state.group.add(im);
    }
  }
  return entry.billboards.length > 0;
}

export function createForestLodState(archetypes, placements, options = {}) {
  const {
    nearCount = 250,
    heroCount = 24,
    heroRadius = 60,
    castShadow = false,
    foliageShadows = false,
    lodMode = 'blend',
  } = options;
  const realOnly = lodMode === 'real';
  const useImpostors = lodMode === 'blend';
  const useHeroes = heroCount > 0;

  const slots = placements.map((p) => ({
    ...p,
    pos: new THREE.Vector3(p.x, p.y, p.z),
  }));

  const byArchetype = new Map();
  for (const p of slots) {
    const list = byArchetype.get(p.archetypeIndex) ?? [];
    list.push(p);
    byArchetype.set(p.archetypeIndex, list);
  }

  const group = new THREE.Group();
  group.name = 'Forest Zone Trees';
  group.userData.noCollision = true;

  // Real full-detail LOD1 hero trees for the closest placements. Renders the
  // single-leaf SeedThree look the instanced buckets can't (512-cap → clusters).
  const heroPool = useHeroes
    ? createHeroForestPool(archetypes, { heroCount, castShadow, foliageShadows })
    : null;
  if (heroPool) group.add(heroPool.group);

  const archBuckets = [];
  for (const archetype of archetypes) {
    const cap = byArchetype.get(archetype.index)?.length ?? 0;
    if (!cap) continue;

    const lod2Cap = realOnly ? cap : Math.min(nearCount, cap);

    const entry = {
      archetype,
      capacity: cap,
      lod2: addLodBuckets(group, archetype.lod2Group, lod2Cap, castShadow, `Forest LOD2 ${archetype.index}`),
      billboards: [],
      impostorHalfH: archetype.impostorHalfH ?? 8,
    };

    if (useImpostors) addBillboardBuckets({ group }, entry);
    archBuckets.push(entry);
  }

  return {
    group,
    slots,
    spatialIndex: buildForestSpatialIndex(slots),
    archBuckets,
    heroPool,
    bounds: forestBoundsFromPlacements(placements),
    lodMode,
    nearCount,
    heroCount,
    heroRadius,
    nearRadius: options.nearRadius ?? 120,
    farRadius: options.farRadius ?? 450,
    fadeBand: options.fadeBand ?? 0.15,
    dormant: false,
    lastCam: new THREE.Vector3(1e9, 0, 0),
    lastRebinAt: 0,
    rebinMs: 0,
    stats: { near: 0, hero: 0, far: 0, culled: 0 },
  };
}

function fillNearBuckets(buckets, slots) {
  const writeBark = (im, list) => {
    if (!im) return;
    const max = im.instanceMatrix.count;
    const active = list.length > max ? list.slice(0, max) : list;
    if (hasSameSlots(im.userData.assignedSlots, active)) {
      im.count = active.length;
      im.visible = active.length > 0;
      return;
    }
    const bwv = im.geometry.attributes.aWindVec;
    const bap = im.geometry.attributes.aAnchorPos;
    active.forEach((slot, i) => {
      _q.setFromAxisAngle(_yAxis, slot.rotY);
      _scale.set(slot.scale, slot.scale, slot.scale);
      _pos.copy(slot.pos);
      _mtx.compose(_pos, _q, _scale);
      im.setMatrixAt(i, _mtx);
      writeSlotWind(bwv, bap, i, slot);
    });
    bwv.needsUpdate = true;
    bap.needsUpdate = true;
    im.count = active.length;
    im.userData.assignedSlots = active.slice();
    im.instanceMatrix.needsUpdate = true;
    im.visible = active.length > 0;
    touchInstancedBounds(im);
  };

  writeBark(buckets.lod2.branches, slots);
  for (const im of buckets.lod2.foliage) writeFoliageInstances(im, slots);

  buckets.lod2.branches && (buckets.lod2.branches.visible = slots.length > 0);
  buckets.lod2.foliage.forEach((m) => { m.visible = slots.length > 0; });

  return slots.length;
}

function fillFarBillboards(billboards, slots, state) {
  if (!billboards.length) return 0;
  const nearWidth = Math.max(1, state.nearRadius * state.fadeBand);
  const nearStart = state.nearRadius - nearWidth;
  const nearEnd = state.nearRadius + nearWidth;
  const farWidth = Math.max(1, state.farRadius * state.fadeBand);
  const farStart = state.farRadius - farWidth;
  for (const im of billboards) {
    const max = im.instanceMatrix.count;
    const start = im.userData.batchStart ?? 0;
    const active = slots.slice(start, start + max);
    const fades = im.geometry.attributes.aImpostorFade;
    const sameSlots = hasSameSlots(im.userData.assignedSlots, active);
    active.forEach((slot, i) => {
      if (!sameSlots) {
        _q.setFromAxisAngle(_yAxis, slot.rotY + (im.userData.rotY ?? 0));
        _scale.set(slot.scale, slot.scale, slot.scale);
        _pos.copy(slot.pos);
        _mtx.compose(_pos, _q, _scale);
        im.setMatrixAt(i, _mtx);
      }
      const nearFade = slot._hasNearLod
        ? smoothstep01((slot._dist - nearStart) / (nearEnd - nearStart))
        : 1;
      const farFade = 1 - smoothstep01((slot._dist - farStart) / farWidth);
      fades.setX(i, nearFade * farFade);
    });
    fades.needsUpdate = true;
    im.count = active.length;
    im.userData.assignedSlots = active.slice();
    if (!sameSlots) im.instanceMatrix.needsUpdate = true;
    im.visible = active.length > 0;
    touchInstancedBounds(im);
  }
  return slots.length;
}

export function rebinForestLod(state, cameraPosition, { force = false } = {}) {
  if (!state || !cameraPosition) return state?.stats;

  const dormantDist = state.farRadius + DORMANT_MARGIN;
  const outside = distSqOutsideBounds(cameraPosition.x, cameraPosition.z, state.bounds) > dormantDist * dormantDist;
  if (outside) {
    if (!state.dormant) {
      state.group.visible = false;
      state.dormant = true;
    }
    return state.stats;
  }
  if (state.dormant) {
    state.group.visible = true;
    state.dormant = false;
    force = true;
  }

  const now = performance.now();
  if (!force && now - state.lastRebinAt < REBIN_INTERVAL_MS
    && cameraPosition.distanceToSquared(state.lastCam) < REBIN_MOVE_SQ) {
    return state.stats;
  }

  const t0 = performance.now();
  state.lastRebinAt = now;
  state.lastCam.copy(cameraPosition);

  let near = [];
  let far = [];
  let culled = 0;
  const realOnly = state.lodMode === 'real';

  const candidates = queryForestSpatialIndex(
    state.spatialIndex,
    cameraPosition.x,
    cameraPosition.z,
    state.farRadius,
  );
  for (const slot of candidates) {
    slot._dist = cameraPosition.distanceTo(slot.pos);
    if (slot._dist > state.farRadius) {
      culled += 1;
    }
  }

  culled += state.slots.length - candidates.length;

  if (realOnly) {
    near = candidates.filter((slot) => slot._dist <= state.farRadius);
  } else {
    const nearWidth = Math.max(1, state.nearRadius * state.fadeBand);
    const nearStart = state.nearRadius - nearWidth;
    const nearEnd = state.nearRadius + nearWidth;
    const missingImpostors = new Set(
      state.archBuckets
        .filter((bucket) => bucket.billboards.length === 0)
        .map((bucket) => bucket.archetype.index),
    );
    // LOD quality must follow camera distance, not deterministic placement order.
    // Keep clusters through the overlap band so the incoming billboard reaches
    // full opacity before the heavier representation disappears.
    near = candidates
      .filter((slot) => slot._dist <= nearEnd || missingImpostors.has(slot.archetypeIndex))
      .sort((a, b) => a._dist - b._dist)
      .slice(0, state.nearCount);
    const nearSet = new Set(near);
    for (const slot of candidates) {
      if (slot._dist > state.farRadius) continue;
      slot._hasNearLod = nearSet.has(slot);
      if (!slot._hasNearLod || slot._dist >= nearStart) far.push(slot);
    }
  }

  // Hero set is GLOBAL across archetypes (one shared pool of `heroCount` real
  // trees): the closest placements within heroRadius, nearest first. Everything
  // else inside nearRadius falls through to the instanced LOD2 cluster buckets.
  const heroSet = new Set();
  const heroList = [];
  if (state.heroPool) {
    const sortedNear = [...near].sort((a, b) => a._dist - b._dist);
    for (const s of sortedNear) {
      if (heroList.length >= state.heroCount) break;
      if (s._dist > state.heroRadius) break;
      heroList.push(s);
      heroSet.add(s);
    }
    state.heroPool.assign(heroList);
  }
  const nearMinusHero = heroSet.size ? near.filter((s) => !heroSet.has(s)) : near;

  let nearTotal = 0;
  let farTotal = 0;

  const byArch = new Map();
  for (const slot of nearMinusHero) {
    const list = byArch.get(slot.archetypeIndex) ?? [];
    list.push(slot);
    byArch.set(slot.archetypeIndex, list);
  }
  const farByArch = new Map();
  for (const slot of far) {
    const list = farByArch.get(slot.archetypeIndex) ?? [];
    list.push(slot);
    farByArch.set(slot.archetypeIndex, list);
  }

  for (const buckets of state.archBuckets) {
    const nearSlots = byArch.get(buckets.archetype.index) ?? [];
    nearTotal += fillNearBuckets(buckets, nearSlots);
    farTotal += fillFarBillboards(
      buckets.billboards,
      farByArch.get(buckets.archetype.index) ?? [],
      state,
    );
  }

  state.rebinMs = performance.now() - t0;
  state.stats = { near: nearTotal, hero: heroList.length, far: farTotal, culled };
  return state.stats;
}

export function installForestLodImpostor(state, archetype) {
  if (!state || state.lodMode !== 'blend' || !archetype?.impostorGroup) return false;
  const entry = state.archBuckets.find((bucket) => bucket.archetype.index === archetype.index);
  if (!entry) return false;
  entry.archetype.impostorGroup = archetype.impostorGroup;
  entry.archetype.impostorHalfH = archetype.impostorHalfH;
  if (!addBillboardBuckets(state, entry)) return false;
  rebinForestLod(state, state.lastCam, { force: true });
  return true;
}

export function disposeForestLodState(state) {
  if (!state?.group) return;
  state.heroPool?.dispose();
  const disposedMaterials = new Set();
  state.group.traverse((obj) => {
    if (!obj.isInstancedMesh) return;
    if (obj.geometry?.userData?.forestClone) obj.geometry.dispose();
    if (obj.material?.userData?.forestCloneMaterial && !disposedMaterials.has(obj.material)) {
      disposedMaterials.add(obj.material);
      obj.material.dispose();
    }
    obj.dispose();
  });
}
