/**
 * Domestic cat coat — TSL shell fur + undercoat + shared uniforms.
 *
 * A fresh take on the proven shell-fur architecture (dogFurMaterial /
 * goosePlumage): N skinned shell copies extruded along the surface normal in
 * positionNode, each a MeshBasicNodeMaterial with in-shader lighting
 * (wrap diffuse + hemisphere ambient + Kajiya-Kay along the groom tangent +
 * tip rim + root AO + in-shader ACES), plus a MeshStandardNodeMaterial
 * undercoat so shell gaps read as depth.
 *
 * Unlike goose plumage (flat overlapping vanes), the cat coat grows UPRIGHT
 * tufted strands: square rest-hashed cells, radial strand falloff, and length
 * variance (short body, longer cheeks / ruff / tail). Groom direction is the
 * one continuous baked flow field.
 *
 * Default coat = tortoiseshell (the feline this replaces): a low-frequency
 * patch mask splits the body into black and ginger blotches, mackerel tabby
 * striping rides the ginger, and white markings claim the belly / chest /
 * paws / muzzle. Nose leather, paw pads, iris (vertical slit) and inner ear
 * are zone overrides.
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
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_float,
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
import { CAT_ZONE } from './catBodyGeometry.js';
import { CAT_DIMS } from './catSkeleton.js';

export const CAT_SHELL_COUNT = 48;

const D = CAT_DIMS;

/** Photo-sampled tortoiseshell palette (sRGB floats). */
export const CAT_COLORS = Object.freeze({
  black: [0.055, 0.050, 0.052],       // dense black patch base
  blackWarm: [0.11, 0.085, 0.075],    // rufous cast in the black
  ginger: [0.62, 0.32, 0.12],         // orange patch base
  gingerDark: [0.40, 0.185, 0.065],   // tabby stripe in the ginger
  gingerLight: [0.80, 0.52, 0.26],    // ticked highlight
  cream: [0.90, 0.80, 0.64],          // pale ground under the ginger
  white: [0.94, 0.925, 0.90],         // belly / chest / paw white
  nose: [0.28, 0.15, 0.15],           // mottled dark-brick nose leather
  noseDark: [0.10, 0.07, 0.08],
  pad: [0.30, 0.18, 0.185],
  innerEar: [0.78, 0.60, 0.56],
  iris: [0.72, 0.66, 0.22],           // yellow-green
  irisRim: [0.42, 0.52, 0.16],
  pupil: [0.015, 0.014, 0.016],
});

export function createCatUniforms() {
  return {
    time: uniform(0),
    breeze: uniform(0.1),
    breezeDir: uniform(new THREE.Vector3(1, 0.1, 0.35).normalize()),
    inertialBend: uniform(new THREE.Vector3()),
    impulse: uniform(new THREE.Vector3()),
    piloerection: uniform(0),            // 0..1 fur raise (startle / halloween arch)
    maxFurLen: uniform(1),               // global multiplier on furLen attr
    nakedBody: uniform(0),
    tabbyStrength: uniform(0.85),
    whiteAmt: uniform(1.0),
    whiskerSway: uniform(0.0),           // 0..1 whisker twitch amplitude
    ruffAmt: uniform(0.0),               // 0 sleek … 1 long neck/cheek ruff
    coatWave: uniform(0.5),              // 0 sleek/straight … 1 wavy coherent strands
    // lighting rig (studio defaults; harness presets remap the key)
    keyDir: uniform(new THREE.Vector3(0.42, 0.78, 0.42).normalize()),
    keyColor: uniform(new THREE.Color(1.0, 0.98, 0.95)),
    fillColor: uniform(new THREE.Color(0.72, 0.78, 0.86)),
    hemiSky: uniform(new THREE.Color(0.62, 0.66, 0.71)),
    hemiGround: uniform(new THREE.Color(0.36, 0.34, 0.31)),
    exposure: uniform(1.0),
  };
}

/** @typedef {ReturnType<typeof createCatUniforms>} CatUniforms */

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
 * Coat masks evaluated per-pixel on bind-space rest position, so patch/stripe
 * edges stay sharp at any resolution and stable under skinning.
 * @param {*} u uniforms
 * @param {*} rest vec3 bind-space position
 * @param {*} coat vec2 (s,t) coat UV
 * @param {*} zone float
 */
