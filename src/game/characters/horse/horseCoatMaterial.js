/**
 * Horse v2 coat — TSL shell fur + undercoat + shared uniforms.
 *
 * Same proven shell architecture as the cat/dog/goose coats: N skinned shell
 * copies extruded along the surface normal in positionNode, each a
 * MeshBasicNodeMaterial with in-shader lighting (wrap diffuse + hemisphere
 * ambient + Kajiya-Kay anisotropic sheen along the groom tangent + tip
 * rim/backlight + root AO + in-shader ACES), plus a MeshStandardNodeMaterial
 * undercoat so shell gaps read as depth.
 *
 * Equine specifics:
 *  - The body coat is SHORT and glossy (strong Kajiya-Kay, high strand
 *    density: rest-position hashing at ~1200–1500 strand cells per meter on
 *    the body) while mane / forelock / tail zones grow LONG coherent strands
 *    with a wind wave whose amplitude is capped to avoid popping.
 *  - Bay coat definition is layered per-pixel on bind-space rest position:
 *    red-brown base with countershading, BLACK points (lower legs, mane,
 *    tail, muzzle, ear rims), a white star/blaze on the forehead midline,
 *    seed-varied white socks, subtle dapples on the quarters, and a roaning
 *    knob. Hooves are dark horn (pale under a white sock).
 *  - CPU spring integrators (HorseFurDynamics) feed inertial bend, breeze,
 *    and a mane/tail sway phase to the shader via uniforms.
 */

import * as THREE from 'three';
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  hash,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  normalLocal,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  sub,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { HORSE_ZONE } from './horseBodyGeometry.js';
import { HORSE_DIMS } from './horseSkeleton.js';

/** Hero shell stack (spec 80–100); NPC budgets thin far below this. */
export const HORSE_SHELL_COUNT = 88;

const D = HORSE_DIMS;

/** Photo-sampled bay palette (sRGB floats, equid-ref board). */
export const HORSE_COLORS = Object.freeze({
  bay: [0.42, 0.20, 0.095],        // red-brown body
  bayBright: [0.55, 0.28, 0.13],   // sun-caught shoulder/quarter
  bayShadow: [0.27, 0.125, 0.06],  // under-belly / girth shadow
  point: [0.055, 0.045, 0.045],    // black points (legs / mane / tail)
  pointWarm: [0.12, 0.08, 0.06],   // rusty cast where black meets bay
  muzzleGrey: [0.16, 0.14, 0.135], // soft grey-black muzzle leather
  white: [0.93, 0.915, 0.89],      // star / blaze / socks
  hoof: [0.22, 0.185, 0.155],      // dark horn
  hoofPale: [0.62, 0.55, 0.44],    // unpigmented hoof under a white sock
  innerEar: [0.35, 0.24, 0.18],
  eyeDark: [0.045, 0.032, 0.028],  // deep brown equine eye
  iris: [0.30, 0.17, 0.09],
});

export function createHorseUniforms() {
  return {
    time: uniform(0),
    breeze: uniform(0.12),
    breezeDir: uniform(new THREE.Vector3(1, 0.08, 0.3).normalize()),
    inertialBend: uniform(new THREE.Vector3()),
    impulse: uniform(new THREE.Vector3()),
    maneSway: uniform(0),                // spring-integrated mane/tail swing phase
    maxFurLen: uniform(1),
    nakedBody: uniform(0),
    // coat definition knobs (seed-varied in createProceduralHorse)
    blazeAmt: uniform(0.35),             // 0 star only … 1 full blaze stripe
    sockFL: uniform(1),                  // per-leg white sock gates
    sockFR: uniform(0),
    sockHL: uniform(0),
    sockHR: uniform(0),
    dappleAmt: uniform(0.3),
    roanAmt: uniform(0.0),
    coatGloss: uniform(0.9),             // summer-slick ↔ winter-matte
    // lighting rig (studio defaults; harness presets remap the key)
    keyDir: uniform(new THREE.Vector3(0.42, 0.78, 0.42).normalize()),
    keyColor: uniform(new THREE.Color(1.0, 0.98, 0.95)),
    fillColor: uniform(new THREE.Color(0.72, 0.78, 0.86)),
    hemiSky: uniform(new THREE.Color(0.62, 0.66, 0.71)),
    hemiGround: uniform(new THREE.Color(0.36, 0.34, 0.31)),
    exposure: uniform(1.0),
  };
}

