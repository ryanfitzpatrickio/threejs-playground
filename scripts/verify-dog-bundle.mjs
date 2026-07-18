// Phase-keyed independence check for the standalone dog product build
// (docs/dog-park-standalone-deploy-plan.md §7.1). Runs against an already
// built dist-dog/ (`npm run build:dog` chains this in after `vite build`).
//
// Phase "studio": disk allowlist + size budgets + forbidden playground
// fingerprints (App.jsx/GameRuntime/simoutfits/etc must never enter the JS).
// Phase "park": disk allowlist + size budgets + no App.jsx in the module
// graph; dormant kernel source strings are allowed (K9/K14) — the runtime
// fetch contract (§5.4) is a separate promotion-gate probe, not part of this
// script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDogAssetManifest,
  walkFiles,
  formatMiB,
  checkDogBundleBudgets,
  findExtraDistFiles,
  DOG_BUILD_MODULES_META_PATH,
} from '../vite/dogDeployAssetsPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const distRoot = path.join(ROOT, 'dist-dog');
const manifestPath = path.join(ROOT, 'deploy', 'dog-asset-manifest.json');

assert.ok(fs.existsSync(distRoot), `dist-dog/ not found — run "npm run build:dog" first (looked at ${distRoot})`);
const manifest = readDogAssetManifest(manifestPath);
assert.ok(['studio', 'park'].includes(manifest.phase), `manifest "phase" must be studio|park, got ${manifest.phase}`);

// --- A. Entry HTML -----------------------------------------------------
const indexHtmlPath = path.join(distRoot, 'index.html');
assert.ok(fs.existsSync(indexHtmlPath), 'dist-dog/index.html missing — Workers Static Assets needs "/" to resolve');

// --- B. Disk allowlist + size budgets (both phases) ---------------------
const extras = findExtraDistFiles(distRoot, manifest);
assert.equal(
  extras.length,
  0,
  `non-allowlisted files present in dist-dog/ (publicDir re-enabled? plugin writing untracked paths?):\n  - ${extras.join('\n  - ')}`,
);

const { totalBytes, largestJsChunk, errors: budgetErrors } = checkDogBundleBudgets(distRoot, manifest);
assert.equal(budgetErrors.length, 0, `budget check failed:\n${budgetErrors.join('\n')}`);
console.log(`[verify-dog-bundle] total ${formatMiB(totalBytes)}, largest JS chunk ${formatMiB(largestJsChunk)} (phase=${manifest.phase})`);

// --- C. Module graph (both phases: App.jsx must never enter the graph) --
assert.ok(
  fs.existsSync(DOG_BUILD_MODULES_META_PATH),
  `module graph metadata missing at ${DOG_BUILD_MODULES_META_PATH} — dogDeployAssetsPlugin generateBundle did not run`,
);
const moduleIds = JSON.parse(fs.readFileSync(DOG_BUILD_MODULES_META_PATH, 'utf8'));
const forbidModulePaths = manifest.verify?.forbidModulePaths || [];
for (const forbidden of forbidModulePaths) {
  // Phase P is expected to import GameRuntime.js (K9) — only App.jsx stays forbidden.
  if (manifest.phase === 'park' && forbidden === 'src/game/core/GameRuntime.js') continue;
  const hit = moduleIds.find((id) => id === forbidden || id.endsWith(`/${forbidden}`));
  assert.equal(hit, undefined, `forbidden module "${forbidden}" found in dog product module graph`);
}

// --- D. Fingerprints (phase-keyed) --------------------------------------
const jsFiles = walkFiles(distRoot).filter((f) => f.endsWith('.js'));
const jsSource = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const requireJsSubstrings = manifest.verify?.requireJsSubstrings || [];
for (const needle of requireJsSubstrings) {
  assert.ok(jsSource.includes(needle), `required fingerprint "${needle}" not found in any dist-dog/*.js`);
}

if (manifest.phase === 'studio') {
  const forbidJsSubstrings = manifest.verify?.forbidJsSubstrings || [];
  for (const needle of forbidJsSubstrings) {
    assert.ok(!jsSource.includes(needle), `forbidden Phase S fingerprint "${needle}" found in dist-dog/*.js (playground leaked into studio product?)`);
  }
} else {
  // Phase P: dormant kernel strings are allowed (K9/K14); only multiplayer UI
  // entry points are still a hard fail per §7.1.C.
  for (const needle of ['PartySocket', 'DeathmatchLobby']) {
    assert.ok(!jsSource.includes(needle), `forbidden Phase P fingerprint "${needle}" found in dist-dog/*.js`);
  }
}

console.log(`verify:dog-bundle ok (phase=${manifest.phase})`);
