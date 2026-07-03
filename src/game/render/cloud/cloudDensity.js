// TSL building blocks for cloud density + scattering phase, ported from the
// sky reference source `qc` density function (analysis §4.2) and its phase helpers (§4.3).
// Pure node graph — no render targets, no control flow, so these are plain
// functions returning node expressions (no `Fn` wrapping needed); the march and
// light-march nodes inline them.
//
// Coordinate frame: flat horizontal slab. `pos` is in world metres; the density
// function tiles clouds around the camera in XZ via `uWindOffset` and skews the
// 3D sample position by height so taller clouds lean with the wind.

import {
  dot,
  vec3,
  max,
  smoothstep,
  mix,
  pow,
  oneMinus,
  float,
  exp,
} from 'three/tsl';
import {
  uCloudAltitude,
  uCloudThickness,
  uCloudCoverage,
  uCloudBaseScale,
  uCloudErosionScale,
  uCloudBaseStrength,
  uCloudErosionStrengthBase,
  uCloudErosionStrengthPeak,
  uCloudErosionShape,
  uCloudEdgeSoftness,
  uCloudEdgeSoftnessFalloff,
  uCloudWeatherScale,
  uWindOffset,
  uWindDirection,
  uWindSkew,
  uEvolution,
} from './cloudUniforms.js';

const BASE_CHANNEL_WEIGHTS = vec3(0.7, 0.41, 0.23); // combined additively for base mass
const EROSION_CHANNEL_WEIGHTS = vec3(0.113, 0.04, 0.02); // subtracted for erosion

// Henyey–Greenstein phase (1/(4π) prefactor absorbed into the caller's intensity).
export function henyeyGreenstein(cosTheta, g) {
  const g2 = g.mul(g);
  const denom = float(1).add(g2).sub(float(2).mul(g).mul(cosTheta));
  return float(1)
    .sub(g2)
    .div(denom.mul(denom.sqrt()).mul(denom.sqrt()))
    .mul(float(1).div(float(4).mul(3.14159265359)));
}

// Three scattering orders approximate the broad forward lobe plus the softer
// light that has bounced inside the cloud volume.
export function multiPhase(cosTheta) {
  return henyeyGreenstein(cosTheta, float(0.8))
    .add(henyeyGreenstein(cosTheta, float(0.4)).mul(0.5))
    .add(henyeyGreenstein(cosTheta, float(0.15)).mul(0.25))
    .div(1.75);
}

// Powder effect: darkens dense cloud edges looking toward the light.
export function powder(extinction, strength) {
  return mix(float(1), float(1).sub(exp(extinction.mul(2).negate())), strength);
}

// Convert a world position to its fraction within the slab [0 = bottom, 1 = top].
export function shellHeightFractionAt(pos) {
  return pos.y.sub(uCloudAltitude).div(uCloudThickness);
}

// Full density at a slab point. `shellHeightFraction` should come from
// `shellHeightFractionAt(pos)` (passed in so the march can reuse it).
export function sampleCloudDensity({ pos, shellHeightFraction, weatherNode, baseShapeNode }) {
  const coverage = uCloudCoverage;

  // Weather UV follows the camera in XZ (no height skew).
  const weatherUV = pos.xz.sub(uWindOffset.xz);
  // Base-shape sample position is height-skewed along the wind direction so
  // clouds lean with altitude, plus an evolving offset for animation.
  const skewOffset = uWindDirection.mul(uWindSkew.mul(max(shellHeightFraction, 0)));
  const evolutionOffset = uWindDirection.mul(uEvolution);
  const samplePos = pos.sub(uWindOffset).sub(skewOffset).add(evolutionOffset);

  const weather = weatherNode.sample(weatherUV.div(uCloudWeatherScale));
  const base = baseShapeNode.sample(samplePos.div(uCloudBaseScale));

  const baseMass = dot(base.rgb, BASE_CHANNEL_WEIGHTS).mul(uCloudBaseStrength).toVar();

  // Erosion: subtract a higher-frequency channel combine, weighted by height.
  const eroded = baseShapeNode.sample(samplePos.div(uCloudErosionScale)).rgb;
  const erosionField = mix(oneMinus(eroded), eroded, uCloudErosionShape);
  const erosionWeight = mix(uCloudErosionStrengthBase, uCloudErosionStrengthPeak, shellHeightFraction);
  const erosion = dot(erosionField, EROSION_CHANNEL_WEIGHTS).mul(erosionWeight).negate();
  baseMass.addAssign(erosion);

  const coverageField = weather.r.add(coverage.sub(1)).add(baseMass.mul(coverage));

  // Edge softness scales with altitude (metres): sharper near the slab floor,
  // softer higher up.
  const heightMetres = max(shellHeightFraction, 0).mul(uCloudThickness).mul(0.001);
  const softness = max(
    uCloudEdgeSoftness.div(pow(max(uCloudEdgeSoftnessFalloff, 0.001), heightMetres)),
    0.0001,
  );

  const top = smoothstep(softness.negate(), softness, coverageField.sub(shellHeightFraction));
  const bottom = smoothstep(
    softness.negate(),
    softness,
    shellHeightFraction.sub(erosion.mul(coverage)),
  );
  return max(top.mul(bottom), 0);
}

// Build density closures bound to specific noise texture nodes. Returned
// `sample({pos, shellHeightFraction})` is what the march calls.
export function createCloudDensityFns({ weatherNode, baseShapeNode }) {
  return {
    shellHeightFractionAt,
    sample: ({ pos, shellHeightFraction }) =>
      sampleCloudDensity({ pos, shellHeightFraction, weatherNode, baseShapeNode }),
  };
}
