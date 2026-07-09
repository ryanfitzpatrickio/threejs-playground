/**
 * PR2 override invariants for cloud/weather systemWrite paths.
 *
 * Pure node — no WebGPU / three. Mirrors CloudSkyProvider + SkySystem K4a +
 * syncCloudReach stamp ids against ShaderDebugRegistry.
 *
 *   npm run verify:shader-debug-overrides
 */

import assert from 'node:assert/strict';
import {
  __resetShaderDebugRegistryForTests,
  registerUniformFloat,
  registerShaderDebugFolder,
  registerShaderDebugParam,
  systemWrite,
  isUserOverride,
  hasAnyUserOverrideInFolder,
  clearOverridesForFolders,
  clearAllUserOverrides,
  markUserOverride,
  listShaderDebugParams,
  reapplyShaderDebugOverrides,
} from '../src/game/debug/shaderDebugRegistry.js';
import {
  buildCloudShapeExport,
  buildCloudTypePresetExport,
  formatShaderDebugExport,
  exportShaderDebugAsJs as structuredExport,
} from '../src/game/debug/shaderDebugExport.js';

// Stand-in uniforms (same .value shape as TSL uniform nodes).
const uCloudCoverage = { value: 0.5 };
const uCloudDensity = { value: 0.02 };
const uCloudAltitude = { value: 1200 };
const uCloudThickness = { value: 1800 };
const uCloudBaseStrength = { value: 0.6 };
const uCloudMaxMarchDist = { value: 16000 };
const uCloudFadeStart = { value: 9000 };

function applyShape({ coverage, density, altitude, thickness, baseStrength }) {
  systemWrite('clouds.coverage', () => { uCloudCoverage.value = coverage; });
  systemWrite('clouds.density', () => { uCloudDensity.value = density; });
  systemWrite('clouds.altitude', () => { uCloudAltitude.value = altitude; });
  systemWrite('clouds.thickness', () => { uCloudThickness.value = thickness; });
  systemWrite('clouds.baseStrength', () => { uCloudBaseStrength.value = baseStrength; });
}

function applyWeather(weather) {
  const profiles = {
    clear: { coverage: 0.5, density: 0.02 },
    overcast: { coverage: 0.8, density: 0.024 },
    fog: { coverage: 0.66, density: 0.021 },
    rain: { coverage: 0.85, density: 0.024 },
  };
  const profile = profiles[weather] ?? profiles.clear;
  systemWrite('clouds.coverage', () => { uCloudCoverage.value = profile.coverage; });
  systemWrite('clouds.density', () => { uCloudDensity.value = profile.density; });
}

/** Mirrors SkySystem.setWeather K4a control flow. */
function setWeatherK4a(weather, { forceStratusShape } = {}) {
  const shapePinned = hasAnyUserOverrideInFolder('Clouds Shape')
    || hasAnyUserOverrideInFolder('Clouds Lighting')
    || hasAnyUserOverrideInFolder('Clouds Wind');

  if (!shapePinned && forceStratusShape && (weather === 'rain' || weather === 'overcast')) {
    applyShape({
      coverage: 0.9,
      density: 0.025,
      altitude: 900,
      thickness: 2200,
      baseStrength: 0.8,
    });
  }
  // Always commit weather profile (coverage/density), even when shape is pinned.
  applyWeather(weather);
}

function syncCloudReachMock({ viewDistance = 370 } = {}) {
  const reachScale = 2.15;
  const fadeStartFrac = 0.52;
  const marchCap = Math.min(Math.ceil(viewDistance * reachScale), 22000);
  systemWrite('clouds.reach.maxMarch', () => { uCloudMaxMarchDist.value = marchCap; });
  systemWrite('clouds.reach.fadeStart', () => { uCloudFadeStart.value = marchCap * fadeStartFrac; });
}

