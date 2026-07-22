/**
 * Bird proportion profiles — measurement oracles for procedural shape kits.
 *
 * Philosophy (same as dogs): we do **not** ship authored character meshes.
 * Birds are built from rudimentary lofts/capsules/cards skinned to a shared
 * skeleton. Reference GLBs (e.g. canada goose export) are measured once;
 * their envelopes become numbers here that drive body-plan construction for
 * waterfowl and inform the general bird kit going forward.
 *
 * Canada goose source (measurement only): `bird-canada-goose.glb`
 * Mesh envelope (bind): L/H ≈ 2.67 — healthy perched waterfowl ratio.
 * Station t goes tail→beak along Z; halfW/halfH are normalized 0–1 of mesh
 * width/height.
 */

/** @typedef {{ t: number, halfW: number, halfH: number, midY: number }} EnvelopeStation */

/**
 * @typedef {{
 *   lengthOverHeight: number,
 *   widthOverHeight: number,
 *   neckLen: number,
 *   neckThick: number,
 *   breastWidth: number,
 *   breastDepth: number,
 *   bodyScale: number,
 *   foldWing: number,
 *   wingScale: number,
 *   tail: number,
 *   tailFan: number,
 *   head: number,
 *   eye: number,
 *   beak: number,
 *   leg: number,
 *   shoulder: number,
 *   dorsalFlat: number,
 *   wingBar: number,
 *   throat: number,
 *   faceMask: number,
 *   rumpLift: number,
 *   breastDrop: number,
 *   envelope?: readonly EnvelopeStation[] | null,
 * }} BodyPlanProfile
 */

// ── Measured from canada-goose GLB (oracle, not mesh) ────────────────────

/** @type {readonly EnvelopeStation[]} */
export const CANADA_GOOSE_ENVELOPE = Object.freeze([
  { t: 0.0, halfW: 0.089, halfH: 0.094, midY: 0.618 },
  { t: 0.083, halfW: 0.086, halfH: 0.134, midY: 0.585 },
  { t: 0.167, halfW: 0.5, halfH: 0.187, midY: 0.549 }, // folded wing bulk
  { t: 0.25, halfW: 0.5, halfH: 0.225, midY: 0.53 },
  { t: 0.333, halfW: 0.369, halfH: 0.351, midY: 0.536 },
  { t: 0.417, halfW: 0.466, halfH: 0.452, midY: 0.452 }, // body max
  { t: 0.5, halfW: 0.413, halfH: 0.459, midY: 0.468 },
  { t: 0.583, halfW: 0.303, halfH: 0.456, midY: 0.495 },
  { t: 0.667, halfW: 0.039, halfH: 0.139, midY: 0.673 }, // long neck
  { t: 0.75, halfW: 0.023, halfH: 0.106, midY: 0.792 },
  { t: 0.833, halfW: 0.036, halfH: 0.14, midY: 0.86 },
  { t: 0.917, halfW: 0.033, halfH: 0.126, midY: 0.868 },
  { t: 1.0, halfW: 0.023, halfH: 0.089, midY: 0.818 },
]);

export const CANADA_GOOSE_MESH_BOUNDS = Object.freeze({
  length: 0.8672,
  height: 0.3252,
  width: 0.9941,
  lengthOverHeight: 2.667,
  widthOverHeight: 3.057,
});

export const CANADA_GOOSE_LANDMARKS = Object.freeze({
  tail_tip: { nz: 0.066, ny: 0.673 },
  hips: { nz: 0.411, ny: 0.665 },
  spine_0: { nz: 0.482, ny: 0.661 },
  spine_1: { nz: 0.581, ny: 0.684 },
  spine_2: { nz: 0.657, ny: 0.749 },
  spine_3: { nz: 0.673, ny: 0.931 },
  head: { nz: 0.708, ny: 1.102 },
  beak_tip: { nz: 0.892, ny: 1.02 },
  wing_1: { nz: 0.615, ny: 0.674 },
  wing_tip: { nz: 0.042, ny: 0.496 },
});

/**
 * Zone palette for Canada goose (field marks from photo boards — not a texture).
 * color = barred brown body/flanks; belly = cream breast; chin = pure white
 * chinstrap / undertail; accent = black head/neck/tail.
 */
export const CANADA_GOOSE_PALETTE = Object.freeze({
  color: 0x6b5a48,
  belly: 0xd4c8b4,
  accent: 0x0a0a0a,
  chin: 0xf7f5f0,
  beakColor: 0x101010,
  legColor: 0x121212,
  sheen: 0.1,
});

/**
 * Simplified passerine envelope (derived: shorter neck, rounder mid-body,
 * less wing bulk than goose). t = tail→beak.
 * @type {readonly EnvelopeStation[]}
 */
