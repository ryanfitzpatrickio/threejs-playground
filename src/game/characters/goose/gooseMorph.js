/**
 * Goose-body shape morph — continuous knobs that turn the Canada-goose mesh
 * into other bird silhouettes without a second rig.
 *
 *   neckLen           0..1   full S-neck → almost no neck (head on breast)
 *   neckSocketX/Y/Z   m      neck–body socket offset from spine_3 (body space)
 *   neckSocketRotX/Y/Z deg   Euler at the socket (XYZ). 180 on an axis flips the
 *                            cervical column — use this if the head/neck reads
 *                            upside-down or displaced after upright morph.
 *   neckRot          -1..1   legacy pitch shorthand → adds to neckSocketRotX
 *   bodyUpright       0..1   horizontal waterfowl → upright passerine
 *   bodyFat           0.55..1.45  torso girth
 *   beakStyle / footStyle / eyeStyle
 *   beakPosX/Y/Z      m      bill offset from bill base (head space)
 *   beakRotX/Y/Z      deg    Euler at bill base (XYZ)
 *   beakScaleX/Y/Z           non-uniform scale about bill base (1 = identity)
 *
 * `resolveGooseMorph` clamps + fills defaults. `buildGooseBoneWorldPos` lays
 * out the bind skeleton; geometry + plumage landmarks consume the same dims.
 */

import { GOOSE_DIMS } from './gooseDims.js';
import { getBirdBodyType } from './birdBodyTypeDefaults.js';

/** @typedef {'goose'|'flat'|'point'|'cone'|'needle'|'hook'} BeakStyle */
/** @typedef {'web'|'perch'|'talon'|'zygodactyl'} FootStyle */
/** @typedef {'beady'|'large'|'raptor'|'soft'} EyeStyle */

/**
 * @typedef {{
 *   neckLen: number,
 *   neckRot?: number,
 *   neckSocketX?: number,
 *   neckSocketY?: number,
 *   neckSocketZ?: number,
 *   neckSocketRotX?: number,
 *   neckSocketRotY?: number,
 *   neckSocketRotZ?: number,
 *   bodyUpright: number,
 *   bodyFat: number,
 *   beakStyle: BeakStyle,
 *   beakPosX?: number,
 *   beakPosY?: number,
 *   beakPosZ?: number,
 *   beakRotX?: number,
 *   beakRotY?: number,
 *   beakRotZ?: number,
 *   beakScaleX?: number,
 *   beakScaleY?: number,
 *   beakScaleZ?: number,
 *   footStyle: FootStyle,
 *   eyeStyle: EyeStyle,
 *   beakLen?: number,
 *   eyeScale?: number,
 * }} GooseMorphInput
 */

/**
 * @typedef {GooseMorphInput & {
 *   dims: typeof GOOSE_DIMS & Record<string, number>,
 *   neckPath: Array<[number, number, number]>,
 *   headPos: [number, number, number],
 *   neckSocket: { x: number, y: number, z: number },
 *   neckSocketRot: { x: number, y: number, z: number },
 *   pitchAngle: number,
 *   beak: {
 *     style: BeakStyle,
 *     length: number,
 *     width: number,
 *     depth: number,
 *     droop: number,
 *     hook: number,
 *     crease: number,
 *     boxy: number,
 *   },
 *   beakXform: {
 *     pos: { x: number, y: number, z: number },
 *     rot: { x: number, y: number, z: number },
 *     scale: { x: number, y: number, z: number },
 *   },
 *   eye: { radius: number, x: number, y: number, z: number },
 *   foot: {
 *     style: FootStyle,
 *     web: boolean,
 *     claw: number,
 *     toeLen: number,
 *     toeSpread: number,
 *     halluxLen: number,
 *     arch: number,
 *     zygodactyl: boolean,
 *   },
 * }} GooseMorph
 */

export const BEAK_STYLES = Object.freeze(['goose', 'flat', 'point', 'cone', 'needle', 'hook']);
export const FOOT_STYLES = Object.freeze(['web', 'perch', 'talon', 'zygodactyl']);
export const EYE_STYLES = Object.freeze(['beady', 'large', 'raptor', 'soft']);

/** Canada-goose reference (identity morph). */
export const DEFAULT_GOOSE_MORPH = Object.freeze({
  neckLen: 1,
  neckRot: 0,
  neckSocketX: 0,
  neckSocketY: 0,
  neckSocketZ: 0,
  neckSocketRotX: 0,
  neckSocketRotY: 0,
  neckSocketRotZ: 0,
  bodyUpright: 0,
  bodyFat: 1,
  beakStyle: /** @type {BeakStyle} */ ('goose'),
  beakPosX: 0,
  beakPosY: 0,
  beakPosZ: 0,
  beakRotX: 0,
  beakRotY: 0,
  beakRotZ: 0,
  beakScaleX: 1,
  beakScaleY: 1,
  beakScaleZ: 1,
  footStyle: /** @type {FootStyle} */ ('web'),
  eyeStyle: /** @type {EyeStyle} */ ('beady'),
});

