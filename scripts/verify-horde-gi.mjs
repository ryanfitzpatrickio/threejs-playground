/**
 * verify-horde-gi — pure-node checks for horde GI settings + level metadata.
 *
 * Full bake requires WebGPU; this guards contracts only.
 * Run: node scripts/verify-horde-gi.mjs
 */

import { createHordeModeLevel } from '../src/game/world/createHordeModeLevel.js';
import {
  resolveHordeGiSettings,
  DEFAULT_MALL_GI_VOLUME,
  createHordeGiController,
} from '../src/game/world/hordeGi.js';
import { applyHordeLevelOverrides } from '../src/game/config/hordePerformance.js';
import { getQualityPreset } from '../src/game/config/qualityPresets.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Level exports mall volume
const level = createHordeModeLevel({});
assert(level.hordeGi?.mall?.center?.length === 3, 'level.hordeGi.mall.center missing');
assert(level.hordeGi?.mall?.size?.length === 3, 'level.hordeGi.mall.size missing');
assert(level.hordeGi.mall.size[0] > 40 && level.hordeGi.mall.size[0] < 100, 'mall GI width out of range');
const snap = level.snapshot?.();
assert(snap?.gi?.mall, 'level snapshot missing gi.mall');

// High quality enables GI under horde overrides
const high = applyHordeLevelOverrides(getQualityPreset('high'), 'horde');
const highGi = resolveHordeGiSettings(high, level.hordeGi);
assert(highGi.enabled === true, `high horde GI should enable, got ${JSON.stringify(highGi)}`);
assert(highGi.probes.x * highGi.probes.y * highGi.probes.z === 8 * 3 * 8, 'default probe count');

// Low quality disables
const low = applyHordeLevelOverrides(getQualityPreset('low'), 'horde');
const lowGi = resolveHordeGiSettings(low, level.hordeGi);
assert(lowGi.enabled === false, 'low quality should disable horde GI');

// Explicit off
const forcedOff = resolveHordeGiSettings({
  ...high,
  environment: { ...high.environment, hordeGi: { enabled: false } },
}, level.hordeGi);
assert(forcedOff.enabled === false, 'explicit enabled:false must win');

// Controller disabled path is safe without renderer
const disabled = createHordeGiController({
  scene: null,
  renderer: null,
  qualityPreset: low,
  levelGi: level.hordeGi,
});
assert(disabled.getSnapshot().status === 'disabled', 'disabled controller status');
disabled.dispose();

// Defaults present
assert(DEFAULT_MALL_GI_VOLUME.size[0] === 70, 'default mall volume');

console.log('ok — horde GI: mall volume + quality gates + controller contracts');