export const PASSERINE_ENVELOPE = Object.freeze([
  { t: 0.0, halfW: 0.12, halfH: 0.12, midY: 0.55 },
  { t: 0.15, halfW: 0.28, halfH: 0.28, midY: 0.52 },
  { t: 0.35, halfW: 0.48, halfH: 0.48, midY: 0.48 }, // plump body
  { t: 0.5, halfW: 0.5, halfH: 0.5, midY: 0.48 },
  { t: 0.65, halfW: 0.42, halfH: 0.42, midY: 0.5 },
  { t: 0.78, halfW: 0.28, halfH: 0.32, midY: 0.58 }, // short neck
  { t: 0.9, halfW: 0.22, halfH: 0.26, midY: 0.62 }, // head
  { t: 1.0, halfW: 0.08, halfH: 0.1, midY: 0.6 }, // bill
]);

/**
 * Body-plan kits — rudiments scale factors + optional envelope.
 * buildBirdBodyGeometry places capsules/lofts/cards from these numbers.
 *
 * @type {Readonly<Record<string, BodyPlanProfile>>}
 */
export const BODY_PLAN_PROFILES = Object.freeze({
  passerine: {
    lengthOverHeight: 2.1,
    widthOverHeight: 1.6,
    neckLen: 1,
    neckThick: 0.72,
    breastWidth: 1.2,
    breastDepth: 1.22,
    bodyScale: 1.05,
    foldWing: 1.2,
    wingScale: 0.92,
    tail: 1.15,
    tailFan: 0.95,
    head: 1.0,
    eye: 1.2,
    beak: 0.92,
    leg: 0.82,
    shoulder: 1,
    dorsalFlat: 0.9,
    wingBar: 0.8,
    throat: 1.2,
    faceMask: 0.85,
    rumpLift: 1,
    breastDrop: 1.15,
    envelope: PASSERINE_ENVELOPE,
  },
  hummingbird: {
    lengthOverHeight: 2.0,
    widthOverHeight: 2.4,
    neckLen: 1,
    neckThick: 0.65,
    breastWidth: 0.85,
    breastDepth: 0.9,
    bodyScale: 0.85,
    foldWing: 0.45,
    wingScale: 1.4,
    tail: 0.65,
    tailFan: 0.7,
    head: 1.2,
    eye: 1.25,
    beak: 1.55,
    leg: 0.65,
    shoulder: 1,
    dorsalFlat: 0.95,
    wingBar: 0,
    throat: 1.2,
    faceMask: 0.4,
    rumpLift: 1,
    breastDrop: 1,
    envelope: null,
  },
  raptor: {
    lengthOverHeight: 2.2,
    widthOverHeight: 1.8,
    neckLen: 1,
    neckThick: 0.8,
    breastWidth: 1.18,
    breastDepth: 1.12,
    bodyScale: 1.05,
    foldWing: 1.15,
    wingScale: 1.25,
    tail: 1.05,
    tailFan: 1.15,
    head: 1.08,
    eye: 1.2,
    beak: 1.1,
    leg: 1.3,
    shoulder: 1.25,
    dorsalFlat: 0.88,
    wingBar: 0,
    throat: 0.85,
    faceMask: 0.5,
    rumpLift: 1,
    breastDrop: 1,
    envelope: null,
  },
  parrot: {
    lengthOverHeight: 2.4,
    widthOverHeight: 1.5,
    neckLen: 1,
    neckThick: 0.7,
    breastWidth: 1.12,
    breastDepth: 1.18,
    bodyScale: 1.0,
    foldWing: 1.05,
    wingScale: 1.1,
    tail: 1.5,
    tailFan: 0.8,
    head: 1.18,
    eye: 1.0,
    beak: 1.4,
    leg: 1.1,
    shoulder: 1,
    dorsalFlat: 0.9,
    wingBar: 0,
    throat: 0.9,
    faceMask: 0,
    rumpLift: 1,
    breastDrop: 1.1,
    envelope: null,
  },
  /**
   * Waterfowl body plan — boat hull + keeled sternum, modest black tail,
   * optional long S-curve neck via presentation.neckLen.
   * Radii follow CANADA_GOOSE_ENVELOPE (measurement oracle, not mesh).
   * neckThick ~1 here; breed knobs set thin (goose ~0.55) / thick (mallard ~1.3).
   */
  waterfowl: {
    lengthOverHeight: CANADA_GOOSE_MESH_BOUNDS.lengthOverHeight,
    widthOverHeight: 1.75,
    neckLen: 2.0,
    neckThick: 1.0,
    breastWidth: 1.32,
    breastDepth: 1.28,
    bodyScale: 1.18,
    foldWing: 1.22,
    wingScale: 1.05,
    tail: 0.72,
    tailFan: 0.7,
    head: 0.92,
    eye: 0.92,
    beak: 1.05,
    leg: 0.95,
    shoulder: 1.12,
    dorsalFlat: 0.82,
    wingBar: 0,
    throat: 0.5,
    faceMask: 0,
    rumpLift: 0.55,
    breastDrop: 0.85,
    envelope: CANADA_GOOSE_ENVELOPE,
  },
  pigeon: {
    lengthOverHeight: 2.0,
    widthOverHeight: 1.7,
    neckLen: 1.05,
    neckThick: 1.05,
    breastWidth: 1.3,
    breastDepth: 1.28,
    bodyScale: 1.15,
    foldWing: 1.15,
    wingScale: 1.1,
    tail: 0.9,
    tailFan: 1.05,
    head: 0.88,
    eye: 0.95,
    beak: 0.7,
    leg: 1.0,
    shoulder: 1,
    dorsalFlat: 0.9,
    wingBar: 0.4,
    throat: 1.2,
    faceMask: 0,
    rumpLift: 1,
    breastDrop: 1.2,
    envelope: PASSERINE_ENVELOPE,
  },
});

