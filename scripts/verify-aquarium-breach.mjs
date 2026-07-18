/**
 * Pure-node unit tests for the aquarium Torricelli breach model.
 *
 * Guards:
 *   (a) no holes → no drain
 *   (b) 3 holes drain faster than 1
 *   (c) jet speed decays to 0 as level approaches hole height
 *   (d) level clamps at the lowest hole, never below waterBottomY
 *   (e) hole-coalesce cap (MAX_HOLES_PER_TANK)
 *   (f) top-face hits do not leak
 *
 * Run: node scripts/verify-aquarium-breach.mjs
 * Alias: npm run verify:aquarium-breach
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createBreachModel,
  MAX_HOLES_PER_TANK,
  DEFAULT_HOLE_AREA,
  FACE_HITS_TO_SHATTER,
  classifyFace,
} from '../src/game/world/aquariumBreachModel.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

const WATER_BOTTOM = 0.72;
const WATER_TOP = 6.86;
const WATER_H = WATER_TOP - WATER_BOTTOM;
const INNER = 3.48;
const INNER_AREA = INNER * INNER;

function makeModel(extraTanks = []) {
  return createBreachModel({
    tanks: [
      {
        id: 'tank-a',
        cx: 0,
        cz: 0,
        halfSize: 1.9,
        waterBottomY: WATER_BOTTOM,
        waterTopY: WATER_TOP,
        waterH: WATER_H,
        innerArea: INNER_AREA,
      },
      {
        id: 'tank-b',
        cx: 20,
        cz: 0,
        halfSize: 1.9,
        waterBottomY: WATER_BOTTOM,
        waterTopY: WATER_TOP,
        waterH: WATER_H,
        innerArea: INNER_AREA,
      },
      ...extraTanks,
    ],
  });
}

function sideNormal() {
  return { x: 1, y: 0, z: 0 };
}

function addSideHole(model, tankId, y, opts = {}) {
  return model.addHole(tankId, {
    point: { x: 1.9, y, z: 0 },
    normal: sideNormal(),
    ...opts,
  });
}

// ── (a) no holes → no drain ────────────────────────────────────────────────
{
  const model = makeModel();
  const before = model.getWaterLevel('tank-a');
  for (let i = 0; i < 120; i += 1) model.step(1 / 60);
  assert.equal(model.getWaterLevel('tank-a'), before, 'no holes keeps water full');
  ok('no holes → no drain');
}

// ── (b) 3 holes drain faster than 1 ────────────────────────────────────────
{
  const one = makeModel();
  const three = makeModel();
  addSideHole(one, 'tank-a', 2.0);
  for (let i = 0; i < 3; i += 1) addSideHole(three, 'tank-a', 2.0 + i * 0.05);

  const DT = 1 / 60;
  const SECONDS = 8;
  for (let i = 0; i < SECONDS * 60; i += 1) {
    one.step(DT);
    three.step(DT);
  }
  const dropOne = WATER_TOP - one.getWaterLevel('tank-a');
  const dropThree = WATER_TOP - three.getWaterLevel('tank-a');
  assert.ok(dropOne > 0.05, `single hole should drain some water (drop=${dropOne})`);
  assert.ok(
    dropThree > dropOne * 1.5,
    `3 holes should drain much faster (${dropThree} vs ${dropOne})`,
  );
  ok('3 holes drain faster than 1');
}

// ── (c) jet speed decays to 0 as level approaches hole height ──────────────
{
  const model = makeModel();
  const holeY = 3.0;
  addSideHole(model, 'tank-a', holeY);
  const entry = model._tanks.get('tank-a');
  const hole = entry.holes[0];

  const speedFull = model.jetSpeedForHole(hole, WATER_TOP);
  assert.ok(speedFull > 1, `full head should produce jet speed (got ${speedFull})`);

  const speedNear = model.jetSpeedForHole(hole, holeY + 0.05);
  assert.ok(speedNear > 0 && speedNear < speedFull * 0.3, 'near-hole head is weaker');

  const speedDry = model.jetSpeedForHole(hole, holeY);
  assert.equal(speedDry, 0, 'jet speed is 0 when waterline equals hole');

  const speedBelow = model.jetSpeedForHole(hole, holeY - 0.5);
  assert.equal(speedBelow, 0, 'jet speed is 0 when water is below hole');
  ok('jet speed decays to 0 as level approaches hole height');
}

// ── (d) level clamps at lowest hole, never below waterBottomY ──────────────
{
  const model = makeModel();
  const lowest = 2.5;
  const higher = 4.5;
  addSideHole(model, 'tank-a', lowest);
  addSideHole(model, 'tank-a', higher);

  // Run long enough that drain should settle at lowest hole.
  for (let i = 0; i < 60 * 180; i += 1) model.step(1 / 60);
  const level = model.getWaterLevel('tank-a');
  assert.ok(
    level >= lowest - 1e-3,
    `level should not drop below lowest hole (level=${level}, lowest=${lowest})`,
  );
  assert.ok(
    level <= lowest + 0.05,
    `level should settle near lowest hole (level=${level}, lowest=${lowest})`,
  );
  assert.ok(level >= WATER_BOTTOM, 'level never below waterBottomY');

  // Even with a hole below water bottom (pathological), floor is waterBottomY.
  const model2 = makeModel();
  model2.addHole('tank-a', {
    point: { x: 1.9, y: WATER_BOTTOM - 0.2, z: 0 },
    normal: sideNormal(),
  });
  for (let i = 0; i < 60 * 120; i += 1) model2.step(1 / 60);
  assert.ok(
    model2.getWaterLevel('tank-a') >= WATER_BOTTOM - 1e-6,
    'never drains below waterBottomY',
  );
  ok('level clamps at lowest hole / waterBottomY');
}

// ── (e) hole-coalesce cap ──────────────────────────────────────────────────
{
  const model = makeModel();
  for (let i = 0; i < MAX_HOLES_PER_TANK + 8; i += 1) {
    addSideHole(model, 'tank-a', 1.5 + (i % 10) * 0.15);
  }
  const holes = model.getHoles('tank-a');
  assert.equal(holes.length, MAX_HOLES_PER_TANK, `cap at ${MAX_HOLES_PER_TANK} holes`);
  // Coalesced holes should have absorbed area from ejected oldest entries.
  const totalArea = holes.reduce((s, h) => s + h.holeArea, 0);
  assert.ok(
    totalArea > MAX_HOLES_PER_TANK * DEFAULT_HOLE_AREA,
    `coalesce bumps area (total=${totalArea})`,
  );
  ok('hole-coalesce cap');
}

// ── (f) top-face hits do not leak ──────────────────────────────────────────
{
  const model = makeModel();
  const top = model.addHole('tank-a', {
    point: { x: 0, y: WATER_TOP - 0.1, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
  });
  assert.equal(top.accepted, true, 'top hit accepted for bookkeeping');
  assert.equal(top.isLeak, false, 'top hit is not a leak');

  const before = model.getWaterLevel('tank-a');
  for (let i = 0; i < 120; i += 1) model.step(1 / 60);
  assert.equal(model.getWaterLevel('tank-a'), before, 'top-only holes do not drain');

  // Side hit at same height does leak.
  addSideHole(model, 'tank-a', 3.0);
  for (let i = 0; i < 60; i += 1) model.step(1 / 60);
  assert.ok(model.getWaterLevel('tank-a') < before, 'side hole drains');
  ok('top-face hits do not leak');
}

// ── resolveTankAt + independent tanks ──────────────────────────────────────
{
  const model = makeModel();
  const a = model.resolveTankAt({ x: 0.5, y: 3, z: 0.2 });
  assert.equal(a?.id, 'tank-a');
  const b = model.resolveTankAt({ x: 20.1, y: 3, z: 0 });
  assert.equal(b?.id, 'tank-b');
  assert.equal(model.resolveTankAt({ x: 100, y: 3, z: 0 }), null);

  addSideHole(model, 'tank-a', 2.0);
  for (let i = 0; i < 120; i += 1) model.step(1 / 60);
  assert.ok(model.getWaterLevel('tank-a') < WATER_TOP);
  assert.equal(model.getWaterLevel('tank-b'), WATER_TOP, 'untouched tank stays full');
  ok('resolveTankAt + independent tanks');
}

// ── gameplay-ish: ~3 holes drain meaningfully within a minute ──────────────
{
  const model = makeModel();
  addSideHole(model, 'tank-a', 1.5);
  addSideHole(model, 'tank-a', 2.0);
  addSideHole(model, 'tank-a', 2.5);
  for (let i = 0; i < 60 * 50; i += 1) model.step(1 / 60);
  const fill = model.getFill01('tank-a');
  assert.ok(fill < 0.55, `~3 holes should drain past half in ~50s (fill=${fill})`);
  assert.ok(fill > 0.05, `should not be bone dry too fast (fill=${fill})`);
  ok('gameplay drain rate (~3 holes / ~50s) is in band');
}

// ── structural integrity: one face collapses, water dumps + waterfall ─────
{
  assert.equal(classifyFace(1, 0, 0), '+x');
  assert.equal(classifyFace(-1, 0, 0), '-x');
  assert.equal(classifyFace(0, 0, 1), '+z');
  assert.equal(classifyFace(0, 0.9, 0), null);

  const model = makeModel();
  let shattered = false;
  for (let i = 0; i < FACE_HITS_TO_SHATTER; i += 1) {
    const r = model.addHole('tank-a', {
      point: { x: 1.9, y: 3.0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
    });
    if (r.shattered) shattered = true;
  }
  assert.equal(shattered, true, 'face shatters at hit threshold');
  const faceState = model.getFaceState('tank-a');
  assert.equal(faceState.shatteredFace, '+x');
  assert.equal(faceState.faces['+x'].shattered, true);
  assert.equal(faceState.faces['-x'].shattered, false);

  // Other faces on same tank still intact; second shatter on -x is blocked.
  assert.equal(model.shatterFace('tank-a', '-x'), false, 'only one face per tank collapses');

  const events = model.drainShatterEvents();
  assert.ok(events.some((e) => e.face === '+x'), 'shatter event emitted');

  // Remaining water dumps fast (bone dry in a few seconds, not stuck at hole height).
  for (let i = 0; i < 60 * 8; i += 1) model.step(1 / 60);
  assert.ok(
    model.getWaterLevel('tank-a') <= WATER_BOTTOM + 0.05,
    `shattered tank empties to bottom (level=${model.getWaterLevel('tank-a')})`,
  );

  // Waterfall active while water remains — re-fill via force for waterfall check.
  const model2 = makeModel();
  model2.shatterFace('tank-a', '+z');
  model2.drainShatterEvents();
  // Immediately after shatter with full water, waterfall is live.
  const falls = model2.getActiveWaterfalls();
  assert.equal(falls.length, 1);
  assert.equal(falls[0].face, '+z');
  assert.ok(falls[0].jetSpeed > 1, 'waterfall has dump speed');
  // Bullet jets suppressed on shattered tank.
  assert.equal(model2.getActiveJets().length, 0);
  // Independent tank unaffected.
  assert.equal(model2.getFaceState('tank-b').shatteredFace, null);
  ok('structural face shatter dumps water + emits waterfall');
}

// ── WeaponSystem world-ray gate contract (source-level) ────────────────────
// World hits are required for glass decals + onWorldHit. USE_WORLD_RAY is false
// globally; aquariumBreachSystem.enabled / wantsWorldRay must opt in.
{
  const weaponPath = fileURLToPath(new URL('../src/game/systems/WeaponSystem.js', import.meta.url));
  const src = readFileSync(weaponPath, 'utf8');
  assert.match(src, /aquariumBreachSystem\?\.enabled/, 'WeaponSystem opts into world ray when breach enabled');
  assert.match(src, /aquariumBreachSystem\?\.wantsWorldRay/, 'WeaponSystem opts into world ray via wantsWorldRay');
  assert.match(src, /aquariumBreachSystem\?\.onWorldHit/, 'WeaponSystem notifies breach on world hits');
  ok('WeaponSystem world-ray + onWorldHit seams present');
}

// ── M4 polish surface contracts (source-level) ─────────────────────────────
{
  const levelSrc = readFileSync(
    fileURLToPath(new URL('../src/game/world/createHordeModeLevel.js', import.meta.url)),
    'utf8',
  );
  assert.match(levelSrc, /tankIndex/, 'fish geometry carries tankIndex');
  assert.match(levelSrc, /tankWaterLevels/, 'fish material has tankWaterLevels uniform');
  assert.match(levelSrc, /fishRestY/, 'fish geometry carries fishRestY');

  const jetSrc = readFileSync(
    fileURLToPath(new URL('../src/game/render/createWaterJetRenderer.js', import.meta.url)),
    'utf8',
  );
  assert.match(jetSrc, /addCrackMark|Crack/, 'jet renderer owns glass crack marks');
  assert.match(jetSrc, /sampleBallisticPathToFloor|makeStreamCapsuleTexture/, 'jets build continuous ballistic streams');
  assert.match(jetSrc, /createMallWaterHeightfield|floorWater/, 'jets feed meatball floor water heightfield');

  const fieldSrc = readFileSync(
    fileURLToPath(new URL('../src/game/render/createMallWaterHeightfield.js', import.meta.url)),
    'utf8',
  );
  assert.match(fieldSrc, /deposit\(|seep\(/, 'heightfield supports splash deposit + drain seep');
  assert.match(fieldSrc, /laplacian|neighborAverage/, 'heightfield has meatball diffusion/jiggle');

  const sysSrc = readFileSync(
    fileURLToPath(new URL('../src/game/systems/AquariumBreachSystem.js', import.meta.url)),
    'utf8',
  );
  assert.match(sysSrc, /AquariumSprayAudio|sprayAudio/, 'breach system has spray audio');
  assert.match(sysSrc, /createGlassPaneShatter|_applyShatter/, 'breach system shatters glass panes');
  assert.match(sysSrc, /waterfalls: activeWaterfalls/, 'shatter dump uses waterfall ribbons');
  assert.match(sysSrc, /physicsSystem/, 'shatter gets physicsSystem for Rapier shards');

  assert.match(levelSrc, /faceMeshes/, 'level builds per-face glass panes');

  const shatterSrc = readFileSync(
    fileURLToPath(new URL('../src/game/render/createGlassPaneShatter.js', import.meta.url)),
    'utf8',
  );
  assert.match(shatterSrc, /clipGeometryByPlane/, 'glass shatter uses CSG plane clips');
  assert.match(shatterSrc, /createDynamicMeshColliderDesc|RigidBodyDesc\.dynamic/, 'glass shards use Rapier dynamics');
  assert.match(shatterSrc, /impactFracture|impactPoint|radial/, 'shatter is impact-centered, not a grid');

  assert.match(jetSrc, /faceWidth|full-face-width|half \* 2/, 'waterfall ribbon spans full face width');
  ok('polish + structural shatter surfaces present');
}

console.log(`\naquarium-breach verification passed (${passed} checks)`);
