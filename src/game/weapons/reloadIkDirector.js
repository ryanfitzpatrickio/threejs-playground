/**
 * Reload left-hand IK director (docs/advanced-reload-system-plan.md, AR3).
 *
 * Pure world-space waypoint sampler: given the normalized reload progress `t`,
 * the gun's `reloadPhaseTiming`, and the three resolved world anchors (foregrip
 * rest, mag_socket, belt source), return where the left hand's IK target should
 * be this frame. The body-anchored dual-IK solver (firstPersonHandIk.js) does the
 * actual arm solve; this only steers the target through the reload path:
 *
 *   rest → mag_socket (grab) → extract → belt (drop old / grab new) →
 *   mag_socket (seat) → rest
 *
 * keyed to the same phase thresholds that fire the mag events, so the hand and
 * the physics/mag beats can never desync.
 */

import * as THREE from 'three';

const _extract = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _socket = new THREE.Vector3();
const _belt = new THREE.Vector3();

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (u) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};

function applyOffset(base, offset, out) {
  out.copy(base);
  if (!offset) return out;
  out.x += Number(offset[0]) || 0;
  out.y += Number(offset[1]) || 0;
  out.z += Number(offset[2]) || 0;
  return out;
}

/**
 * @param {number} t normalized reload progress [0,1]
 * @param {{ mag_release?: number, mag_drop?: number, mag_seat?: number }} timing
 * @param {{ rest: THREE.Vector3, magSocket: THREE.Vector3, belt: THREE.Vector3 }} waypoints
 * @param {THREE.Vector3} [out]
 * @param {{
 *   restOffset?: [number,number,number]|null,
 *   socketOffset?: [number,number,number]|null,
 *   extractOffset?: [number,number,number]|null,
 *   beltOffset?: [number,number,number]|null,
 *   extractDrop?: number,
 *   handPosition?: [number,number,number]|null,
 * }} [opts] offsets already in **world** meters (caller converts body-local → world)
 * @returns {THREE.Vector3} world position for the left-hand IK target
 */
export function sampleReloadLeftHand(t, timing, waypoints, out = new THREE.Vector3(), opts = null) {
  const restIn = waypoints?.rest;
  const socketIn = waypoints?.magSocket;
  const beltIn = waypoints?.belt;
  if (!restIn || !socketIn || !beltIn) return out;

  const restOff = opts?.restOffset ?? null;
  const socketOff = opts?.socketOffset ?? null;
  const extractOff = opts?.extractOffset ?? null;
  const beltOff = opts?.beltOffset ?? null;
  // Matches RELOAD_DEBUG_DEFAULTS.extractDrop (live-fit 2026-07-11). World −Y.
  const extractDrop = Number.isFinite(opts?.extractDrop) ? opts.extractDrop : 0.035;

  applyOffset(restIn, restOff, _rest);
  applyOffset(socketIn, socketOff, _socket);
  applyOffset(beltIn, beltOff, _belt);

  const rel = clamp01(timing?.mag_release ?? 0.2);
  const drop = clamp01(timing?.mag_drop ?? 0.45);
  const seat = clamp01(timing?.mag_seat ?? 0.82);
  const extractT = (rel + drop) * 0.5;

  // Extract point: partway from the well toward the belt, pulled a touch lower so
  // the spent mag reads as being drawn down and out of the gun.
  _extract.lerpVectors(_socket, _belt, 0.35);
  _extract.y -= extractDrop;
  if (extractOff) {
    _extract.x += Number(extractOff[0]) || 0;
    _extract.y += Number(extractOff[1]) || 0;
    _extract.z += Number(extractOff[2]) || 0;
  }

  const keys = [
    { t: 0, p: _rest },
    { t: rel, p: _socket },
    { t: extractT, p: _extract },
    { t: drop, p: _belt },
    { t: seat, p: _socket },
    { t: 1, p: _rest },
  ];
  sampleKeys(keys, t, out);

  // Global hand fudge after the path (world meters; body-local converted by caller).
  const handPos = opts?.handPosition;
  if (handPos) {
    out.x += Number(handPos[0]) || 0;
    out.y += Number(handPos[1]) || 0;
    out.z += Number(handPos[2]) || 0;
  }
  return out;
}

/** Piecewise smoothstep interpolation over ascending-`t` keyframes. */
function sampleKeys(keys, t, out) {
  const tt = clamp01(t);
  if (tt <= keys[0].t) return out.copy(keys[0].p);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (tt <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-6) return out.copy(b.p);
      return out.lerpVectors(a.p, b.p, smoothstep((tt - a.t) / span));
    }
  }
  return out.copy(keys[keys.length - 1].p);
}
