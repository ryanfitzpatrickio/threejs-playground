/**
 * Module-scope TSL uniforms for the rain streak effect.
 *
 * Same golden-path pattern as cloudUniforms / weatherUniforms: createRainEffect
 * and the shader-debug registry both import these nodes. WeatherSystem owns
 * intensity ramping via systemWrite; look params are user/debug writable.
 *
 * Single global rain instance (WeatherSystem creates at most one effect).
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';

export const DEFAULT_RAIN_VOLUME = /*@__PURE__*/ new THREE.Vector3(50, 40, 50);
export const DEFAULT_RAIN_FALL_SPEED = 22;
export const DEFAULT_RAIN_LENGTH = 1.4;
export const DEFAULT_RAIN_STREAK_WIDTH = 0.03;
export const DEFAULT_RAIN_WIND = /*@__PURE__*/ new THREE.Vector3(3, 0, 1);

export const uRainVolume = uniform(DEFAULT_RAIN_VOLUME.clone());
export const uRainFallSpeed = uniform(DEFAULT_RAIN_FALL_SPEED);
export const uRainLengthBase = uniform(DEFAULT_RAIN_LENGTH);
export const uRainStreakWidth = uniform(DEFAULT_RAIN_STREAK_WIDTH);
export const uRainWindVec = uniform(DEFAULT_RAIN_WIND.clone());
/** Ramped 0..1 by createRainEffect.update (systemWrite-aware). */
export const uRainIntensity = uniform(0);
