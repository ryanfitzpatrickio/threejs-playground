/**
 * Cat facial landmark ratios — feature placement "via photo landmark ratios".
 *
 * These are normalized offsets measured off the cat-ref reference boards
 * (front + profile head-close stills), expressed as fractions of a single
 * `headScale` relative to the head centre. Resolving them against a chosen
 * head centre/scale places the eyes, ears, muzzle and nose by proportion
 * rather than magic numbers, so the same ratios drive the skeleton, the
 * geometry, and the coat masks in agreement — and re-scale cleanly for a
 * kitten head or a big Maine-Coon skull.
 *
 * Frame: cat faces +Z, profile camera on +X. x = half-offset (±), y up,
 * z forward. Values are landmark_offset / headScale.
 */

export const CAT_HEAD_LANDMARK_RATIOS = Object.freeze({
  // headScale ≈ skull span used to normalize every offset below.
  headScale: 0.072,
  // Large, round, forward-facing eyes set in sockets on the upper face —
  // BEHIND the muzzle (low z) so they don't ride out onto the snout.
  // Eyeballs on the front-side of the face flanking the muzzle. Framed by a
  // dark painted socket ring in the coat so they read as eyes even where the
  // round skull only lets the dome poke partway out.
  eye: { x: 0.49, y: -0.02, z: 0.315, r: 0.30 },
  // Tall pointed ears set wide on the crown, swept slightly back at the tip
  // (cat-ref: ears ~0.9× head height, wide base).
  earBase: { x: 0.50, y: 0.42, z: -0.28 },
  earTip: { x: 0.66, y: 1.32, z: -0.50 },
  // Short blunt muzzle + small nose leather, dropping BELOW the eyes and only
  // just forward of them (a cat's face is nearly flat-fronted, not a snout).
  muzzleTip: { y: -0.40, z: 0.60 },
  nose: { y: -0.43, z: 0.68 },
});

/**
 * Resolve the ratios into absolute landmark dimensions.
 * @param {{ headCenterY: number, headCenterZ: number, headScale?: number }} head
 */
export function resolveCatHeadLandmarks({ headCenterY, headCenterZ, headScale }) {
  const S = headScale ?? CAT_HEAD_LANDMARK_RATIOS.headScale;
  const R = CAT_HEAD_LANDMARK_RATIOS;
  const cy = headCenterY;
  const cz = headCenterZ;
  return {
    headScale: S,
    eyeX: R.eye.x * S,
    eyeY: cy + R.eye.y * S,
    eyeZ: cz + R.eye.z * S,
    eyeRadius: R.eye.r * S,
    earBaseX: R.earBase.x * S,
    earBaseY: cy + R.earBase.y * S,
    earBaseZ: cz + R.earBase.z * S,
    earTipX: R.earTip.x * S,
    earTipY: cy + R.earTip.y * S,
    earTipZ: cz + R.earTip.z * S,
    muzzleTipY: cy + R.muzzleTip.y * S,
    muzzleTipZ: cz + R.muzzleTip.z * S,
    noseY: cy + R.nose.y * S,
    noseZ: cz + R.nose.z * S,
  };
}