/** Legacy neckRot ±1 → degrees added onto neckSocketRotX. */
const NECK_ROT_LEGACY_DEG = 54.4;

function degToRad(d) {
  return (Number(d) || 0) * (Math.PI / 180);
}

function clampDeg(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-180, Math.min(180, n));
}

function clampOffset(v, lim = 0.25) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-lim, Math.min(lim, n));
}

/**
 * Rotate (x,y,z) around origin by Euler XYZ degrees, then translate by socket.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ x: number, y: number, z: number }} socket
 * @param {{ x: number, y: number, z: number }} eulerDeg
 * @returns {[number, number, number]}
 */
export function applyNeckSocketTransform(x, y, z, socket, eulerDeg) {
  let lx = x - socket.x;
  let ly = y - socket.y;
  let lz = z - socket.z;
  const rx = degToRad(eulerDeg.x);
  const ry = degToRad(eulerDeg.y);
  const rz = degToRad(eulerDeg.z);
  // X (pitch)
  {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = ly * c - lz * s;
    const nz = ly * s + lz * c;
    ly = ny;
    lz = nz;
  }
  // Y (yaw)
  {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const nx = lx * c + lz * s;
    const nz = -lx * s + lz * c;
    lx = nx;
    lz = nz;
  }
  // Z (roll) — 180 flips the neck "upside down" left/right and up/down in plane
  {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = lx * c - ly * s;
    const ny = lx * s + ly * c;
    lx = nx;
    ly = ny;
  }
  return [socket.x + lx, socket.y + ly, socket.z + lz];
}

function clampScale(v, lo = 0.15, hi = 3.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Beak local transform about bill-base pivot: scale → Euler XYZ → translate.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ x: number, y: number, z: number }} pivot  bill base
 * @param {{
 *   pos: { x: number, y: number, z: number },
 *   rot: { x: number, y: number, z: number },
 *   scale: { x: number, y: number, z: number },
 * }} xform
 * @returns {[number, number, number]}
 */
export function applyBeakXform(x, y, z, pivot, xform) {
  const sx = xform?.scale?.x ?? 1;
  const sy = xform?.scale?.y ?? 1;
  const sz = xform?.scale?.z ?? 1;
  let lx = (x - pivot.x) * sx;
  let ly = (y - pivot.y) * sy;
  let lz = (z - pivot.z) * sz;
  const rx = degToRad(xform?.rot?.x ?? 0);
  const ry = degToRad(xform?.rot?.y ?? 0);
  const rz = degToRad(xform?.rot?.z ?? 0);
  if (rx !== 0) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = ly * c - lz * s;
    const nz = ly * s + lz * c;
    ly = ny;
    lz = nz;
  }
  if (ry !== 0) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const nx = lx * c + lz * s;
    const nz = -lx * s + lz * c;
    lx = nx;
    lz = nz;
  }
  if (rz !== 0) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = lx * c - ly * s;
    const ny = lx * s + ly * c;
    lx = nx;
    ly = ny;
  }
  const px = xform?.pos?.x ?? 0;
  const py = xform?.pos?.y ?? 0;
  const pz = xform?.pos?.z ?? 0;
  return [pivot.x + px + lx, pivot.y + py + ly, pivot.z + pz + lz];
}

/** True when beak xform is not identity (skip work in geometry when possible). */
export function beakXformIsIdentity(xform) {
  if (!xform) return true;
  const { pos, rot, scale } = xform;
  return (
    Math.abs(pos?.x ?? 0) + Math.abs(pos?.y ?? 0) + Math.abs(pos?.z ?? 0) < 1e-9
    && Math.abs(rot?.x ?? 0) + Math.abs(rot?.y ?? 0) + Math.abs(rot?.z ?? 0) < 1e-9
    && Math.abs((scale?.x ?? 1) - 1) + Math.abs((scale?.y ?? 1) - 1) + Math.abs((scale?.z ?? 1) - 1) < 1e-9
  );
}

/** Canonical full S-neck path (y, z) — matches original GOOSE_BONE_DEFS. */
export const FULL_NECK_PATH = Object.freeze([
  [0.520, 0.160],
  [0.552, 0.166],
  [0.585, 0.171],
  [0.618, 0.175],
  [0.651, 0.177],
  [0.684, 0.178],
  [0.717, 0.179],
  [0.750, 0.181],
  [0.782, 0.185],
  [0.812, 0.192],
  [0.838, 0.203],
  [0.858, 0.219],
]);

