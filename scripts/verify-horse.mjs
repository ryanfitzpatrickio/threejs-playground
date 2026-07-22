/**
 * verify-horse — guards the bespoke procedural horse ("horse v2"), exposed in
 * the catalog as "Domestic Horse v2 (Procedural)" (flag: horse-rig) beside the
 * v1 dog-skeleton `domestic-horse` phenotype, which must stay untouched.
 *
 * Asserts, headless (no renderer):
 *   - createProceduralHorse builds skeleton + ring-loft geometry + TSL coat
 *     materials + procedural animation without throwing
 *   - the rig is ~120 bones with the full equine chains present (10-vertebra
 *     spine, 7 cervical, 12 caudal, carpus/hock → cannon → fetlock → hoof
 *     legs, jaw/nostril/lip/eyelid face, ears, mane)
 *   - geometry uses exactly the 8 WebGPU vertex buffers, is non-degenerate,
 *     and carries valid skin weights (sum ≈ 1, no NaN)
 *   - the gait/FSM system steps every behavior (walk/trot/canter/gallop,
 *     graze, snort, chew, rest, alert) with no NaN in bone world space
 *   - gait footfall tables are distinct (trot diagonal sync, walk 4-beat)
 *   - all four hooves plant on the ground (min toe y ≈ 0) after a settle
 *   - grazing actually brings the muzzle near the ground
 *   - core bounds stay finite and horse-sized (~1.6 m withers class)
 *   - the horse opts OUT of the shared dog-bone clip library (stays
 *     procedural) while v1 domestic-horse keeps its equid clip routing
 *
 * Run:  node scripts/verify-horse.mjs
 * npm:  npm run verify:horse
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProceduralHorse } from '../src/game/characters/horse/createProceduralHorse.js';
import { getDogBreed, isHorseRigBreed } from '../src/game/characters/dog/dogCatalog.js';
import { animalClipLibraryKind, animalUsesDogClipLibrary } from '../src/game/characters/dog/DogClipPlayer.js';
import {
  createHorseSkeleton,
  HORSE_BONE_DEFS,
  HORSE_CHAINS,
  HORSE_HOOF_TIPS,
  HORSE_DIMS,
} from '../src/game/characters/horse/horseSkeleton.js';
import { HORSE_CLIP_CATALOG } from '../src/game/characters/horse/horseAnimation.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

// --- 1. builds end-to-end ---------------------------------------------------
{
  const horse = createProceduralHorse({ seed: 7, shellCount: 6 });
  assert.ok(horse.root, 'root group');
  assert.equal(horse.rigKind, 'horse', 'rigKind horse');
  assert.equal(horse.phenotype.speciesId, 'equidae', 'equidae species');
  assert.ok(horse.boneCount >= 112 && horse.boneCount <= 130, `~120 bones (got ${horse.boneCount})`);
  assert.ok(horse.vertexCount > 1200, `geometry has verts (${horse.vertexCount})`);
  assert.ok(horse.shells.length === 6, 'shell stack built');
  horse.dispose();
  ok('createProceduralHorse builds end-to-end (~120-bone rig)');
}

// --- 1b. catalog: v2 routes to this rig, v1 stays on the dog skeleton -------
{
  const v2 = getDogBreed('domestic-horse-procedural');
  assert.ok(v2, 'domestic-horse-procedural catalog entry exists');
  assert.equal(v2.familyId, 'equid', 'lives in the equid family');
  assert.equal(isHorseRigBreed('domestic-horse-procedural'), true, 'flagged horse-rig');
  assert.equal(isHorseRigBreed('domestic-horse'), false, 'v1 domestic-horse stays dog-derived');
  const v1 = getDogBreed('domestic-horse');
  assert.ok(v1?.conformationFlags?.includes('horse-clips'), 'v1 keeps the equid clip pack flag');
  const horse = createProceduralHorse({ breedId: 'domestic-horse-procedural', seed: 2, shellCount: 4 });
  assert.equal(horse.breedId, 'domestic-horse-procedural', 'keeps catalog breedId');
  horse.dispose();
  ok('catalog: v2 horse-rig flagged, v1 untouched');
}

// --- 1c. skeleton anatomy: the complex-equine chains are all present --------
{
  const rig = createHorseSkeleton();
  assert.ok(HORSE_BONE_DEFS.length >= 112 && HORSE_BONE_DEFS.length <= 128,
    `bone table ~120 (${HORSE_BONE_DEFS.length})`);
  assert.equal(HORSE_CHAINS.spine.length, 11, '10-vertebra spine chain (+hips)');
  assert.equal(HORSE_CHAINS.neck.length, 7, '7 cervical vertebrae');
  assert.equal(HORSE_CHAINS.tail.length, 12, '12 caudal controls');
  assert.equal(HORSE_CHAINS.foreL.length, 8, 'fore chain scapula→…→hoofTip');
  assert.equal(HORSE_CHAINS.hindL.length, 7, 'hind chain femur→…→hoofTip');
  for (const name of [
    'jaw', 'tongue', 'chin', 'muzzle', 'noseTip', 'lip_upper', 'lip_lower',
    'nostril_L', 'nostril_R', 'eye_L', 'eye_R', 'eyelid_up_L', 'eyelid_low_R',
    'ear_L_1', 'ear_R_1', 'forelock', 'mane_0', 'mane_9', 'chest', 'breast',
    'rib_L_0', 'rib_R_4', 'belly', 'flank_L', 'pelvis_R', 'shoulder_L',
    'haunch_R', 'carpus_L', 'cannon_F_R', 'fetlock_H_L', 'hoof_H_R', 'throat',
  ]) {
    assert.ok(rig.bonesByName.has(name), `bone ${name} present`);
  }
  // studio landmark alias
  assert.ok(rig.bonesByName.get('Head'), 'Head alias for the studio');
  ok('skeleton: ribcage, shoulder/pelvis complexes, 4 full leg chains, expressive face');
}

// --- 2. geometry: 8 buffers, non-degenerate, valid skin weights -------------
{
  const horse = createProceduralHorse({ seed: 1, shellCount: 4 });
  const g = horse.geometry;
  const names = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'furLen', 'groomDir', 'zoneId'];
  for (const n of names) assert.ok(g.getAttribute(n), `attr ${n} present`);
  assert.equal(Object.keys(g.attributes).length, 8, 'exactly 8 vertex buffers (WebGPU cap)');

  const pos = g.getAttribute('position');
  let nan = 0;
  for (let i = 0; i < pos.count * 3; i += 1) if (!Number.isFinite(pos.array[i])) nan += 1;
  assert.equal(nan, 0, 'no NaN positions');

  const sw = g.getAttribute('skinWeight');
  let badWeights = 0;
  for (let i = 0; i < sw.count; i += 1) {
    const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
    if (Math.abs(s - 1) > 1e-3) badWeights += 1;
  }
  assert.equal(badWeights, 0, 'skin weights normalized to 1');

  assert.ok(g.index && g.index.count > 0, 'geometry indexed');
  assert.ok(g.boundingSphere && g.boundingSphere.radius > 0.8, 'horse-sized bounding sphere');
  horse.dispose();
  ok('geometry: 8 buffers, no NaN, normalized skin weights, indexed');
}

// --- 3. FSM steps every behavior with no NaN in bone world space ------------
{
  const horse = createProceduralHorse({ seed: 3, shellCount: 4 });
  horse.animation.setFrozenBlink(true); // determinism
  const behaviors = ['idle', 'graze', 'walk', 'trot', 'canter', 'gallop', 'look', 'snort', 'chew', 'sit'];
  const tmp = new THREE.Vector3();
  for (const b of behaviors) {
    horse.animation.setBehavior(b);
    for (let i = 0; i < 45; i += 1) horse.update(1 / 60);
    horse.root.updateMatrixWorld(true);
    let bad = 0;
    horse.rig.bonesByName.forEach((bone) => { bone.getWorldPosition(tmp); if (!finite3(tmp)) bad += 1; });
    assert.equal(bad, 0, `behavior ${b}: finite bone world positions`);
  }
  horse.dispose();
  ok('gait/FSM steps all 10 behaviors (walk→gallop, graze, snort, chew, rest), no NaN bones');
}

// --- 3b. gaits are distinct: trot syncs diagonals, walk staggers 4 beats ----
{
  const horse = createProceduralHorse({ seed: 4, shellCount: 4 });
  horse.animation.setFrozenBlink(true);
  const tmp = new THREE.Vector3();
  const hoofY = (name) => {
    horse.rig.bonesByName.get(name).getWorldPosition(tmp);
    return tmp.y;
  };
  const sample = (behavior) => {
    horse.animation.setBehavior(behavior);
    for (let i = 0; i < 120; i += 1) horse.update(1 / 60); // settle into the gait
    const series = { FL: [], HR: [], FR: [], HL: [] };
    for (let i = 0; i < 90; i += 1) {
      horse.update(1 / 60);
      horse.root.updateMatrixWorld(true);
      series.FL.push(hoofY('hoofTip_F_L'));
      series.HR.push(hoofY('hoofTip_H_R'));
      series.FR.push(hoofY('hoofTip_F_R'));
      series.HL.push(hoofY('hoofTip_H_L'));
    }
    return series;
  };
  const corr = (a, b) => {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0; let da = 0; let db = 0;
    for (let i = 0; i < n; i += 1) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.max(1e-9, Math.sqrt(da * db));
  };
  const trot = sample('trot');
  const trotDiag = corr(trot.FL, trot.HR);
  assert.ok(trotDiag > 0.7, `trot diagonal couplet FL~HR in phase (r=${trotDiag.toFixed(2)})`);
  const trotLat = corr(trot.FL, trot.FR);
  assert.ok(trotLat < 0, `trot fore pair anti-phase (r=${trotLat.toFixed(2)})`);
  const walk = sample('walk');
  const walkDiag = corr(walk.FL, walk.HR);
  assert.ok(walkDiag < 0.55, `walk is 4-beat, not trot-synced (r=${walkDiag.toFixed(2)})`);
  // hooves actually leave the ground at speed
  const gallop = sample('gallop');
  const gallopLift = Math.max(...gallop.FL) - Math.min(...gallop.FL);
  assert.ok(gallopLift > 0.12, `gallop swing lifts the hoof (${gallopLift.toFixed(3)} m)`);
  horse.dispose();
  ok('gait tables distinct: trot diagonals sync, walk staggers, gallop lifts');
}

// --- 3c. grazing lowers the muzzle to the grass line ------------------------
{
  const horse = createProceduralHorse({ seed: 5, shellCount: 4 });
  horse.animation.setFrozenBlink(true);
  const tmp = new THREE.Vector3();
  horse.animation.setBehavior('idle');
  for (let i = 0; i < 60; i += 1) horse.update(1 / 60);
  horse.rig.bonesByName.get('noseTip').getWorldPosition(tmp);
  const idleMuzzleY = tmp.y;
  horse.animation.setBehavior('graze');
  for (let i = 0; i < 180; i += 1) horse.update(1 / 60);
  horse.rig.bonesByName.get('noseTip').getWorldPosition(tmp);
  const grazeMuzzleY = tmp.y;
  assert.ok(idleMuzzleY > 1.2, `idle muzzle carried high (${idleMuzzleY.toFixed(2)})`);
  assert.ok(grazeMuzzleY < idleMuzzleY - 0.5, `graze drops the muzzle (${grazeMuzzleY.toFixed(2)})`);
  horse.dispose();
  ok('graze: neck/head chain reaches down toward the grass');
}

// --- 3d. clip catalog drives the studio grid --------------------------------
{
  const names = HORSE_CLIP_CATALOG.map((c) => c.name);
  for (const n of ['Idle', 'Graze', 'Walk', 'Trot', 'Canter', 'Gallop', 'Snort', 'Rest']) {
    assert.ok(names.includes(n), `clip catalog exposes ${n}`);
  }
  const horse = createProceduralHorse({ seed: 1, shellCount: 2 });
  assert.equal(horse.animation.playClip('Canter'), true, 'playClip routes to the FSM');
  assert.equal(horse.animation.getCurrentClip(), 'Canter', 'current clip tracked');
  horse.dispose();
  ok('HORSE_CLIP_CATALOG drives the studio clip grid');
}

// --- 4. all four hooves plant on the ground after a settle ------------------
{
  const horse = createProceduralHorse({ seed: 5, shellCount: 4 });
  horse.animation.setFrozenBlink(true);
  horse.animation.setBehavior('idle');
  for (let i = 0; i < 60; i += 1) horse.update(1 / 60);
  horse.root.updateMatrixWorld(true);
  const tmp = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const name of HORSE_HOOF_TIPS) {
    horse.rig.bonesByName.get(name).getWorldPosition(tmp);
    minY = Math.min(minY, tmp.y);
    maxY = Math.max(maxY, tmp.y);
  }
  assert.ok(Math.abs(minY) < 0.02, `lowest hoof grounded (minY=${minY.toFixed(4)})`);
  assert.ok(maxY < 0.06, `all hooves near the floor (maxY=${maxY.toFixed(4)})`);
  horse.dispose();
  ok('idle settle: four hooves plant on the ground');
}

// --- 5. core bounds finite + horse-sized ------------------------------------
{
  const horse = createProceduralHorse({ seed: 1, shellCount: 2 });
  horse.animation.setBehavior('idle');
  for (let i = 0; i < 30; i += 1) horse.update(1 / 60);
  const box = horse.animation.getCoreBounds();
  const size = box.getSize(new THREE.Vector3());
  assert.ok(finite3(box.min) && finite3(box.max), 'bounds finite');
  assert.ok(size.z > 1.6 && size.z < 3.2, `length sane (${size.z.toFixed(2)})`);
  assert.ok(size.y > 1.4 && size.y < 2.4, `height sane (${size.y.toFixed(2)})`);
  assert.ok(HORSE_DIMS.withersY > 1.4 && HORSE_DIMS.withersY < 1.8, 'withers in the riding-horse band');
  horse.dispose();
  ok('core bounds finite + horse-sized');
}

// --- 6. v2 opts out of the shared clip packs; v1 keeps equid routing --------
{
  const horse = createProceduralHorse({ seed: 1, shellCount: 2 });
  assert.equal(animalUsesDogClipLibrary(horse), false, 'v2 stays procedural (no clip pack)');
  assert.equal(animalClipLibraryKind(horse), null, 'clip kind null for horse-rig');
  assert.equal(
    animalClipLibraryKind({ breedId: 'domestic-horse' }), 'equid',
    'v1 domestic-horse still routes to the equid clip pack',
  );
  horse.dispose();
  ok('v2 opts out of dog/equid clip libraries; v1 routing unchanged');
}

console.log(`\nhorse verify: ${passed} checks passed ✓`);