/** @typedef {ReturnType<typeof createHorseUniforms>} HorseUniforms */

const acesTonemap = Fn(([x]) => {
  const a = float(2.51);
  const b = float(0.03);
  const c = float(2.43);
  const d = float(0.59);
  const e = float(0.14);
  return clamp(x.mul(a.mul(x).add(b)).div(x.mul(c.mul(x).add(d)).add(e)), 0.0, 1.0);
});

const hash2 = Fn(([p]) => hash(p.x.add(p.y.mul(57.3))));
const hash3 = Fn(([p]) => hash(p.x.mul(0.31).add(p.y.mul(57.3)).add(p.z.mul(113.7))));

function zoneIs(zone, id) {
  return step(float(id - 0.45), zone).mul(step(zone, float(id + 0.45)));
}

/**
 * Bay coat masks evaluated per-pixel on bind-space rest position, so edges
 * stay sharp at any resolution and stable under skinning.
 * @param {*} u uniforms
 * @param {*} rest vec3 bind-space position
 * @param {*} coat vec2 (s,t) coat UV
 * @param {*} zone float
 */
export function horseAlbedo(u, rest, coat, zone) {
  const C = (k) => vec3(...HORSE_COLORS[k]);

  const y = rest.y;
  const z = rest.z;
  const x = rest.x;
  const ax = abs(x);

  // ---- base bay with countershading + muscle-following tone ----------------
  // Brighter over the shoulder/quarter masses, deep shadow under the belly.
  const topLight = smoothstep(float(0.9), float(1.5), y);
  const muscleGlow = hash3(vec3(floor(x.mul(3.0)), floor(y.mul(3.0)), floor(z.mul(3.0)))).mul(0.25);
  let col = mix(C('bayShadow'), C('bay'), smoothstep(float(0.85), float(1.25), y));
  col = mix(col, C('bayBright'), topLight.mul(0.45).add(muscleGlow.mul(topLight)));

  // ---- dapples: soft low-frequency rosettes over croup + barrel -------------
  const dcell = hash3(vec3(floor(x.mul(11.0)), floor(y.mul(11.0)), floor(z.mul(11.0))));
  const dappleMask = smoothstep(float(0.55), float(0.9), dcell)
    .mul(smoothstep(float(1.05), float(1.35), y))               // upper body only
    .mul(smoothstep(float(0.7), float(0.2), z.mul(z)));         // fade toward chest & rump ends
  col = mix(col, C('bayBright'), dappleMask.mul(u.dappleAmt).mul(0.5));

  // ---- roaning: fine white ticking through the body coat --------------------
  const tick = hash2(vec2(floor(coat.x.mul(160.0)), floor(coat.y.mul(160.0))));
  col = mix(col, C('white'), step(float(0.82), tick).mul(u.roanAmt).mul(0.55)
    .mul(smoothstep(float(0.6), float(1.0), y)));

  // ---- BLACK POINTS: lower legs blend to black below knee/hock --------------
  // (bay defining trait — ragged upper edge via cell noise)
  const rag = hash3(vec3(floor(x.mul(40.0)), floor(y.mul(24.0)), floor(z.mul(40.0)))).sub(0.5).mul(0.10);
  const pointMask = smoothstep(float(0.62), float(0.34), y.add(rag));
  const pointCol = mix(C('point'), C('pointWarm'), tick.mul(0.35));
  col = mix(col, pointCol, pointMask);

  // ---- white socks (seed-gated per leg) — override the black point ---------
  // Leg identity from bind-space quadrant: fore z>0.3, hind z<-0.3.
  const inFore = smoothstep(float(0.3), float(0.45), z);
  const inHind = smoothstep(float(-0.3), float(-0.45), z);
  const isL = step(float(0.0), x);
  const sockGate = inFore.mul(isL).mul(u.sockFL)
    .add(inFore.mul(sub(float(1.0), isL)).mul(u.sockFR))
    .add(inHind.mul(isL).mul(u.sockHL))
    .add(inHind.mul(sub(float(1.0), isL)).mul(u.sockHR));
  const sockBand = smoothstep(float(0.20), float(0.13), y.add(rag.mul(0.5)));
  const sockM = clamp(sockGate.mul(sockBand), 0.0, 1.0);
  col = mix(col, C('white'), sockM);

  // ---- face: star / blaze on the forehead midline ---------------------------
  // Star: small diamond around [0, 1.85, 1.30]; blazeAmt stretches it down the
  // nasal line toward the muzzle.
  const starD = ax.div(0.022).add(abs(y.sub(1.85)).div(0.045)).add(abs(z.sub(1.30)).div(0.05));
  const star = smoothstep(float(1.15), float(0.75), starD);
  const stripe = smoothstep(float(0.016), float(0.006), ax)
    .mul(smoothstep(float(1.86), float(1.80), y).mul(smoothstep(float(1.48), float(1.56), y.add(z.sub(1.3)))))
    .mul(smoothstep(float(1.26), float(1.34), z))
    .mul(u.blazeAmt);
  const faceWhite = clamp(star.add(stripe), 0.0, 1.0);
  col = mix(col, C('white'), faceWhite);

  // ---- muzzle leather + nostril shadow --------------------------------------
  const isNose = zoneIs(zone, HORSE_ZONE.nose);
  const noseMottle = hash2(vec2(floor(x.mul(200.0)), floor(y.mul(180.0))));
  col = mix(col, mix(C('muzzleGrey'), C('point'), noseMottle.mul(0.5)), isNose);
  // painted nostril comma: dark ellipse beside the nose tip
  const nl = ax.sub(float(0.047)).div(0.018);
  const nostril = smoothstep(float(1.2), float(0.5),
    nl.mul(nl).add(abs(y.sub(1.503)).div(0.016).mul(abs(y.sub(1.503)).div(0.016)))
      .add(abs(z.sub(1.487)).div(0.024).mul(abs(z.sub(1.487)).div(0.024))));
  col = mix(col, vec3(0.02, 0.016, 0.016), nostril.mul(smoothstep(float(1.4), float(1.46), z)));

  // ---- mane / forelock / tail: black hair ----------------------------------
  const isMane = zoneIs(zone, HORSE_ZONE.mane);
  const isTail = zoneIs(zone, HORSE_ZONE.tail);
  const hairTick = mix(C('point'), C('pointWarm'), tick.mul(0.3));
  col = mix(col, hairTick, isMane.add(isTail.mul(smoothstep(float(1.45), float(1.30), y))));
  // dock top blends bay → black
  col = mix(col, C('point'), isTail.mul(smoothstep(float(1.50), float(1.30), y)));

  // ---- ears: bay outer, black rim + tips, warm inner ------------------------
  const isEar = zoneIs(zone, HORSE_ZONE.ear);
  const earTipDark = smoothstep(float(2.02), float(2.09), y);
  col = mix(col, mix(mix(col, C('innerEar'), float(0.35)), C('point'), earTipDark), isEar);

  // ---- hooves: dark horn with growth-ring striations; pale under socks ------
  const isHoof = zoneIs(zone, HORSE_ZONE.hoof);
  const ring = sin(y.mul(240.0)).mul(0.5).add(0.5);
  const hoofCol = mix(mix(C('hoof'), C('hoofPale'), sockGate), vec3(0.08, 0.07, 0.06), ring.mul(0.18));
  col = mix(col, hoofCol, isHoof);

  // ---- eye: deep brown orb, painted iris ring + horizontal pupil + caustic --
  const isEye = zoneIs(zone, HORSE_ZONE.eye);
  const ey = y.sub(float(D.eyeY));
  const ez = z.sub(float(D.eyeZ));
  const rr = ey.mul(ey).add(ez.mul(ez));
  let eyeCol = mix(C('iris'), C('eyeDark'), smoothstep(float(0.00012), float(0.0005), rr));
  // horizontal-slab pupil (equine): dark band around eye centre height
  const pupil = smoothstep(float(0.011), float(0.006), abs(ey)).mul(smoothstep(float(0.018), float(0.010), abs(ez)));
  eyeCol = mix(eyeCol, C('eyeDark'), pupil);
  // corneal caustic glint high-forward
  const glint = smoothstep(float(0.0075), float(0.002), abs(ey.sub(0.011)).add(abs(ez.sub(0.008))));
  eyeCol = mix(eyeCol, vec3(0.95, 0.97, 0.99), glint.mul(0.9));
  col = mix(col, eyeCol, isEye);

  // ---- sheen strength: slick summer bay, satin points, matte hair/leather ---
  let sheenAmt = float(0.22).mul(u.coatGloss);
  sheenAmt = mix(sheenAmt, float(0.12), pointMask);
  sheenAmt = mix(sheenAmt, float(0.06), sockM.add(faceWhite));
  sheenAmt = mix(sheenAmt, float(0.30), isMane.add(isTail));  // hair highlights
  sheenAmt = mix(sheenAmt, float(0.02), isNose);
  sheenAmt = mix(sheenAmt, float(0.35), isHoof);
  sheenAmt = mix(sheenAmt, float(0.6), isEye);                // wet cornea
  sheenAmt = clamp(sheenAmt, 0.0, 1.0);

  return { albedo: col, sheenAmt, pointMask, sockM, faceWhite };
}

