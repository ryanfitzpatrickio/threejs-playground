#!/usr/bin/env node
/**
 * M1 regression: every weapon-locomotion state wired into the Mara animation
 * manifest (rifle_* / pistol_*) points at a normalized FBX that exists on disk.
 * Guards against typos in buildWeaponLocoStates and against the import dirs going
 * stale (rerun `npm run import:loco-packs`). The resolver→manifest direction is
 * covered separately by verify-weapon-locomotion.mjs (M2).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MARA_ANIMATION_MANIFEST } from '../src/game/characters/mara/maraAnimationManifest.js';

const PUBLIC = path.resolve('public');
// 43 rifle_ + 20 pistol_ generated locomotion states, plus one optional reload each.
const EXPECTED = { rifle: 44, pistol: 21 };
const counts = { rifle: 0, pistol: 0 };

for (const [state, entry] of Object.entries(MARA_ANIMATION_MANIFEST)) {
  const kind = state.startsWith('rifle_') ? 'rifle' : state.startsWith('pistol_') ? 'pistol' : null;
  if (!kind) continue;
  counts[kind] += 1;
  assert.ok(entry?.url, `${state} must have a url`);
  const filePath = path.join(PUBLIC, entry.url.replace(/^\//, ''));
  // Optional assets (e.g. reload) may not be dropped in yet — they lazy-fail safely.
  if (entry.optionalAsset && !existsSync(filePath)) continue;
  assert.ok(existsSync(filePath), `${state} -> missing file ${entry.url}`);
  assert.equal(entry.retarget, false, `${state} must load with retarget:false`);
  assert.equal(entry.useBakedClip, false, `${state} must load with useBakedClip:false`);
  // Moving clips must drive locomotion so root motion matches the physics controller.
  const moving = /_(walk|run|sprint|strafe)(_|$)/.test(state);
  if (moving) {
    assert.equal(entry.rootMotion?.drive, 'locomotion', `${state} moving clip must drive locomotion`);
  }
}

for (const kind of Object.keys(EXPECTED)) {
  assert.equal(counts[kind], EXPECTED[kind], `expected ${EXPECTED[kind]} ${kind}_ states, found ${counts[kind]}`);
}

// Pistol-only source-pack corrections: diagonal hips tracks are animation-only
// (the regular movement solver owns translation), and the forward arc source
// files are exported with their left/right labels reversed. Rifle mappings and
// the pistol pure-strafe mapping remain untouched.
for (const tier of ['walk', 'run']) {
  for (const dir of ['fwd_left', 'fwd_right', 'bwd_left', 'bwd_right']) {
    assert.equal(
      MARA_ANIMATION_MANIFEST[`pistol_${tier}_${dir}`].rootMotion?.movementScale,
      0,
      `pistol_${tier}_${dir} must not contribute root motion`,
    );
    assert.equal(
      MARA_ANIMATION_MANIFEST[`pistol_${tier}_${dir}`].loop,
      true,
      `pistol_${tier}_${dir} must remain looped`,
    );
    assert.equal(
      MARA_ANIMATION_MANIFEST[`pistol_${tier}_${dir}`].loopBlend,
      0.12,
      `pistol_${tier}_${dir} must smooth its loop boundary`,
    );
  }
}
for (const tier of ['walk', 'run']) {
  assert.match(MARA_ANIMATION_MANIFEST[`pistol_${tier}_fwd_left`].url, new RegExp(`/${tier}_fwd_right\\.fbx$`));
  assert.match(MARA_ANIMATION_MANIFEST[`pistol_${tier}_fwd_right`].url, new RegExp(`/${tier}_fwd_left\\.fbx$`));
}
assert.match(MARA_ANIMATION_MANIFEST.pistol_strafe_left.url, /\/strafe_left\.fbx$/);
assert.match(MARA_ANIMATION_MANIFEST.pistol_strafe_right.url, /\/strafe_right\.fbx$/);
assert.notEqual(
  MARA_ANIMATION_MANIFEST.rifle_run_fwd_left.rootMotion?.movementScale,
  0,
  'rifle diagonal root motion must remain enabled',
);

console.log(`verify-weapon-loco-manifest: ${counts.rifle} rifle_ + ${counts.pistol} pistol_ states resolve to files`);
