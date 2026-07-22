/**
 * Bird varieties of the procedural Canada-goose body.
 *
 * Every authored bird breed shares the goose skeleton, ring-loft mesh, shell
 * plumage, flight-feather cards, and procedural FSM. Per-breed identity is:
 *   - overall root scale (relative to the native goose body = 1)
 *   - plumage palette (mapped onto goose color slots)
 *   - pattern knobs (stocking / chinstrap / barring / breast pale)
 *   - seed micro-variation for gallery A/B
 *
 * Field-mark masks stay landmark-ratio (goose bind space). Non-goose breeds
 * turn chinstrap/stocking down and recolor slots so the same geometry reads
 * as a different species rather than a retextured goose.
 */

import * as THREE from 'three';
import { getBirdBodyType } from './birdBodyTypeDefaults.js';

/** Native goose standing height (m) — variety scales multiply this. */
export const GOOSE_BODY_REFERENCE_SCALE = 1;

/** Photo-sampled Canada goose palette (sRGB floats) — matches goosePlumage.GOOSE_COLORS. */
const CANADA_GOOSE_SLOT_COLORS = Object.freeze({
  stocking: [0.052, 0.052, 0.058],   // black head + neck only
  chinstrap: [0.93, 0.905, 0.85],
  breast: [0.78, 0.725, 0.64],
  belly: [0.895, 0.875, 0.84],
  vent: [0.93, 0.915, 0.885],
  backBase: [0.40, 0.33, 0.252],
  backEdge: [0.655, 0.575, 0.462],
  flankBase: [0.555, 0.495, 0.415],
  flankEdge: [0.705, 0.65, 0.572],
  wingBase: [0.36, 0.30, 0.235],
  wingEdge: [0.60, 0.52, 0.41],
  // Dark brown remiges/tail — body must not read pure black
  primary: [0.28, 0.23, 0.18],
  tail: [0.32, 0.26, 0.20],
  bill: [0.048, 0.047, 0.05],
  leg: [0.088, 0.086, 0.084],
  eyeIris: [0.16, 0.10, 0.06],
});

/**
 * Hex → raw sRGB float triple for shader uniforms.
 * Avoid THREE.Color(hex).r which is linear under color management — plumage
 * slots are authored/consumed as sRGB floats (matches GOOSE_COLORS).
 * @param {number} hex
 * @returns {[number, number, number]}
 */
export function hexToSrgb(hex) {
  const h = hex >>> 0;
  return [
    ((h >> 16) & 255) / 255,
    ((h >> 8) & 255) / 255,
    (h & 255) / 255,
  ];
}

/**
 * Darken / lighten a hex toward black or white (sRGB channel mix).
 * @param {number} hex
 * @param {number} t  negative = darker, positive = lighter (−1..1)
 */
function shiftHex(hex, t) {
  const [r, g, b] = hexToSrgb(hex);
  if (t < 0) {
    const k = 1 + t;
    return (
      (Math.round(r * k * 255) << 16)
      | (Math.round(g * k * 255) << 8)
      | Math.round(b * k * 255)
    );
  }
  const k = t;
  return (
    (Math.round((r + (1 - r) * k) * 255) << 16)
    | (Math.round((g + (1 - g) * k) * 255) << 8)
    | Math.round((b + (1 - b) * k) * 255)
  );
}

/**
 * Build a full goose-slot palette from the compact breed presentation colors.
 * @param {{
 *   color: number, belly: number, accent: number,
 *   chin?: number, beakColor: number, legColor: number,
 *   sheen?: number,
 * }} p
 */
