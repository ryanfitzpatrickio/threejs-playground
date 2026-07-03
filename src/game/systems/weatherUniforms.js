/**
 * weatherUniforms.js
 *
 * A single shared TSL uniform, `rainWetness` (0..1), imported directly by any
 * material factory that wants to react to rain — terrain, roads, vehicle
 * paint. Same "global, auto-shared, zero manual wiring" pattern this codebase
 * already relies on for TSL's own `time`/`cameraPosition` builtins: material
 * factories just read `.value` in their node graph, and `WeatherSystem` is the
 * only thing that writes it, each frame. This avoids threading a new
 * constructor param through every level/vehicle factory's init order — the
 * uniform object exists at import time, independent of when
 * `WeatherSystem.initialize()` runs relative to level/vehicle construction.
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';

export const rainWetness = uniform(0);

// Shared wind vector for the wet-surface ripple/beading nodes
// (wetSurfaceNodes.js), matching the default `uWind` in the reference repo's
// src/main.js — same value createRainEffect.js's rain streaks already use.
export const rainWind = uniform(new THREE.Vector3(3, 0, 1));

// 0..1 lightning flash brightness (`uLightning` in the reference), decayed
// every frame by WeatherSystem's strike/flicker logic. Read directly by
// createRainEffect.js's streak color, matching the reference's
// `uColor * (1 + uLightning * 2.5)` rain-streak brightening exactly.
export const lightningFlash = uniform(0);
