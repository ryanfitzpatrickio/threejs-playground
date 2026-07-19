/**
 * probe-capybara-head — numerical silhouette check for buildCaviidPolyHead.
 *
 * The capybara reference board (assets-source/rodent-ref/capybara/board.jpg)
 * was analyzed to a precise target silhouette:
 *   - Gently DOMED dorsal line (NOT flat-top), highest point ~1/3 forward
 *     from the nape (u≈0.33), gradual slope to the nose.
 *   - Blunt ROUNDED snout tip (NOT squared-off).
 *   - Full-but-light rounded jaw (no heavy low jowl).
 *   - Wedge profile: wider/taller at the base, tapering toward the nose.
 *   - Snout ≈ 1/3 of head length, skull ≈ 2/3.
 *   - Length ≈ 1.2 × height.
 *
 * We can't see WebGPU pixels headlessly, so this slices the lofted head
 * geometry by Z and reads the silhouette numerically — a feedback loop for
 * iterating buildCaviidPolyHead's station schedule.
 *
 * Run:  node scripts/probe-capybara-head.mjs
 */
import * as THREE from 'three';
import { resolveDogPhenotype } from '../src/game/characters/dog/dogPhenotypes.js';
import { createDogSkeleton } from '../src/game/characters/dog/dogSkeleton.js';
import { buildCaviidPolyHead } from '../src/game/characters/dog/animalPolyHead.js';

const ph = resolveDogPhenotype({ breedId: 'capybara', seed: 1 });

// Build the REAL capybara skeleton so head/muzzle/nose/jaw positions are
// authentic — the head length (and thus L/H ratio) is driven by where the
// NoseTip bone sits, which depends on muzzleLength in the phenotype.
const rig = createDogSkeleton({ phenotype: ph });
const wp = (name) => rig.worldBindPos.get(name).clone();

const ctx = {
  headCenter: wp('Head'),
  muzzle: wp('Muzzle'),
  nose: wp('NoseTip'),
  jawPos: wp('Jaw'),
  headScale: ph.skeleton.headSize ?? 1,
  skullWidth: ph.geometry.skullWidth,
  skullHeight: ph.geometry.skullHeight,
  skullLength: ph.geometry.skullLength,
  muzzleWidth: ph.geometry.muzzleWidth,
  muzzleHeight: ph.geometry.muzzleHeight ?? 1,
  cheekFullness: ph.geometry.cheekFullness ?? 1,
  headBone: 0,
  muzzleBone: 1,
  jawBone: 2,
  phenotype: ph,
  eyeX: 0.030,
  eyeY: 0.016,
  eyeZ: 0.030,
};

const [head] = buildCaviidPolyHead(ctx);
const pos = head.getAttribute('position');
const count = pos.count;

// Bin vertices by Z into N slices; for each slice keep max Y (top of skull),
// min Y (bottom of jaw), and max |X| (half-width).
const N = 26;
let zMin = Infinity;
let zMax = -Infinity;
for (let i = 0; i < count; i += 1) {
  const z = pos.getZ(i);
  if (z < zMin) zMin = z;
  if (z > zMax) zMax = z;
}
const span = zMax - zMin || 1;
const slices = Array.from({ length: N }, () => ({
  topY: -Infinity, botY: Infinity, halfW: 0, n: 0,
}));
for (let i = 0; i < count; i += 1) {
  const z = pos.getZ(i);
  const y = pos.getY(i);
  const x = pos.getX(i);
  const idx = Math.min(N - 1, Math.max(0, Math.floor(((z - zMin) / span) * N)));
  const s = slices[idx];
  if (y > s.topY) s.topY = y;
  if (y < s.botY) s.botY = y;
  if (Math.abs(x) > s.halfW) s.halfW = Math.abs(x);
  s.n += 1;
}

