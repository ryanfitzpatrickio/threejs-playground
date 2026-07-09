/**
 * Module-scope TSL uniforms for AAA mud particle / decal colors.
 *
 * Vector3 linear RGB (not THREE.Color) — matches createAaaMudParticleRenderer.
 * Defaults from rallyMudPalette.js. Shared across mud particle instances.
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import {
  RALLY_MUD_WET_LINEAR,
  RALLY_MUD_BODY_LINEAR,
  RALLY_MUD_DECAL_DARK_LINEAR,
  RALLY_MUD_DECAL_LIGHT_LINEAR,
} from '../materials/rallyMudPalette.js';

export const uMudLightColor = uniform(new THREE.Vector3(1.05, 0.98, 0.90));
export const uMudAmbient = uniform(new THREE.Vector3(0.44, 0.42, 0.40));
export const uMudWetCol = uniform(new THREE.Vector3(...RALLY_MUD_WET_LINEAR));
export const uMudDryCol = uniform(new THREE.Vector3(...RALLY_MUD_BODY_LINEAR));
export const uMudDecalDark = uniform(new THREE.Vector3(...RALLY_MUD_DECAL_DARK_LINEAR));
export const uMudDecalLight = uniform(new THREE.Vector3(...RALLY_MUD_DECAL_LIGHT_LINEAR));
