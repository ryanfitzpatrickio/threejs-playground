/**
 * Plush shell-fur for the procedural dog.
 *
 * Target look: soft golden volume (ears/ruff/cheeks fluff), short face,
 * laid body coat — NOT upright grass, NOT painted plastic mesh.
 *
 * Recipe:
 * - enough shell height to read as a coat halo
 * - extrude mostly along normal near roots (volume), lean to groom at tips (lay)
 * - dense opaque mid-shells + soft outer haze (fuzzy silhouette)
 * - soft clump noise on outer shells only (no hard strand tubes)
 */

import * as THREE from 'three';
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  float,
  floor,
  fract,
  Fn,
  hash,
  mix,
  modelWorldMatrix,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  sub,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  max,
  min,
  dot,
  sqrt,
} from 'three/tsl';
import { COAT_ZONE } from './dogCoatFields.js';
import { MUD_DRY_SRGB, MUD_WET_SRGB } from '../../materials/rallyMudPalette.js';

/** Shell count — enough layers for soft volume without crushing performance. */
export const DEFAULT_SHELL_COUNT = 64;

/**
 * Shared CPU-driven fur dynamics uniforms.
 */
export function createDogFurUniforms(phenotype = null) {
  const coat = phenotype?.coat ?? {};
  const palette = coat.palette ?? {};
  return {
    time: uniform(0),
    breeze: uniform(0.14),
    breezeDir: uniform(new THREE.Vector3(1, 0.1, 0.35).normalize()),
    inertialBend: uniform(new THREE.Vector3(0, 0, 0)),
    impulse: uniform(new THREE.Vector3(0, 0, 0)),
    shellCount: uniform(DEFAULT_SHELL_COUNT),
    // Global height scale. Vertex furLength is absolute metres; 0.05 baseline.
    maxFurLength: uniform(0.065),
    // Tips droop so coat lays; not a stiff lawn.
    gravityDroop: uniform(coat.gravityDroop ?? 0.58),
    // Warm golden palette (ref head-close stills). These multiply the coat
    // albedo mix, so they stay near-white — root/tip are tints, not colors.
    rootColor: uniform(new THREE.Color(palette.root ?? 0xd8b57e)),
    tipColor: uniform(new THREE.Color(palette.tip ?? 0xf2d9a4)),
    undercoatColor: uniform(new THREE.Color(palette.undercoat ?? 0xecd6a4)),
    guardColor: uniform(new THREE.Color(palette.guard ?? 0xcf9440)),
    earInnerTint: uniform(new THREE.Vector3(...(coat.earInnerTint ?? [0.12, 0.045, 0.035]))),
    // Soft density field (lower = larger clumps, less grass blades).
    cellsPerMeter: uniform(coat.density ?? 420),
    waveAmpCells: uniform(0.1),
    nakedBody: uniform(0),
    keyDir: uniform(new THREE.Vector3(0.4, 0.82, 0.4).normalize()),
    keyColor: uniform(new THREE.Color(0xfff2e0)),
    fillColor: uniform(new THREE.Color(0xd8e4f0)),
    // Shared by the undercoat and every shell so mud never separates by layer.
    mudLowerCoverage: uniform(0),
    mudBodyCoverage: uniform(0),
    mudWetness: uniform(0),
    mudDryness: uniform(0),
    mudPawCoverage: uniform(new THREE.Vector4()),
    mudWetColor: uniform(new THREE.Color(MUD_WET_SRGB)),
    mudDryColor: uniform(new THREE.Color(MUD_DRY_SRGB)),
  };
}

/**
 * @typedef {ReturnType<typeof createDogFurUniforms>} DogFurUniforms
 */

const acesTonemap = Fn(([x]) => {
  const a = float(2.51);
  const b = float(0.03);
  const c = float(2.43);
  const d = float(0.59);
  const e = float(0.14);
  return clamp(x.mul(a.mul(x).add(b)).div(x.mul(c.mul(x).add(d)).add(e)), 0.0, 1.0);
});

function zoneMask(zone, id) {
  return step(float(id - 0.45), zone).mul(step(zone, float(id + 0.45)));
}

