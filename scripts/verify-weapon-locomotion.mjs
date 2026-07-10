#!/usr/bin/env node
/**
 * M2 regression: the shared weapon-locomotion resolver only ever emits state
 * keys that exist in the animation manifest, across the full (kind × stance ×
 * aiming × 8 direction × tier × grounded × turn) truth table. Closes the loop
 * with verify-weapon-loco-manifest.mjs (manifest→files); this is resolver→manifest.
 */
import assert from 'node:assert/strict';
import { MARA_ANIMATION_MANIFEST } from '../src/game/characters/mara/maraAnimationManifest.js';
import {
  resolveWeaponLocomotionState,
  weaponLocoJumpState,
  normalizeWeaponLocoKind,
  locomotionDirToken,
} from '../src/game/characters/player/weaponLocomotion.js';

const has = (state) => Object.prototype.hasOwnProperty.call(MARA_ANIMATION_MANIFEST, state);

// Kind normalization contract.
assert.equal(normalizeWeaponLocoKind('shotgun'), 'rifle');
assert.equal(normalizeWeaponLocoKind('bullpup'), 'rifle');
assert.equal(normalizeWeaponLocoKind('revolver'), 'pistol');
assert.equal(normalizeWeaponLocoKind('greatsword'), null);
assert.equal(normalizeWeaponLocoKind(null), null);

// Direction tokens.
assert.equal(locomotionDirToken(0, 0), null);
assert.equal(locomotionDirToken(1, 0), 'fwd');
assert.equal(locomotionDirToken(-1, 0), 'bwd');
assert.equal(locomotionDirToken(0, 1), 'right');
assert.equal(locomotionDirToken(1, 1), 'fwd_right');
assert.equal(locomotionDirToken(-1, -1), 'bwd_left');

const AXES = [-1, -0.5, 0, 0.5, 1];
let checked = 0;
for (const kind of ['rifle', 'pistol', 'shotgun']) {
  for (const stance of ['stand', 'crouch']) {
    for (const aiming of [false, true]) {
      for (const sprinting of [false, true]) {
        for (const grounded of [false, true]) {
          for (const turning of [null, 'left', 'right']) {
            for (const forward of AXES) {
              for (const strafe of AXES) {
                const res = resolveWeaponLocomotionState({
                  weaponKind: kind, stance, aiming, sprinting, grounded, turning, forward, strafe,
                });
                assert.ok(res, `resolver returned null for ${kind}`);
                assert.ok(has(res.state), `resolver emitted missing state "${res.state}" (${kind}/${stance}/aim=${aiming}/f=${forward}/s=${strafe}/g=${grounded}/turn=${turning})`);
                const expectFacing = aiming ? 'aim' : 'velocity';
                assert.equal(res.facingMode, expectFacing, `facingMode mismatch for aiming=${aiming}`);
                checked += 1;
              }
            }
          }
        }
      }
    }
  }
}

// Jump helper.
for (const kind of ['rifle', 'pistol', 'shotgun']) {
  for (const phase of ['up', 'loop', 'down', 'default']) {
    const s = weaponLocoJumpState(kind, phase);
    assert.ok(has(s), `jump state "${s}" missing for ${kind}/${phase}`);
  }
}
assert.equal(weaponLocoJumpState('greatsword'), null);

// Spot-check the intended mappings.
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'rifle', forward: 1, strafe: -1 }).state, 'rifle_run_fwd_left');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'rifle', forward: 1, sprinting: true }).state, 'rifle_sprint_fwd');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'rifle', stance: 'crouch', forward: 1 }).state, 'rifle_crouch_walk_fwd');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'rifle', aiming: true }).state, 'rifle_aim_idle');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'rifle', turning: 'right' }).state, 'rifle_turn_right');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'pistol', strafe: 1 }).state, 'pistol_strafe_right');
assert.equal(resolveWeaponLocomotionState({ weaponKind: 'pistol', forward: 1, sprinting: true }).state, 'pistol_run_fwd');

console.log(`verify-weapon-locomotion: ${checked} resolver outputs all resolve to manifest states`);
