/**
 * Forest perf checklist — run in browser console while driving through a forest zone.
 * Usage: node scripts/probe-forest-perf.mjs [url]
 */
import assert from 'node:assert/strict';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';

const res = await fetch(url);
const html = await res.text();
if (!html.includes('__DREAMFALL_DEBUG__')) {
  console.warn('Page has no __DREAMFALL_DEBUG__ hook — load a world map with forest zones in-browser first.');
  process.exit(0);
}

console.log(`Forest perf probe: open ${url}, drive through a forest zone, then inspect:`);
console.log('');
console.log('Counters (city snapshot):');
console.log('  window.__DREAMFALL_DEBUG__.city.forestTrees      — total placements');
console.log('  window.__DREAMFALL_DEBUG__.city.forestNear       — LOD1/LOD2 near-band trees');
console.log('  window.__DREAMFALL_DEBUG__.city.forestImpostors  — impostor billboards');
console.log('  window.__DREAMFALL_DEBUG__.city.forestRebinMs    — last LOD rebin CPU ms (keep < 3)');
console.log('  window.__DREAMFALL_DEBUG__.city.forestNearRadius — real-tree radius (m)');
console.log('  window.__DREAMFALL_DEBUG__.city.forestFarRadius   — impostor cutoff (m)');
console.log('');
console.log('Healthy targets:');
console.log('  forestNear + forestImpostors < forestTrees');
console.log('  forestRebinMs < 3 ms on high, < 6 ms on ultra');
console.log('  forestNearRadius 145 (high) / 180 (ultra) after reload');
console.log('');
console.log('If FPS tanks in forest:');
console.log('  - Drop quality to high (shadows off on foliage)');
console.log('  - Lower forestTreeBudget in qualityPresets.js');
console.log('  - Check ultra shadow clipmap + SSAO (bigger wins than forest LOD)');
assert.ok(true);
