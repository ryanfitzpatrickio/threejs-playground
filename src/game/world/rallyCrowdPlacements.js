/**
 * Deterministic rally sideline spectator placements. Shared by the static box
 * crowd (low quality) and the animated flipbook crowd (medium+).
 */

import { placementsAlong } from '../../world/worldMap/trackFrame.js';

export function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @returns {Array<{
 *   x: number, z: number, y: number,
 *   nx: number, nz: number, sign: number, s: number,
 *   yaw: number, scale: number, color: number,
 *   occupancySeed: number, variantSeed: number, sectionId: string,
 * }>}
 */
export function collectRallyCrowdPlacements({
  frame,
  band,
  sign,
  uLine,
  sampleHeight,
  allowedAtArc,
  roadIndex = 0,
  side = 'left',
}) {
  const every = Math.max(1.4, band.every ?? 2.4);
  const depth = Math.max(1, band.depth ?? 3.5);
  const maxInstances = Math.max(1, Math.floor(band.maxInstances ?? 260));
  const anchors = placementsAlong(frame, every, {
    phase: every * 0.5,
    lateral: sign * uLine,
  }).filter((a) => allowedAtArc(a.s));
  if (!anchors.length) return [];

  const placements = [];
  let frameIndex = 1;
  for (const a of anchors) {
    while (frameIndex < frame.n - 2 && frame.arc[frameIndex] < a.s) frameIndex += 1;
    const i0 = Math.max(0, frameIndex - 2);
    const i1 = Math.min(frame.n - 1, frameIndex + 2);
    const cross = frame.tanX[i0] * frame.tanZ[i1] - frame.tanZ[i0] * frame.tanX[i1];
    const bend = Math.min(1, Math.abs(cross) * 6);
    const outside = sign * cross >= 0;
    const copies = 1 + (outside && bend > 0.22 ? 1 : 0) + (outside && bend > 0.62 ? 1 : 0);
    for (let copy = 0; copy < copies && placements.length < maxInstances; copy += 1) {
      const seed = hash01(a.s * 0.173 + copy * 17.13 + sign * 9.7);
      const lateral = 0.45 + seed * depth;
      const x = a.x + a.nx * sign * lateral;
      const z = a.z + a.nz * sign * lateral;
      const yaw = Math.atan2(-sign * a.nx, -sign * a.nz);
      placements.push({
        x,
        z,
        y: sampleHeight(x, z),
        nx: a.nx,
        nz: a.nz,
        sign,
        s: a.s,
        yaw,
        scale: 0.88 + hash01(seed * 31.7) * 0.22,
        color: [0xc84b36, 0x356a83, 0xd19a35, 0x52613d, 0x7c4d78][Math.floor(seed * 5) % 5],
        occupancySeed: seed,
        variantSeed: hash01(seed * 97.31 + 3.17),
        sectionId: `${roadIndex}_${side}_${Math.floor(a.s / 40)}`,
      });
    }
    if (placements.length >= maxInstances) break;
  }

  return placements;
}

export { placementsAlong };
