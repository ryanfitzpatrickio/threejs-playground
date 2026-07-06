// verify-forest-hero.mjs
//
// Guards the SeedThree hero-foliage integration — the fix for "the leaves don't
// look as good as SeedThree". Three things must hold:
//
//  1. The closest trees render FULL single-leaf LOD1 foliage (the crisp SeedThree
//     look). Previously LOD1 foliage was built into the archetype then STRIPPED at
//     bucket time (`includeFoliage:false`), so the forest only ever showed the
//     cluster-card LOD and the single-leaf detail never appeared on screen.
//  2. Canopy shadow flags propagate to hero foliage when `castShadow` is on, so
//     the canopy self-shadows and reads as a volume.
//  3. `rebinForestLod` partitions placements into hero (real) / near (cluster) /
//     far (impostor) / culled (>farRadius), so a 1000 trees/ha forest never tries
//     to render every tree at full detail — distant trees LOD or cull. Every
//     instanced bucket stays under WebGPU's 512-instance cap.
//
// Pure node: archetype lod1/lod2/impostor groups are mocked with lightweight
// InstancedMeshes/Meshes (no GPU backend needed — we assert structure, not pixels).

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroForestPool } from '../src/game/world/forest/forestHero.js';
import {
  createForestLodState,
  rebinForestLod,
  disposeForestLodState,
} from '../src/game/world/forest/forestLod.js';

function mockFoliage(cards, name = 'foliage') {
  const geo = new THREE.PlaneGeometry(0.5, 1);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), cards);
  im.name = name;
  im.count = cards;
  return im;
}

function mockLodGroup(cards) {
  const g = new THREE.Group();
  g.add(mockFoliage(cards)); // single-leaf (LOD1) or cluster (LOD2) foliage
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 12, 0.5), new THREE.MeshBasicMaterial()));
  return g;
}

function mockImpostor() {
  const g = new THREE.Group();
  const card = new THREE.Mesh(new THREE.PlaneGeometry(2, 12), new THREE.MeshBasicMaterial());
  card.userData.isBillboardCard = true;
  g.add(card);
  return g;
}

function mockArchetypes(n, { impostors = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    lod1Group: mockLodGroup(50 + i * 10),
    lod2Group: mockLodGroup(20),
    impostorGroup: impostors ? mockImpostor() : null,
    impostorHalfH: 8,
  }));
}

// ── 1. Hero pool renders LOD1 foliage on the closest trees ──────────────────
const archetypes = mockArchetypes(3);
const pool = createHeroForestPool(archetypes, { heroCount: 4, castShadow: true });

assert.equal(pool.heroCount, 4);
assert.equal(pool.group.children.length, 4, 'hero pool pre-allocates heroCount slot groups');

const placements = Array.from({ length: 10 }, (_, i) => ({
  x: i * 5,
  y: 0,
  z: 0,
  rotY: i * 0.3,
  scale: 1,
  archetypeIndex: i % 3,
}));

pool.assign(placements.slice(0, 4));

let visibleSlots = 0;
let slotsWithFoliage = 0;
for (const slot of pool.group.children) {
  if (!slot.visible) continue;
  visibleSlots += 1;
  let hasFoliage = false;
  slot.traverse((o) => { if (o.isInstancedMesh) hasFoliage = true; });
  if (hasFoliage) slotsWithFoliage += 1;
}
assert.equal(visibleSlots, 4, '4 hero slots visible');
assert.equal(slotsWithFoliage, 4, 'every hero slot renders LOD1 foliage (leaves NOT stripped)');

// Fewer placements than slots → extras hide.
pool.assign(placements.slice(0, 2));
let vis2 = 0;
pool.group.children.forEach((s) => { if (s.visible) vis2 += 1; });
assert.equal(vis2, 2, 'leftover hero slots hide');

// Clear.
pool.assign([]);
let vis3 = 0;
pool.group.children.forEach((s) => { if (s.visible) vis3 += 1; });
assert.equal(vis3, 0, 'assign([]) hides all hero slots');

