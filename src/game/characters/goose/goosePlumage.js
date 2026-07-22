/**
 * Canada goose plumage — TSL shell feathers + undercoat + shared uniforms.
 *
 * Follows the proven dog shell-fur architecture (dogFurMaterial.js):
 *   - N skinned shell copies extruded along normals in positionNode
 *   - MeshBasicNodeMaterial shells with in-shader lighting:
 *     wrap diffuse + hemisphere ambient + Kajiya-Kay anisotropic sheen along
 *     the groom tangent + rim/backlight on tips + root AO + in-shader ACES
 *   - MeshStandardNodeMaterial undercoat so shell gaps read as depth
 *
 * Feather-specific fragment: rest-parameterized COAT UV (s along the groom
 * flow, t around the ring — baked by gooseBodyGeometry) is hashed into
 * anisotropic cells; each cell is a flattened VANELET: length variance, tip
 * taper, barb micro-noise, and a coherent wave capped at ≤0.3 cells so
 * neighbouring pixels never switch cells (feathers stay flat — this is what
 * separates plumage from mammal fur).
 *
 * Coat definition = three baked/derived fields:
 *   1. length zones — featherLen vertex attr (short dense head → long rump)
 *   2. color masks — landmark-ratio smoothsteps in bind space (sharp black
 *      stocking, white chinstrap, cream breast, barred brown body + coverts,
 *      white undertail V, black tail)
 *   3. groom direction — baked flow field (one continuous tract, no seams)
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
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  sub,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  max,
  min,
  dot,
  abs,
  sqrt,
} from 'three/tsl';
import { GOOSE_DIMS } from './gooseDims.js';
import { GOOSE_ZONE } from './gooseBodyGeometry.js';

export const GOOSE_SHELL_COUNT = 56;

const D = GOOSE_DIMS;

/** Photo-sampled palette (sRGB floats). */
export const GOOSE_COLORS = Object.freeze({
  stocking: [0.052, 0.052, 0.058],   // black head + neck ONLY
  chinstrap: [0.93, 0.905, 0.85],
  breast: [0.78, 0.725, 0.64],       // pale cream-tan chest
  belly: [0.895, 0.875, 0.84],
  vent: [0.93, 0.915, 0.885],        // undertail coverts
  backBase: [0.40, 0.33, 0.252],     // scapular/back brown
  backEdge: [0.655, 0.575, 0.462],   // pale feather edging
  flankBase: [0.555, 0.495, 0.415],
  flankEdge: [0.705, 0.65, 0.572],
  wingBase: [0.36, 0.30, 0.235],     // covert brown (slightly cooler)
  wingEdge: [0.60, 0.52, 0.41],
  // Body/wing/tail stay brown — no black on the torso (black = neck/head/legs).
  primary: [0.28, 0.23, 0.18],       // dark brown remiges (not pure black)
  tail: [0.32, 0.26, 0.20],          // dark brown tail base (white vent band separate)
  bill: [0.048, 0.047, 0.05],        // black bill
  leg: [0.088, 0.086, 0.084],        // black tarsus/feet
  eyeIris: [0.16, 0.10, 0.06],
});

function colorU(rgb) {
  return uniform(new THREE.Color(rgb[0], rgb[1], rgb[2]));
}

