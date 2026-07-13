// Pure-node guard for gun limb-sever planes + classification.
//
// Guns must map hits to the same survivable partial outcomes as the sword
// (head / armL / armR / legL / legR / both-legs crawl) and must NEVER author a
// torso bisect plane. Split-in-half stays sword-only.
//
// Run: node scripts/verify-gun-limb-sever.mjs
// Alias: npm run verify:gun-limb-sever

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GUN_SEVER_REGIONS,
  analyzeSeveredRegions,
  buildLimbSeverPlane,
  canGunSeverRegion,
  classifyGunHitLimbRegion,
  createSoldierLimbState,
  decideSoldierCutOutcome,
  getSoldierKeepSideSign,
} from '../src/game/systems/soldierPartialCut.js';

function makeEnemy({ yaw = 0 } = {}) {
  const model = new THREE.Group();
  const bones = {};
  function bone(name, x, y, z, parent) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    (parent || model).add(b);
    bones[name] = b;
    return b;
  }
  const hips = bone('mixamorigHips', 0, 1.0, 0);
  const spine = bone('mixamorigSpine', 0, 0.15, 0, hips);
  const spine1 = bone('mixamorigSpine1', 0, 0.15, 0, spine);
  const neck = bone('mixamorigNeck', 0, 0.2, 0, spine1);
  const head = bone('mixamorigHead', 0, 0.12, 0, neck);
  bone('mixamorigHeadTop_End', 0, 0.12, 0, head);
  const lShoulder = bone('mixamorigLeftShoulder', 0.12, 0.18, 0, spine1);
  const lArm = bone('mixamorigLeftArm', 0.18, 0, 0, lShoulder);
  const lFore = bone('mixamorigLeftForeArm', 0.28, 0, 0, lArm);
  bone('mixamorigLeftHand', 0.25, 0, 0, lFore);
  const rShoulder = bone('mixamorigRightShoulder', -0.12, 0.18, 0, spine1);
  const rArm = bone('mixamorigRightArm', -0.18, 0, 0, rShoulder);
  const rFore = bone('mixamorigRightForeArm', -0.28, 0, 0, rArm);
  bone('mixamorigRightHand', -0.25, 0, 0, rFore);
  const lUp = bone('mixamorigLeftUpLeg', 0.12, -0.05, 0, hips);
  const lLeg = bone('mixamorigLeftLeg', 0, -0.42, 0, lUp);
  const lFoot = bone('mixamorigLeftFoot', 0, -0.42, 0.05, lLeg);
  bone('mixamorigLeftToeBase', 0, 0, 0.12, lFoot);
  bone('mixamorigLeftToe_End', 0, 0, 0.06, bones.mixamorigLeftToeBase);
  const rUp = bone('mixamorigRightUpLeg', -0.12, -0.05, 0, hips);
  const rLeg = bone('mixamorigRightLeg', 0, -0.42, 0, rUp);
  const rFoot = bone('mixamorigRightFoot', 0, -0.42, 0.05, rLeg);
  bone('mixamorigRightToeBase', 0, 0, 0.12, rFoot);
  bone('mixamorigRightToe_End', 0, 0, 0.06, bones.mixamorigRightToeBase);
  model.rotation.y = yaw;
  model.updateMatrixWorld(true);
  return {
    model,
    collisionHeight: 1.85,
    limbLossProfile: 'mixamo-humanoid',
    limbLoss: createSoldierLimbState(),
    cutCount: 0,
  };
}

function assertSingleRegionPartial(enemy, region, cutCount = 0) {
  const plane = buildLimbSeverPlane(enemy, region);
  assert.ok(plane, `plane for ${region}`);
  // Guns never author a near-horizontal waist splitter.
  assert.ok(Math.abs(plane.normal.y) <= 0.62 + 1e-6 || region === 'head',
    `${region} plane too horizontal (waist risk)`);

  const keepSign = getSoldierKeepSideSign(enemy, plane);
  const severed = analyzeSeveredRegions(enemy, plane, keepSign);
  assert.equal(severed.core, false, `${region}: core`);
  assert.equal(severed[region], true, `${region}: target not severed`);
  for (const other of GUN_SEVER_REGIONS) {
    if (other === region) continue;
    assert.equal(severed[other], false, `${region}: also severed ${other}`);
  }

  const outcome = decideSoldierCutOutcome({
    enemy,
    plane,
    limbLoss: enemy.limbLoss,
    cutCount,
  });
  assert.equal(outcome.mode, 'partial', `${region}: mode ${outcome.mode}/${outcome.reason}`);
  if (region === 'head') {
    assert.equal(outcome.locomotion, 'head');
  } else {
    assert.equal(outcome.locomotion, 'limb');
  }
  return outcome;
}

// ── planes ────────────────────────────────────────────────────────────────
for (const yaw of [0, 0.7, -1.2, Math.PI]) {
  const enemy = makeEnemy({ yaw });
  for (const region of GUN_SEVER_REGIONS) {
    assertSingleRegionPartial(enemy, region);
  }
}
console.log('ok: single-region planes (incl. rotated)');

// ── both legs → crawl ─────────────────────────────────────────────────────
{
  const enemy = makeEnemy();
  const o1 = assertSingleRegionPartial(enemy, 'legL', 0);
  enemy.limbLoss = o1.nextLoss;
  enemy.cutCount = 1;
  const plane = buildLimbSeverPlane(enemy, 'legR');
  const o2 = decideSoldierCutOutcome({
    enemy,
    plane,
    limbLoss: enemy.limbLoss,
    cutCount: 1,
  });
  assert.equal(o2.mode, 'partial', o2.reason);
  assert.equal(o2.locomotion, 'crawl', o2.reason);
  assert.equal(o2.nextLoss.legL, false);
  assert.equal(o2.nextLoss.legR, false);
  console.log('ok: second leg → crawl');
}

// ── classification ────────────────────────────────────────────────────────
{
  const enemy = makeEnemy();
  assert.equal(classifyGunHitLimbRegion(enemy, { x: 0, y: 1.75, z: 0 }, 'head'), 'head');
  assert.equal(classifyGunHitLimbRegion(enemy, { x: 0, y: 1.15, z: 0 }, 'body'), 'body');
  assert.equal(classifyGunHitLimbRegion(enemy, { x: 0.55, y: 1.35, z: 0 }, 'limb'), 'armL');
  assert.equal(classifyGunHitLimbRegion(enemy, { x: -0.55, y: 1.35, z: 0 }, 'limb'), 'armR');
  assert.equal(classifyGunHitLimbRegion(enemy, { x: 0.15, y: 0.2, z: 0 }, 'limb'), 'legL');
  assert.equal(canGunSeverRegion(enemy, 'armL'), true);
  enemy.limbLoss.armL = false;
  assert.equal(canGunSeverRegion(enemy, 'armL'), false);
  console.log('ok: classify + canGunSeverRegion');
}

console.log('PASS: gun limb-sever contract holds (no bisect; all disability regions).');
