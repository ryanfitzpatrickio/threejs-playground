// LUT-atmosphere sky shader. A MeshBasicNodeMaterial whose `colorNode` marches a
// view ray through the atmosphere shell (planet-sphere math in km — the sky is a
// visual backdrop, independent of dreamfall's flat metre-scale gameplay world)
// and accumulates single-scatter Rayleigh + Mie light, sampling the
// transmittance LUT for the sun-direction transmittance at each sample.
//
// This is the sky reference source P1 sky material (analysis §3.2), including the
// transmittance and compact multiple-scattering LUTs.
//
// The material goes on a small sphere glued to the camera (BackSide,
// depthTest/depthWrite off, renderOrder -1000); `positionWorld - cameraPosition`
// therefore reduces to a pure direction, so the sphere radius is irrelevant.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  positionWorld,
  cameraPosition,
  float,
  vec2,
  vec3,
  vec4,
  Loop,
  exp,
  sqrt,
  pow,
  max,
  min,
  dot,
  normalize,
  smoothstep,
} from 'three/tsl';
import { ATMOSPHERE } from './cloudConfig.js';
import {
  uSunDirection,
  uSunIntensity,
  uSunColor,
  uSunDiscSize,
  uAtmosphereRayleigh,
  uAtmosphereTurbidity,
  uAtmosphereMieG,
  uAtmosphereMieStrength,
  uAtmosphereSkyMultiScatter,
} from './cloudUniforms.js';

const PI = Math.PI;

export function createSkyMaterial(transmittanceNode, multiScatterNode, { sunDisc = true } = {}) {
  const material = new MeshBasicNodeMaterial();
  material.name = 'cloud.sky';
  material.depthWrite = false;
  material.depthTest = false;
  material.side = THREE.BackSide;
  // The scene pass captures this in linear HDR (matching the SkyMesh path);
  // tone mapping happens once at the RenderPipeline output.
  material.colorNode = buildSkyFn(transmittanceNode, multiScatterNode, sunDisc)();
  return material;
}

function buildSkyFn(transmittanceNode, multiScatterNode, sunDisc) {
  const A = ATMOSPHERE;
  const SAMPLES = A.SKY_MARCH_SAMPLES;
  return Fn(() => {
    const EARTH_R = float(A.EARTH_R_KM);
    const ATMO_R = float(A.ATMO_R_KM);
    const Hr = float(A.RAYLEIGH_SCALE_HEIGHT_KM);
    const Hm = float(A.MIE_SCALE_HEIGHT_KM);
    const THICK = float(A.THICKNESS_KM);
    const MIE_EXT = float(A.MIE_EXTINCTION_FACTOR);

    const betaR = vec3(
      A.RAYLEIGH_BETA_RGB_KM[0],
      A.RAYLEIGH_BETA_RGB_KM[1],
      A.RAYLEIGH_BETA_RGB_KM[2],
    ).mul(uAtmosphereRayleigh);
    const mieBase = float(A.MIE_BETA_BASE_KM).mul(uAtmosphereTurbidity);
    const betaM = vec3(mieBase, mieBase, mieBase);

    const sunDir = uSunDirection;
    const dirRaw = positionWorld.sub(cameraPosition);
    const clampedY = max(dirRaw.y, float(0.001));
    const dir = normalize(vec3(dirRaw.x, clampedY, dirRaw.z));

    // Observer at sea level (camera altitude in dreamfall is ~metres → ~0 km).
    const originY = EARTH_R.add(0.001);
    // Ray/atmosphere-shell intersection: origin = (0, originY, 0), |dir|=1.
    const b = float(2).mul(originY).mul(dir.y);
    const c = originY.mul(originY).sub(ATMO_R.mul(ATMO_R));
    const discAtmo = max(b.mul(b).sub(float(4).mul(c)), 0);
    const tFar = max(b.negate().add(sqrt(discAtmo)).div(2), 0);
    const step = float(2).mul(tFar).div(SAMPLES);

    const tauR = float(0).toVar();
    const tauM = float(0).toVar();
    const accumR = vec3(0, 0, 0).toVar();
    const accumM = vec3(0, 0, 0).toVar();

    Loop(SAMPLES, ({ i }) => {
      const no = float(i).add(0.5).div(SAMPLES);
      const dist = no.mul(no).mul(tFar); // quadratic: denser sampling near the ground
      const wn = no.mul(step);

      const sx = dir.x.mul(dist);
      const sy = originY.add(dir.y.mul(dist));
      const sz = dir.z.mul(dist);
      const r = sqrt(sx.mul(sx).add(sy.mul(sy)).add(sz.mul(sz)));
      const altitude = max(r.sub(EARTH_R), 0);
      const hr = exp(altitude.negate().div(Hr));
      const hm = exp(altitude.negate().div(Hm));
      tauR.addAssign(hr.mul(wn));
      tauM.addAssign(hm.mul(wn));

      const cosSun = sx.mul(sunDir.x).add(sy.mul(sunDir.y)).add(sz.mul(sunDir.z)).div(r);
      const lutUV = vec2(cosSun.mul(0.5).add(0.5), altitude.div(THICK));
      const tSample = transmittanceNode.sample(lutUV).rgb;

      const ext = betaR.mul(tauR).add(betaM.mul(MIE_EXT).mul(tauM));
      const s = exp(ext.negate()).mul(tSample);
      accumR.addAssign(s.mul(hr).mul(wn));
      accumM.addAssign(s.mul(hm).mul(wn));
    });

    // Phase functions.
    const cosT = dot(dir, sunDir);
    const cosT2 = cosT.mul(cosT);
    const rayleighPhase = float(3).div(float(16).mul(PI)).mul(float(1).add(cosT2));
    const g = uAtmosphereMieG;
    const g2 = g.mul(g);
    const denom = max(float(1).add(g2).sub(float(2).mul(g).mul(cosT)), 0.001);
    const miePhase = float(3)
      .mul(float(1).sub(g2))
      .div(float(8).mul(PI).mul(float(2).add(g2)))
      .mul(float(1).add(cosT2))
      .div(denom.mul(sqrt(denom)));

    const scatter = betaR
      .mul(accumR)
      .mul(rayleighPhase)
      .add(betaM.mul(accumM).mul(miePhase).mul(uAtmosphereMieStrength));

    const multiScatter = multiScatterNode
      .sample(vec2(sunDir.y.mul(0.5).add(0.5), 0.02))
      .rgb
      .mul(uAtmosphereSkyMultiScatter);
    const sky = scatter.add(multiScatter).mul(uSunIntensity);

    // Sun disc: soft circle around the sun direction, brightened through the
    // transmittance at the sun's elevation.
    const mu = dot(dir, sunDir);
    const disc = smoothstep(float(1).sub(uSunDiscSize), float(1).sub(uSunDiscSize.mul(0.5)), mu);
    const tHorizon = transmittanceNode
      .sample(vec2(sunDir.y.mul(0.5).add(0.5), 0))
      .rgb;
    const discColor = uSunColor.mul(tHorizon).mul(uSunIntensity).mul(disc).mul(sunDisc ? 20 : 0);

    return vec4(sky.add(discColor), 1);
  });
}
