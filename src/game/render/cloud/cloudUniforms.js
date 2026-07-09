// Shared TSL uniforms for the cloud + LUT-atmosphere subsystem.
//
// Same "global, auto-shared, zero manual wiring" pattern this codebase uses for
// `weatherUniforms.js` and TSL's own `time`/`cameraPosition` builtins: the
// `CloudSkyProvider` is the only writer, and every node material / shader Fn in
// `src/game/render/cloud/` reads these by import. This avoids threading params
// through every constructor and keeps the per-pipeline node graph stable across
// quality/weather changes (the uniforms just get new `.value`s).
//
// These persist at module scope for the life of the page — like `weatherUniforms`
// — so they survive level/streaming reloads. Textures (LUTs, noise) are NOT here:
// those are provider-owned and passed explicitly to the materials that need them.

import * as THREE from 'three';
import { uniform } from 'three/tsl';

// --- Sun (written by CloudSkyProvider.setTimeOfDay) ---------------------------
export const uSunDirection = uniform(new THREE.Vector3(0, 0.3, -1).normalize());
export const uSunIntensity = uniform(6.6);                 // sky reference source radiance space
export const uSunColor = uniform(new THREE.Color(1, 0.95, 0.85));
export const uSunDiscSize = uniform(0.0016);

// --- Atmosphere params (written on init / preset change) ----------------------
// Re-baking the transmittance LUT when these change is M6 polish; for now they
// are set once at provider init.
export const uAtmosphereRayleigh = uniform(1.95);
export const uAtmosphereTurbidity = uniform(1.5);
export const uAtmosphereMieG = uniform(0.76);
export const uAtmosphereMieStrength = uniform(0.26);
export const uAtmosphereMultiScatter = uniform(0.22);
export const uAtmosphereSkyMultiScatter = uniform(0.28);

// 0 = full day, 1 = full night. Drives the moon/night terms once added; for M1
// it is computed from the sun elevation each frame.
export const uSkyDarkness = uniform(0);

// --- Per-frame state (written by CloudSkyProvider.update) ---------------------
export const uCameraPos = uniform(new THREE.Vector3());
// Wind advances cloud sample offsets in XZ (metres) + evolution (seconds).
export const uWindOffset = uniform(new THREE.Vector3());
export const uEvolution = uniform(0);

// --- Cloud slab + shape params (flat-slab adaptation; analysis §4.2/§4.6) -----
// All lengths in metres. The provider copies DEFAULT_CLOUD_PARAMS / preset
// overrides in here; the density + march shaders read them directly.
export const uCloudAltitude = uniform(1200);
export const uCloudThickness = uniform(1800);
export const uCloudCoverage = uniform(0.5);
export const uCloudDensity = uniform(0.02);          // extinction coefficient
export const uCloudScatteringAlbedo = uniform(1);
export const uCloudWeatherScale = uniform(4600);
export const uCloudBaseScale = uniform(1300);
export const uCloudErosionScale = uniform(364);
export const uCloudBaseStrength = uniform(0.6);
export const uCloudErosionStrengthBase = uniform(0.42);
export const uCloudErosionStrengthPeak = uniform(2.95);
export const uCloudErosionShape = uniform(1);
export const uCloudEdgeSoftness = uniform(0.16);
export const uCloudEdgeSoftnessFalloff = uniform(0.82);
export const uCloudPowderStrength = uniform(0.65);
export const uCloudAmbientIntensity = uniform(0.52);

// Lighting helpers: sun transmittance to the cloud deck (tint) + an ambient
// sky color. The provider sets these each frame (M2: from the LUT horizon
// transmittance / a sky-blue constant; refined in M6).
export const uSunTint = uniform(new THREE.Color(1, 1, 1));
export const uCloudAmbientColor = uniform(new THREE.Color(0.5, 0.6, 0.75));

// Wind direction (unit vec3, XZ) — derived from heading by the provider.
export const uWindDirection = uniform(new THREE.Vector3(0, 0, 1));
export const uWindSkew = uniform(350);