export function catAlbedo(u, rest, coat, zone) {
  const C = (k) => vec3(...CAT_COLORS[k]);

  const y = rest.y;
  const z = rest.z;
  const ax = abs(rest.x);

  // ---- ragged edge noise (fur-clump scale) ---------------------------------
  const cellN = hash2(vec2(floor(coat.x.mul(60.0)), floor(coat.y.mul(60.0))));
  const rag = cellN.sub(0.5).mul(0.012);

  // ---- tortie patch mask: smooth fractal noise splits black vs ginger ------
  // Real Perlin octaves (not floor-cell hashes, which read as axis-aligned
  // blocks): a large patch tendency + mid clumps + a strong fine octave so the
  // black/ginger boundary shatters into brindled flecks like the reference.
  const n1 = mx_noise_float(rest.mul(9.0));
  const n2 = mx_noise_float(rest.mul(26.0).add(vec3(3.7)));
  const n3 = mx_noise_float(rest.mul(74.0).add(vec3(11.3)));
  let field = n1.mul(0.55).add(n2.mul(0.32)).add(n3.mul(0.38)).add(rag.mul(3.0));
  // Facial split: one side of the face runs blacker, the other more ginger
  // (classic tortie asymmetry), plus a narrow ginger blaze up the nose bridge.
  const onHead = smoothstep(float(0.20), float(0.26), z);
  field = field.add(rest.x.mul(3.2).mul(onHead));
  const noseBlaze = smoothstep(float(0.009), float(0.003), ax)
    .mul(smoothstep(float(0.223), float(0.258), z))
    .mul(smoothstep(float(0.234), float(0.262), y));
  field = field.add(noseBlaze.mul(0.55));
  // Tail runs dark on a tortie.
  const isTail = zoneIs(zone, CAT_ZONE.tail);
  field = field.sub(isTail.mul(0.30));
  // Threshold set black-dominant (~1/3 ginger), wide soft edge = brindle zone.
  const gingerSel = smoothstep(float(0.06), float(0.44), field);

  // ---- mackerel tabby stripes ----------------------------------------------
  // Vertical bands that wrap the barrel: spaced along the body length
  // (coat.x ~ arc length), bowed by ring position so they curve down the
  // flanks. Wider pitch + gentler contrast than the first pass, and faded out
  // on the head so the face doesn't read as tree-rings.
  const stripeCoord = coat.x.mul(13.0).add(sin(coat.y.mul(6.0)).mul(0.28)).add(cellN.mul(0.25));
  const stripe = smoothstep(float(0.28), float(0.5), abs(fract(stripeCoord).sub(0.5)).mul(2.0));
  const headFade = smoothstep(float(0.34), float(0.24), z); // 1 on body, 0 on the face
  const legFade = smoothstep(float(0.11), float(0.17), y); // fade stripes off the lower legs
  const tabbyOn = u.tabbyStrength.mul(mix(float(0.35), float(1.0), headFade)).mul(legFade)
    .mul(float(1).sub(isTail)); // no crisp rings around the tail
  let gingerCol = mix(mix(C('ginger'), C('gingerDark'), tabbyOn.mul(0.6)), C('ginger'), stripe);
  gingerCol = mix(gingerCol, C('gingerLight'), stripe.mul(0.25));

  // Faint rufous brindle in the black patches (tortie warmth).
  const tick = hash2(vec2(floor(coat.x.mul(40.0)), floor(coat.y.mul(40.0))));
  const blackStripe = stripe.mul(headFade).mul(u.tabbyStrength);
  const blackCol = mix(mix(C('black'), C('blackWarm'), tick.mul(0.4)), C('blackWarm'), blackStripe.mul(0.5));

  let col = mix(blackCol, gingerCol, gingerSel);

  // ---- ticked grain: fine per-strand luminance jitter (breaks the flat
  //      poly-shaded read; real fur is never one value) ----------------------
  const grain = mx_noise_float(rest.mul(280.0));
  col = col.mul(grain.mul(0.20).add(1.0));

  // ---- white markings: a true tortie has essentially NO white — keep only a
  // tiny optional ventral patch, scaled by whiteAmt (0 for the reference).
  const bellyMask = smoothstep(float(0.150), float(0.118), y)
    .mul(smoothstep(float(0.12), float(0.0), z)).mul(smoothstep(float(-0.10), float(0.0), z));
  const whiteM = clamp(bellyMask, 0, 1).mul(u.whiteAmt);
  col = mix(col, C('white'), whiteM);

  // ---- zone overrides -------------------------------------------------------
  // zoneId is a float attribute, so triangles that SPAN zones interpolate
  // through intermediate ids (fur 0 → pad 2 crosses nose 1; body 0 → tail 5
  // crosses everything), painting stray nose/pad/ear bands at the seams.
  // Every override is therefore ALSO gated by its geometric region.
  const isNose = zoneIs(zone, CAT_ZONE.nose)
    .mul(smoothstep(float(0.284), float(0.290), z));
  const noseMottle = hash2(vec2(floor(rest.x.mul(220.0)), floor(z.mul(180.0))));
  const noseCol = mix(C('nose'), C('noseDark'), noseMottle.mul(0.6));
  col = mix(col, noseCol, isNose);

  const isPad = zoneIs(zone, CAT_ZONE.pad)
    .mul(smoothstep(float(0.030), float(0.020), y));
  // Paw top follows the coat (dark on a tortie); pad pink only on the very
  // sole (tight y gate so no maroon ring bands the ankle).
  const padBottom = smoothstep(float(0.010), float(0.004), y);
  col = mix(col, mix(col, C('pad'), padBottom), isPad);

  const isEar = zoneIs(zone, CAT_ZONE.ear)
    .mul(smoothstep(float(0.30), float(0.33), y));
  // Dark-backed pinna (tortie ears are near-black), a small warm inner flush
  // near the base only. Ear uv.x = 10 + t (0 base … 1 tip).
  const earT = clamp(coat.x.sub(10.0), 0.0, 1.0);
  const earDark = mix(col, C('black').mul(1.5), 0.72);
  const earInner = smoothstep(float(0.45), float(0.08), earT).mul(0.22);
  col = mix(col, mix(earDark, C('innerEar'), earInner), isEar);

  // SPHERE EYE — real bedded eyeball geometry (the horse approach, with a
  // feline iris). The iris/pupil paints in eye-local offsets on the eyeball's
  // forward hemisphere; a dark socket ring in the surrounding fur anchors the
  // ball so it reads seated, not glued on. Blink squashes the eye bone.
  const R = float(D.eyeRadius);
  const de = vec3(ax.sub(float(D.eyeX)), rest.y.sub(float(D.eyeY)), rest.z.sub(float(D.eyeZ)));
  const isEyeZone = zoneIs(zone, CAT_ZONE.eye);
  const nOut = normalize(vec3(0.46, 0.06, 0.89));   // outward-forward gaze axis
  const tDepth = dot(de, nOut);
  const radial = de.sub(nOut.mul(tDepth));
  const rr = length(radial).div(R);
  // green iris → darker limbal edge → near-black limbal ring
  let eyeCol = mix(C('iris'), C('irisRim'), smoothstep(float(0.35), float(0.75), rr));
  eyeCol = mix(eyeCol, C('pupil'), smoothstep(float(0.88), float(1.02), rr));
  // vertical-slit pupil: narrow across the horizontal tangent, tall in y
  const hAxis = normalize(cross(vec3(0, 1, 0), nOut));
  const ph = abs(dot(de, hAxis)).div(R);
  const pv = abs(de.y).div(R);
  const pupilM = smoothstep(float(0.30), float(0.14), ph)
    .mul(smoothstep(float(0.75), float(0.55), pv));
  eyeCol = mix(eyeCol, C('pupil'), pupilM);
  // upper/lower lid shadow so the dome tucks under the brow
  const lidT = smoothstep(float(0.45), float(0.75), de.y.div(R));
  const lidB = smoothstep(float(0.55), float(0.85), de.y.div(R).negate());
  eyeCol = mix(eyeCol, vec3(0.05, 0.04, 0.04), clamp(lidT.add(lidB), 0, 1));
  // rear hemisphere fades to socket-dark (only grazing angles ever see it)
  eyeCol = mix(vec3(0.05, 0.04, 0.04), eyeCol, smoothstep(float(-0.2), float(0.1), tDepth.div(R)));
  // corneal glint: a small bright dot INSIDE the iris, up-outward of centre
  const glint = smoothstep(float(0.11), float(0.045),
    length(radial.sub(hAxis.mul(R.mul(0.18))).sub(vec3(0, R.mul(0.22), 0))).div(R));
  eyeCol = mix(eyeCol, vec3(0.95, 0.97, 0.99), glint.mul(0.7));
  const inEye = isEyeZone;
  col = mix(col, eyeCol, inEye);
  // slim dark socket ring painted in the FUR around the eyeball
  const socket = smoothstep(R.mul(1.28), R.mul(1.02), length(de))
    .mul(float(1).sub(isEyeZone));
  col = mix(col, vec3(0.045, 0.038, 0.038), socket.mul(0.45));

  const isClaw = zoneIs(zone, CAT_ZONE.claw)
    .mul(smoothstep(float(0.035), float(0.025), y));
  col = mix(col, vec3(0.24, 0.21, 0.19), isClaw); // dark horn keratin

  // ---- sheen strength: glossy black, satin ginger, matte white/nose --------
  let sheenAmt = float(0.10);
  sheenAmt = mix(sheenAmt, float(0.16), float(1).sub(gingerSel)); // black glossier
  sheenAmt = mix(sheenAmt, float(0.04), whiteM);
  sheenAmt = mix(sheenAmt, float(0.0), isNose.add(isPad));
  sheenAmt = mix(sheenAmt, float(0.3), isClaw); // keratin sheen
  sheenAmt = mix(sheenAmt, float(0.5), inEye);  // wet painted-eye highlight

  return { albedo: col, sheenAmt, gingerSel, whiteM };
}