export function createGooseUniforms() {
  return {
    time: uniform(0),
    breeze: uniform(0.1),
    breezeDir: uniform(new THREE.Vector3(1, 0.05, 0.3).normalize()),
    inertialBend: uniform(new THREE.Vector3()),
    impulse: uniform(new THREE.Vector3()),
    ruffle: uniform(0),                 // 0..1 feather raise (alert/shake)
    maxFeatherLen: uniform(1),          // global multiplier on featherLen attr
    nakedBody: uniform(0),
    // Variety knobs — Canada goose defaults; other breeds remap via applyBirdVarietyToUniforms
    stockingAmt: uniform(1),            // 0..1 black/colored head+neck stocking
    chinstrapAmt: uniform(1),           // 0..1 cheek/chin field mark
    barringAmt: uniform(1),             // 0..1 upperpart barring strength
    breastPaleAmt: uniform(1),          // 0..1 pale breast/belly wash
    sheenBoost: uniform(0.12),          // breed iridescence boost
    // Per-slot plumage colors (sRGB). Defaults = Canada goose photo palette.
    cStocking: colorU(GOOSE_COLORS.stocking),
    cChinstrap: colorU(GOOSE_COLORS.chinstrap),
    cBreast: colorU(GOOSE_COLORS.breast),
    cBelly: colorU(GOOSE_COLORS.belly),
    cVent: colorU(GOOSE_COLORS.vent),
    cBackBase: colorU(GOOSE_COLORS.backBase),
    cBackEdge: colorU(GOOSE_COLORS.backEdge),
    cFlankBase: colorU(GOOSE_COLORS.flankBase),
    cFlankEdge: colorU(GOOSE_COLORS.flankEdge),
    cWingBase: colorU(GOOSE_COLORS.wingBase),
    cWingEdge: colorU(GOOSE_COLORS.wingEdge),
    cPrimary: colorU(GOOSE_COLORS.primary),
    cTail: colorU(GOOSE_COLORS.tail),
    cBill: colorU(GOOSE_COLORS.bill),
    cLeg: colorU(GOOSE_COLORS.leg),
    cEyeIris: colorU(GOOSE_COLORS.eyeIris),
    // Morph landmarks — keep field-mark masks aligned when neck/body reshape.
    lmCollarY: uniform(D.collarY),
    lmCollarZ: uniform(D.collarZ),
    lmHeadY: uniform(D.headCenterY),
    lmHeadZ: uniform(D.headCenterZ),
    lmEyeY: uniform(D.eyeY),
    lmEyeZ: uniform(D.eyeZ),
    lmBillBaseZ: uniform(D.billBaseZ),
    lmBodyCenterY: uniform(D.bodyCenterY),
    lmBackTopY: uniform(D.backTopY),
    lmBellyY: uniform(D.bellyY),
    // lighting rig (matches studio defaults; harness presets remap sun)
    keyDir: uniform(new THREE.Vector3(0.42, 0.78, 0.42).normalize()),
    keyColor: uniform(new THREE.Color(1.0, 0.98, 0.95)),
    fillColor: uniform(new THREE.Color(0.72, 0.78, 0.86)),
    hemiSky: uniform(new THREE.Color(0.62, 0.66, 0.71)),
    hemiGround: uniform(new THREE.Color(0.38, 0.36, 0.33)),
    exposure: uniform(1.0),
  };
}

/**
 * Push resolved morph landmark dims into plumage uniforms.
 * @param {GooseUniforms} uniforms
 * @param {object} dims morph.dims
 */
export function applyGooseMorphLandmarks(uniforms, dims) {
  if (!dims || !uniforms) return;
  const set = (u, v) => {
    if (u && Number.isFinite(v)) u.value = v;
  };
  set(uniforms.lmCollarY, dims.collarY);
  set(uniforms.lmCollarZ, dims.collarZ);
  set(uniforms.lmHeadY, dims.headCenterY);
  set(uniforms.lmHeadZ, dims.headCenterZ);
  set(uniforms.lmEyeY, dims.eyeY);
  set(uniforms.lmEyeZ, dims.eyeZ);
  set(uniforms.lmBillBaseZ, dims.billBaseZ);
  set(uniforms.lmBodyCenterY, dims.bodyCenterY);
  set(uniforms.lmBackTopY, dims.backTopY);
  set(uniforms.lmBellyY, dims.bellyY);
}

/** @typedef {ReturnType<typeof createGooseUniforms>} GooseUniforms */

const acesTonemap = Fn(([x]) => {
  const a = float(2.51);
  const b = float(0.03);
  const c = float(2.43);
  const d = float(0.59);
  const e = float(0.14);
  return clamp(x.mul(a.mul(x).add(b)).div(x.mul(c.mul(x).add(d)).add(e)), 0.0, 1.0);
});