function setupRegistry() {
  __resetShaderDebugRegistryForTests();
  registerShaderDebugFolder('Clouds Shape', { expanded: true });
  registerShaderDebugFolder('Clouds Lighting');
  registerShaderDebugFolder('Clouds Wind');
  registerShaderDebugFolder('Clouds Reach');
  registerUniformFloat('clouds.coverage', 'Clouds Shape', 'Coverage', uCloudCoverage, { default: 0.5 });
  registerUniformFloat('clouds.density', 'Clouds Shape', 'Density', uCloudDensity, { default: 0.02 });
  registerUniformFloat('clouds.altitude', 'Clouds Shape', 'Altitude', uCloudAltitude, { default: 1200 });
  registerUniformFloat('clouds.thickness', 'Clouds Shape', 'Thickness', uCloudThickness, { default: 1800 });
  registerUniformFloat('clouds.baseStrength', 'Clouds Shape', 'Base strength', uCloudBaseStrength, { default: 0.6 });
  registerUniformFloat('clouds.reach.maxMarch', 'Clouds Reach', 'Max march', uCloudMaxMarchDist, { default: 16000 });
  registerUniformFloat('clouds.reach.fadeStart', 'Clouds Reach', 'Fade start', uCloudFadeStart, { default: 9000 });
}

setupRegistry();

// 1) Pin coverage → rain weather must not clobber coverage; density still updates.
uCloudCoverage.value = 0.5;
uCloudDensity.value = 0.02;
listShaderDebugParams().find((p) => p.id === 'clouds.coverage').set(0.42);
assert.equal(uCloudCoverage.value, 0.42);
assert.equal(isUserOverride('clouds.coverage'), true);

setWeatherK4a('rain', { forceStratusShape: true });
assert.equal(uCloudCoverage.value, 0.42, 'pinned coverage holds under rain');
assert.equal(uCloudDensity.value, 0.024, 'unpinned density follows rain profile');

// 2) Pin altitude (shape) → rain must NOT rewrite full stratus shape; weather still applies.
clearAllUserOverrides();
uCloudAltitude.value = 1200;
uCloudCoverage.value = 0.5;
uCloudDensity.value = 0.02;
listShaderDebugParams().find((p) => p.id === 'clouds.altitude').set(1500);
assert.equal(hasAnyUserOverrideInFolder('Clouds Shape'), true);

setWeatherK4a('rain', { forceStratusShape: true });
assert.equal(uCloudAltitude.value, 1500, 'shape pin skips stratus altitude clobber');
assert.equal(uCloudCoverage.value, 0.85, 'unpinned coverage still gets rain profile');
assert.equal(uCloudDensity.value, 0.024);

// 3) Fog weather with no shape pin updates coverage.
clearAllUserOverrides();
uCloudCoverage.value = 0.5;
setWeatherK4a('fog', { forceStratusShape: true });
assert.equal(uCloudCoverage.value, 0.66, 'fog updates coverage without shape pin');

// 4) Explicit cloud-type select: folder clear then full shape stamp.
clearAllUserOverrides();
listShaderDebugParams().find((p) => p.id === 'clouds.coverage').set(0.11);
listShaderDebugParams().find((p) => p.id === 'clouds.altitude').set(999);
assert.equal(isUserOverride('clouds.coverage'), true);

clearOverridesForFolders(['Clouds Shape', 'Clouds Lighting', 'Clouds Wind']);
assert.equal(isUserOverride('clouds.coverage'), false);
assert.equal(isUserOverride('clouds.altitude'), false);
applyShape({
  coverage: 0.55,
  density: 0.02,
  altitude: 1200,
  thickness: 1800,
  baseStrength: 0.6,
});
assert.equal(uCloudCoverage.value, 0.55);
assert.equal(uCloudAltitude.value, 1200);

// 5) Reach frame sync respects pin.
clearAllUserOverrides();
syncCloudReachMock({ viewDistance: 400 });
const marchBefore = uCloudMaxMarchDist.value;
listShaderDebugParams().find((p) => p.id === 'clouds.reach.maxMarch').set(12345);
assert.equal(uCloudMaxMarchDist.value, 12345);
syncCloudReachMock({ viewDistance: 400 });
assert.equal(uCloudMaxMarchDist.value, 12345, 'pinned maxMarch survives syncCloudReach');

// 6) Reset / clear all lets system write again.
clearAllUserOverrides();
syncCloudReachMock({ viewDistance: 400 });
assert.equal(uCloudMaxMarchDist.value, marchBefore, 'after clear, reach re-syncs');