/** Shared in-shader lighting for shells (Basic materials — studio-matched). */
function catShade(u, albedo, sheenAmt, nW, pW, groomW, layerT) {
  const L = normalize(u.keyDir);
  const NdotL = dot(nW, L);
  const wrap = NdotL.mul(0.5).add(0.5);
  const diffuse = albedo.mul(u.keyColor).mul(wrap.mul(0.82).add(0.12));

  const hemi = mix(u.hemiGround, u.hemiSky, nW.y.mul(0.5).add(0.5));
  const ambient = albedo.mul(hemi).mul(0.4);

  const fillL = normalize(vec3(-0.5, 0.3, -0.35));
  const fill = albedo.mul(u.fillColor).mul(max(float(0.0), dot(nW, fillL)).mul(0.2));

  // Kajiya-Kay sheen along the groom tangent (fur anisotropy).
  const T = normalize(groomW);
  const V = normalize(cameraPosition.sub(pW));
  const TdotV = dot(T, V);
  const TdotL = dot(T, L);
  const sinTV = sqrt(max(float(0.0), sub(float(1.0), TdotV.mul(TdotV))));
  const sinTL = sqrt(max(float(0.0), sub(float(1.0), TdotL.mul(TdotL))));
  const kk = pow(max(float(0.0), sinTV.mul(sinTL).sub(TdotV.mul(TdotL))), float(40.0));
  const sheen = vec3(1.0, 0.99, 0.96).mul(kk).mul(sheenAmt).mul(layerT.mul(0.6).add(0.3));

  // Rim/backlight on the fur tips (soft halo), scaled by albedo.
  const rim = pow(sub(float(1.0), max(float(0.0), dot(nW, V))), float(2.4)).mul(layerT);
  const rimCol = albedo.mul(1.5).add(vec3(0.02)).mul(rim).mul(0.32);

  return acesTonemap(diffuse.add(ambient).add(fill).add(sheen).add(rimCol).mul(u.exposure));
}