const hash2 = Fn(([p]) => hash(p.x.add(p.y.mul(57.3))));

function zoneIs(zone, id) {
  return step(float(id - 0.45), zone).mul(step(zone, float(id + 0.45)));
}

/**
 * Landmark-ratio color masks + feather-row detailing, evaluated per-pixel on
 * bind-space rest position so edges stay razor sharp at any resolution and
 * stable under skinning. Slot colors + pattern knobs come from uniforms so
 * other bird breeds can share the goose body as recolored varieties.
 *
 * Returns { albedo, sheenAmt, edgeLight } nodes.
 * @param {GooseUniforms} u
 * @param {*} rest vec3 node — bind-space position
 * @param {*} coat vec2 node — (s,t) coat UV
 * @param {*} zone float node
 */
export function gooseAlbedo(u, rest, coat, zone) {
  const y = rest.y;
  const z = rest.z;
  const ax = abs(rest.x);

  // ---- ragged mask noise (feather-scale, not pixel noise) ------------------
  const cellN = hash2(vec2(floor(coat.x.mul(90.0)), floor(coat.y.mul(90.0))));
  const rag = cellN.sub(0.5).mul(0.016);

  // Landmark uniforms track morph (neck short / body upright).
  const lmCollarY = u.lmCollarY;
  const lmCollarZ = u.lmCollarZ;
  const lmHeadY = u.lmHeadY;
  const lmHeadZ = u.lmHeadZ;
  const lmEyeY = u.lmEyeY;
  const lmBillBaseZ = u.lmBillBaseZ;
  const lmBodyY = u.lmBodyCenterY;
  const lmBackY = u.lmBackTopY;
  const lmBellyY = u.lmBellyY;

  // ---- zones (early — stocking is gated to neck mesh only) -----------------
  const isWingZone = zoneIs(zone, GOOSE_ZONE.wing);
  const isTail = zoneIs(zone, GOOSE_ZONE.tail);
  const isNeck = zoneIs(zone, GOOSE_ZONE.neck);
  const isWing = isWingZone;

  // ---- stocking: BLACK only on neck/head mesh (never body/wing/tail) --------
  // Soft falloff along the neck loft is still useful for variety remaps, but
  // the zone gate is the hard rule: torso plumage cannot go black.
  const collarY = lmCollarY.add(z.sub(lmCollarZ).mul(-0.35)).add(rag.mul(1.4));
  const stockingMask = smoothstep(collarY.sub(0.012), collarY.add(0.012), y)
    .mul(smoothstep(lmCollarY.sub(0.06), lmCollarY.add(0.02), y));
  // Soften toward the buried neck root so the chest seam stays brown.
  const stocking = stockingMask.mul(u.stockingAmt).mul(isNeck);

  // ---- chinstrap / throat mark (neck-zone only) ----------------------------
  const topLine = lmHeadY.sub(0.026).add(z.sub(lmHeadZ.add(0.055)).mul(-0.27)).add(rag.mul(1.2));
  const cheek = smoothstep(topLine.add(0.007), topLine.sub(0.007), y)
    .mul(smoothstep(lmHeadZ.sub(0.063), lmHeadZ.sub(0.040), z))
    .mul(smoothstep(lmBillBaseZ, lmBillBaseZ.sub(0.016), z))
    .mul(smoothstep(lmHeadY.sub(0.080), lmHeadY.sub(0.057), y));
  const chinBand = smoothstep(lmHeadY.sub(0.024), lmHeadY.sub(0.032), y)
    .mul(smoothstep(lmHeadZ.add(0.007), lmHeadZ.add(0.019), z))
    .mul(smoothstep(lmBillBaseZ.add(0.002), lmBillBaseZ.sub(0.012), z));
  const headRegion = smoothstep(lmHeadY.sub(0.09), lmHeadY.sub(0.03), y)
    .mul(smoothstep(lmHeadZ.sub(0.06), lmHeadZ.add(0.03), z));
  const chinstrap = clamp(cheek.add(chinBand), 0, 1)
    .mul(mix(headRegion, stockingMask, clamp(u.stockingAmt, 0, 1)))
    .mul(u.chinstrapAmt)
    .mul(isNeck);

  // ---- breast → belly → vent (body-center relative) ------------------------
  const frontnessZ = smoothstep(float(-0.02), float(0.16), z);
  const breastMask = frontnessZ.mul(smoothstep(lmBackY.add(0.02), lmBodyY.add(0.05), y)).mul(u.breastPaleAmt);
  const bellyMask = smoothstep(lmBellyY.add(0.075), lmBellyY.add(0.035), y).mul(u.breastPaleAmt);
  const ventMask = smoothstep(float(-0.13), float(-0.20), z).mul(smoothstep(lmBodyY.add(0.01), lmBellyY.add(0.11), y));

  // ---- barred upperparts ----------------------------------------------------
  const rowPitch = mix(float(0.021), float(0.030), isWingZone);
  const colPitch = mix(float(0.048), float(0.042), isWingZone);
  const rowCoord = mix(coat.y, coat.x, isWingZone);
  const colCoord = mix(coat.x, coat.y, isWingZone);
  const rowF = rowCoord.div(rowPitch);
  const rowI = floor(rowF);
  const colF = colCoord.div(colPitch).add(fract(rowI.mul(0.5)));
  const colI = floor(colF);
  const cellHash = hash2(vec2(rowI, colI));
  const rowFr = fract(rowF.add(cellHash.mul(0.14)));
  const colFr = fract(colF);
  const scallopCurve = colFr.sub(0.5).pow(2).mul(0.8);
  const edgeBand = smoothstep(float(0.80), float(0.95), rowFr.add(scallopCurve).sub(cellHash.mul(0.06)))
    .mul(u.barringAmt);
  const rowJitterLum = mix(float(0.94), float(1.06), cellHash);

  const backMask = smoothstep(lmBodyY.add(0.03), lmBackY.sub(0.02), y)
    .mul(smoothstep(float(0.19), float(0.10), z));
  const flankMask = smoothstep(lmBackY.sub(0.01), lmBodyY.add(0.05), y)
    .mul(smoothstep(lmBellyY.add(0.04), lmBellyY.add(0.08), y))
    .mul(smoothstep(float(0.16), float(0.02), z));

  // ---- compose body plumage (brown / cream only) ----------------------------
  const barredRegion = clamp(flankMask.add(backMask), 0, 1);
  const flankCol = mix(u.cFlankBase, u.cFlankEdge, edgeBand.mul(0.85)).mul(rowJitterLum);
  const backCol = mix(u.cBackBase, u.cBackEdge, edgeBand.mul(0.9)).mul(rowJitterLum);
  let col = u.cBreast;
  col = mix(col, flankCol, flankMask);
  col = mix(col, backCol, backMask);
  col = mix(col, u.cBelly, bellyMask.mul(float(1).sub(barredRegion.mul(0.7))));
  col = mix(col, u.cVent, ventMask);

  // Neck base reads as breast/back under the stocking; then black stocking.
  col = mix(col, u.cBreast, isNeck.mul(float(1).sub(stocking)).mul(0.35));
  col = mix(col, u.cStocking, stocking);
  col = mix(col, u.cChinstrap, chinstrap);

  // ---- zone overrides ---------------------------------------------------------
  // Wings: brown coverts + slightly darker brown tips (never pure black).
  const wingCol = mix(u.cWingBase, u.cWingEdge, edgeBand.mul(0.95)).mul(rowJitterLum);
  const tipDark = smoothstep(float(-0.24), float(-0.35), z);
  col = mix(col, mix(wingCol, u.cPrimary, tipDark.mul(0.75)), isWing);

  // Tail: dark brown rectrix base + white undertail V (not black slab).
  const tailWhite = smoothstep(float(-0.284), float(-0.272), z);
  col = mix(col, mix(u.cTail, u.cVent, tailWhite), isTail);
  const isBill = zoneIs(zone, GOOSE_ZONE.bill);
  const nares = smoothstep(float(0.0006), float(0.00018),
    z.sub(0.345).pow(2).mul(0.5).add(y.sub(0.869).pow(2)).add(ax.sub(0.014).pow(2).mul(2.2)));
  const nail = smoothstep(float(0.408), float(0.418), z);
  let billCol = mix(u.cBill, vec3(0.16, 0.155, 0.15), nail);
  billCol = mix(billCol, vec3(0.02, 0.02, 0.022), nares);
  col = mix(col, billCol, isBill);
  const isLeg = zoneIs(zone, GOOSE_ZONE.leg);
  const scales = mix(float(0.92), float(1.1), hash2(vec2(floor(y.mul(160.0)), floor(rest.x.mul(90.0).add(z.mul(60.0))))));
  col = mix(col, u.cLeg.mul(scales), isLeg);
  const isEye = zoneIs(zone, GOOSE_ZONE.eye);
  const eyeCol = mix(
    vec3(0.010, 0.009, 0.009),
    u.cEyeIris.mul(0.5),
    smoothstep(lmEyeY.add(0.002), lmEyeY.sub(0.004), y),
  );
  col = mix(col, eyeCol, isEye);

  // Sheen: stocking glossy, wing satin, bare zones matte; sheenBoost scales breed iridescence.
  let sheenAmt = float(0.07).add(u.sheenBoost.mul(0.25));
  sheenAmt = mix(sheenAmt, float(0.2).add(u.sheenBoost.mul(0.5)), stocking.mul(float(1).sub(chinstrap)));
  sheenAmt = mix(sheenAmt, float(0.12).add(u.sheenBoost.mul(0.4)), isWing);
  sheenAmt = mix(sheenAmt, float(0.0), isBill.add(isLeg).add(isEye));

  return { albedo: col, sheenAmt, edgeBand, stocking, chinstrap };
}

