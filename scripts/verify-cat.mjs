/**
 * verify-cat — guards the bespoke procedural cat ("3cat"), exposed in the
 * catalog as the 3rd feline option "Tortoiseshell (Procedural)" (flag:
 * cat-rig) beside the dog-derived tortoiseshell + khao-manee stubs.
 *
 * Asserts, headless (no renderer):
 *   - createProceduralCat builds skeleton + ring-loft geometry + TSL coat
 *     materials + procedural animation without throwing
 *   - the rig is ~46 bones with the studio landmark bones present
 *   - geometry uses exactly the 8 WebGPU vertex buffers, is non-degenerate,
 *     and carries valid skin weights (sum ≈ 1, no NaN)
 *   - the animation FSM steps every behavior with no NaN in bone world space
 *   - all four paws plant on the ground (min foot-tip y ≈ 0) after a settle
 *   - core bounds stay finite and cat-sized
 *   - the cat opts OUT of the shared dog-bone clip library (stays procedural)
 *
 * Run:  node scripts/verify-cat.mjs
 * npm:  npm run verify:cat
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProceduralCat } from '../src/game/characters/cat/createProceduralCat.js';
import { getDogBreed, isCatRigBreed } from '../src/game/characters/dog/dogCatalog.js';
import { buildCatWhiskers } from '../src/game/characters/cat/catBodyGeometry.js';
import { animalUsesDogClipLibrary } from '../src/game/characters/dog/DogClipPlayer.js';
import { createCatSkeleton, CAT_DIMS } from '../src/game/characters/cat/catSkeleton.js';
import { CAT_FOOT_TIPS, CAT_CLAWS } from '../src/game/characters/cat/catSkeleton.js';
import { CAT_HEAD_LANDMARK_RATIOS, resolveCatHeadLandmarks } from '../src/game/characters/cat/catLandmarks.js';
import { CAT_CLIP_CATALOG } from '../src/game/characters/cat/catAnimation.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

// --- 1. builds end-to-end for the default + a few feline breeds -------------
for (const breedId of ['domestic-shorthair', 'siamese', 'maine-coon', 'bengal']) {
  const cat = createProceduralCat({ breedId, seed: 7, shellCount: 8 });
  assert.ok(cat.root, `${breedId}: root group`);
  assert.equal(cat.rigKind, 'cat', `${breedId}: rigKind cat`);
  assert.equal(cat.phenotype.speciesId, 'felidae', `${breedId}: felidae species`);
  assert.ok(cat.boneCount >= 48 && cat.boneCount <= 56, `${breedId}: ~50 bones (got ${cat.boneCount})`);
  assert.ok(cat.vertexCount > 500, `${breedId}: geometry has verts (${cat.vertexCount})`);
  cat.dispose();
}
ok('createProceduralCat builds default + siamese/maine-coon/bengal');

// --- 1b. catalog: the 3rd feline option routes to this rig ------------------
{
  const entry = getDogBreed('tortoiseshell-procedural');
  assert.ok(entry, 'tortoiseshell-procedural catalog entry exists');
  assert.equal(entry.familyId, 'feline', 'lives in the feline family');
  assert.equal(isCatRigBreed('tortoiseshell-procedural'), true, 'flagged cat-rig');
  assert.equal(isCatRigBreed('tortoiseshell'), false, 'plain tortoiseshell stays dog-derived');
  const cat = createProceduralCat({ breedId: 'tortoiseshell-procedural', seed: 2, shellCount: 4 });
  assert.equal(cat.breedId, 'tortoiseshell-procedural', 'keeps catalog breedId');
  assert.equal(cat.phenotype.speciesId, 'felidae', 'felidae species');
  cat.dispose();
  ok('tortoiseshell-procedural: 3rd feline option, cat-rig flagged, builds');
}

// --- 2. geometry: 8 buffers, non-degenerate, valid skin weights -------------
{
  const cat = createProceduralCat({ breedId: 'domestic-shorthair', seed: 1, shellCount: 4 });
  const g = cat.geometry;
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
  assert.ok(g.boundingSphere && g.boundingSphere.radius > 0.1, 'bounding sphere built');
  cat.dispose();
  ok('geometry: 8 buffers, no NaN, normalized skin weights, indexed');
}

// --- 3. FSM steps every behavior with no NaN in bone world space ------------
{
  const cat = createProceduralCat({ breedId: 'domestic-shorthair', seed: 3, shellCount: 4 });
  cat.animation.setFrozenBlink(true); // determinism
  const behaviors = ['idle', 'walk', 'trot', 'stalk', 'pounce', 'play', 'sit', 'knead', 'groom', 'stretch', 'loaf', 'look', 'lie'];
  const tmp = new THREE.Vector3();
  for (const b of behaviors) {
    cat.animation.setBehavior(b);
    for (let i = 0; i < 40; i += 1) cat.update(1 / 60);
    cat.root.updateMatrixWorld(true);
    let bad = 0;
    cat.rig.bonesByName.forEach((bone) => { bone.getWorldPosition(tmp); if (!finite3(tmp)) bad += 1; });
    assert.equal(bad, 0, `behavior ${b}: finite bone world positions`);
  }
  cat.dispose();
  ok('animation FSM steps all 13 behaviors (incl. play + knead), no NaN bones');
}

// --- 3a2. facial landmarks are ratio-derived (photo-ratio placement) --------
{
  const r = resolveCatHeadLandmarks({
    headCenterY: CAT_DIMS.headCenterY,
    headCenterZ: CAT_DIMS.headCenterZ,
    headScale: CAT_DIMS.headScale,
  });
  // CAT_DIMS face fields must equal the ratio resolver's output (not magic nums).
  for (const k of ['eyeX', 'eyeY', 'eyeZ', 'eyeRadius', 'earBaseX', 'earTipY', 'muzzleTipZ', 'noseZ']) {
    assert.ok(Math.abs(CAT_DIMS[k] - r[k]) < 1e-9, `${k} is ratio-derived (${CAT_DIMS[k]} vs ${r[k]})`);
  }
  // Eyes must sit forward of the head centre and near/above mid-face height.
  assert.ok(r.eyeZ > CAT_DIMS.headCenterZ && r.eyeY > CAT_DIMS.headCenterY - 0.03, 'eyes forward + mid-face');
  assert.ok(CAT_HEAD_LANDMARK_RATIOS.headScale > 0, 'landmark headScale set');
  ok('facial features placed via photo landmark ratios');
}

// --- 3a3. play behavior + clip catalog (harness studio grid) ----------------
{
  const names = CAT_CLIP_CATALOG.map((c) => c.name);
  for (const n of ['Play', 'Knead', 'Stalk', 'Pounce', 'Groom', 'Sleep']) {
    assert.ok(names.includes(n), `clip catalog exposes ${n}`);
  }
  ok('CAT_CLIP_CATALOG drives the harness clip grid (incl. Play/Knead)');
}

// --- 3a4. optional ruff: long-haired breed grows a ruff, shorthair sleek -----
{
  const maine = createProceduralCat({ breedId: 'maine-coon', seed: 1, shellCount: 4 });
  const dsh = createProceduralCat({ breedId: 'domestic-shorthair', seed: 1, shellCount: 4 });
  assert.ok(maine.furUniforms.ruffAmt.value > 0.4, `maine-coon has a ruff (${maine.furUniforms.ruffAmt.value.toFixed(2)})`);
  assert.equal(dsh.furUniforms.ruffAmt.value, 0, 'domestic shorthair is sleek (no ruff)');
  assert.ok(dsh.furUniforms.coatWave.value >= 0, 'coatWave uniform present');
  maine.dispose(); dsh.dispose();
  ok('optional ruff: long-haired breed ruffs up, shorthair stays sleek');
}

// --- 3b. claws: 50-bone rig, protract on pounce vs sheathed on idle --------
{
  assert.equal(createCatSkeleton().boneCount, 50, 'skeleton is 50 bones (4 claw carriers)');
  const cat = createProceduralCat({ breedId: 'domestic-shorthair', seed: 4, shellCount: 6 });
  cat.animation.setFrozenBlink(true);
  const clawBone = CAT_CLAWS[0][0]; // claw_FL
  const parentToe = CAT_CLAWS[0][1];
  const localQ = () => cat.rig.bonesByName.get(clawBone).quaternion.clone();
  cat.animation.setBehavior('idle');
  for (let i = 0; i < 40; i += 1) cat.update(1 / 60);
  const sheathed = localQ();
  cat.animation.setBehavior('pounce');
  for (let i = 0; i < 40; i += 1) cat.update(1 / 60);
  const protracted = localQ();
  assert.ok(cat.rig.bonesByName.get(clawBone), 'claw carrier bone exists');
  assert.ok(cat.rig.bonesByName.get(parentToe), 'claw parent toe exists');
  assert.ok(sheathed.angleTo(protracted) > 0.3, `claws protract on pounce (Δ=${sheathed.angleTo(protracted).toFixed(3)})`);
  cat.dispose();
  ok('retractable claws: 50-bone rig, sheathed↔protracted');
}

// --- 3c. whiskers: skinned ribbon geometry bound to the muzzle -------------
{
  const rig = createCatSkeleton();
  const wg = buildCatWhiskers(rig.boneIndex);
  const pos = wg.getAttribute('position');
  assert.ok(pos && pos.count > 40, `whisker geometry has verts (${pos?.count})`);
  const si = wg.getAttribute('skinIndex');
  const muzzle = rig.boneIndex.get('muzzle');
  let boundToMuzzle = 0;
  for (let i = 0; i < si.count; i += 1) if (si.getX(i) === muzzle) boundToMuzzle += 1;
  assert.equal(boundToMuzzle, si.count, 'every whisker vert is skinned to the muzzle bone');
  let nan = 0;
  for (let i = 0; i < pos.count * 3; i += 1) if (!Number.isFinite(pos.array[i])) nan += 1;
  assert.equal(nan, 0, 'no NaN whisker positions');
  wg.dispose();
  ok('procedural whiskers: muzzle-bound skinned ribbons, no NaN');
}

// --- 4. all four paws plant on the ground after a settle --------------------
{
  const cat = createProceduralCat({ breedId: 'domestic-shorthair', seed: 5, shellCount: 4 });
  cat.animation.setFrozenBlink(true);
  cat.animation.setBehavior('idle');
  for (let i = 0; i < 60; i += 1) cat.update(1 / 60);
  cat.root.updateMatrixWorld(true);
  const tmp = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const name of CAT_FOOT_TIPS) {
    cat.rig.bonesByName.get(name).getWorldPosition(tmp);
    minY = Math.min(minY, tmp.y);
    maxY = Math.max(maxY, tmp.y);
  }
  assert.ok(Math.abs(minY) < 0.02, `lowest paw grounded (minY=${minY.toFixed(4)})`);
  assert.ok(maxY < 0.06, `all paws near the floor (maxY=${maxY.toFixed(4)})`);
  cat.dispose();
  ok('idle settle: four paws plant on the ground');
}

// --- 5. core bounds finite + cat-sized --------------------------------------
{
  const cat = createProceduralCat({ breedId: 'domestic-shorthair', seed: 1, shellCount: 2 });
  cat.animation.setBehavior('idle');
  for (let i = 0; i < 30; i += 1) cat.update(1 / 60);
  const box = cat.animation.getCoreBounds();
  const size = box.getSize(new THREE.Vector3());
  assert.ok(finite3(box.min) && finite3(box.max), 'bounds finite');
  assert.ok(size.x > 0.03 && size.x < 0.4, `width sane (${size.x.toFixed(3)})`);
  assert.ok(size.z > 0.2 && size.z < 1.2, `length sane (${size.z.toFixed(3)})`);
  assert.ok(size.y > 0.15 && size.y < 0.6, `height sane (${size.y.toFixed(3)})`);
  cat.dispose();
  ok('core bounds finite + cat-sized');
}

// --- 6. cat opts out of the shared dog-bone clip library --------------------
{
  const cat = createProceduralCat({ breedId: 'siamese', seed: 1, shellCount: 2 });
  assert.equal(animalUsesDogClipLibrary(cat), false, 'cat uses procedural animation, not dog clips');
  cat.dispose();
  ok('cat opts out of dog clip library (stays procedural)');
}

console.log(`\ncat verify: ${passed} checks passed ✓`);