/** Shared in-shader lighting for shells (studio-matched, ACES at the end). */
function horseShade(u, albedo, sheenAmt, nW, pW, groomW, layerT) {
  const L = normalize(u.keyDir);
  const NdotL = dot(nW, L);
  const wrap = NdotL.mul(0.5).add(0.5);
  const diffuse = albedo.mul(u.keyColor).mul(wrap.mul(0.82).add(0.12));

  const hemi = mix(u.hemiGround, u.hemiSky, nW.y.mul(0.5).add(0.5));
  const ambient = albedo.mul(hemi).mul(0.4);

  const fillL = normalize(vec3(-0.5, 0.3, -0.35));
  const fill = albedo.mul(u.fillColor).mul(max(float(0.0), dot(nW, fillL)).mul(0.2));

  // Kajiya-Kay sheen along the groom tangent — the glossy horse-coat signature.
  const T = normalize(groomW);
  const V = normalize(cameraPosition.sub(pW));
  const TdotV = dot(T, V);
  const TdotL = dot(T, L);
  const sinTV = sqrt(max(float(0.0), sub(float(1.0), TdotV.mul(TdotV))));
  const sinTL = sqrt(max(float(0.0), sub(float(1.0), TdotL.mul(TdotL))));
  const kk = pow(max(float(0.0), sinTV.mul(sinTL).sub(TdotV.mul(TdotL))), float(52.0));
  const sheen = vec3(1.0, 0.99, 0.96).mul(kk).mul(sheenAmt).mul(layerT.mul(0.6).add(0.35));

  // Strong rim/backlight on body edges and mane (ref stills are rim-lit).
  const rim = pow(sub(float(1.0), max(float(0.0), dot(nW, V))), float(2.2)).mul(layerT.mul(0.7).add(0.3));
  const rimCol = albedo.mul(1.6).add(vec3(0.03)).mul(rim).mul(0.34);

  return acesTonemap(diffuse.add(ambient).add(fill).add(sheen).add(rimCol).mul(u.exposure));
}