/**
 * Shared in-shader lighting for shells (Basic materials — deterministic,
 * studio-matched, same recipe as the dog coat).
 */
function gooseShade(u, albedo, sheenAmt, nW, pW, groomW, layerT) {
  const L = normalize(u.keyDir);
  const NdotL = dot(nW, L);
  const wrap = NdotL.mul(0.45).add(0.55);
  const diffuse = albedo.mul(u.keyColor).mul(wrap.mul(0.78).add(0.14));

  const hemi = mix(u.hemiGround, u.hemiSky, nW.y.mul(0.5).add(0.5));
  const ambient = albedo.mul(hemi).mul(0.42);

  const fillL = normalize(vec3(-0.5, 0.3, -0.35));
  const fill = albedo.mul(u.fillColor).mul(max(float(0.0), dot(nW, fillL)).mul(0.2));

  // Kajiya-Kay along the groom tangent (feather vane sheen).
  const T = normalize(groomW);
  const V = normalize(cameraPosition.sub(pW));
  const TdotV = dot(T, V);
  const TdotL = dot(T, L);
  const sinTV = sqrt(max(float(0.0), sub(float(1.0), TdotV.mul(TdotV))));
  const sinTL = sqrt(max(float(0.0), sub(float(1.0), TdotL.mul(TdotL))));
  const kk = pow(max(float(0.0), sinTV.mul(sinTL).sub(TdotV.mul(TdotL))), float(56.0));
  // Smoothly weighted — outer layers alone turn the band into sparkly dashes.
  const sheen = vec3(1.0, 0.99, 0.96).mul(kk).mul(sheenAmt).mul(layerT.mul(0.5).add(0.35));

  // Rim/backlight on tips only — scaled by albedo so black feathers don't
  // sparkle into white dashes where shell alpha dices the rim band.
  const rim = pow(sub(float(1.0), max(float(0.0), dot(nW, V))), float(2.6)).mul(layerT);
  const rimCol = albedo.mul(1.4).add(vec3(0.02)).mul(rim).mul(0.35);

  return acesTonemap(diffuse.add(ambient).add(fill).add(sheen).add(rimCol).mul(u.exposure));
}