// 7) Unknown id always writes (PR2 aerial.hazeColor pattern before registration).
let haze = 0;
assert.equal(systemWrite('aerial.hazeColor', () => { haze = 1; }), true);
assert.equal(haze, 1);
markUserOverride('aerial.hazeColor'); // no-op if unregistered
assert.equal(isUserOverride('aerial.hazeColor'), false);
// Once registered + pinned, systemWrite skips
registerUniformFloat('aerial.hazeColor', 'Aerial', 'Haze', { value: 0 }, {});
listShaderDebugParams().find((p) => p.id === 'aerial.hazeColor').set(0.5);
assert.equal(systemWrite('aerial.hazeColor', () => { haze = 99; }), false);
assert.equal(haze, 1, 'pinned known id blocks systemWrite');

// ---------------------------------------------------------------------------
// PR3: wetness, rain intensity, aerial, cloud-shadow dual-source
// ---------------------------------------------------------------------------

const uWetness = { value: 0 };
const uRainIntensity = { value: 0 };
const uAerialStrength = { value: 1 };
const uHaze = { value: { r: 0.6, g: 0.7, b: 0.8, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; }, copy(o) { this.r = o.r; this.g = o.g; this.b = o.b; return this; } } };
const nodeExtent = { value: 3200 };
const terrainExtent = { value: 3200 };
const terrainIntensity = { value: 0.58 };
const nodeIntensity = { value: 0.72 };

registerShaderDebugFolder('Wetness');
registerShaderDebugFolder('Rain');
registerShaderDebugFolder('Aerial');
registerShaderDebugFolder('Cloud Shadows');
registerUniformFloat('weather.wetness', 'Wetness', 'Wetness', uWetness, { default: 0 });
registerUniformFloat('rain.intensity', 'Rain', 'Intensity', uRainIntensity, { default: 0 });
registerUniformFloat('aerial.strength', 'Aerial', 'Strength', uAerialStrength, { default: 1 });
registerUniformFloat('shadow.intensity', 'Cloud Shadows', 'Intensity', terrainIntensity, { default: 0.58 });
// shadow.extent binds SOURCE node (not terrain copy)
registerUniformFloat('shadow.extent', 'Cloud Shadows', 'Extent', nodeExtent, { default: 3200 });

// 8) Wetness ramp respects pin
clearAllUserOverrides();
uWetness.value = 0;
function rampWetness(target, rate = 0.5) {
  systemWrite('weather.wetness', () => {
    uWetness.value += (target - uWetness.value) * rate;
  });
}
rampWetness(1);
assert.ok(uWetness.value > 0 && uWetness.value < 1);
listShaderDebugParams().find((p) => p.id === 'weather.wetness').set(0.9);
rampWetness(1);
assert.equal(uWetness.value, 0.9, 'pinned wetness holds');
rampWetness(0);
assert.equal(uWetness.value, 0.9, 'pinned wetness holds against dry');

// 9) Rain intensity ramp respects pin
clearAllUserOverrides();
uRainIntensity.value = 0;
function rampRain(target) {
  systemWrite('rain.intensity', () => { uRainIntensity.value = target; });
}
rampRain(1);
assert.equal(uRainIntensity.value, 1);
listShaderDebugParams().find((p) => p.id === 'rain.intensity').set(0.25);
rampRain(1);
assert.equal(uRainIntensity.value, 0.25, 'pinned rain intensity holds');

// 10) Aerial strength pin
clearAllUserOverrides();
systemWrite('aerial.strength', () => { uAerialStrength.value = 0.8; });
assert.equal(uAerialStrength.value, 0.8);
listShaderDebugParams().find((p) => p.id === 'aerial.strength').set(0.3);
systemWrite('aerial.strength', () => { uAerialStrength.value = 1; });
assert.equal(uAerialStrength.value, 0.3, 'pinned aerial strength holds');

// 11) Cloud shadow dual-source: intensity pin; extent always mirrors node → terrain
clearAllUserOverrides();
function syncShadow() {
  // ALWAYS copy extent (no systemWrite skip on terrain copy)
  terrainExtent.value = nodeExtent.value;
  systemWrite('shadow.intensity', () => {
    terrainIntensity.value = nodeIntensity.value;
  });
}
nodeExtent.value = 3200;
nodeIntensity.value = 0.72;
terrainIntensity.value = 0.58;
syncShadow();
assert.equal(terrainExtent.value, 3200);
assert.equal(terrainIntensity.value, 0.72);

listShaderDebugParams().find((p) => p.id === 'shadow.intensity').set(0.2);
nodeIntensity.value = 0.9;
syncShadow();
assert.equal(terrainIntensity.value, 0.2, 'pinned shadow intensity holds');