/**
 * @param {CatUniforms} u
 * @param {number} layerIndex 1-based (0 is the undercoat mesh)
 * @param {number} shellCount
 */
export function createCatShellMaterial(u, layerIndex, shellCount) {
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

  // ---- shell extrusion: mostly along the normal (upright fur), slight groom
  //      lean + wind/inertia at the tips ------------------------------------
  const wind = u.breezeDir.mul(u.breeze).mul(layerT).mul(layerT);
  const bend = u.inertialBend.add(u.impulse).mul(layerT).mul(0.5);
  const raise = u.piloerection.mul(0.5);
  const groomN = normalize(groomDir.add(wind).add(bend));
  const lean = clamp(float(0.16).add(layerT.mul(0.24)).sub(raise), 0.05, 0.6);
  const extrudeDir = normalize(mix(normalLocal, groomN, lean));

  // Optional ruff: lengthen the neck + cheek fur into a mane/ruff (Maine-Coon
  // style) — a bind-space region gate, scaled by u.ruffAmt.
  const rzY = restPos.y;
  const rzZ = restPos.z;
  const neckRuff = smoothstep(float(0.26), float(0.16), rzZ).mul(smoothstep(float(0.10), float(0.17), rzZ));
  const cheekRuff = smoothstep(float(0.22), float(0.27), rzZ).mul(smoothstep(float(0.31), float(0.27), rzZ))
    .mul(smoothstep(float(0.24), float(0.29), rzY));
  const ruffMask = clamp(neckRuff.add(cheekRuff), 0, 1).mul(u.ruffAmt);
  const flBoost = float(1.0).add(ruffMask.mul(2.2));
  const shellHeight = fl.mul(u.maxFurLen).mul(flBoost).mul(layerT);

  // Coherent wave: the strand S-curves along its growth, phase locked to a
  // low-freq function of the rest position so neighbouring strands sway
  // TOGETHER (a coherent field, not per-pixel noise). Displaced along a
  // tangent perpendicular to both the normal and the groom.
  const wavePerp = normalize(cross(normalLocal, groomDir).add(vec3(0.0001, 0, 0)));
  const wavePhase = restPos.x.mul(38.0).add(restPos.z.mul(31.0)).add(restPos.y.mul(19.0));
  const waveAmt = sin(layerT.mul(4.2).add(wavePhase))
    .mul(u.coatWave).mul(layerT).mul(shellHeight).mul(0.6);
  material.positionNode = positionLocal.add(extrudeDir.mul(shellHeight)).add(wavePerp.mul(waveAmt));

  const vRest = varying(restPos, 'vCatRest');
  const vCoat = varying(coat, 'vCatCoat');
  const vZone = varying(zone, 'vCatZone');
  const vLayerT = varying(layerT, 'vCatLayerT');
  const vFl = varying(fl, 'vCatFl');
  const vGroomW = varying(modelWorldMatrix.mul(vec4(groomN, 0.0)).xyz, 'vCatGroomW');
  const vNormalW = varying(
    normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz),
    'vCatNormalW',
  );
  const vPosW = varying(positionWorld, 'vCatPosW');

  // ---- strand alpha: square rest-hashed cells, radial falloff, tip taper ----
  const strand = Fn(() => {
    const lt = vLayerT;
    const flv = vFl;
    // Cell size scales with local fur length (short dense head → soft ruff).
    // Real strand pitch is millimetres — 2cm cells read as blur, not fur.
    const cell = clamp(flv.mul(0.9), 0.002, 0.0075);
    const sC = vCoat.x.div(cell);
    const tC0 = vCoat.y.div(cell);
    // Coherent wave: shift the across-coordinate by a smooth sine seeded per
    // row, capped ≤0.3 cells so neighbouring pixels never hop cells (strands
    // stay continuous and wavy, not diced).
    const rowSeed = hash(floor(sC));
    const tC = tC0.add(sin(sC.mul(2.1).add(rowSeed.mul(6.28))).mul(0.24));
    const cellId = vec2(floor(sC), floor(tC));
    const h1 = hash2(cellId);
    const h2 = hash2(cellId.add(19.3));
    // Strand center jittered within the cell → tufts, not a grid.
    const cu = fract(sC).sub(h1.mul(0.6).add(0.2));
    const cv = fract(tC).sub(h2.mul(0.6).add(0.2));
    const rad = sqrt(cu.mul(cu).add(cv.mul(cv)));

    // Length variance per strand; taper the profile toward the tip.
    const strandLen = mix(float(0.62), float(1.0), h1);
    const tipT = clamp(lt.div(strandLen), 0.0, 1.0);
    // strand gets thinner as it rises → pointed tip (but a fat opaque base)
    const coreR = mix(float(0.72), float(0.16), tipT);
    let alpha = smoothstep(coreR, coreR.mul(0.45), rad);
    // cut off past the strand length
    alpha = alpha.mul(smoothstep(float(0.08), float(0.0), lt.sub(strandLen)));

    // Dense base coat so the undercoat never shows through as holes. Inner
    // shells stay nearly solid; only the outer third feathers into strands.
    const baseFill = mix(float(1.0), float(0.55), pow(lt, float(2.0)));
    alpha = max(alpha, float(1).sub(smoothstep(float(0.0), float(0.42), lt))).mul(baseFill);
    // Short-fur tracts (legs / face) pack solid so thin limbs never go ghostly.
    const shortBoost = smoothstep(float(0.007), float(0.004), flv);
    alpha = mix(alpha, clamp(alpha.mul(1.8).add(0.45), 0.0, 1.0), shortBoost);

    // Bare zones (nose / eye / pad soles) grow no shells.
    alpha = alpha.mul(smoothstep(float(0.0), float(0.0018), flv));
    alpha = alpha.mul(float(1).sub(u.nakedBody));
    return clamp(alpha, 0.0, 1.0).mul(h2.mul(0.1).add(0.92));
  });

  material.colorNode = Fn(() => {
    const { albedo, sheenAmt } = catAlbedo(u, vRest, vCoat, vZone);
    const lt = vLayerT;
    // Root AO: inner shells sit in self-shadow between strands.
    const rootAo = mix(float(0.5), float(1.0), pow(lt, float(0.7)));
    const nW = normalize(vNormalW);
    return catShade(u, albedo.mul(rootAo), sheenAmt, nW, vPosW, vGroomW, lt);
  })();

  material.opacityNode = strand();
  material.userData.catUniforms = u;
  return material;
}