/**
 * @param {GooseUniforms} u
 * @param {number} layerIndex 1-based (0 is the undercoat mesh)
 * @param {number} shellCount
 */
export function createGooseShellMaterial(u, layerIndex, shellCount) {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: layerIndex <= Math.max(4, Math.floor(shellCount * 0.3)),
    side: THREE.DoubleSide,
  });

  const layer = float(layerIndex);
  const shells = float(Math.max(1, shellCount));
  const layerT = layer.div(shells);

  const fl = attribute('featherLen', 'float');
  const groomDir = attribute('groomDir', 'vec3');
  const restPos = positionGeometry; // bind-space rest position (see geometry note)
  const zone = attribute('zoneId', 'float');
  const coat = uv();

  // ---- shell extrusion -------------------------------------------------------
  // Feathers hug the body: mostly-normal near roots, strong groom lean at the
  // tips so shells read as overlapping flat vanes, not upright fur.
  const wind = u.breezeDir.mul(u.breeze).mul(layerT).mul(layerT);
  const bend = u.inertialBend.add(u.impulse).mul(layerT).mul(0.45);
  const raise = u.ruffle.mul(0.7);
  const groomN = normalize(groomDir.add(wind).add(bend));
  const lean = clamp(float(0.30).add(layerT.mul(0.62)).sub(raise), 0.12, 0.95);
  const extrudeDir = normalize(mix(normalLocal, groomN, lean));
  const shellHeight = fl.mul(u.maxFeatherLen).mul(layerT);
  material.positionNode = positionLocal.add(extrudeDir.mul(shellHeight));

  const vRest = varying(restPos, 'vGooseRest');
  const vCoat = varying(coat, 'vGooseCoat');
  const vZone = varying(zone, 'vGooseZone');
  const vLayerT = varying(layerT, 'vGooseLayerT');
  const vFl = varying(fl, 'vGooseFl');
  const vGroomW = varying(modelWorldMatrix.mul(vec4(groomN, 0.0)).xyz, 'vGooseGroomW');
  const vNormalW = varying(
    normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz),
    'vGooseNormalW',
  );
  const vPosW = varying(positionWorld, 'vGoosePosW');

  // ---- vanelet alpha -----------------------------------------------------------
  const vanelet = Fn(() => {
    const lt = vLayerT;
    const flv = vFl;
    // Cell size scales with local feather length: short dense head cells,
    // broad body vanes.
    const cellL = clamp(flv.mul(1.7), 0.006, 0.05);
    const cellW = cellL.mul(0.32);
    const sC = vCoat.x.div(cellL);
    const tC = vCoat.y.div(cellW);
    // coherent wave (≤0.3 cells) — keeps vane rows wavy but never re-cells
    const rowSeed = hash(floor(sC));
    const tWave = tC.add(sin(sC.mul(2.4).add(rowSeed.mul(6.28))).mul(0.26));
    const cellId = vec2(floor(sC), floor(tWave));
    const h1 = hash2(cellId);
    const h2 = hash2(cellId.add(31.7));
    const fu = fract(tWave); // across the vanelet
    const fv = fract(sC);    // along growth

    // Length variance per vanelet.
    const strandLen = mix(float(0.62), float(1.0), h1);
    const beyond = lt.sub(strandLen);

    // Flattened vane: opaque core, taper near the tip, soft side edges.
    const sideProfile = smoothstep(float(0.0), float(0.16), fu).mul(smoothstep(float(1.0), float(0.84), fu));
    const tipT = clamp(lt.div(strandLen), 0.0, 1.0);
    const tipTaper = smoothstep(float(1.0), float(0.55), tipT.mul(fu.sub(0.5).abs().mul(2.0).add(0.62)));

    // barb micro-noise (fine striations across the vane)
    const barbs = mix(float(0.88), float(1.0), hash(floor(fu.mul(9.0)).add(cellId.x.mul(7.0)).add(cellId.y.mul(13.0))));

    // Dense base coat, softening outward — plumage is flat, so keep mid
    // shells nearly solid and only feather the last third.
    const baseFill = mix(float(0.96), float(0.30), pow(lt, float(2.2)));
    let alpha = baseFill.mul(sideProfile).mul(tipTaper).mul(barbs);
    alpha = alpha.mul(smoothstep(float(0.05), float(0.0), beyond));
    // Short dense tracts (head/neck) pack nearly solid — no see-through gaps.
    const shortBoost = smoothstep(float(0.009), float(0.0045), flv);
    alpha = mix(alpha, clamp(alpha.mul(1.7).add(0.30), 0.0, 1.0), shortBoost.mul(0.85));
    // Bare zones (bill/eye/tarsus/web) never grow shells.
    alpha = alpha.mul(smoothstep(float(0.0), float(0.0022), flv));
    alpha = alpha.mul(float(1).sub(u.nakedBody));
    return clamp(alpha, 0.0, 1.0).mul(mix(float(1.0), float(0.75), pow(lt, float(3.0))).mul(h2.mul(0.1).add(0.95)));
  });

  material.colorNode = Fn(() => {
    const { albedo, sheenAmt } = gooseAlbedo(u, vRest, vCoat, vZone);
    const lt = vLayerT;
    // Root AO: inner shells sit in shadow between vanes.
    const rootAo = mix(float(0.52), float(1.0), pow(lt, float(0.75)));
    const nW = normalize(vNormalW);
    return gooseShade(u, albedo.mul(rootAo), sheenAmt, nW, vPosW, vGroomW, lt);
  })();

  material.opacityNode = vanelet();
  material.userData.gooseUniforms = u;
  return material;
}