function paletteFromPresentation(p) {
  const body = p.color;
  const belly = p.belly;
  const accent = p.accent;
  const chin = p.chin ?? 0xe8e4d8;
  const beak = p.beakColor;
  const leg = p.legColor;
  return {
    stocking: hexToSrgb(accent),
    chinstrap: hexToSrgb(chin),
    breast: hexToSrgb(shiftHex(belly, -0.08)),
    belly: hexToSrgb(belly),
    vent: hexToSrgb(shiftHex(belly, 0.12)),
    backBase: hexToSrgb(body),
    backEdge: hexToSrgb(shiftHex(body, 0.22)),
    flankBase: hexToSrgb(shiftHex(body, 0.1)),
    flankEdge: hexToSrgb(shiftHex(body, 0.28)),
    wingBase: hexToSrgb(shiftHex(body, -0.12)),
    wingEdge: hexToSrgb(shiftHex(body, 0.18)),
    primary: hexToSrgb(shiftHex(accent, -0.35)),
    tail: hexToSrgb(shiftHex(accent, -0.4)),
    bill: hexToSrgb(beak),
    leg: hexToSrgb(leg),
    eyeIris: hexToSrgb(0x2a1a10),
    sheen: Number.isFinite(p.sheen) ? p.sheen : 0.1,
  };
}

/**
 * @typedef {{
 *   label: string,
 *   scale: number,
 *   stockingAmt: number,
 *   chinstrapAmt: number,
 *   barringAmt: number,
 *   breastPaleAmt: number,
 *   maxFeatherLen: number,
 *   palette: ReturnType<typeof paletteFromPresentation>,
 *   bodyPlan: string,
 *   beakStyle: string,
 *   footStyle: string,
 *   eyeStyle: string,
 *   neckLen: number,
 *   bodyUpright: number,
 *   bodyFat: number,
 * }} BirdVariety
 */

/**
 * Per-breed variety of the goose body.
 * Scales are relative to the native Canada-goose mesh (1.0 = full goose).
 * Shape knobs (neckLen / bodyUpright / beak / foot / eye) drive gooseMorph.
 */
