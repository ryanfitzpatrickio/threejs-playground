import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readGlb } from './lib/readGlb.mjs';

const source = resolve('public/assets/models/horse-rigged.glb');
const { json } = await readGlb(source);
const clipNames = (json.animations ?? []).map((clip) => clip.name);
const nodeNames = new Set((json.nodes ?? []).map((node) => node.name).filter(Boolean));
for (const required of ['Idle', 'Walk', 'Run', 'Sit', 'Jump']) {
  assert.ok(clipNames.includes(required), `missing required horse clip ${required}`);
}
for (const required of ['root', 'Hips', 'Head', 'Tail_Base', 'Front_Leg_Upper_L', 'Back_Leg_Upper_R']) {
  assert.ok(nodeNames.has(required), `missing source joint ${required}`);
}
assert.equal(json.animations.length, 14, `expected 14 source clips, got ${json.animations.length}`);
console.log(`probe-dog-source-anims: OK (${json.animations.length} clips, ${nodeNames.size} named nodes)`);
console.log(clipNames.join(', '));

