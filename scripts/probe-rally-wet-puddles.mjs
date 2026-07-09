// Probe: dump wet-road puddle / reflection config for tuning.
//
// Prints wetness floor, coverage, low-spot bias, and env reflection settings
// from the quality preset + DEFAULT_WET_ROAD_WETNESS. Builds a wet material
// and reports userData flags (no GPU required).
//
// Run: node scripts/probe-rally-wet-puddles.mjs

import {
  createRallySurfaceMaterial,
  loadRallySurfaceSet,
  DEFAULT_WET_ROAD_WETNESS,
} from '../src/game/materials/rallySurfaceTextures.js';
const { rainWetness, rainWind } = await import('../src/game/systems/weatherUniforms.js');
const { getQualityPreset, getQualityLevel } = await import('../src/game/config/qualityPresets.js');
const { DEFAULT_VEHICLE_CONFIG } = await import('../src/game/config/vehicleConfig.js');
const { ROAD_SURFACES } = await import('../src/world/worldMap/roadSurface.js');

const level = getQualityLevel();
const preset = getQualityPreset(level);
const wr = preset.wetRoads ?? {};

console.log('--- rally wet puddles probe ---');
console.log(`quality level: ${level}`);
console.log(`ROAD_SURFACES.wet: ${Boolean(ROAD_SURFACES.wet)}`);
console.log(`DEFAULT_WET_ROAD_WETNESS: ${DEFAULT_WET_ROAD_WETNESS}`);
console.log('wetRoads preset:', JSON.stringify(wr, null, 2));
console.log('surfaces.wet grip:', DEFAULT_VEHICLE_CONFIG.ground.surfaces.wet);
console.log('dust.water:', DEFAULT_VEHICLE_CONFIG.ground.dust?.water ? {
  buoyancy: DEFAULT_VEHICLE_CONFIG.ground.dust.water.buoyancy,
  gravity: DEFAULT_VEHICLE_CONFIG.ground.dust.water.gravity,
  color: DEFAULT_VEHICLE_CONFIG.ground.dust.water.color,
} : null);

const wetMat = createRallySurfaceMaterial(loadRallySurfaceSet('dirt'), {
  rainWetness,
  rainWind,
  wetness: wr.wetness ?? DEFAULT_WET_ROAD_WETNESS,
  wetSurface: true,
  envReflections: wr.enabled === false
    ? null
    : { enabled: true, ...(wr.reflections ?? {}) },
  puddleCoverageScale: ((wr.puddles?.coverage ?? 0.34) / 0.32),
  lowSpotBias: wr.puddles?.lowSpotBias ?? 0.25,
  tireTracks: true,
});

const floor = wetMat.wetnessUniform?.value ?? 0;
const rain = rainWetness.value ?? 0;
console.log('material wetness floor:', floor);
console.log('rainWetness (current):', rain);
console.log('effWet = max(rain, floor):', Math.max(rain, floor));
console.log('envNode blacked out?', wetMat.envNode != null);
console.log('wetEnvReflections:', wetMat.userData?.wetEnvReflections ?? null);
console.log('wetSurface userData:', wetMat.userData?.wetSurface ?? null);
console.log('--- done ---');