export const BIRD_VARIETIES = Object.freeze({
  'canada-goose': Object.freeze({
    label: 'Canada Goose',
    scale: 1.0,
    stockingAmt: 1,
    chinstrapAmt: 1,
    barringAmt: 1,
    breastPaleAmt: 1,
    maxFeatherLen: 1,
    bodyPlan: 'waterfowl',
    beakStyle: 'goose',
    footStyle: 'web',
    eyeStyle: 'beady',
    neckLen: 1.0,
    bodyUpright: 0.0,
    bodyFat: 1.12,
    // Keep the photo-sampled Canada palette exactly (not presentation remap).
    palette: Object.freeze({
      ...Object.fromEntries(
        Object.entries(CANADA_GOOSE_SLOT_COLORS).map(([k, v]) => [k, Object.freeze([...v])]),
      ),
      sheen: 0.12,
    }),
  }),

  mallard: Object.freeze({
    label: 'Mallard',
    scale: 0.72,
    stockingAmt: 0.95,
    chinstrapAmt: 0.15, // thin white neck-ring suggestion
    barringAmt: 0.55,
    breastPaleAmt: 0.7,
    maxFeatherLen: 0.95,
    bodyPlan: 'waterfowl',
    beakStyle: 'flat',
    footStyle: 'web',
    eyeStyle: 'beady',
    neckLen: 0.48,
    bodyUpright: 0.08,
    bodyFat: 1.22,
    palette: paletteFromPresentation({
      color: 0x5a6a58,
      belly: 0xc8b070,
      accent: 0x1a6b3a, // green head
      chin: 0xe8e4d8,
      beakColor: 0xd4b020,
      legColor: 0xc86830,
      sheen: 0.22,
    }),
  }),

  'eastern-phoebe': Object.freeze({
    label: 'Eastern Phoebe',
    scale: 0.36,
    stockingAmt: 0.35,
    chinstrapAmt: 0,
    barringAmt: 0.2,
    breastPaleAmt: 1.1,
    maxFeatherLen: 0.75,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    eyeStyle: 'large',
    neckLen: 0.07,
    bodyUpright: 0.9,
    bodyFat: 0.95,
    palette: paletteFromPresentation({
      color: 0x6b6e66,
      belly: 0xe8e4d4,
      accent: 0x3a3c38,
      beakColor: 0x1a1814,
      legColor: 0x1a1814,
      sheen: 0.04,
    }),
  }),

  'blue-gray-tanager': Object.freeze({
    label: 'Blue-gray Tanager',
    scale: 0.38,
    stockingAmt: 0.45,
    chinstrapAmt: 0,
    barringAmt: 0.12,
    breastPaleAmt: 0.9,
    maxFeatherLen: 0.78,
    bodyPlan: 'passerine',
    beakStyle: 'cone',
    footStyle: 'perch',
    eyeStyle: 'large',
    neckLen: 0.09,
    bodyUpright: 0.86,
    bodyFat: 1.0,
    palette: paletteFromPresentation({
      color: 0x7a9bb5,
      belly: 0xc0d0dc,
      accent: 0x4a6a82,
      beakColor: 0x1e1c18,
      legColor: 0x3a3430,
      sheen: 0.1,
    }),
  }),

  'ruby-throated-hummingbird': Object.freeze({
    label: 'Ruby-throated Hummingbird',
    scale: 0.18,
    stockingAmt: 0.55,
    chinstrapAmt: 0.85, // ruby throat
    barringAmt: 0.08,
    breastPaleAmt: 0.85,
    maxFeatherLen: 0.55,
    bodyPlan: 'hummingbird',
    beakStyle: 'needle',
    footStyle: 'perch',
    eyeStyle: 'large',
    neckLen: 0.03,
    bodyUpright: 0.94,
    bodyFat: 0.7,
    palette: paletteFromPresentation({
      color: 0x3d8f5a,
      belly: 0xd0e4c0,
      accent: 0x2a7048,
      chin: 0xc42828,
      beakColor: 0x1a1a18,
      legColor: 0x2a2820,
      sheen: 0.55,
    }),
  }),

  'rock-pigeon': Object.freeze({
    label: 'Rock Pigeon',
    scale: 0.5,
    stockingAmt: 0.55,
    chinstrapAmt: 0.2,
    barringAmt: 0.35,
    breastPaleAmt: 0.75,
    maxFeatherLen: 0.9,
    bodyPlan: 'pigeon',
    beakStyle: 'cone',
    footStyle: 'perch',
    eyeStyle: 'beady',
    neckLen: 0.2,
    bodyUpright: 0.52,
    bodyFat: 1.18,
    palette: paletteFromPresentation({
      color: 0x6a7080,
      belly: 0x9aa0ac,
      accent: 0x5a3a6a, // iridescent neck cast
      chin: 0xb0a8b8,
      beakColor: 0xc8c0b0,
      legColor: 0xc45a4a,
      sheen: 0.35,
    }),
  }),

  'european-robin': Object.freeze({
    label: 'European Robin',
    scale: 0.32,
    stockingAmt: 0.15,
    chinstrapAmt: 0, // orange breast handled via breast/belly colors
    barringAmt: 0.15,
    breastPaleAmt: 1.25,
    maxFeatherLen: 0.72,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    eyeStyle: 'large',
    neckLen: 0.06,
    bodyUpright: 0.92,
    bodyFat: 1.08,
    palette: paletteFromPresentation({
      color: 0x6a5840,
      belly: 0xf07838, // orange breast/face
      accent: 0x4a3a28,
      beakColor: 0x1a1814,
      legColor: 0x5a3a28,
      sheen: 0.06,
    }),
  }),

  'rufous-hornero': Object.freeze({
    label: 'Rufous Hornero',
    scale: 0.4,
    stockingAmt: 0.3,
    chinstrapAmt: 0,
    barringAmt: 0.25,
    breastPaleAmt: 0.95,
    maxFeatherLen: 0.8,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    eyeStyle: 'soft',
    neckLen: 0.1,
    bodyUpright: 0.84,
    bodyFat: 1.0,
    palette: paletteFromPresentation({
      color: 0xb56a3a,
      belly: 0xd4a070,
      accent: 0x6a3a18,
      beakColor: 0x3a3020,
      legColor: 0x4a4030,
      sheen: 0.04,
    }),
  }),

  'red-tailed-hawk': Object.freeze({
    label: 'Red-tailed Hawk',
    scale: 0.88,
    stockingAmt: 0.25,
    chinstrapAmt: 0,
    barringAmt: 0.85,
    breastPaleAmt: 1.05,
    maxFeatherLen: 1.05,
    bodyPlan: 'raptor',
    beakStyle: 'hook',
    footStyle: 'talon',
    eyeStyle: 'raptor',
    neckLen: 0.22,
    bodyUpright: 0.55,
    bodyFat: 1.05,
    palette: paletteFromPresentation({
      color: 0x8a5a3a,
      belly: 0xd4c4a0,
      accent: 0xc04020, // rufous tail cast into accents/primaries
      beakColor: 0xc8a020,
      legColor: 0xc8a040,
      sheen: 0.08,
    }),
  }),

  'house-finch': Object.freeze({
    label: 'House Finch',
    scale: 0.3,
    stockingAmt: 0.5,
    chinstrapAmt: 0.35, // red wash on head/breast
    barringAmt: 0.3,
    breastPaleAmt: 0.9,
    maxFeatherLen: 0.7,
    bodyPlan: 'passerine',
    beakStyle: 'cone',
    footStyle: 'perch',
    eyeStyle: 'large',
    neckLen: 0.07,
    bodyUpright: 0.88,
    bodyFat: 0.95,
    palette: paletteFromPresentation({
      color: 0x8a6a5a,
      belly: 0xe8d8c8,
      accent: 0xc43838,
      chin: 0xd45050,
      beakColor: 0x3a2820,
      legColor: 0x4a3a28,
      sheen: 0.05,
    }),
  }),

  'scarlet-macaw': Object.freeze({
    label: 'Scarlet Macaw',
    scale: 0.82,
    stockingAmt: 0.75,
    chinstrapAmt: 0.4,
    barringAmt: 0.1,
    breastPaleAmt: 0.55,
    maxFeatherLen: 1.1,
    bodyPlan: 'parrot',
    beakStyle: 'hook',
    footStyle: 'zygodactyl',
    eyeStyle: 'large',
    neckLen: 0.16,
    bodyUpright: 0.7,
    bodyFat: 0.98,
    palette: paletteFromPresentation({
      color: 0xd42a2a,
      belly: 0xe8c020,
      accent: 0x2050c0,
      chin: 0xf0e8d8,
      beakColor: 0xe8e0d0,
      legColor: 0x4a4a48,
      sheen: 0.18,
    }),
  }),
});