/**
 * Undercoat: solid body under the shells (also the "naked" debug body).
 * @param {CatUniforms} u
 */
export function createCatBodyMaterial(u) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide, // ear pinnae are single-sided cards
  });
  const restPos = positionGeometry;
  const zone = attribute('zoneId', 'float');
  const coat = uv();
  const { albedo, whiteM } = catAlbedo(u, restPos, coat, zone);
  const isNose = zoneIs(zone, CAT_ZONE.nose);
  const isEye = zoneIs(zone, CAT_ZONE.eye);
  const isPad = zoneIs(zone, CAT_ZONE.pad);
  const bare = clamp(isNose.add(isEye).add(isPad), 0, 1);
  // Slightly darker under the shells so gaps read as fur depth.
  const under = albedo.mul(mix(float(0.7), float(1.0), bare));
  material.colorNode = mix(under, albedo, u.nakedBody);

  let rough = float(0.85);
  rough = mix(rough, float(0.72), whiteM);
  rough = mix(rough, float(0.35), isNose); // wet nose
  rough = mix(rough, float(0.10), isEye);  // glossy eye
  rough = mix(rough, float(0.6), isPad);
  material.roughnessNode = rough;
  material.userData.catUniforms = u;
  return material;
}

/**
 * Whisker ribbon material: pale, unlit, faintly translucent, with light
 * dynamics — each ribbon bends as t² (uv.x) under a per-whisker sine so the
 * vibrissae twitch/sway (driven by u.whiskerSway from the animation FSM).
 * @param {CatUniforms} u
 */
