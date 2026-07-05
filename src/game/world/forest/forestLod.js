import * as THREE from 'three';
import { forestBarkMaterial } from './seedthree/barkMaterial.js';
import { WIND_DIR } from './seedthree/wind.js';

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _yAxis = new THREE.Vector3(0, 1, 0);

const REBIN_INTERVAL_MS = 400;
const REBIN_MOVE_SQ = 100; // 10 m
const DORMANT_MARGIN = 100; // m beyond farRadius before hiding the whole forest group

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
  const k = sourceChild.count;
  const maxInstances = treeCapacity * k;
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
    for (let slot = 0; slot < treeCapacity; slot += 1) {
      arr.set(attr.array.subarray(0, k * attr.itemSize), slot * k * attr.itemSize);
    }
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, attr.itemSize));
  }
  const im = new THREE.InstancedMesh(geo, sourceChild.material, maxInstances);
  im.frustumCulled = true;
  im.userData.noCollision = true;
  im.userData.k = k;
  im.userData.treeCapacity = treeCapacity;
  im.userData.srcMatrices = new Float32Array(k * 16);
  for (let j = 0; j < k; j += 1) {
    sourceChild.getMatrixAt(j, _mtx);
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
  im.instanceMatrix.needsUpdate = true;
  touchInstancedBounds(im);
}

function addLodBuckets(group, lodGroup, capacity, castShadow, namePrefix, { includeFoliage = true } = {}) {
  const buckets = { branches: null, foliage: [] };
  for (const child of lodGroup.children) {
    if (child.isMesh && !child.isInstancedMesh) {
      buckets.branches = cloneLodInstancedMesh(child, capacity, true);
      buckets.branches.name = `${namePrefix} Bark`;
      buckets.branches.castShadow = castShadow;
      buckets.branches.receiveShadow = castShadow;
      group.add(buckets.branches);
    } else if (child.isInstancedMesh && includeFoliage) {
      const im = cloneFoliageInstancedMesh(child, capacity);
      im.name = `${namePrefix} Foliage`;
      // Foliage cards are the dominant GPU cost — never cast or receive shadows.
      im.castShadow = false;
      im.receiveShadow = false;
      buckets.foliage.push(im);
      group.add(im);
    }
  }
  return buckets;
}

export function createForestLodState(archetypes, placements, options = {}) {
  const { nearCount = 250, heroCount = 30, castShadow = false, lodMode = 'blend' } = options;
  const realOnly = lodMode === 'real';
  const useImpostors = lodMode === 'blend';

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

  const archBuckets = [];
  for (const archetype of archetypes) {
    const cap = byArchetype.get(archetype.index)?.length ?? 0;
    if (!cap) continue;

    const lod2Cap = realOnly ? cap : Math.min(nearCount, cap);

    const entry = {
      archetype,
      capacity: cap,
      lod1: addLodBuckets(group, archetype.lod1Group, Math.min(heroCount, cap), castShadow, `Forest LOD1 ${archetype.index}`, { includeFoliage: false }),
      lod2: addLodBuckets(group, archetype.lod2Group, lod2Cap, castShadow, `Forest LOD2 ${archetype.index}`),
      billboards: [],
      impostorHalfH: archetype.impostorHalfH ?? 8,
    };

    if (useImpostors && archetype.impostorGroup) {
      const cards = archetype.impostorGroup.children.filter((c) => c.userData?.isBillboardCard);
      for (const card of cards) {
        const geo = card.geometry.clone();
        stripInstancedAttributes(geo);
        const im = new THREE.InstancedMesh(geo, card.material, cap);
        im.frustumCulled = true;
        im.userData.noCollision = true;
        im.userData.rotY = card.rotation.y;
        im.count = 0;
        im.castShadow = false;
        im.receiveShadow = false;
        entry.billboards.push(im);
        group.add(im);
      }
    }
    archBuckets.push(entry);
  }

  return {
    group,
    slots,
    archBuckets,
    bounds: forestBoundsFromPlacements(placements),
    lodMode,
    nearCount,
    heroCount,
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

function fillNearBuckets(buckets, slots, heroCount) {
  const sorted = [...slots].sort((a, b) => a._dist - b._dist);
  const hero = sorted.slice(0, Math.min(heroCount, sorted.length));
  const heroSet = new Set(hero);
  const near = sorted.filter((s) => !heroSet.has(s));

  const writeBark = (im, list) => {
    if (!im) return;
    const max = im.instanceMatrix.count;
    const active = list.length > max ? list.slice(0, max) : list;
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
    im.instanceMatrix.needsUpdate = true;
    im.visible = active.length > 0;
    touchInstancedBounds(im);
  };

  writeBark(buckets.lod1.branches, hero);
  writeBark(buckets.lod2.branches, near);
  const nearBand = hero.length ? [...hero, ...near] : near;
  for (const im of buckets.lod2.foliage) writeFoliageInstances(im, nearBand);

  buckets.lod1.branches?.visible && touchInstancedBounds(buckets.lod1.branches);
  buckets.lod2.branches?.visible && touchInstancedBounds(buckets.lod2.branches);

  buckets.lod1.branches && (buckets.lod1.branches.visible = hero.length > 0);
  buckets.lod2.branches && (buckets.lod2.branches.visible = near.length > 0);
  buckets.lod2.foliage.forEach((m) => { m.visible = nearBand.length > 0; });

  return { hero: hero.length, near: near.length };
}

function fillFarBillboards(billboards, slots) {
  if (!billboards.length) return 0;
  for (const im of billboards) {
    const max = im.instanceMatrix.count;
    const active = slots.length > max ? slots.slice(0, max) : slots;
    active.forEach((slot, i) => {
      _q.setFromAxisAngle(_yAxis, slot.rotY + (im.userData.rotY ?? 0));
      _scale.set(slot.scale, slot.scale, slot.scale);
      _pos.copy(slot.pos);
      _mtx.compose(_pos, _q, _scale);
      im.setMatrixAt(i, _mtx);
    });
    im.count = active.length;
    im.instanceMatrix.needsUpdate = true;
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

  const near = [];
  const far = [];
  let culled = 0;
  const realOnly = state.lodMode === 'real';

  for (const slot of state.slots) {
    slot._dist = cameraPosition.distanceTo(slot.pos);
    if (slot._dist > state.farRadius) {
      culled += 1;
    } else if (realOnly || (slot._dist <= state.nearRadius && near.length < state.nearCount)) {
      near.push(slot);
    } else {
      far.push(slot);
    }
  }

  let heroTotal = 0;
  let nearTotal = 0;
  let farTotal = 0;

  const byArch = new Map();
  for (const slot of near) {
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
    const counts = fillNearBuckets(buckets, nearSlots, state.heroCount);
    heroTotal += counts.hero;
    nearTotal += counts.near;
    farTotal += fillFarBillboards(
      buckets.billboards,
      farByArch.get(buckets.archetype.index) ?? [],
    );
  }

  state.rebinMs = performance.now() - t0;
  state.stats = { near: nearTotal, hero: heroTotal, far: farTotal, culled };
  return state.stats;
}

export function disposeForestLodState(state) {
  if (!state?.group) return;
  state.group.traverse((obj) => {
    if (!obj.isInstancedMesh) return;
    if (obj.geometry?.userData?.forestClone) obj.geometry.dispose();
    obj.dispose();
  });
}
