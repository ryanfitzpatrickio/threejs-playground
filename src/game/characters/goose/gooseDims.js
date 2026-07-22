/**
 * Canonical Canada-goose landmark dimensions (identity morph).
 * Shared by skeleton, geometry, plumage, and morph resolve — kept in its own
 * module to avoid circular imports between gooseSkeleton ↔ gooseMorph.
 */

export const GOOSE_DIMS = Object.freeze({
  standHeight: 0.92,          // ground → crown
  // torso
  chestFrontZ: 0.27,          // breast most-forward point
  rumpZ: -0.24,               // feathered body rear
  tailTipZ: -0.45,            // rectrix tips
  backTopY: 0.535,            // top of back line
  bellyY: 0.26,               // belly bottom
  bodyCenterY: 0.405,
  bodyHalfWidth: 0.125,
  // neck / head
  collarY: 0.50,              // black stocking lower edge at breast
  collarZ: 0.155,
  headCenterY: 0.872,
  headCenterZ: 0.245,
  crownY: 0.92,
  headHalfWidth: 0.042,
  headLen: 0.125,             // nape → bill base
  // bill
  billBaseY: 0.862,
  billBaseZ: 0.318,
  billTipY: 0.838,
  billTipZ: 0.425,
  billHalfWidth: 0.021,
  // eye
  eyeY: 0.885,
  eyeZ: 0.274,
  eyeX: 0.0405,
  eyeRadius: 0.0095,
  // legs
  legX: 0.047,
  hipY: 0.40,
  hipZ: -0.035,
  kneeY: 0.285,
  kneeZ: 0.05,
  ankleY: 0.155,
  ankleZ: -0.005,
  footBallY: 0.014,
  footBallZ: 0.012,
  toeTipZ: 0.128,
  // folded wing
  shoulderX: 0.078,
  shoulderY: 0.505,
  shoulderZ: 0.115,
  wristY: 0.505,
  wristZ: -0.165,
  handTipZ: -0.29,
  primaryTipZ: -0.44,
});