// Pin extent on node, then enlarge under pin — terrain always mirrors (no desync)
listShaderDebugParams().find((p) => p.id === 'shadow.extent').set(5000);
assert.equal(nodeExtent.value, 5000);
// User set on source; sync still mirrors to terrain
syncShadow();
assert.equal(terrainExtent.value, 5000, 'terrain extent always mirrors node');
// Even if something tried to systemWrite terrain extent separately, policy is always-copy:
nodeExtent.value = 6000; // e.g. external / rebind
// pin is on shadow.extent which is the node — systemWrite on node would skip, but
// frame path always copies current node value to terrain:
syncShadow();
assert.equal(terrainExtent.value, 6000, 'always-copy keeps UVs in sync with node');

// ---------------------------------------------------------------------------
// PR4: fog density pin + post lastUserValue reapply
// ---------------------------------------------------------------------------

const uFogDensity = { value: 0.117 };
const uFogAlpha = { value: 0.68 };
registerShaderDebugFolder('Height Fog');
registerUniformFloat('fog.densityScale', 'Height Fog', 'Density', uFogDensity, { default: 0.117 });
registerUniformFloat('fog.alphaMax', 'Height Fog', 'Alpha max', uFogAlpha, { default: 0.68 });

// 12) Fog density pin holds against systemWrite (pipeline haze resync)
clearAllUserOverrides();
listShaderDebugParams().find((p) => p.id === 'fog.densityScale').set(0.2);
assert.equal(uFogDensity.value, 0.2);
assert.equal(systemWrite('fog.densityScale', () => { uFogDensity.value = 0.117; }), false);
assert.equal(uFogDensity.value, 0.2, 'pinned fog density holds');

// 13) reapplyShaderDebugOverrides restores lastUserValue after "pipeline rebuild"
const fakePost = { strength: { value: 0.5 } };
registerShaderDebugFolder('Post (SSAO / Bloom)');
registerShaderDebugParam({
  id: 'post.bloom.strength',
  folder: 'Post (SSAO / Bloom)',
  label: 'Bloom strength',
  type: 'float',
  get: () => fakePost.strength.value,
  set: (v) => {
    const n = Number(v);
    markUserOverride('post.bloom.strength', n);
    fakePost.strength.value = n;
  },
});
listShaderDebugParams().find((p) => p.id === 'post.bloom.strength').set(1.25);
assert.equal(fakePost.strength.value, 1.25);
// Simulate pipeline rebuild wiping node value
fakePost.strength.value = 0.5;
assert.equal(isUserOverride('post.bloom.strength'), true);
const reapplied = reapplyShaderDebugOverrides('post.');
assert.ok(reapplied >= 1, 'reapply touches post.bloom.strength');
assert.equal(fakePost.strength.value, 1.25, 'pinned bloom strength restored after rebuild');

// ---------------------------------------------------------------------------
// PR5: structured export formatters
// ---------------------------------------------------------------------------

clearAllUserOverrides();
listShaderDebugParams().find((p) => p.id === 'clouds.altitude').set(1300);
listShaderDebugParams().find((p) => p.id === 'clouds.coverage').set(0.61);
listShaderDebugParams().find((p) => p.id === 'clouds.density').set(0.021);

const shape = buildCloudShapeExport();
assert.equal(shape.altitude, 1300);
assert.equal(shape.coverage, 0.61);
assert.equal(shape.density, 0.021);

const preset = buildCloudTypePresetExport(undefined, 'testType');
assert.equal(preset.label, 'testType');
assert.ok(preset.shape);
assert.ok(typeof preset.lighting === 'object');
assert.ok(typeof preset.wind === 'object');

const js = formatShaderDebugExport('cloudShape');
assert.ok(js.includes('AUTHORED_CLOUD_SHAPE'));
assert.ok(js.includes('1300'));

const allJs = structuredExport(null);
assert.ok(allJs.includes('AUTHORED_SHADER_DEBUG_BUNDLE') || allJs.includes('cloudType'));

const overrideJs = formatShaderDebugExport('overrides');
assert.ok(overrideJs.includes('clouds.coverage') || overrideJs.includes('shaderDebugOverrides'));

console.log('verify-shader-debug-overrides: ok');