/** Deterministic [0,1) from seed + salt. */
function seedUnit(seed, salt = 0) {
  let h = (seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * Nudge an sRGB triple slightly for seed variation.
 * Manual HSL so we never cross Three color-management (keeps sRGB floats).
 * @param {[number, number, number]} rgb
 * @param {number} seed
 * @param {number} salt
 * @returns {[number, number, number]}
 */
function nudgeRgb(rgb, seed, salt) {
  let [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) * 0.5;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6; break;
    }
  }
  h = (h + (seedUnit(seed, salt) - 0.5) * 0.04 + 1) % 1;
  s = THREE.MathUtils.clamp(s + (seedUnit(seed, salt + 1) - 0.5) * 0.08, 0.05, 1);
  const nl = THREE.MathUtils.clamp(l + (seedUnit(seed, salt + 2) - 0.5) * 0.06, 0.08, 0.92);
  if (s < 1e-6) return [nl, nl, nl];
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s;
  const p = 2 * nl - q;
  return [
    hue2rgb(p, q, h + 1 / 3),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1 / 3),
  ];
}

/**
 * Resolve a breed variety, optionally applying seed micro-variation.
 * Unknown breeds fall back to Canada goose.
 *
 * @param {string} breedId
 * @param {number} [seed]
 * @returns {BirdVariety}
 */