/** Irregular anatomical coating from the existing rest-position + zone streams. */
function dogMudMask(rest, zone, u) {
  const pawZone = zoneMask(zone, COAT_ZONE.paw);
  const legZone = zoneMask(zone, COAT_ZONE.leg);
  const bellyZone = zoneMask(zone, COAT_ZONE.belly);
  const bodyZone = zoneMask(zone, COAT_ZONE.body);
  const tailZone = zoneMask(zone, COAT_ZONE.tail);
  const earZone = zoneMask(zone, COAT_ZONE.ear);
  const left = step(float(0), rest.x);
  const front = step(float(0.18), rest.z);
  const frontPaw = mix(u.mudPawCoverage.x, u.mudPawCoverage.y, left);
  const hindPaw = mix(u.mudPawCoverage.z, u.mudPawCoverage.w, left);
  const localPaw = mix(hindPaw, frontPaw, front);
  const cell = floor(rest.mul(43.0));
  const irregular = mix(
    float(0.58),
    float(1.0),
    hash(cell.x.add(cell.y.mul(19.0)).add(cell.z.mul(71.0))),
  );
  const speckle = smoothstep(
    float(0.63),
    float(0.9),
    hash(cell.z.add(cell.x.mul(37.0)).add(cell.y.mul(101.0))),
  );

  const lower = pawZone.mul(max(u.mudLowerCoverage, localPaw))
    .add(legZone.mul(u.mudLowerCoverage).mul(irregular))
    .add(bellyZone.mul(u.mudLowerCoverage).mul(speckle).mul(0.24));
  const broadAnatomy = bodyZone.mul(irregular.mul(0.72).add(0.28))
    .add(bellyZone)
    .add(legZone.mul(0.86))
    .add(pawZone)
    .add(tailZone.mul(irregular).mul(0.82))
    // Partial ear spatters; the head/muzzle zones remain clean for face readability.
    .add(earZone.mul(speckle).mul(0.58));
  return clamp(max(lower, broadAnatomy.mul(u.mudBodyCoverage)), 0, 1);
}

/**
 * @param {DogFurUniforms} u
 * @param {number} layerIndex
 * @param {number} shellCount
 */
