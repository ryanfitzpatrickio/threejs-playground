/**
 * Module-scope TSL uniforms for river water materials.
 *
 * Shared across all createWaterMaterial() instances so one Water debug folder
 * drives every river. Defaults match the previous hard-coded look (Appendix B).
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';

export const uWaterRippleAmp = uniform(0.07);
export const uWaterShallow = uniform(new THREE.Color(0.18, 0.42, 0.50));
export const uWaterDeep = uniform(new THREE.Color(0.03, 0.10, 0.20));
export const uWaterRoughness = uniform(0.08);
export const uWaterOpacity = uniform(0.82);
