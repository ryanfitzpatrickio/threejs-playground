#!/usr/bin/env node
/**
 * probe-dog-front-leg — diagnose the front-leg rest-pose silhouette.
 *
 * Prints the side-profile (Y up, +Z forward) world positions of the front-leg
 * chain plus the chest/brisket, and derives the segment angles that decide
 * whether the leg reads as a correctly-angulated dog foreassembly vs a swept-
 * back stilt. Pure node: imports the skeleton directly.
 *
 *   node scripts/probe-dog-front-leg.mjs [breedId]
 */
import { createDogSkeleton } from '../src/game/characters/dog/dogSkeleton.js';
import { resolveDogPhenotype } from '../src/game/characters/dog/dogPhenotypes.js';

const breedId = process.argv[2] ?? 'golden-retriever';
const phenotype = resolveDogPhenotype({ breedId, seed: 1 });
const rig = createDogSkeleton({ phenotype });
const wp = (name) => rig.worldBindPos.get(name).clone();

const chain = ['ShoulderL', 'UpperArmL', 'ForearmL', 'PasternL', 'PawL'];
const labels = ['shoulder top', 'elbow', 'wrist(carpus)', 'pastern/fetlock', 'paw'];

console.log(`\n=== ${breedId} front-left leg side profile (Y up, +Z forward) ===`);
const pts = chain.map((n) => wp(n));
for (let i = 0; i < chain.length; i += 1) {
  const p = pts[i];
  console.log(`  ${labels[i].padEnd(18)} ${chain[i].padEnd(10)} Y=${p.y.toFixed(4)}  Z=${p.z.toFixed(4)}`);
}

// Segment angle from vertical: atan2(dZ, -dY). Positive = leans FORWARD, negative = leans BACK.
function segAngle(a, b) {
  const dY = b.y - a.y;
  const dZ = b.z - a.z;
  return Math.atan2(dZ, -dY) * 180 / Math.PI;
}
console.log('\n  segment angles from vertical (+ = forward lean, − = back lean):');
console.log(`    upper arm  (shoulder→elbow): ${segAngle(pts[0], pts[1]).toFixed(1)}°`);
console.log(`    forearm    (elbow→wrist)  : ${segAngle(pts[1], pts[2]).toFixed(1)}°   ← should be ~0° (vertical)`);
console.log(`    pastern    (wrist→fetlock): ${segAngle(pts[2], pts[3]).toFixed(1)}°   ← should be +12..18° (forward)`);
console.log(`    paw        (fetlock→paw)  : ${segAngle(pts[3], pts[4]).toFixed(1)}°`);

// Relative fore/aft of each joint vs the shoulder (Z).
console.log('\n  fore/aft vs shoulder (ΔZ; + = ahead of shoulder, − = behind):');
for (let i = 1; i < pts.length; i += 1) {
  console.log(`    ${labels[i].padEnd(18)} ΔZ=${(pts[i].z - pts[0].z).toFixed(4)}`);
}

// Brisket depth vs elbow: does the chest bottom reach the elbow?
const chest = wp('Chest');
console.log(`\n  Chest bone Y=${chest.y.toFixed(4)} Z=${chest.z.toFixed(4)}  (elbow Y=${pts[1].y.toFixed(4)} Z=${pts[1].z.toFixed(4)})`);
console.log(`  elbow is ${((chest.y - pts[1].y) * 100).toFixed(1)} cm below Chest bone`);
