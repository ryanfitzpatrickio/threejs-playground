// Verifies deploy/dog-asset-manifest.json is internally consistent and every
// referenced path actually exists on disk. Runnable standalone (no build
// required) so a manifest edit can be checked before spending a full
// `build:dog`. See docs/dog-park-standalone-deploy-plan.md §7.2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDogAssetManifest, resolveDogManifestCopyJobs } from '../vite/dogDeployAssetsPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const manifestPath = path.join(ROOT, 'deploy', 'dog-asset-manifest.json');

assert.ok(fs.existsSync(manifestPath), `manifest not found at ${manifestPath}`);
const manifest = readDogAssetManifest(manifestPath);

assert.ok(['studio', 'park'].includes(manifest.phase), `manifest "phase" must be studio|park, got ${manifest.phase}`);
assert.equal(manifest.product, 'dog-park', 'manifest "product" must be dog-park');

for (const key of ['maxFileBytes', 'maxTotalBytes', 'maxJsChunkBytes']) {
  assert.ok(Number.isFinite(manifest.budgets?.[key]), `manifest budgets.${key} must be a finite number`);
}
assert.equal(manifest.budgets.unit, 'raw-on-disk', 'manifest budgets.unit must be raw-on-disk (no gzip gating)');

for (const entry of manifest.include || []) {
  assert.ok(!path.isAbsolute(entry.from), `include.from must be repo-relative: ${entry.from}`);
  assert.ok(!entry.from.includes('..'), `include.from must not escape repo root: ${entry.from}`);
}
for (const glob of manifest.includeGlobs || []) {
  assert.ok(!path.isAbsolute(glob.from), `includeGlobs.from must be repo-relative: ${glob.from}`);
  assert.ok(!glob.from.includes('..'), `includeGlobs.from must not escape repo root: ${glob.from}`);
}

const { jobs, missingRequired } = resolveDogManifestCopyJobs(manifest, ROOT);
assert.equal(
  missingRequired.length,
  0,
  `manifest references missing required paths:\n  - ${missingRequired.join('\n  - ')}`,
);

for (const glob of manifest.includeGlobs || []) {
  if (glob.optional) continue;
  const matched = jobs.filter((job) => job.sourceGlob === glob.from);
  assert.ok(matched.length >= 1, `includeGlobs "${glob.from}" expanded to zero files`);
}

console.log(`verify:dog-assets ok (phase=${manifest.phase}, ${jobs.length} allowlisted file(s))`);
