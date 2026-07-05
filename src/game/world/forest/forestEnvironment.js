import * as THREE from 'three';
import { windStrength, windSpeed, sunDirectionUniform } from './seedthree/wind.js';

const _wind = new THREE.Vector3();

/** Drive SeedThree wind + sun uniforms from live weather / sky state (M4). */
export function syncForestEnvironment({ sunDirection, windVector } = {}) {
  if (sunDirection) {
    sunDirectionUniform.value.copy(sunDirection);
  }
  if (windVector) {
    _wind.copy(windVector);
    const strength = THREE.MathUtils.clamp(_wind.length() * 0.12, 0.08, 1);
    windStrength.value = strength;
    windSpeed.value = 0.75 + strength * 0.85;
  }
}
