// verify-office-glass.mjs — M2 glass tier checks (docs/office-interior-fidelity-2-plan.md).
// Run: npm run verify:office-glass

import {
  createOfficeGlassMaterial,
  getOfficeGlassMaterial,
} from '../src/game/world/office/officeGlassMaterial.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

try {
  const high = createOfficeGlassMaterial({ quality: 'high' });
  const ultra = createOfficeGlassMaterial({ quality: 'ultra' });
  if (high.userData.officeGlassTier === 'fresnel' && high.transmission === 0) ok('high tier uses fresnel opacity fake');
  else fail('high glass tier', `tier=${high.userData.officeGlassTier} tx=${high.transmission}`);
  if (ultra.userData.officeGlassTier === 'transmission' && ultra.transmission > 0) ok('ultra tier enables transmission');
  else fail('ultra glass tier', `tier=${ultra.userData.officeGlassTier} tx=${ultra.transmission}`);
  if (ultra.roughness >= 0.35 && ultra.roughness <= 0.45) ok('ultra roughness in sandblast range');
  else fail('ultra roughness', String(ultra.roughness));
  if (high.side === 2) ok('glass uses DoubleSide for stable sorting');
  else fail('glass side', String(high.side));
  if (high.colorNode != null && ultra.colorNode != null) ok('glass TSL colorNode builds under node');
  else fail('glass colorNode');
} catch (err) {
  fail('glass material construct', err.message);
}

try {
  const cached = getOfficeGlassMaterial({ quality: 'high' });
  if (cached.userData.officeGlass) ok('getOfficeGlassMaterial caches');
  else fail('glass cache');
} catch (err) {
  fail('glass getter', err.message);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll office-glass checks passed.');