export function createDogShellMaterial(u, layerIndex, shellCount) {
  // Root + mid shells write depth so coat is solid; outer shells stay soft.
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: layerIndex <= Math.max(4, Math.floor(shellCount * 0.22)),
    side: THREE.DoubleSide,
  });

  const layer = float(layerIndex);
  const shells = float(Math.max(1, shellCount - 1));
  const layerT = layer.div(shells);

  const furLen = attribute('furLength', 'float');
  const groomDir = attribute('groomDir', 'vec3');
  const restPos = attribute('restPosition', 'vec3');
  const packedCoat = attribute('coatMask', 'float');
  const coatZone = floor(packedCoat.div(4.0));
  const coatPayload = packedCoat.sub(coatZone.mul(4.0));
  const mudMask = dogMudMask(restPos, coatZone, u);

  const wind = u.breezeDir.mul(u.breeze).mul(layerT).mul(layerT);
  const bend = u.inertialBend.add(u.impulse).mul(layerT).mul(0.6);
  const gravity = vec3(0, u.gravityDroop.negate().mul(layerT).mul(furLen), 0);

  const groomN = normalize(groomDir.add(wind).add(bend).add(gravity));
  // Volume near roots (normal), tips lean along groom → plush not grass.
  const extrudeDir = normalize(
    mix(normalLocal, groomN, float(0.22).add(layerT.mul(0.55))),
  );
  // Visible coat height (this was crushed when fur "disappeared").
  const shellHeight = furLen.mul(layerT).mul(u.maxFurLength.div(float(0.05)));
  // Wet mud clumps shells close to the body. Dry crust stays compressed until
  // shedding reduces the anatomical coverage mask.
  const mudCompression = mix(float(0.34), float(0.16), u.mudWetness);
  const extrude = extrudeDir.mul(shellHeight).mul(mix(float(1), mudCompression, mudMask));

  material.positionNode = positionLocal.add(extrude);

  const vRest = varying(restPos, 'vDogRest');
  const vLayerT = varying(layerT, 'vDogLayerT');
  const vGroom = varying(groomN, 'vDogGroom');
  const vFurLen = varying(furLen, 'vDogFurLen');
  const vMudMask = varying(mudMask, 'vDogMudMask');
  const vCoatMask = varying(coatPayload, 'vDogCoatMask');
  const vNormalW = varying(
    normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz),
    'vDogNormalW',
  );
  const vPosW = varying(positionWorld, 'vDogPosW');

  const strandAlpha = Fn(() => {
    const rest = vRest;
    const lt = vLayerT;
    const fl = vFurLen;

    // Soft multi-scale density (plush clumps, not thin grass tubes).
    const cellsA = rest.mul(u.cellsPerMeter);
    const cellsB = rest.mul(u.cellsPerMeter.mul(1.7));
    const idA = floor(cellsA);
    const idB = floor(cellsB);
    const uvA = fract(cellsA);
    const uvB = fract(cellsB);

    const hA = hash(idA.x.add(idA.y.mul(19.0)).add(idA.z.mul(131.0)));
    const hB = hash(idB.y.add(idB.z.mul(7.0)).add(idB.x.mul(53.0)));
    const hC = hash(idA.z.add(idA.x.mul(11.0)).add(idA.y.mul(97.0)));

    const dA = uvA.xy.sub(vec2(0.5, 0.5)).length();
    const dB = uvB.xz.sub(vec2(0.5, 0.5)).length();
    // Tight clumps with real gaps — long fur must read as strands, not drapes.
    const clumpA = smoothstep(float(0.75), float(0.05), dA);
    const clumpB = smoothstep(float(0.8), float(0.1), dB);
    const density = mix(float(0.42), float(1.0), hA)
      .mul(mix(float(0.6), float(1.0), clumpA))
      .mul(mix(float(0.8), float(1.0), clumpB));

    // Length variance — tips thin out as a soft halo. Wide spread so the
    // silhouette reads as fuzz, not scalloped petals.
    const strandLen = mix(float(0.5), float(1.0), hB);
    const beyond = lt.sub(strandLen);

    // Dense mid-coat (solid plush), soft outer haze only — kills ghost glass.
    const baseFill = mix(float(0.95), float(0.08), pow(lt, float(1.4)));
    const noiseAmt = smoothstep(float(0.15), float(0.7), lt);
    let alpha = baseFill.mul(mix(float(1.0), density, noiseAmt));
    alpha = alpha.mul(smoothstep(float(0.06), float(0.0), beyond));
    // Bare face (tiny furLen) kills shells.
    alpha = alpha.mul(smoothstep(float(0.0), float(0.0035), fl));
    // Controlled outer haze (not transparent mane).
    alpha = alpha.mul(mix(float(1.05), float(0.45), pow(lt, float(1.6))));
    alpha = clamp(alpha, float(0.0), float(1.0));
    alpha = mix(alpha, float(1.0).sub(step(float(0.001), lt)).mul(0.97), u.nakedBody);
    // Saturated wet clumps fill some shell gaps, avoiding a stippled shimmer.
    return mix(alpha, max(alpha.mul(0.68), float(0.48)), vMudMask.mul(u.mudWetness));
  });

  material.colorNode = Fn(() => {
    const lt = vLayerT;
    const groom = vGroom;
    const earInner = step(float(1.5), vCoatMask);
    const coat = vCoatMask.sub(earInner.mul(2.0));
    const nW = normalize(vNormalW);
    const pW = vPosW;

    const coatCol = mix(u.undercoatColor, u.guardColor, coat);
    const innerCol = coatCol.mul(0.42).add(u.earInnerTint);
    const baseCol = mix(coatCol, innerCol, earInner.mul(0.78));
    const rootCol = baseCol.mul(u.rootColor).mul(float(0.9));
    const tipCol = baseCol.mul(u.tipColor).mul(float(1.0));
    const rest = vRest;
    const cellN = hash(floor(rest.mul(140.0)).x.add(floor(rest.mul(140.0)).y.mul(17.0)));
    const cleanCol = mix(rootCol, tipCol, pow(lt, float(0.95))).mul(mix(float(0.94), float(1.06), cellN));
    const mudCol = mix(u.mudWetColor, u.mudDryColor, u.mudDryness);
    const col = mix(cleanCol, mudCol, vMudMask.mul(0.94));

    const L = normalize(u.keyDir);
    const NdotL = dot(nW, L);
    const wrap = NdotL.mul(0.4).add(0.6);
    const diffuse = col.mul(u.keyColor).mul(wrap.mul(0.7).add(0.18));

    const hemi = mix(vec3(0.3, 0.24, 0.18), vec3(0.58, 0.62, 0.66), nW.y.mul(0.5).add(0.5));
    const ambient = col.mul(hemi).mul(0.35);

    const fillL = normalize(vec3(-0.55, 0.35, -0.25));
    const fill = col.mul(u.fillColor).mul(max(float(0.0), dot(nW, fillL)).mul(0.22));

    // Soft sheen along groom (plush highlight, not plastic).
    const T = normalize(modelWorldMatrix.mul(vec4(groom, 0.0)).xyz);
    const V = normalize(cameraPosition.sub(pW));
    const TdotV = dot(T, V);
    const TdotL = dot(T, L);
    const sinTV = sqrt(max(float(0.0), sub(float(1.0), TdotV.mul(TdotV))));
    const sinTL = sqrt(max(float(0.0), sub(float(1.0), TdotL.mul(TdotL))));
    const kk = pow(max(float(0.0), sinTV.mul(sinTL).sub(TdotV.mul(TdotL))), float(48.0));
    const sheen = vec3(1.0, 0.97, 0.9).mul(kk).mul(0.12).mul(lt);

    // Tight wet highlight; it vanishes continuously through the drying phase.
    const H = normalize(L.add(V));
    const wetSpec = vec3(1.0, 0.94, 0.82)
      .mul(pow(max(float(0), dot(nW, H)), float(96)))
      .mul(vMudMask)
      .mul(u.mudWetness)
      .mul(0.55);

    // Rim on tips — reads as soft fur edge against the backdrop.
    const rim = pow(sub(float(1.0), max(float(0.0), dot(nW, V))), float(2.4)).mul(lt);
    const rimCol = vec3(1.0, 0.95, 0.86).mul(rim).mul(0.16);

    return acesTonemap(diffuse.add(ambient).add(fill).add(sheen).add(wetSpec).add(rimCol));
  })();

  material.opacityNode = strandAlpha();
  material.userData.dogFurUniforms = u;
  material.userData.dogMudUniforms = u;

  return material;
}