export function createCatWhiskerMaterial(u) {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const t = uv().x;                       // 0 root … 1 tip
  const px = positionLocal.x;
  // Per-whisker phase from the root x so left/right and neighbours decorrelate.
  const phase = px.mul(90.0);
  const wobble = sin(u.time.mul(6.0).add(phase))
    .mul(u.whiskerSway.mul(0.5).add(0.12)); // always a faint idle tremor
  const bend = t.mul(t);
  const off = vec3(
    wobble.mul(0.010).mul(bend),
    sin(u.time.mul(4.2).add(phase.mul(1.3))).mul(0.006).mul(bend),
    float(0.0),
  );
  material.positionNode = positionLocal.add(off);
  // Pale silver, fading translucent toward the tip.
  material.colorNode = vec3(0.92, 0.90, 0.86);
  material.opacityNode = clamp(sub(float(0.9), t.mul(0.5)), 0.2, 0.9)
    .mul(float(1).sub(u.nakedBody));
  material.userData.catUniforms = u;
  return material;
}

/**
 * CPU spring integrators → shader uniforms: inertial fur sway from root motion,
 * breeze, and impulse decay (same scheme as DogFurDynamics / GooseFeatherDynamics).
 */
export class CatFurDynamics {
  /** @param {CatUniforms} uniforms */
  constructor(uniforms) {
    this.u = uniforms;
    this.vel = new THREE.Vector3();
    this.bend = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.prevRoot = new THREE.Vector3();
    this.hasPrev = false;
    this.stiffness = 18;
    this.damping = 11;
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

    const target = accel.multiplyScalar(-0.018);
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
