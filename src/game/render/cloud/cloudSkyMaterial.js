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
  abs,
  dot,
  normalize,
  smoothstep,
  select,
  mix,
  clamp,
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
  material.fog = false;
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
    const dir = normalize(dirRaw);
    // BackSide sky sphere still draws below the horizon. Clamping every sub-horizon
    // ray to y=0.001 collapsed the whole lower dome to one LUT sample (flat band).
    // Mirror elevation gently so the lower sky keeps variation without marching
    // through the planet.
    const marchY = max(select(dir.y.lessThan(0), abs(dir.y).mul(0.22), dir.y), float(0.001));
    const marchDir = normalize(vec3(dir.x, marchY, dir.z));

    // Observer at sea level (camera altitude in dreamfall is ~metres → ~0 km).
    const originY = EARTH_R.add(0.001);
    // Ray/atmosphere-shell intersection (use marchDir — same ray as the integral).
    const b = float(2).mul(originY).mul(marchDir.y);
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

      const sx = marchDir.x.mul(dist);
      const sy = originY.add(marchDir.y.mul(dist));
      const sz = marchDir.z.mul(dist);
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
    const cosT = dot(marchDir, sunDir);
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

    // Multi-scatter LUT sampled at view elevation — the old fixed v=0.02 was
    // ground-bounce grey and washed the zenith to white.
    const msUv = vec2(
      sunDir.y.mul(0.5).add(0.5),
      clamp(marchDir.y.mul(0.5).add(0.5), float(0.04), float(0.98)),
    );
    const multiScatter = multiScatterNode
      .sample(msUv)
      .rgb
      .mul(uAtmosphereSkyMultiScatter);
    const skyLinear = scatter.add(multiScatter).mul(uSunIntensity);
    // Artistic zenith saturation — physical march is milky at our short sample count.
    // Lighter blues than the old cobalt (0.38/0.58/1.12) so clear midday feels airy.
    const zenith = smoothstep(0.06, 0.78, marchDir.y);
    const zenithTint = mix(vec3(0.88, 0.92, 0.98), vec3(0.58, 0.74, 1.04), zenith);
    const sky = skyLinear.mul(zenithTint);

    // Sun disc: soft circle around the sun direction, brightened through the
    // transmittance at the sun's elevation. Wider soft falloff (×0.2 core) so the
    // disc reads as a broad glow rather than a hard pin.
    const mu = dot(marchDir, sunDir);
    const disc = smoothstep(float(1).sub(uSunDiscSize), float(1).sub(uSunDiscSize.mul(0.2)), mu);
    const corona = smoothstep(
      float(1).sub(uSunDiscSize.mul(3.2)),
      float(1).sub(uSunDiscSize.mul(0.55)),
      mu,
    ).mul(0.22);
    const tHorizon = transmittanceNode
      .sample(vec2(sunDir.y.mul(0.5).add(0.5), 0))
      .rgb;
    const discColor = uSunColor
      .mul(tHorizon)
      .mul(uSunIntensity)
      .mul(disc.add(corona))
      .mul(sunDisc ? 18 : 0);

    return vec4(sky.add(discColor), 1);
  });
}
