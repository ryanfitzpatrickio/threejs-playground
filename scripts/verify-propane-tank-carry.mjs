/**
 * Guards propane-tank pickup wiring:
 *   - horde level authors ≥1 propane tank outside static merge
 *   - CarryItemSystem pick up / drop on E (mountPressed)
 *   - AnimationStateSystem has a carrying upper-body branch
 *   - runtime services expose carryItemSystem
 *
 * Run: node scripts/verify-propane-tank-carry.mjs
 * Alias: npm run verify:propane-tank-carry
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createHordeModeLevel } from '../src/game/world/createHordeModeLevel.js';
import { createPropaneTank } from '../src/game/items/createPropaneTank.js';
import { CarryItemSystem } from '../src/game/systems/CarryItemSystem.js';

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log('verify-propane-tank-carry');

test('createPropaneTank builds grips + materials', () => {
  const tank = createPropaneTank({ seed: 1 });
  assert.equal(tank.kind, 'propaneTank');
  assert.ok(tank.height > 0.7 && tank.height < 1.3);
  assert.ok(tank.leftGrip && tank.rightGrip);
  assert.ok(tank.group.userData.noStaticMerge);
  assert.ok(tank.group.children.length >= 8);
  tank.dispose();
});

test('horde level places propane tanks', () => {
  const level = createHordeModeLevel({});
  assert.ok(Array.isArray(level.propaneTanks));
  assert.ok(level.propaneTanks.length >= 1);
  for (const tank of level.propaneTanks) {
    assert.equal(tank.kind, 'propaneTank');
    assert.equal(tank.group.userData.noStaticMerge, true);
    assert.ok(tank.group.parent === level.group);
  }
  const snap = level.snapshot?.();
  assert.equal(snap?.propaneTanks, level.propaneTanks.length);
});

test('CarryItemSystem pickup + drop', () => {
  const level = createHordeModeLevel({});
  const carry = new CarryItemSystem();
  carry.bindLevel({ level });

  const modelRoot = new THREE.Group();
  const spine = new THREE.Group();
  spine.name = 'mixamorigSpine2';
  modelRoot.add(spine);

  const character = {
    group: new THREE.Group(),
    sword: { group: { visible: true } },
    combat: { weapon: 'armed', armed: true, animationOverride: null, attack: null },
    animationController: { modelRoot },
  };
  const tank = level.propaneTanks[0];
  character.group.position.set(tank.group.position.x + 0.4, 0, tank.group.position.z);

  carry.update({ character, input: { mountPressed: true }, movement: {} });
  assert.equal(character.carrying, true);
  assert.equal(carry.held, tank);
  assert.equal(character.combat.armed, false);
  assert.equal(character.sword.group.visible, false);
  assert.equal(tank.group.parent, spine);

  // Simulate Mixamo bone-scale cancel (carry path scales up ~1/parentScale).
  spine.scale.setScalar(0.017);
  carry.postAnimation({ character, delta: 1 / 60 });
  assert.equal(tank.group.parent, spine);
  assert.ok(tank.group.scale.x > 10, 'carry scale cancels tiny spine scale');

  carry.update({ character, input: { mountPressed: true }, movement: {} });
  assert.equal(character.carrying, false);
  assert.equal(carry.held, null);
  assert.equal(tank.group.parent, level.group);
  // Drop must reset the cancel-scale or the tank freezes giant above the player.
  assert.ok(Math.abs(tank.group.scale.x - 1) < 1e-6, `drop scale reset, got ${tank.group.scale.x}`);
  assert.ok(Math.abs(tank.group.scale.y - 1) < 1e-6);
  assert.ok(Math.abs(tank.group.scale.z - 1) < 1e-6);
  assert.ok(tank.group.position.y < 0.5, `drop sits near ground, y=${tank.group.position.y}`);

  carry.dispose();
});

await testAsync('runtime wires carryItemSystem', async () => {
  const services = await readFile(new URL('../src/game/runtime/createRuntimeServices.js', import.meta.url), 'utf8');
  assert.match(services, /CarryItemSystem/);
  assert.match(services, /carryItemSystem/);

  const pipeline = await readFile(new URL('../src/game/runtime/RuntimeFramePipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /carryItemSystem\?\.update/);
  assert.match(pipeline, /carryItemSystem\?\.postAnimation/);

  const loader = await readFile(new URL('../src/game/runtime/RuntimeLoader.js', import.meta.url), 'utf8');
  assert.match(loader, /carryItemSystem\?\.bindLevel/);

  const plan = await readFile(new URL('../src/game/runtime/runtimeFramePlan.js', import.meta.url), 'utf8');
  assert.match(plan, /carry-item/);
  assert.match(plan, /carry-item-attach/);

  const anim = await readFile(new URL('../src/game/systems/AnimationStateSystem.js', import.meta.url), 'utf8');
  assert.match(anim, /character\.carrying/);
  assert.match(anim, /armedIdle/);
  assert.match(anim, /carryHold/);
});

console.log('PASS: propane-tank-carry');