/**
 * @param {HorseUniforms} u
 * @param {number} layerIndex 1-based (0 is the undercoat mesh)
 * @param {number} shellCount
 */
export function createHorseShellMaterial(u, layerIndex, shellCount) {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: layerIndex <= Math.max(3, Math.floor(shellCount * 0.25)),
    side: THREE.DoubleSide,
  });

  const layer = float(layerIndex);
  const shells = float(Math.max(1, shellCount));
  const layerT = layer.div(shells);

  const fl = attribute('furLen', 'float');
  const groomDir = attribute('groomDir', 'vec3');
  const restPos = positionGeometry; // bind-space rest position
  const zone = attribute('zoneId', 'float');
  const coat = uv();

  const isLongHair = zoneIs(zone, HORSE_ZONE.mane).add(zoneIs(zone, HORSE_ZONE.tail));

  // ---- shell extrusion: short body coat hugs the normal; mane/tail strands
  //      lean hard into groom + wind + spring sway ---------------------------
  const wind = u.breezeDir.mul(u.breeze).mul(layerT).mul(layerT);
  const bend = u.inertialBend.add(u.impulse).mul(layerT).mul(0.5);
  // Coherent mane/tail sway: a slow standing wave phase-locked to rest position
  // (capped amplitude → no popping), plus the CPU spring sway uniform.
  const swayPhase = restPos.y.mul(2.4).add(restPos.z.mul(1.8));
  const hairSway = vec3(
    sin(u.time.mul(1.7).add(swayPhase)).mul(0.12).add(u.maneSway),
    float(0.0),
    sin(u.time.mul(1.3).add(swayPhase.mul(1.3))).mul(0.06),
  ).mul(isLongHair).mul(layerT);
  const groomN = normalize(groomDir.add(wind).add(bend).add(hairSway));
  const lean = clamp(float(0.14).add(layerT.mul(0.22)).add(isLongHair.mul(0.45)), 0.05, 0.92);
  const extrudeDir = normalize(mix(normalLocal, groomN, lean));
  const shellHeight = fl.mul(u.maxFurLen).mul(layerT);
  material.positionNode = positionLocal.add(extrudeDir.mul(shellHeight));

  const vRest = varying(restPos, 'vHrRest');
  const vCoat = varying(coat, 'vHrCoat');
  const vZone = varying(zone, 'vHrZone');
  const vLayerT = varying(layerT, 'vHrLayerT');
  const vFl = varying(fl, 'vHrFl');
  const vGroomW = varying(modelWorldMatrix.mul(vec4(groomN, 0.0)).xyz, 'vHrGroomW');
  const vNormalW = varying(
    normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz),
    'vHrNormalW',
  );
  const vPosW = varying(positionWorld, 'vHrPosW');

  // ---- strand alpha: rest-hashed cells, radial falloff, tip taper -----------
  // Body coat hashes at ~1200–1500 cells/m (dense short nap); mane/tail use
  // far coarser cells with long strand variance for readable hair locks.
  const strand = Fn(() => {
    const lt = vLayerT;
    const flv = vFl;
    const longHair = zoneIs(vZone, HORSE_ZONE.mane).add(zoneIs(vZone, HORSE_ZONE.tail));
    // cell size: short nap ≈ 1/1350 m; hair locks ≈ 8–20 mm
    const napCell = float(1.0 / 1350.0).mul(clamp(flv.mul(120.0), 0.65, 1.6));
    const lockCell = clamp(flv.mul(0.16), 0.008, 0.02);
    const cell = mix(napCell, lockCell, longHair);
    const sC = vCoat.x.div(cell);
    const tC0 = vCoat.y.div(cell);
    // Coherent wave: shift the across-coordinate by a smooth sine seeded per
    // row (≤0.3 cells so strands stay continuous, not diced).
    const rowSeed = hash(floor(sC));
    const tC = tC0.add(sin(sC.mul(2.1).add(rowSeed.mul(6.28))).mul(0.24));
    const cellId = vec2(floor(sC), floor(tC));
    const h1 = hash2(cellId);
    const h2 = hash2(cellId.add(19.3));
    const cu = fract(sC).sub(h1.mul(0.6).add(0.2));
    const cv = fract(tC).sub(h2.mul(0.6).add(0.2));
    const rad = sqrt(cu.mul(cu).add(cv.mul(cv)));

    // Length variance per strand (mane/tail vary much more than the nap).
    const strandLen = mix(
      mix(float(0.7), float(1.0), h1),
      mix(float(0.45), float(1.0), h1),
      longHair,
    );
    const tipT = clamp(lt.div(strandLen), 0.0, 1.0);
    const coreR = mix(float(0.72), float(0.16), tipT); // taper to a point
    let alpha = smoothstep(coreR, coreR.mul(0.45), rad);
    alpha = alpha.mul(smoothstep(float(0.08), float(0.0), lt.sub(strandLen)));

    // Dense base so the undercoat never shows as holes; the short nap stays
    // nearly solid through most of the stack (a horse reads as a surface, not
    // fluff), while hair zones feather earlier into strands.
    const solidCore = mix(float(0.62), float(0.30), longHair);
    const baseFill = mix(float(1.0), float(0.55), pow(lt, float(2.0)));
    alpha = max(alpha, float(1).sub(smoothstep(float(0.0), solidCore, lt))).mul(baseFill);
    // Very-short tracts (face / legs) pack solid so thin limbs never ghost.
    const shortBoost = smoothstep(float(0.006), float(0.0035), flv);
    alpha = mix(alpha, clamp(alpha.mul(1.8).add(0.45), 0.0, 1.0), shortBoost);

    // Bare zones (hoof / eye / nose leather) grow no shells.
    alpha = alpha.mul(smoothstep(float(0.0), float(0.0015), flv));
    alpha = alpha.mul(float(1).sub(u.nakedBody));
    return clamp(alpha, 0.0, 1.0).mul(h2.mul(0.1).add(0.92));
  });

  material.colorNode = Fn(() => {
    const { albedo, sheenAmt } = horseAlbedo(u, vRest, vCoat, vZone);
    const lt = vLayerT;
    // Root AO: inner shells sit in self-shadow between strands.
    const rootAo = mix(float(0.52), float(1.0), pow(lt, float(0.7)));
    const nW = normalize(vNormalW);
    return horseShade(u, albedo.mul(rootAo), sheenAmt, nW, vPosW, vGroomW, lt);
  })();

  material.opacityNode = strand();
  material.userData.horseUniforms = u;
  return material;
}

