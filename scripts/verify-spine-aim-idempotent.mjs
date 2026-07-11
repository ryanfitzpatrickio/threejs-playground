#!/usr/bin/env node
/**
 * Guards the FP spine-aim "wind-up" bug.
 *
 * applySpineAimPitch is an ADDITIVE offset applied after the mixer writes the
 * pose. During a reload the upper-body layer plays a clip that may not re-key the
 * spine, so the bone keeps our previous output. A naive `quaternion.multiply`
 * then compounds each frame (`base × aim^n`) and winds the whole torso up — the
 * player folds into itself / T-poses until a spine-keying clip resumes.
 *
 * This check simulates that exact window: many frames where the "mixer" does NOT
 * re-write the spine bone, and asserts the applied offset stays bounded (does not
 * accumulate) and that a fresh mixer write is still honoured.
 *
 * Usage: node scripts/verify-spine-aim-idempotent.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applySpineAimPitch } from '../src/game/characters/player/firstPersonRig.js';

function makeBone(name) {
  const b = new THREE.Bone();
  b.name = name;
  return b;
}

const spine = makeBone('mixamorigSpine');
const spine1 = makeBone('mixamorigSpine1');
const spine2 = makeBone('mixamorigSpine2');
const bones = [
  { bone: spine, weight: 0.2 },
  { bone: spine1, weight: 0.28 },
  { bone: spine2, weight: 0.35 },
];

// The mixer-written base pose for the spine (some non-trivial idle twist).
const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05, 0.03, -0.04));
function writeMixerBase() {
  for (const { bone } of bones) bone.quaternion.copy(base);
}

const pitch = 0.9; // looking down while reloading

// 1) Single frame: the offset moves the bone off base by a bounded amount.
writeMixerBase();
applySpineAimPitch(bones, pitch);
const oneFrame = spine2.quaternion.angleTo(base);
assert.ok(oneFrame > 1e-3, 'aim offset should tilt the spine');
assert.ok(oneFrame < 0.6, `single-frame offset unexpectedly large (${oneFrame.toFixed(3)} rad)`);

// 2) Reload window: the mixer STOPS re-keying the spine for 90 frames (~1.5 s).
//    Without the idempotent guard this compounds to many radians (visible fold).
for (let f = 0; f < 90; f += 1) {
  // NOTE: no writeMixerBase() — the reload clip leaves the spine untouched.
  applySpineAimPitch(bones, pitch);
}
const wound = spine2.quaternion.angleTo(base);
assert.ok(
  wound < 0.6,
  `spine wound up during reload: ${wound.toFixed(3)} rad off base (should stay ≈ single-frame ${oneFrame.toFixed(3)})`,
);
assert.ok(
  Math.abs(wound - oneFrame) < 1e-4,
  `offset must be identical every un-keyed frame (${oneFrame.toFixed(4)} → ${wound.toFixed(4)})`,
);

// 3) Reload ends: a fresh mixer write must still be honoured (not undone).
const resumedBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0.0, 0.06));
for (const { bone } of bones) bone.quaternion.copy(resumedBase);
applySpineAimPitch(bones, pitch);
const fromResumed = spine2.quaternion.angleTo(resumedBase);
assert.ok(fromResumed > 1e-3, 'aim must apply on top of the resumed clip pose');
assert.ok(fromResumed < 0.6, 'offset from the resumed pose must stay bounded too');
// And it must be applied relative to the NEW base, not the old one.
assert.ok(
  spine2.quaternion.angleTo(base) > fromResumed,
  'resumed pose must not snap back toward the stale reload base',
);

// 4) Pitch 0 on an un-keyed frame cleanly restores the base (no residual tilt).
writeMixerBase();
applySpineAimPitch(bones, pitch);
applySpineAimPitch(bones, 0); // still un-keyed, but aim released
const released = spine2.quaternion.angleTo(base);
assert.ok(released < 1e-4, `releasing aim must return to base (residual ${released.toFixed(5)} rad)`);

console.log('verify-spine-aim-idempotent: all checks passed');
