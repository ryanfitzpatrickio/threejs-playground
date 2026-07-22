/**
 * Canada goose TSL material — zone field marks + light barring.
 *
 * Procedural mesh carries vertex zones; this paints:
 *   brown/grey body with subtle horizontal barring,
 *   pale cream breast/belly,
 *   pure black head/neck (accent),
 *   white chinstrap (high-g belly / body mix),
 *   darker folded wing pack,
 *   black bill/legs, white undertail (belly).
 *
 * No GLB albedo — shape kit + zone colors only (dog-style primitives).
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  fract,
  mix,
  normalWorld,
  positionLocal,
  pow,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { CANADA_GOOSE_PALETTE } from './birdProportionProfile.js';

/**
 * @param {{
 *   color?: number,
 *   belly?: number,
 *   accent?: number,
 *   chin?: number,
 *   beakColor?: number,
 *   legColor?: number,
 *   sheen?: number,
 * }} [presentation]
 */
export function createGoosePlumageMaterial(presentation = {}) {
  const pal = CANADA_GOOSE_PALETTE;
  const base = new THREE.Color(presentation.color ?? pal.color);
  const belly = new THREE.Color(presentation.belly ?? pal.belly);
  const accent = new THREE.Color(presentation.accent ?? pal.accent);
  const chin = new THREE.Color(presentation.chin ?? pal.chin);
  const beak = new THREE.Color(presentation.beakColor ?? pal.beakColor);
  const leg = new THREE.Color(presentation.legColor ?? pal.legColor);
  // Folded wing pack: cooler brown-grey than body (profile ref)
  const wing = base.clone().lerp(accent, 0.18).multiplyScalar(0.78);
  const sheenAmt = Number.isFinite(presentation.sheen) ? presentation.sheen : pal.sheen;

  const uBase = uniform(base);
  const uBelly = uniform(belly);
  const uAccent = uniform(accent);
  const uChin = uniform(chin);
  const uWing = uniform(wing);
  const uBeak = uniform(beak);
  const uLeg = uniform(leg);
  const uSheen = uniform(sheenAmt);

  try {
    const mat = new MeshStandardNodeMaterial({
      roughness: 0.8,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    const c = attribute('color', 'vec3');
    const r = c.x;
    const g = c.y;
    const b = c.z;

    // Zone decode (same keys as buildBirdBodyGeometry)
    const isBodyBelly = smoothstep(float(0.15), float(0.0), b)
      .mul(smoothstep(float(0.0), float(0.05), r.add(g)));
    const bodyBelly = mix(uBase, uBelly, g);

    const isWing = smoothstep(float(0.55), float(0.85), b)
      .mul(smoothstep(float(0.55), float(0.15), r.add(g)));
    const isAccent = smoothstep(float(0.55), float(0.85), r)
      .mul(smoothstep(float(0.55), float(0.85), g))
      .mul(smoothstep(float(0.55), float(0.15), b));
    const isBeak = smoothstep(float(0.55), float(0.15), r)
      .mul(smoothstep(float(0.55), float(0.85), g))
      .mul(smoothstep(float(0.55), float(0.85), b));
    const isLeg = smoothstep(float(0.55), float(0.85), r)
      .mul(smoothstep(float(0.55), float(0.15), g))
      .mul(smoothstep(float(0.55), float(0.85), b));

    // Chinstrap / pure white: high belly channel (chinstrap pads + undertail)
    // vs cream breast (moderate g on body).
    const pureWhite = isBodyBelly.mul(smoothstep(float(0.82), float(0.98), g));
    const creamBreast = isBodyBelly.mul(float(1).sub(pureWhite));

    let zoneCol = mix(uBase, bodyBelly, creamBreast);
    zoneCol = mix(zoneCol, uChin, pureWhite);
    zoneCol = mix(zoneCol, uWing, isWing);
    // Sharp black head / neck / tail (accent) — no soft wash
    zoneCol = mix(zoneCol, uAccent, isAccent);
    zoneCol = mix(zoneCol, uBeak, isBeak);
    zoneCol = mix(zoneCol, uLeg, isLeg);

    // Subtle horizontal barring on body flanks (photo: pale + brown bands)
    // Driven by rest-local Y so bands stay stable under skinning.
    const barWave = sin(positionLocal.y.mul(42.0).add(positionLocal.z.mul(6.0)))
      .mul(0.5)
      .add(0.5);
    const barAmt = isBodyBelly
      .mul(float(1).sub(pureWhite))
      .mul(float(1).sub(smoothstep(float(0.15), float(0.55), g)).add(0.35).mul(0.5));
    // Darker bars on flanks; cream breast stays smoother
    const barDark = zoneCol.mul(0.78);
    zoneCol = mix(zoneCol, barDark, barWave.mul(barAmt).mul(0.45));

    // Soft grain (procedural micro-feather, not photo texture)
    const grain = fract(
      sin(positionLocal.x.mul(29.1).add(positionLocal.y.mul(17.3)).add(positionLocal.z.mul(23.7)))
        .mul(43758.5453),
    );
    let col = mix(zoneCol, zoneCol.mul(0.92), grain.mul(0.12).mul(float(1).sub(isBeak).sub(isLeg)));

    // Cool rim on black neck / crown
    const nDotUp = pow(smoothstep(float(0.05), float(0.85), normalWorld.y), float(1.4));
    col = mix(col, mix(col, vec3(0.12, 0.14, 0.18), nDotUp.mul(uSheen.add(0.08))), isAccent);

    // Slight satin on white chinstrap
    col = mix(col, mix(col, vec3(1.0, 1.0, 0.98), nDotUp.mul(0.12)), pureWhite);

    mat.colorNode = col;

    let rough = float(0.82);
    rough = mix(rough, float(0.88), creamBreast);
    rough = mix(rough, float(0.72), pureWhite);
    rough = mix(rough, float(0.76), isWing);
    rough = mix(rough, float(0.52), isAccent);
    rough = mix(rough, float(0.32), isBeak);
    rough = mix(rough, float(0.48), isLeg);
    mat.roughnessNode = rough;
    mat.metalnessNode = mix(float(0.02), float(0.14), isBeak);

    mat.userData.goosePlumage = {
      uBase, uBelly, uAccent, uChin, uWing, uBeak, uLeg, uSheen,
    };
    return mat;
  } catch {
    return new THREE.MeshStandardMaterial({
      color: base,
      roughness: 0.8,
      metalness: 0.02,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
  }
}