/**
 * Undercoat: solid body under the shells (also the "naked" debug body).
 * @param {HorseUniforms} u
 */
export function createHorseBodyMaterial(u) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.75,
    metalness: 0.0,
    side: THREE.FrontSide,
  });
  const restPos = positionGeometry;
  const zone = attribute('zoneId', 'float');
  const coat = uv();
  const { albedo, sheenAmt } = horseAlbedo(u, restPos, coat, zone);
  const isHoof = zoneIs(zone, HORSE_ZONE.hoof);
  const isEye = zoneIs(zone, HORSE_ZONE.eye);
  const isNose = zoneIs(zone, HORSE_ZONE.nose);
  const bare = clamp(isHoof.add(isEye).add(isNose), 0, 1);
  // Slightly darker under the shells so gaps read as coat depth.
  const under = albedo.mul(mix(float(0.72), float(1.0), bare));
  material.colorNode = mix(under, albedo, u.nakedBody);

  let rough = float(0.72);
  rough = rough.sub(sheenAmt.mul(0.3));
  rough = mix(rough, float(0.35), isHoof);
  rough = mix(rough, float(0.08), isEye);   // wet cornea
  rough = mix(rough, float(0.45), isNose);  // soft moist muzzle
  material.roughnessNode = clamp(rough, 0.05, 1.0);
  material.userData.horseUniforms = u;
  return material;
}