export function resolveBirdVariety(breedId, seed = 1) {
  const id = String(breedId ?? 'canada-goose').trim().toLowerCase();
  const base = BIRD_VARIETIES[id] ?? BIRD_VARIETIES['canada-goose'];
  const s = seed >>> 0;
  const scaleJitter = 1 + (seedUnit(s, 3) - 0.5) * 0.05;
  // Shape from live body-type store (P-menu) so whole plans retarget together.
  const planShape = getBirdBodyType(base.bodyPlan);

  // Canada goose keeps the photo-true palette (tiny scale jitter only).
  const socketFields = {
    neckSocketX: planShape.neckSocketX ?? 0,
    neckSocketY: planShape.neckSocketY ?? 0,
    neckSocketZ: planShape.neckSocketZ ?? 0,
    neckSocketRotX: planShape.neckSocketRotX ?? 0,
    neckSocketRotY: planShape.neckSocketRotY ?? 0,
    neckSocketRotZ: planShape.neckSocketRotZ ?? 0,
  };
  const beakXformFields = {
    beakPosX: planShape.beakPosX ?? 0,
    beakPosY: planShape.beakPosY ?? 0,
    beakPosZ: planShape.beakPosZ ?? 0,
    beakRotX: planShape.beakRotX ?? 0,
    beakRotY: planShape.beakRotY ?? 0,
    beakRotZ: planShape.beakRotZ ?? 0,
    beakScaleX: planShape.beakScaleX ?? 1,
    beakScaleY: planShape.beakScaleY ?? 1,
    beakScaleZ: planShape.beakScaleZ ?? 1,
  };

  if (id === 'canada-goose' && base === BIRD_VARIETIES['canada-goose']) {
    return {
      ...base,
      scale: base.scale * scaleJitter,
      neckLen: planShape.neckLen,
      neckRot: planShape.neckRot ?? 0,
      ...socketFields,
      ...beakXformFields,
      bodyUpright: planShape.bodyUpright,
      bodyFat: planShape.bodyFat,
      beakStyle: planShape.beakStyle,
      footStyle: planShape.footStyle,
      eyeStyle: planShape.eyeStyle,
      palette: { ...base.palette },
    };
  }

  const pal = base.palette;
  return {
    ...base,
    scale: base.scale * scaleJitter,
    neckLen: THREE.MathUtils.clamp(
      planShape.neckLen + (seedUnit(s, 110) - 0.5) * 0.04,
      0,
      1,
    ),
    neckRot: THREE.MathUtils.clamp(
      (planShape.neckRot ?? 0) + (seedUnit(s, 113) - 0.5) * 0.06,
      -1,
      1,
    ),
    ...socketFields,
    ...beakXformFields,
    bodyUpright: THREE.MathUtils.clamp(
      planShape.bodyUpright + (seedUnit(s, 111) - 0.5) * 0.04,
      0,
      1,
    ),
    bodyFat: THREE.MathUtils.clamp(
      planShape.bodyFat * (1 + (seedUnit(s, 112) - 0.5) * 0.06),
      0.55,
      1.45,
    ),
    beakStyle: planShape.beakStyle,
    footStyle: planShape.footStyle,
    eyeStyle: planShape.eyeStyle,
    stockingAmt: THREE.MathUtils.clamp(
      base.stockingAmt + (seedUnit(s, 50) - 0.5) * 0.06,
      0,
      1.2,
    ),
    chinstrapAmt: THREE.MathUtils.clamp(
      base.chinstrapAmt + (seedUnit(s, 51) - 0.5) * 0.05,
      0,
      1.2,
    ),
    barringAmt: THREE.MathUtils.clamp(
      base.barringAmt + (seedUnit(s, 52) - 0.5) * 0.08,
      0,
      1.2,
    ),
    maxFeatherLen: THREE.MathUtils.clamp(
      base.maxFeatherLen * (1 + (seedUnit(s, 53) - 0.5) * 0.08),
      0.4,
      1.4,
    ),
    palette: {
      stocking: nudgeRgb(pal.stocking, s, 10),
      chinstrap: nudgeRgb(pal.chinstrap, s, 20),
      breast: nudgeRgb(pal.breast, s, 30),
      belly: nudgeRgb(pal.belly, s, 40),
      vent: nudgeRgb(pal.vent, s, 45),
      backBase: nudgeRgb(pal.backBase, s, 50),
      backEdge: nudgeRgb(pal.backEdge, s, 55),
      flankBase: nudgeRgb(pal.flankBase, s, 60),
      flankEdge: nudgeRgb(pal.flankEdge, s, 65),
      wingBase: nudgeRgb(pal.wingBase, s, 70),
      wingEdge: nudgeRgb(pal.wingEdge, s, 75),
      primary: nudgeRgb(pal.primary, s, 80),
      tail: nudgeRgb(pal.tail, s, 85),
      bill: nudgeRgb(pal.bill, s, 90),
      leg: nudgeRgb(pal.leg, s, 95),
      eyeIris: pal.eyeIris,
      sheen: THREE.MathUtils.clamp(
        (pal.sheen ?? 0.1) + (seedUnit(s, 100) - 0.5) * 0.04,
        0,
        0.7,
      ),
    },
  };
}