/**
 * Undercoat: solid body under the shells (also the "naked" debug body).
 * Standard material so studio shadows/SSGI light it like the dogs.
 * @param {GooseUniforms} u
 */
export function createGooseBodyMaterial(u) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.FrontSide,
  });
  const restPos = positionGeometry; // bind-space rest position
  const zone = attribute('zoneId', 'float');
  const coat = uv();
  const { albedo, stocking } = gooseAlbedo(u, restPos, coat, zone);
  const isBill = zoneIs(zone, GOOSE_ZONE.bill);
  const isLeg = zoneIs(zone, GOOSE_ZONE.leg);
  const isEye = zoneIs(zone, GOOSE_ZONE.eye);
  const bare = clamp(isBill.add(isLeg).add(isEye), 0, 1);
  // Slightly darker under the shells so gaps read as feather depth.
  const under = albedo.mul(mix(float(0.68), float(1.0), bare));
  material.colorNode = mix(under, albedo, u.nakedBody);

  let rough = float(0.87);
  rough = mix(rough, float(0.85), stocking);
  rough = mix(rough, float(0.62), isBill);
  rough = mix(rough, float(0.58), isLeg);
  rough = mix(rough, float(0.12), isEye);
  material.roughnessNode = rough;
  material.userData.gooseUniforms = u;
  return material;
}

/**
 * CPU spring integrators → shader uniforms: inertial ruffle from root motion,
 * breeze, and impulse decay (same integration scheme as DogFurDynamics).
 */
export class GooseFeatherDynamics {
  /** @param {GooseUniforms} uniforms */
  constructor(uniforms) {
    this.u = uniforms;
    this.vel = new THREE.Vector3();
    this.bend = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.prevRoot = new THREE.Vector3();
    this.hasPrev = false;
    this.stiffness = 16;
    this.damping = 10;
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

    const target = accel.multiplyScalar(-0.02);
    const force = target.sub(this.bend).multiplyScalar(this.stiffness);
    this.bend.addScaledVector(force, t);
    this.bend.addScaledVector(this.impulse, t);
    this.bend.multiplyScalar(Math.exp(-this.damping * t));
    this.impulse.multiplyScalar(Math.exp(-6 * t));

    this.u.inertialBend.value.copy(this.bend);
    this.u.impulse.value.copy(this.impulse);
  }

  addImpulse(v) {
    this.impulse.add(v);
  }

  setNaked(on) {
    this.u.nakedBody.value = on ? 1 : 0;
  }
}