/**
 * @param {DogFurUniforms} u
 */
export function createDogBodyMaterial(u) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.02,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  // Slightly darker undercoat so shell gaps read as depth, not holes.
  const packedCoat = attribute('coatMask', 'float');
  const restPos = attribute('restPosition', 'vec3');
  const coatZone = floor(packedCoat.div(4.0));
  const coatPayload = packedCoat.sub(coatZone.mul(4.0));
  const earInner = step(float(1.5), coatPayload);
  const coat = coatPayload.sub(earInner.mul(2.0));
  const coatCol = mix(u.undercoatColor.mul(0.9), u.guardColor.mul(0.88), coat);
  const innerCol = coatCol.mul(0.42).add(u.earInnerTint);
  const cleanCol = mix(coatCol, innerCol, earInner.mul(0.78));
  const mudMask = dogMudMask(restPos, coatZone, u);
  const mudCol = mix(u.mudWetColor, u.mudDryColor, u.mudDryness);
  material.colorNode = mix(cleanCol, mudCol, mudMask.mul(0.96));
  material.roughnessNode = mix(float(0.88), float(0.3), mudMask.mul(u.mudWetness));
  material.userData.dogFurUniforms = u;
  material.userData.dogMudUniforms = u;
  return material;
}

export class DogFurDynamics {
  /**
   * @param {DogFurUniforms} uniforms
   */
  constructor(uniforms) {
    this.u = uniforms;
    this.vel = new THREE.Vector3();
    this.bend = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.prevRoot = new THREE.Vector3();
    this.hasPrev = false;
    this.stiffness = 14;
    this.damping = 9;
    this._tmp = new THREE.Vector3();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} rootWorldPos
   * @param {{ breeze?: number, breezeDir?: THREE.Vector3, time?: number }} [opts]
   */
  update(dt, rootWorldPos, opts = {}) {
    const t = Math.min(dt, 1 / 20);
    if (opts.time != null) this.u.time.value = opts.time;
    if (opts.breeze != null) this.u.breeze.value = opts.breeze;
    if (opts.breezeDir) this.u.breezeDir.value.copy(opts.breezeDir).normalize();

    if (!this.hasPrev) {
      this.prevRoot.copy(rootWorldPos);
      this.hasPrev = true;
    }

    this._tmp.copy(rootWorldPos).sub(this.prevRoot).divideScalar(Math.max(t, 1e-4));
    const accel = this._tmp.clone().sub(this.vel);
    this.vel.lerp(this._tmp, 1 - Math.exp(-10 * t));
    this.prevRoot.copy(rootWorldPos);

    const target = accel.multiplyScalar(-0.03);
    const force = target.sub(this.bend).multiplyScalar(this.stiffness);
    this.bend.addScaledVector(force, t);
    this.bend.addScaledVector(this.impulse, t);
    this.bend.multiplyScalar(Math.exp(-this.damping * t));
    this.impulse.multiplyScalar(Math.exp(-6 * t));

    this.u.inertialBend.value.copy(this.bend);
    this.u.impulse.value.copy(this.impulse);
  }

  /**
   * @param {THREE.Vector3} v
   */
  addImpulse(v) {
    this.impulse.add(v);
  }

  setNaked(on) {
    this.u.nakedBody.value = on ? 1 : 0;
  }
}