const FULL_HEAD = Object.freeze([GOOSE_DIMS.headCenterY, GOOSE_DIMS.headCenterZ]);
const SPINE3 = Object.freeze([0.492, 0.152]);
const PIVOT = Object.freeze({ y: 0.415, z: -0.06 }); // hips / synsacrum

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pitch (y,z) around the hip pivot — positive angle is nose-up / upright:
 * breast and head rise (+Y), rump settles toward the feet. (The opposite
 * sign would tip the bird onto its back with the rump on top.)
 *
 *   y' = dy·cos + dz·sin   // +Z (chest) contributes upward
 *   z' = −dy·sin + dz·cos
 *
 * @param {number} y
 * @param {number} z
 * @param {number} angle rad
 * @returns {[number, number]}
 */
export function pitchYZ(y, z, angle) {
  if (Math.abs(angle) < 1e-6) return [y, z];
  const dy = y - PIVOT.y;
  const dz = z - PIVOT.z;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [PIVOT.y + dy * c + dz * s, PIVOT.z - dy * s + dz * c];
}

/**
 * @param {string} style
 * @param {string[]} allowed
 * @param {string} fallback
 */
function pickStyle(style, allowed, fallback) {
  const s = String(style ?? fallback).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

/**
 * Beak profile multipliers relative to the Canada-goose bill.
 * @param {BeakStyle} style
 * @param {number} [lenOverride]
 */
function resolveBeak(style, lenOverride) {
  /** @type {Record<BeakStyle, { length: number, width: number, depth: number, droop: number, hook: number, crease: number, boxy: number }>} */
  const table = {
    goose: { length: 1.0, width: 1.0, depth: 1.0, droop: 0.22, hook: 0, crease: 0.8, boxy: 0.85 },
    flat: { length: 1.15, width: 1.35, depth: 0.62, droop: 0.08, hook: 0, crease: 0.35, boxy: 0.55 },
    point: { length: 0.72, width: 0.55, depth: 0.7, droop: 0.12, hook: 0.05, crease: 0.15, boxy: 0.2 },
    cone: { length: 0.55, width: 0.85, depth: 0.9, droop: 0.05, hook: 0, crease: 0.05, boxy: 0.1 },
    needle: { length: 1.85, width: 0.28, depth: 0.32, droop: 0.02, hook: 0, crease: 0, boxy: 0 },
    // Raptor/parrot: short–medium, deep cere, smooth cross-section.
    // Culmen curve (high arch → sharp downturn) is authored in buildBillStations;
    // droop only nudges landmarks so the tip sits below the gape.
    hook: { length: 0.78, width: 1.22, depth: 1.65, droop: 0.18, hook: 1.0, crease: 0.12, boxy: 0.35 },
  };
  const base = table[style] ?? table.goose;
  const length = Number.isFinite(lenOverride)
    ? Math.max(0.25, Math.min(2.4, lenOverride))
    : base.length;
  return { style, ...base, length };
}

/**
 * @param {FootStyle} style
 */
function resolveFoot(style) {
  /** @type {Record<FootStyle, object>} */
  const table = {
    web: {
      web: true, claw: 0.35, toeLen: 1.0, toeSpread: 1.0, halluxLen: 0.55, arch: 0.15, zygodactyl: false,
    },
    perch: {
      web: false, claw: 0.7, toeLen: 0.82, toeSpread: 0.85, halluxLen: 0.85, arch: 0.45, zygodactyl: false,
    },
    talon: {
      web: false, claw: 1.35, toeLen: 1.15, toeSpread: 1.05, halluxLen: 1.25, arch: 0.55, zygodactyl: false,
    },
    zygodactyl: {
      web: false, claw: 0.95, toeLen: 0.95, toeSpread: 0.9, halluxLen: 1.1, arch: 0.4, zygodactyl: true,
    },
  };
  return { style, ...(table[style] ?? table.web) };
}

/**
 * @param {EyeStyle} style
 * @param {number} [scaleOverride]
 */
function resolveEye(style, scaleOverride) {
  /** @type {Record<EyeStyle, number>} */
  const mul = { beady: 1.0, large: 1.45, raptor: 1.28, soft: 1.18 };
  const m = Number.isFinite(scaleOverride)
    ? Math.max(0.5, Math.min(2.2, scaleOverride))
    : (mul[style] ?? 1);
  // Raptor eyes sit slightly more forward/forward-lateral.
  const forward = style === 'raptor' ? 0.012 : style === 'large' ? 0.006 : 0;
  const lateral = style === 'large' || style === 'soft' ? 1.06 : 1;
  return {
    radius: GOOSE_DIMS.eyeRadius * m,
    x: GOOSE_DIMS.eyeX * lateral,
    y: GOOSE_DIMS.eyeY + (style === 'large' ? 0.004 : 0),
    z: GOOSE_DIMS.eyeZ + forward,
  };
}

/**
 * Clamp + expand a partial morph into a full resolved morph with dims.
 * @param {Partial<GooseMorphInput>} [input]
 * @returns {GooseMorph}
 */
export function resolveGooseMorph(input = {}) {
  const neckLen = clamp01(input.neckLen ?? DEFAULT_GOOSE_MORPH.neckLen);
  const neckRot = Math.max(-1, Math.min(1, Number(input.neckRot ?? DEFAULT_GOOSE_MORPH.neckRot) || 0));
  const bodyUpright = clamp01(input.bodyUpright ?? DEFAULT_GOOSE_MORPH.bodyUpright);
  const bodyFat = Math.max(0.55, Math.min(1.45, Number(input.bodyFat) || DEFAULT_GOOSE_MORPH.bodyFat));
  const beakStyle = /** @type {BeakStyle} */ (pickStyle(input.beakStyle, BEAK_STYLES, 'goose'));
  const footStyle = /** @type {FootStyle} */ (pickStyle(input.footStyle, FOOT_STYLES, 'web'));
  const eyeStyle = /** @type {EyeStyle} */ (pickStyle(input.eyeStyle, EYE_STYLES, 'beady'));

  // Neck socket: position offset (m) + Euler XYZ (deg) relative to body spine_3.
  const neckSocketOff = {
    x: clampOffset(input.neckSocketX ?? DEFAULT_GOOSE_MORPH.neckSocketX),
    y: clampOffset(input.neckSocketY ?? DEFAULT_GOOSE_MORPH.neckSocketY),
    z: clampOffset(input.neckSocketZ ?? DEFAULT_GOOSE_MORPH.neckSocketZ),
  };
  const neckSocketRot = {
    x: clampDeg((input.neckSocketRotX ?? DEFAULT_GOOSE_MORPH.neckSocketRotX) + neckRot * NECK_ROT_LEGACY_DEG),
    y: clampDeg(input.neckSocketRotY ?? DEFAULT_GOOSE_MORPH.neckSocketRotY),
    z: clampDeg(input.neckSocketRotZ ?? DEFAULT_GOOSE_MORPH.neckSocketRotZ),
  };

  const pitchAngle = bodyUpright * 0.92; // ~53° at full upright
  // Compress body length slightly when upright (passerines are shorter-bodied).
  const lengthScale = lerp(1, 0.78, bodyUpright);
  const heightBoost = lerp(1, 1.12, bodyUpright);

  /** Apply length/height scale then body pitch to a canonical (y,z). */
  const mapCanon = (y, z) => pitchYZ(
    PIVOT.y + (y - PIVOT.y) * heightBoost,
    PIVOT.z + (z - PIVOT.z) * lengthScale,
    pitchAngle,
  );

  // Neck base after body morph (spine_3) + authorable socket offset.
  const [baseY0, baseZ0] = mapCanon(SPINE3[0], SPINE3[1]);
  const neckSocket = {
    x: 0 + neckSocketOff.x,
    y: baseY0 + neckSocketOff.y,
    z: baseZ0 + neckSocketOff.z,
  };
  const baseY = neckSocket.y;
  const baseZ = neckSocket.z;

  // Full-length head / neck path (pitched Canada-goose S-curve).
  const [fullHeadY, fullHeadZ] = mapCanon(FULL_HEAD[0], FULL_HEAD[1]);
  /** @type {Array<[number, number]>} */
  const fullNeckMapped = FULL_NECK_PATH.map(([y, z]) => mapCanon(y, z));

  // Almost-no-neck head sits just above the neck base. When the body is
  // upright, lift more on +Y (passerine "head on shoulders") instead of
  // pitching a forward waterfowl short-head (which would drop under the body).
  const shortHeadY = baseY + lerp(0.035, 0.11, bodyUpright);
  const shortHeadZ = baseZ + lerp(0.045, 0.012, bodyUpright);

  // Chest leading point (pitched), used below as the upright head-reach target.
  const [, chestReachZ] = mapCanon(GOOSE_DIMS.bodyCenterY, GOOSE_DIMS.chestFrontZ);

  // Pitching the canonical S-neck by a steep body angle over-rotates its
  // forward reach (the neck path was authored for a near-horizontal goose),
  // swinging the tip behind the pivot instead of just upright — the head
  // ends up tucked into the shoulder. An upright, alert bird instead holds
  // its head out past the leading edge of its own chest (robin/pigeon/hawk
  // reference), so pull the head toward the chest's forward-most point as
  // the body stands up. Scaled by neckLen (saturating fast — real breeds
  // are never truly neck-less) so the degenerate neckLen-0 stub is
  // untouched, and ramped along the neck (0 at the base, full at the head)
  // to avoid a kink. No effect at bodyUpright 0 (goose/mallard S-neck
  // untouched).
  const rawHeadZ = lerp(shortHeadZ, fullHeadZ, neckLen);
  const reachBlend = Math.min(1, bodyUpright * 2) * Math.min(1, neckLen * 8);
  const targetHeadZ = lerp(rawHeadZ, chestReachZ, reachBlend);
  const uprightForwardReach = targetHeadZ - rawHeadZ;

  // ---- neck path + head features in pre-rotation space, then one socket Euler ----
  const beak = resolveBeak(beakStyle, input.beakLen);
  const beakXform = {
    pos: {
      x: clampOffset(input.beakPosX ?? DEFAULT_GOOSE_MORPH.beakPosX),
      y: clampOffset(input.beakPosY ?? DEFAULT_GOOSE_MORPH.beakPosY),
      z: clampOffset(input.beakPosZ ?? DEFAULT_GOOSE_MORPH.beakPosZ),
    },
    rot: {
      x: clampDeg(input.beakRotX ?? DEFAULT_GOOSE_MORPH.beakRotX),
      y: clampDeg(input.beakRotY ?? DEFAULT_GOOSE_MORPH.beakRotY),
      z: clampDeg(input.beakRotZ ?? DEFAULT_GOOSE_MORPH.beakRotZ),
    },
    scale: {
      x: clampScale(input.beakScaleX ?? DEFAULT_GOOSE_MORPH.beakScaleX),
      y: clampScale(input.beakScaleY ?? DEFAULT_GOOSE_MORPH.beakScaleY),
      z: clampScale(input.beakScaleZ ?? DEFAULT_GOOSE_MORPH.beakScaleZ),
    },
  };
  const eye = resolveEye(eyeStyle, input.eyeScale);
  const crownLift = lerp(0.028, GOOSE_DIMS.crownY - GOOSE_DIMS.headCenterY, 0.45 + neckLen * 0.55);

  /** @type {Array<[number, number, number]>} */
  let neckPath = [];
  for (let i = 0; i < 12; i += 1) {
    const t = (i + 1) / 13;
    const shortY = lerp(baseY, shortHeadY, t);
    const shortZ = lerp(baseZ, shortHeadZ, t);
    const [fy, fz] = fullNeckMapped[i];
    const fySock = fy + neckSocketOff.y;
    const fzSock = fz + neckSocketOff.z;
    neckPath.push([
      neckSocket.x,
      lerp(shortY, fySock, neckLen),
      lerp(shortZ, fzSock, neckLen) + uprightForwardReach * t * t,
    ]);
  }

  let headX = neckSocket.x;
  let headY = lerp(shortHeadY, fullHeadY + neckSocketOff.y, neckLen);
  let headZ = targetHeadZ + neckSocketOff.z;
  const eyeOffY = eye.y - GOOSE_DIMS.headCenterY;
  const eyeOffZ = eye.z - GOOSE_DIMS.headCenterZ;
  // All features authored in pre-rotation space, then one socket Euler.
  let pts = {
    crown: [headX, headY + crownLift, headZ],
    billTip: [
      headX,
      headY + (GOOSE_DIMS.billTipY - GOOSE_DIMS.headCenterY) * beak.length
        - beak.droop * 0.04
        // Hook: tip landmark hangs below gape (mesh does the arched culmen).
        - beak.hook * (beak.style === 'hook' ? 0.048 : 0.035),
      headZ + (GOOSE_DIMS.billTipZ - GOOSE_DIMS.headCenterZ)
        * beak.length * (beak.style === 'hook' ? 0.95 : 1),
    ],
    billBase: [
      headX,
      headY + (GOOSE_DIMS.billBaseY - GOOSE_DIMS.headCenterY),
      headZ + (GOOSE_DIMS.billBaseZ - GOOSE_DIMS.headCenterZ)
        * Math.min(1.15, beak.length) * (beak.style === 'hook' ? 0.95 : 1),
    ],
    eyeL: [headX + eye.x, headY + eyeOffY, headZ + eyeOffZ],
    eyeR: [headX - eye.x, headY + eyeOffY, headZ + eyeOffZ],
    head: [headX, headY, headZ],
  };

  // Single transform for the whole cervical assembly about the body socket.
  // Set neckSocketRotX/Y/Z to ±180 to flip an upside-down head/neck.
  const hasSocketRot = Math.abs(neckSocketRot.x) + Math.abs(neckSocketRot.y) + Math.abs(neckSocketRot.z) > 1e-6;
  if (hasSocketRot) {
    const xform = (p) => applyNeckSocketTransform(p[0], p[1], p[2], neckSocket, neckSocketRot);
    neckPath = neckPath.map((p) => xform(p));
    pts = {
      crown: xform(pts.crown),
      billTip: xform(pts.billTip),
      billBase: xform(pts.billBase),
      eyeL: xform(pts.eyeL),
      eyeR: xform(pts.eyeR),
      head: xform(pts.head),
    };
  }
  headX = pts.head[0];
  headY = pts.head[1];
  headZ = pts.head[2];
  const crownY = pts.crown[1];
  const billTipY = pts.billTip[1];
  const billTipZ = pts.billTip[2];
  const billBaseY = pts.billBase[1];
  const billBaseZ = pts.billBase[2];
  eye.x = Math.max(Math.abs(pts.eyeL[0] - headX), Math.abs(pts.eyeR[0] - headX), 0.001);
  eye.y = (pts.eyeL[1] + pts.eyeR[1]) * 0.5;
  eye.z = (pts.eyeL[2] + pts.eyeR[2]) * 0.5;

  // Collar follows neck base (short) → canonical collar (long).
  const [canonCollarY, canonCollarZ] = mapCanon(GOOSE_DIMS.collarY, GOOSE_DIMS.collarZ);
  const cY = lerp(baseY + 0.01, canonCollarY + neckSocketOff.y, Math.max(neckLen, 0.2));
  const cZ = lerp(baseZ + 0.005, canonCollarZ + neckSocketOff.z, Math.max(neckLen, 0.2));

  // Torso landmarks (length compress → height boost → pitch).
  const [bodyCenterY] = mapCanon(GOOSE_DIMS.bodyCenterY, GOOSE_DIMS.chestFrontZ);
  const chestFrontZ = chestReachZ;
  const [backTopY, rumpZ] = mapCanon(GOOSE_DIMS.backTopY, GOOSE_DIMS.rumpZ);
  const [bellyY] = mapCanon(GOOSE_DIMS.bellyY, 0);

  const standHeight = Math.max(crownY, headY + eye.radius + 0.01);

  const dims = {
    ...GOOSE_DIMS,
    standHeight,
    chestFrontZ,
    rumpZ,
    tailTipZ: PIVOT.z + (GOOSE_DIMS.tailTipZ - PIVOT.z) * lengthScale,
    backTopY,
    bellyY,
    bodyCenterY,
    bodyHalfWidth: GOOSE_DIMS.bodyHalfWidth * bodyFat,
    collarY: cY,
    collarZ: cZ,
    headCenterX: headX,
    headCenterY: headY,
    headCenterZ: headZ,
    crownY,
    headHalfWidth: GOOSE_DIMS.headHalfWidth * lerp(1.05, 0.95, neckLen),
    headLen: GOOSE_DIMS.headLen * lerp(0.85, 1, neckLen),
    billBaseY,
    billBaseZ,
    billTipY,
    billTipZ,
    billHalfWidth: GOOSE_DIMS.billHalfWidth * beak.width,
    eyeY: eye.y,
    eyeZ: eye.z,
    eyeX: eye.x,
    eyeRadius: eye.radius,
    eyeWorldL: pts.eyeL,
    eyeWorldR: pts.eyeR,
    // legs: slight forward under upright birds
    hipZ: lerp(GOOSE_DIMS.hipZ, GOOSE_DIMS.hipZ + 0.02, bodyUpright),
    kneeZ: lerp(GOOSE_DIMS.kneeZ, GOOSE_DIMS.kneeZ + 0.015, bodyUpright),
    // wings track pitched shoulder
    shoulderY: pitchYZ(
      PIVOT.y + (GOOSE_DIMS.shoulderY - PIVOT.y) * heightBoost,
      PIVOT.z + (GOOSE_DIMS.shoulderZ - PIVOT.z) * lengthScale,
      pitchAngle,
    )[0],
    shoulderZ: pitchYZ(
      PIVOT.y + (GOOSE_DIMS.shoulderY - PIVOT.y) * heightBoost,
      PIVOT.z + (GOOSE_DIMS.shoulderZ - PIVOT.z) * lengthScale,
      pitchAngle,
    )[1],
    // morph meta for consumers
    _neckLen: neckLen,
    _neckRot: neckRot,
    _bodyUpright: bodyUpright,
    _bodyFat: bodyFat,
    _lengthScale: lengthScale,
    _heightBoost: heightBoost,
    _pitchAngle: pitchAngle,
    _neckSocket: neckSocket,
    _neckSocketRot: neckSocketRot,
  };

  const foot = resolveFoot(footStyle);

  return {
    neckLen,
    neckRot,
    neckSocketX: neckSocketOff.x,
    neckSocketY: neckSocketOff.y,
    neckSocketZ: neckSocketOff.z,
    neckSocketRotX: neckSocketRot.x,
    neckSocketRotY: neckSocketRot.y,
    neckSocketRotZ: neckSocketRot.z,
    bodyUpright,
    bodyFat,
    beakStyle,
    beakPosX: beakXform.pos.x,
    beakPosY: beakXform.pos.y,
    beakPosZ: beakXform.pos.z,
    beakRotX: beakXform.rot.x,
    beakRotY: beakXform.rot.y,
    beakRotZ: beakXform.rot.z,
    beakScaleX: beakXform.scale.x,
    beakScaleY: beakXform.scale.y,
    beakScaleZ: beakXform.scale.z,
    footStyle,
    eyeStyle,
    beakLen: beak.length,
    eyeScale: eye.radius / GOOSE_DIMS.eyeRadius,
    dims,
    neckPath,
    headPos: [headX, headY, headZ],
    neckSocket: { ...neckSocket },
    neckSocketRot: { ...neckSocketRot },
    pitchAngle,
    beak,
    beakXform,
    eye,
    foot,
  };
}

/**
 * Transform a canonical (y,z) body point with the morph's pitch/length/height.
 * @param {number} y
 * @param {number} z
 * @param {GooseMorph} morph
 * @returns {[number, number]}
 */
export function morphBodyYZ(y, z, morph) {
  const ls = morph.dims._lengthScale ?? 1;
  const hb = morph.dims._heightBoost ?? 1;
  let ny = PIVOT.y + (y - PIVOT.y) * hb;
  let nz = PIVOT.z + (z - PIVOT.z) * ls;
  return pitchYZ(ny, nz, morph.pitchAngle);
}

/**
 * World bind positions for every goose bone under this morph.
 * Same names/order as the canonical skeleton.
 * @param {GooseMorph} morph
 * @returns {Map<string, [number, number, number]>}
 */
export function buildGooseBoneWorldPos(morph) {
  const D = morph.dims;
  const map = new Map();
  const set = (name, x, y, z) => map.set(name, [x, y, z]);

  set('root', 0, 0, 0);
  set('hips', 0, 0.415, D.hipZ - 0.025);
  // Spine chain — pitch each station from canonical.
  const spineCanon = [
    ['spine_0', 0.42, 0.015],
    ['spine_1', 0.435, 0.09],
    ['spine_2', 0.455, 0.135],
    ['spine_3', 0.492, 0.152],
  ];
  for (const [name, y, z] of spineCanon) {
    const [my, mz] = morphBodyYZ(y, z, morph);
    set(name, 0, my, mz);
  }
  {
    const [ky, kz] = morphBodyYZ(0.30, 0.11, morph);
    set('keel', 0, ky, kz);
  }
  {
    const [cy, cz] = morphBodyYZ(0.46, 0.20, morph);
    set('crop', 0, cy, cz);
  }

  morph.neckPath.forEach((pt, i) => {
    // neckPath is [x,y,z] (legacy [y,z] tolerated)
    if (pt.length >= 3) set(`neck_${i}`, pt[0], pt[1], pt[2]);
    else set(`neck_${i}`, 0, pt[0], pt[1]);
  });
  const hx = D.headCenterX ?? 0;
  set('head', hx, D.headCenterY, D.headCenterZ);
  {
    const pivot = { x: hx, y: D.billBaseY, z: D.billBaseZ };
    const [jx, jy, jz] = applyBeakXform(
      hx,
      D.billBaseY - 0.017,
      D.billBaseZ - 0.018,
      pivot,
      morph.beakXform,
    );
    set('jaw', jx, jy, jz);
  }
  if (D.eyeWorldL && D.eyeWorldR) {
    set('eye_L', D.eyeWorldL[0], D.eyeWorldL[1], D.eyeWorldL[2]);
    set('eye_R', D.eyeWorldR[0], D.eyeWorldR[1], D.eyeWorldR[2]);
  } else {
    set('eye_L', hx + D.eyeX, D.eyeY, D.eyeZ);
    set('eye_R', hx - D.eyeX, D.eyeY, D.eyeZ);
  }

  // Tail — pitch lightly with body.
  for (const [name, y, z] of [
    ['tail_0', 0.412, -0.185],
    ['tail_1', 0.398, -0.245],
    ['tail_2', 0.378, -0.30],
  ]) {
    const [my, mz] = morphBodyYZ(y, z, morph);
    set(name, 0, my, mz);
  }
  {
    const t2 = map.get('tail_2');
    set('rectrix_L', 0.03, t2[1] - 0.006, t2[2] - 0.015);
    set('rectrix_R', -0.03, t2[1] - 0.006, t2[2] - 0.015);
  }

  // Wings — pitch shoulder/hand chain with body upright.
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const [sy, sz] = morphBodyYZ(GOOSE_DIMS.shoulderY, GOOSE_DIMS.shoulderZ, morph);
    set(`shoulder_${side}`, s * GOOSE_DIMS.shoulderX, sy, sz);
    const [eY, eZ] = morphBodyYZ(0.455, -0.005, morph);
    set(`wing_0_${side}`, s * 0.108, eY, eZ);
    const [wY, wZ] = morphBodyYZ(GOOSE_DIMS.wristY, GOOSE_DIMS.wristZ, morph);
    set(`wing_1_${side}`, s * 0.102, wY, wZ);
    const [hY, hZ] = morphBodyYZ(0.468, GOOSE_DIMS.handTipZ, morph);
    set(`wing_2_${side}`, s * 0.078, hY, hZ);
    const [tY, tZ] = morphBodyYZ(0.425, -0.355, morph);
    set(`wing_tip_${side}`, s * 0.052, tY, tZ);
  }

  // Legs stay mostly plantigrade; slight hip-z from dims.
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const x = s * GOOSE_DIMS.legX;
    set(`femur_${side}`, x, GOOSE_DIMS.hipY, D.hipZ);
    set(`tibia_${side}`, x * 1.12, GOOSE_DIMS.kneeY, D.kneeZ);
    set(`Foot_${side}`, x, GOOSE_DIMS.ankleY, GOOSE_DIMS.ankleZ);
    set(`Toes_${side}`, x, GOOSE_DIMS.footBallY, GOOSE_DIMS.footBallZ);
    const toeLen = morph.foot.toeLen;
    const spread = morph.foot.toeSpread;
    const tipZ = GOOSE_DIMS.toeTipZ * toeLen;
    set(`Toes_tip_${side}`, x, 0.006, tipZ);
    if (morph.foot.zygodactyl) {
      // Two forward, two aft (outer + hallux aft).
      set(`toe_in_${side}`, x - s * 0.038 * spread, 0.006, tipZ * 0.78);
      set(`toe_out_${side}`, x + s * 0.045 * spread, 0.008, -0.04 * toeLen);
      set(`hallux_${side}`, x - s * 0.01, 0.016, -0.045 * morph.foot.halluxLen);
    } else {
      set(`toe_in_${side}`, x - s * 0.042 * spread, 0.006, tipZ * 0.76);
      set(`toe_out_${side}`, x + s * 0.05 * spread, 0.006, tipZ * 0.72);
      set(`hallux_${side}`, x, 0.018, -0.028 * morph.foot.halluxLen);
    }
  }

  return map;
}