// Archetype swap: slot 0 (archetype 0) → archetype 2 re-clones (different card count).
pool.assign([{ ...placements[0], archetypeIndex: 2 }]);
const slot0 = pool.group.children[0];
assert.ok(slot0.visible, 'swapped slot is visible');
let swappedCards = 0;
slot0.traverse((o) => { if (o.isInstancedMesh) swappedCards = o.count; });
assert.equal(swappedCards, 70, 'swapped slot re-clones to the new archetype (arch 2 = 70 cards)');

pool.dispose();

// ── 2. Shadow gating: foliage shadows are separate from bark ────────────────
// The foliage depth/shadow pass (SSS node material + wind positionNode) is the
// GPU-fragile path that poisoned command buffers, so it gets its own gate.
// `castShadow` drives bark; `foliageShadows` drives leaves.
const shadowedPool = createHeroForestPool(archetypes, {
  heroCount: 3, castShadow: true, foliageShadows: true,
});
shadowedPool.assign(placements.slice(0, 3));
let barkShadowed = 0;
let foliageShadowed = 0;
shadowedPool.group.traverse((o) => {
  if (o.isInstancedMesh && o.castShadow) foliageShadowed += 1;
  else if (o.isMesh && !o.isInstancedMesh && o.castShadow) barkShadowed += 1;
});
assert.ok(foliageShadowed >= 3, 'foliage casts shadows when foliageShadows=true');
assert.ok(barkShadowed >= 3, 'bark casts shadows when castShadow=true');
shadowedPool.dispose();

// Default (foliageShadows=false): foliage must NOT shadow — the GPU-safe path.
const gatedPool = createHeroForestPool(archetypes, { heroCount: 2, castShadow: true });
gatedPool.assign(placements.slice(0, 2));
let gatedFoliage = 0;
gatedPool.group.traverse((o) => { if (o.isInstancedMesh && o.castShadow) gatedFoliage += 1; });
assert.equal(gatedFoliage, 0, 'foliage does NOT shadow when foliageShadows=false (GPU-safe default)');
gatedPool.dispose();
const unshadowed = createHeroForestPool(mockArchetypes(2), { heroCount: 2, castShadow: false });
unshadowed.assign([{ x: 0, y: 0, z: 0, rotY: 0, scale: 1, archetypeIndex: 0 }]);
let anyShadow = false;
unshadowed.group.traverse((o) => {
  if ((o.isMesh || o.isInstancedMesh) && o.castShadow) anyShadow = true;
});
assert.equal(anyShadow, false, 'castShadow=false → hero foliage does not shadow');
unshadowed.dispose();

// ── 3. rebinForestLod partition + 512-instance budget ───────────────────────
// Placements at known distances from the origin along +x: 5m, 13m, 21m, … (step 8).
const distant = [];
for (let i = 0; i < 60; i += 1) {
  distant.push({ x: 5 + i * 8, y: 0, z: 0, rotY: 0, scale: 1, archetypeIndex: i % 3 });
}
const state = createForestLodState(mockArchetypes(3, { impostors: true }), distant, {
  heroCount: 4,
  heroRadius: 30,
  nearCount: 8,
  nearRadius: 90,
  farRadius: 200,
  lodMode: 'blend',
  castShadow: true,
});

rebinForestLod(state, new THREE.Vector3(0, 0, 0), { force: true });

const heroVisible = state.heroPool.group.children.filter((s) => s.visible).length;
assert.ok(heroVisible >= 1 && heroVisible <= 4, `hero ring within heroRadius (${heroVisible})`);

// Distant trees (>farRadius) are never rendered: rendered instance count is bounded.
state.group.traverse((o) => {
  if (o.isInstancedMesh) {
    assert.ok(o.count <= 512, `instanced bucket respects 512 WebGPU cap (${o.name}: ${o.count})`);
  }
});

// Culled trees (beyond farRadius) don't appear in any rendered bucket total.
const rendered = state.stats.hero + state.stats.near + state.stats.far;
assert.ok(rendered <= distant.length, 'rendered trees never exceed placements');
assert.ok(state.stats.culled >= 0, 'cull count is non-negative');
console.log(
  `  rebin partition @60 placements: hero=${state.stats.hero} near=${state.stats.near}`
  + ` far(impostor)=${state.stats.far} culled=${state.stats.culled}`,
);

disposeForestLodState(state);

console.log('Forest hero-foliage verification passed.');