/**
 * Rudimentary shape kit used by buildBirdBodyGeometry (dog-style primitives).
 * Each part is a loft/capsule/card; placement is bone-relative.
 */
export const BIRD_SHAPE_KIT = Object.freeze({
  /** Oval loft along hips→spine→head (and optional long neck) */
  body: 'ovalLoft',
  /** Sphere / short loft at head */
  head: 'sphereCap',
  /** Point / needle / hook / flat / cone along mouth bones */
  beak: 'beakStyle',
  /** Soft belly/thigh spheres (hide legs on passerines) */
  fluff: 'softSpheres',
  /** Folded flank pack + primary cards (perched silhouette) */
  wingFold: 'foldPack',
  /** Thin proximal ribbons for Flap/Glide open wing */
  wingFlight: 'thinRibbon',
  /** Discrete rectrices from tail chain */
  tail: 'rectrices',
  /** Tubes + foot style (perch / talon / web / zygodactyl) */
  leg: 'tubeFeet',
});

/**
 * @param {string} planId
 * @returns {BodyPlanProfile}
 */
export function getBodyPlanProfile(planId) {
  return BODY_PLAN_PROFILES[planId] ?? BODY_PLAN_PROFILES.passerine;
}

/**
 * @param {number} t
 * @param {readonly EnvelopeStation[]} stations
 */
export function sampleEnvelope(t, stations) {
  const list = stations?.length ? stations : PASSERINE_ENVELOPE;
  const u = Math.max(0, Math.min(1, t));
  if (u <= list[0].t) return { ...list[0] };
  if (u >= list[list.length - 1].t) return { ...list[list.length - 1] };
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i];
    const b = list[i + 1];
    if (u >= a.t && u <= b.t) {
      const f = (u - a.t) / Math.max(1e-6, b.t - a.t);
      return {
        t: u,
        halfW: a.halfW + (b.halfW - a.halfW) * f,
        halfH: a.halfH + (b.halfH - a.halfH) * f,
        midY: a.midY + (b.midY - a.midY) * f,
      };
    }
  }
  return { ...list[list.length - 1] };
}

/**
 * Absolute half-width / half-height for a body-plan envelope station.
 * @param {string} planId
 * @param {number} t 0=tail … 1=beak
 * @param {number} bodyLen hips→head (or similar)
 * @param {{ widthScale?: number, heightScale?: number }} [opts]
 */
export function planStationRadii(planId, t, bodyLen, opts = {}) {
  const plan = getBodyPlanProfile(planId);
  const stations = plan.envelope;
  if (!stations?.length) {
    // Fallback teardrop without measured envelope
    const u = Math.max(0, Math.min(1, t));
    const belly = Math.sin(u * Math.PI);
    return {
      rx: bodyLen * 0.22 * (0.35 + 0.65 * belly) * (opts.widthScale ?? 1),
      ry: bodyLen * 0.18 * (0.35 + 0.65 * belly) * (opts.heightScale ?? 1),
      midY: 0.5,
    };
  }
  const env = sampleEnvelope(t, stations);
  // Scale envelope to body length using plan L/H / W/H targets
  const fullH = bodyLen / Math.max(0.5, plan.lengthOverHeight);
  const fullW = fullH * plan.widthOverHeight;
  return {
    rx: env.halfW * fullW * (opts.widthScale ?? 1),
    ry: env.halfH * fullH * (opts.heightScale ?? 1),
    midY: env.midY,
  };
}

/** @deprecated use planStationRadii('waterfowl', ...) */
export function waterfowlStationRadii(t, bodyLen, opts = {}) {
  return planStationRadii('waterfowl', t, bodyLen, opts);
}