/**
 * Map a catalog bodyPlan (+ beak/foot style) to morph defaults.
 * Reads live bird body-type store so P-menu sliders retarget whole plans.
 * @param {string} bodyPlan
 * @param {{ beakStyle?: string, footStyle?: string, eyeStyle?: string }} [styles]
 * @returns {Partial<GooseMorphInput>}
 */
export function morphFromBodyPlan(bodyPlan, styles = {}) {
  const plan = String(bodyPlan ?? 'waterfowl').toLowerCase();
  const bt = getBirdBodyType(plan);
  return {
    neckLen: bt.neckLen,
    neckRot: Number.isFinite(bt.neckRot) ? bt.neckRot : 0,
    neckSocketX: bt.neckSocketX ?? 0,
    neckSocketY: bt.neckSocketY ?? 0,
    neckSocketZ: bt.neckSocketZ ?? 0,
    neckSocketRotX: bt.neckSocketRotX ?? 0,
    neckSocketRotY: bt.neckSocketRotY ?? 0,
    neckSocketRotZ: bt.neckSocketRotZ ?? 0,
    bodyUpright: bt.bodyUpright,
    bodyFat: bt.bodyFat,
    eyeStyle: /** @type {EyeStyle} */ (
      pickStyle(styles.eyeStyle ?? bt.eyeStyle, EYE_STYLES, bt.eyeStyle)
    ),
    beakStyle: /** @type {BeakStyle} */ (
      pickStyle(styles.beakStyle ?? bt.beakStyle, BEAK_STYLES, bt.beakStyle)
    ),
    beakPosX: bt.beakPosX ?? 0,
    beakPosY: bt.beakPosY ?? 0,
    beakPosZ: bt.beakPosZ ?? 0,
    beakRotX: bt.beakRotX ?? 0,
    beakRotY: bt.beakRotY ?? 0,
    beakRotZ: bt.beakRotZ ?? 0,
    beakScaleX: bt.beakScaleX ?? 1,
    beakScaleY: bt.beakScaleY ?? 1,
    beakScaleZ: bt.beakScaleZ ?? 1,
    footStyle: /** @type {FootStyle} */ (
      pickStyle(styles.footStyle ?? bt.footStyle, FOOT_STYLES, bt.footStyle)
    ),
  };
}