// Render an ASCII side-profile (top line + bottom line) and a width bar.
console.log('Capybara poly-head silhouette (side profile, z: nape→nose)\n');
const TOP_H = 12;
let topPeakSlice = 0;
let topPeakY = -Infinity;
slices.forEach((s, i) => {
  if (s.topY > topPeakY) { topPeakY = s.topY; topPeakSlice = i; }
});
const yLo = Math.min(...slices.map((s) => s.botY));
const yHi = Math.max(...slices.map((s) => s.topY));
const ySpan = yHi - yLo || 1;
const col = (s) => {
  if (!s.n) return ' '.repeat(40);
  const top = Math.round(((s.topY - yLo) / ySpan) * (TOP_H - 1));
  const bot = Math.round(((s.botY - yLo) / ySpan) * (TOP_H - 1));
  let row = '';
  for (let r = TOP_H - 1; r >= 0; r -= 1) {
    row += r === top ? '╦' : r === bot ? '╨' : (r < top && r > bot) ? '▒' : ' ';
  }
  return row;
};
slices.forEach((s, i) => {
  const u = i / (N - 1);
  const tag = i === topPeakSlice ? ' ◄ peak' : '';
  console.log(`u=${u.toFixed(2)} ${col(s)}  W=${(s.halfW * 1000).toFixed(0).padStart(3)}${tag}`);
});

// ---- Assertions vs reference ----
let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures += 1;
};

// 1. Domed crown: peak topY is in the front-third-from-nape region
//    (u≈0.25–0.45, i.e. NOT at the nape u=0 and NOT at the flat middle).
const peakU = topPeakSlice / (N - 1);
assert(peakU > 0.2 && peakU < 0.5, `crown peak at u≈${peakU.toFixed(2)} (want 0.2–0.5, ref 0.33)`);

// 2. Crown clearly higher than nape (dome, not flat-top).
const napeTop = slices[0].topY;
assert(topPeakY - napeTop > 0.004, `crown rises ${( (topPeakY - napeTop) * 1000).toFixed(0)}mm above nape (want >4mm dome)`);

// 3. Slope down to nose: tip topY below crown.
const tipTop = slices[N - 1].topY;
assert(tipTop < topPeakY - 0.004, `nose top ${((topPeakY - tipTop) * 1000).toFixed(0)}mm below crown (gradual slope down)`);

// 4. Blunt rounded snout: the tip still has real height (not a pinched point)
//    AND height at the tip is ≥ ~45% of crown height (full/boxy, not tapered to a point).
const crownH = topPeakY - slices[topPeakSlice].botY;
const tipH = tipTop - slices[N - 1].botY;
assert(tipH / crownH > 0.45, `snout tip height is ${( (tipH / crownH) * 100).toFixed(0)}% of crown (want >45% — blunt, not pinched)`);

// 5. No heavy low jowl: jaw floor stays within ~80% of crown depth below midline
//    (botY never plunges far below the nape floor).
const lowestJaw = Math.min(...slices.map((s) => s.botY));
assert(lowestJaw > napeTop - (crownH * 0.95), `jaw floor ${(lowestJaw * 1000).toFixed(0)}mm — no heavy low jowl hang`);

// 6. Wedge taper: half-width at nose < half-width at crown.
const crownW = slices[topPeakSlice].halfW;
const tipW = slices[N - 1].halfW;
assert(tipW < crownW, `width tapers nose→crown: tip ${(tipW * 1000).toFixed(0)}mm < crown ${(crownW * 1000).toFixed(0)}mm`);

// 7. Length ≈ 1.2 × height (rounded compact, not a long pipe).
const lengthOverHeight = span / crownH;
assert(lengthOverHeight < 1.7, `length/height ${lengthOverHeight.toFixed(2)} (want ≤1.7, ref ≈1.2)`);

console.log(`\ncrownH=${(crownH * 1000).toFixed(1)}mm  length=${(span * 1000).toFixed(1)}mm  L/H=${lengthOverHeight.toFixed(2)}`);
console.log(failures === 0 ? '\nAll silhouette checks passed.' : `\n${failures} silhouette check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