/**
 * CPU spring integrators → shader uniforms: inertial coat sway from root
 * motion, breeze, impulse decay, and a dedicated mane/tail swing spring
 * (same scheme as CatFurDynamics / DogFurDynamics).
 */
export class HorseFurDynamics {
  /** @param {HorseUniforms} uniforms */
  constructor(uniforms) {
    this.u = uniforms;
    this.vel = new THREE.Vector3();
    this.bend = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.prevRoot = new THREE.Vector3();
    this.hasPrev = false;
    this.stiffness = 16;
    this.damping = 10;
    // mane/tail lateral swing spring (scalar phase fed to the shader)
    this.mane = 0;
    this.maneVel = 0;
    this._tmp = new THREE.Vector3();
  }

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

    const target = accel.multiplyScalar(-0.014);
    const force = target.sub(this.bend).multiplyScalar(this.stiffness);
    this.bend.addScaledVector(force, t);
    this.bend.addScaledVector(this.impulse, t);
    this.bend.multiplyScalar(Math.exp(-this.damping * t));
    this.impulse.multiplyScalar(Math.exp(-6 * t));

    // Mane spring chases lateral root acceleration (head toss / turns).
    const maneTarget = THREE.MathUtils.clamp(-accel.x * 0.012, -0.35, 0.35);
    this.maneVel += (maneTarget - this.mane) * 20 * t;
    this.maneVel *= Math.exp(-7 * t);
    this.mane += this.maneVel * t;

    this.u.inertialBend.value.copy(this.bend);
    this.u.impulse.value.copy(this.impulse);
    this.u.maneSway.value = this.mane;
  }

  addImpulse(v) {
    this.impulse.add(v);
  }

  setNaked(on) {
    this.u.nakedBody.value = on ? 1 : 0;
  }
}
