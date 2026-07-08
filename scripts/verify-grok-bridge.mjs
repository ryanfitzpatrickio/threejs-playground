// Guards the Grok headless JSON bridge used by Map Builder and World Map editors.
// Regression: parser must prefer cliEnvelope.text over longer invalid thought traces;
// live spawn must not pass unsupported --effort or explore the repo instead of JSON.
//
// Run: node scripts/verify-grok-bridge.mjs
// Live Grok call (slow, needs authenticated CLI): GROK_VERIFY_LIVE=1 node scripts/verify-grok-bridge.mjs

import assert from 'node:assert/strict';
import {
  checkGrokAvailability,
  parseGrokStructuredPayload,
  runGrokGenerate,
} from '../vite/grokBridge.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

{
  const validText = JSON.stringify({
    summary: 'Small platform',
    project: { version: 1, chunkSize: 32, objects: [{ type: 'box', position: [0, 1, 0] }] },
  });
  const noisyThought = `thinking...\n${validText}\nbut also broken {"project": [[0]*33]}`;
  const parsed = parseGrokStructuredPayload([validText, noisyThought]);
  assert.equal(parsed?.summary, 'Small platform');
  assert.ok(Array.isArray(parsed?.project?.objects));
  ok('parseGrokStructuredPayload prefers valid text over longer thought noise');
}

{
  const fenced = '```json\n{"summary":"x","project":{"version":1,"objects":[]}}\n```';
  const parsed = parseGrokStructuredPayload([fenced]);
  assert.equal(parsed?.summary, 'x');
  ok('parseGrokStructuredPayload strips markdown fences');
}

{
  // World map mode: model sometimes emits the map object directly (no wrapper)
  const bareMap = JSON.stringify({
    version: 1,
    name: 'Test Rally',
    bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
    roads: [{ id: 'r1', points: [{x:0,z:0},{x:10,z:10}], width: 6, trackStyle: 'rallySpectator', surface: 'mud' }],
    zones: [{ id: 'z1', type: 'wilds' }],
  });
  const noisy = `thinking...\nhere is the map\n${bareMap}\nend`;
  const parsed = parseGrokStructuredPayload([noisy]);
  assert.ok(parsed && (parsed.roads || parsed.zones), 'should accept bare world map object');
  ok('parseGrokStructuredPayload accepts bare map objects (common worldmap failure mode)');
}

const availability = checkGrokAvailability();
if (!availability.available) {
  console.log(`grok CLI unavailable (${availability.error}); skipped live checks`);
  console.log(`\n${passed} passed`);
  process.exit(0);
}

ok(`grok CLI available (${availability.version})`);

if (process.env.GROK_VERIFY_LIVE === '1') {
  const result = await runGrokGenerate({
    prompt: 'tiny platform',
    summary: { terrain: { authoredCount: 0 }, objects: [] },
    mode: 'blueprint',
  });
  assert.equal(result.success, true, result.error || 'blueprint generation failed');
  assert.ok(result.project && Array.isArray(result.project.objects), 'expected project.objects');
  ok('live blueprint generation returns loadable project JSON');
}

console.log(`\n${passed} passed`);
