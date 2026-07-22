/**
 * Plumage material for procedural bird mesh.
 *
 * Vertex colors encode zones (see buildBirdBodyGeometry BIRD_ZONE / ZONE_RGB):
 *   (1,0,0) body   (0,1,0) belly   (0,0,1) wing
 *   (1,1,0) accent (0,1,1) beak    (1,0,1) leg
 * Body↔belly blends use (1-t, t, 0).
 *
 * Adds per-zone roughness (soft plumage vs hard beak) and a light sheen mix
 * for iridescent accents (hummingbird / pigeon / macaw).
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  fract,
  mix,
  normalWorld,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';

/**
 * @param {{
 *   color?: number,
 *   belly?: number,
 *   accent?: number,
 *   sheen?: number,
 *   beakColor?: number,
 *   legColor?: number,
 * }} presentation
 */
export function createBirdPlumageMaterial(presentation = {}) {
  const base = new THREE.Color(presentation.color ?? 0x6b6e66);
  const belly = new THREE.Color(presentation.belly ?? 0xd4d0c4);
  const accent = new THREE.Color(presentation.accent ?? 0x3a3c38);
  const beak = new THREE.Color(presentation.beakColor ?? 0x2a2418);
  const leg = new THREE.Color(presentation.legColor ?? 0x3a3028);
  const wing = base.clone().lerp(accent, 0.42).multiplyScalar(0.76);
  const sheenAmt = Number.isFinite(presentation.sheen) ? presentation.sheen : 0.12;

  const uBase = uniform(base);
  const uBelly = uniform(belly);
  const uAccent = uniform(accent);
  const uWing = uniform(wing);
  const uBeak = uniform(beak);
  const uLeg = uniform(leg);
  const uSheen = uniform(sheenAmt);

  try {
    const mat = new MeshStandardNodeMaterial({
      roughness: 0.72,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });

    const c = attribute('color', 'vec3');
    const r = c.x;
    const g = c.y;
    const b = c.z;

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

    let col = mix(uBase, bodyBelly, isBodyBelly);
    col = mix(col, uWing, isWing);
    col = mix(col, uAccent, isAccent);
    col = mix(col, uBeak, isBeak);
    col = mix(col, uLeg, isLeg);

    // Cheap iridescence: lift accent/wing toward a cooler highlight by N·up.
    const nDotUp = pow(smoothstep(float(0.15), float(0.95), normalWorld.y), float(1.4));
    const iridescent = mix(col, vec3(0.45, 0.75, 0.85), nDotUp.mul(uSheen));
    col = mix(col, iridescent, isAccent.add(isWing).mul(0.65));

    // Soft plumage grain (not UVs — world-space hash so skinned birds keep it).
    const grain = fract(sin(positionWorld.x.mul(37.1).add(positionWorld.y.mul(19.7)).add(positionWorld.z.mul(23.3))).mul(43758.5453));
    col = mix(col, col.mul(0.88), grain.mul(0.12).mul(float(1).sub(isBeak)));

    mat.colorNode = col;

    // Soft plumage vs hard keratin
    let rough = float(0.78);
    rough = mix(rough, float(0.84), isBodyBelly);
    rough = mix(rough, float(0.72), isWing);
    rough = mix(rough, float(0.55), isAccent);
    rough = mix(rough, float(0.36), isBeak);
    rough = mix(rough, float(0.5), isLeg);
    rough = mix(rough, rough.add(0.06), grain.mul(float(1).sub(isBeak)));
    mat.roughnessNode = rough;

    let metal = float(0.02);
    metal = mix(metal, float(0.12), isBeak);
    metal = mix(metal, float(0.08).mul(uSheen.add(0.2)), isAccent);
    mat.metalnessNode = metal;

    mat.userData.birdPlumage = {
      uBase, uBelly, uAccent, uWing, uBeak, uLeg, uSheen,
    };
    return mat;
  } catch {
    return new THREE.MeshStandardMaterial({
      color: base,
      roughness: 0.74,
      metalness: 0.03,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
  }
}

/**
 * Resolve zone RGB → palette color on CPU (for probes / debug).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {{ color?: number, belly?: number, accent?: number, beakColor?: number, legColor?: number }} presentation
 */
export function resolveBirdZoneColor(r, g, b, presentation = {}) {
  const base = new THREE.Color(presentation.color ?? 0x6b6e66);
  const belly = new THREE.Color(presentation.belly ?? 0xd4d0c4);
  const accent = new THREE.Color(presentation.accent ?? 0x3a3c38);
  if (b < 0.2 && r + g > 0.5) {
    return base.clone().lerp(belly, THREE.MathUtils.clamp(g, 0, 1));
  }
  if (b > 0.6 && r + g < 0.5) return base.clone().lerp(accent, 0.45).multiplyScalar(0.78);
  if (r > 0.6 && g > 0.6 && b < 0.4) return accent.clone();
  if (r < 0.4 && g > 0.6 && b > 0.6) return new THREE.Color(presentation.beakColor ?? 0x2a2418);
  if (r > 0.6 && g < 0.4 && b > 0.6) return new THREE.Color(presentation.legColor ?? 0x3a3028);
  return base;
}