/**
 * Apply a resolved variety onto goose plumage uniforms.
 * @param {import('./goosePlumage.js').GooseUniforms} uniforms
 * @param {BirdVariety} variety
 */
export function applyBirdVarietyToUniforms(uniforms, variety) {
  const p = variety.palette;
  const set = (u, rgb) => {
    if (!u?.value) return;
    // Match createGooseUniforms colorU: raw floats into Color (same space as
    // GOOSE_COLORS literals — photo sRGB numbers used as shader channel values).
    if (u.value.isColor) {
      u.value.setRGB(rgb[0], rgb[1], rgb[2]);
    } else if (Array.isArray(u.value)) {
      u.value[0] = rgb[0];
      u.value[1] = rgb[1];
      u.value[2] = rgb[2];
    }
  };
  set(uniforms.cStocking, p.stocking);
  set(uniforms.cChinstrap, p.chinstrap);
  set(uniforms.cBreast, p.breast);
  set(uniforms.cBelly, p.belly);
  set(uniforms.cVent, p.vent);
  set(uniforms.cBackBase, p.backBase);
  set(uniforms.cBackEdge, p.backEdge);
  set(uniforms.cFlankBase, p.flankBase);
  set(uniforms.cFlankEdge, p.flankEdge);
  set(uniforms.cWingBase, p.wingBase);
  set(uniforms.cWingEdge, p.wingEdge);
  set(uniforms.cPrimary, p.primary);
  set(uniforms.cTail, p.tail);
  set(uniforms.cBill, p.bill);
  set(uniforms.cLeg, p.leg);
  set(uniforms.cEyeIris, p.eyeIris);

  if (uniforms.stockingAmt) uniforms.stockingAmt.value = variety.stockingAmt;
  if (uniforms.chinstrapAmt) uniforms.chinstrapAmt.value = variety.chinstrapAmt;
  if (uniforms.barringAmt) uniforms.barringAmt.value = variety.barringAmt;
  if (uniforms.breastPaleAmt) uniforms.breastPaleAmt.value = variety.breastPaleAmt;
  if (uniforms.maxFeatherLen) uniforms.maxFeatherLen.value = variety.maxFeatherLen;
  if (uniforms.sheenBoost) uniforms.sheenBoost.value = variety.palette.sheen ?? 0.1;
}
