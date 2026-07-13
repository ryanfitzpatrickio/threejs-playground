import * as THREE from 'three';

export const SOLDIER_LOCOMOTION_CLIPS = {
  headMissing: ['Head Missing', 'Head Missing 2'],
  armL: 'Left Arm Missing Walk',
  armR: 'Right Arm Missing Walk',
  legL: 'Left Leg Missing',
  legR: 'Right Leg Missing',
  crawlForward: 'Crawl Forward',
  crawlBack: 'Crawl Back',
};

export const SOLDIER_DISABILITY_CLIP_NAMES = new Set([
  ...SOLDIER_LOCOMOTION_CLIPS.headMissing,
  SOLDIER_LOCOMOTION_CLIPS.armL,
  SOLDIER_LOCOMOTION_CLIPS.armR,
  SOLDIER_LOCOMOTION_CLIPS.legL,
  SOLDIER_LOCOMOTION_CLIPS.legR,
  SOLDIER_LOCOMOTION_CLIPS.crawlForward,
  SOLDIER_LOCOMOTION_CLIPS.crawlBack,
]);

export function isSoldierDisabilityClip(clipName) {
  return SOLDIER_DISABILITY_CLIP_NAMES.has(clipName);
}

const GROUND_LOCOMOTION_CLIPS = new Set([
  SOLDIER_LOCOMOTION_CLIPS.crawlForward,
  SOLDIER_LOCOMOTION_CLIPS.crawlBack,
  SOLDIER_LOCOMOTION_CLIPS.legL,
  SOLDIER_LOCOMOTION_CLIPS.legR,
]);

const PRONE_LOCOMOTION_CLIPS = new Set([
  SOLDIER_LOCOMOTION_CLIPS.crawlForward,
  SOLDIER_LOCOMOTION_CLIPS.crawlBack,
]);

const ARM_MISSING_LOCOMOTION_CLIPS = new Set([
  SOLDIER_LOCOMOTION_CLIPS.armL,
  SOLDIER_LOCOMOTION_CLIPS.armR,
]);

const SINGLE_LEG_LOCOMOTION_CLIPS = new Set([
  SOLDIER_LOCOMOTION_CLIPS.legL,
  SOLDIER_LOCOMOTION_CLIPS.legR,
]);

const PRONE_HIPS_CLEARANCE = 0.16;
const PRONE_POSTURE_OFFSET_FALLBACK = -0.88;
const PRONE_COLLISION_HEIGHT_SCALE = 0.42;

export function isSoldierGroundLocomotionClip(clipName) {
  return GROUND_LOCOMOTION_CLIPS.has(clipName);
}

export function isSoldierProneLocomotionClip(clipName) {
  return PRONE_LOCOMOTION_CLIPS.has(clipName);
}

export function isSoldierArmMissingLocomotionClip(clipName) {
  return ARM_MISSING_LOCOMOTION_CLIPS.has(clipName);
}

const CRAWL_LOCOMOTION_CLIPS = new Set([
  SOLDIER_LOCOMOTION_CLIPS.crawlForward,
  SOLDIER_LOCOMOTION_CLIPS.crawlBack,
]);

// Inner.rotation.x overrides while ground disability clips play. Every soldier
// clip is authored in the GLB's lying-down space, so all of them use the upright
// base fix (-π/2). Crawl uses -π/2. One-legged (leg-missing clips which are
// upright-authored) now uses +π/2 to lay it on his back (supine) instead of belly.
export const SOLDIER_CRAWL_INNER_ROTATION_X = -Math.PI / 2;
export const SOLDIER_ONE_LEG_PRONE_INNER_ROTATION_X = -Math.PI;

export function isSoldierCrawlLocomotionClip(clipName) {
  return CRAWL_LOCOMOTION_CLIPS.has(clipName);
}

export function resolveSoldierInnerRotationX(enemy, clipName) {
  if (isSoldierCrawlLocomotionClip(clipName) || enemy?.locomotionMode === 'crawl') {
    return SOLDIER_CRAWL_INNER_ROTATION_X;
  }

  // One-legged prone: rotate so on his back.
  const loss = enemy?.limbLoss;
  if (loss && ((!loss.legL || !loss.legR) && loss.legL !== loss.legR)) {
    return SOLDIER_ONE_LEG_PRONE_INNER_ROTATION_X;
  }

  return enemy?.baseOrientationFixX ?? 0;
}

export function soldierPostureOffsetCacheKey(clipName, rotationX) {
  return `${clipName}@${rotationX.toFixed(4)}`;
}

export function isSoldierPronePosture(enemy, clipName) {
  if (isSoldierArmMissingLocomotionClip(clipName)) {
    return false;
  }

  if (isSoldierProneLocomotionClip(clipName)) {
    return true;
  }

  if (enemy?.locomotionMode === 'crawl') {
    return true;
  }

  const loss = enemy?.limbLoss;
  if (!loss) {
    return false;
  }

  // One or both legs lost => prone/lying on the ground (one-legged state back
  // to lying, using prone clearance/offset/scale even for leg-missing clips).
  return !loss.legL || !loss.legR;
}

function isSoldierSingleLegPosture(enemy, clipName) {
  if (SINGLE_LEG_LOCOMOTION_CLIPS.has(clipName)) {
    return true;
  }

  const loss = enemy?.limbLoss;
  if (!loss) {
    return false;
  }

  return (!loss.legL || !loss.legR) && loss.legL !== loss.legR;
}

// Lower-limb loss (one or both legs) puts the soldier into prone/lying posture
// on the ground. These never play the upright 'Bite' attack. Arm-missing stays
// upright and is intentionally excluded, so it is the only disability that behaves
// differently on idle/attack.
export function isSoldierLowerLimbLossPosture(enemy) {
  if (!enemy?.limbLoss) {
    return false;
  }

  return isSoldierPronePosture(enemy) || isSoldierSingleLegPosture(enemy);
}

// Distal-first: severance is decided from the limb tip inward (hand/foot), so a
// chop through the forearm/shin registers without the torso bones diluting it.
const REGION_SEVERANCE_BONES = {
  head: ['headtop_end', 'head', 'neck'],
  armL: ['lefthand', 'leftforearm', 'leftarm', 'leftshoulder'],
  armR: ['righthand', 'rightforearm', 'rightarm', 'rightshoulder'],
  legL: ['lefttoe_end', 'lefttoebase', 'leftfoot', 'leftleg', 'leftupleg'],
  legR: ['righttoe_end', 'righttoebase', 'rightfoot', 'rightleg', 'rightupleg'],
};

const scratchPoint = new THREE.Vector3();
const scratchMove = new THREE.Vector3();

export function normalizeMixamoBoneName(name) {
  return String(name).replace(/^mixamorig:?/, '').toLowerCase();
}

export function createSoldierLimbState() {
  return {
    head: true,
    armL: true,
    armR: true,
    legL: true,
    legR: true,
  };
}

export function countLostLimbs(limbLoss) {
  return Object.values(limbLoss ?? {}).filter((intact) => !intact).length;
}

function findMixamoBones(model) {
  const byNorm = new Map();
  model.traverse((object) => {
    if (!object.isBone) {
      return;
    }
    byNorm.set(normalizeMixamoBoneName(object.name), object);
  });
  return byNorm;
}

function signedPlaneDistance(plane, point, sideSign) {
  return plane.distanceToPoint(point) * sideSign;
}

export function getSoldierKeepSideSign(enemy, plane) {
  enemy.model.updateMatrixWorld(true);
  const bones = findMixamoBones(enemy.model);
  const hips = bones.get('hips');
  const sample = hips ?? enemy.model;
  sample.getWorldPosition(scratchPoint);
  return signedPlaneDistance(plane, scratchPoint, 1) >= 0 ? 1 : -1;
}

function isBoneOnDiscardSide(bone, plane, keepSign, threshold = 0.03) {
  if (!bone) {
    return false;
  }

  bone.getWorldPosition(scratchPoint);
  return signedPlaneDistance(plane, scratchPoint, keepSign) < -threshold;
}

function isLimbRegionSevered(bones, boneNames, plane, keepSign, {
  distalThreshold = 0.02,
  majorityRatio = 0.45,
} = {}) {
  let found = 0;
  let onDiscard = 0;

  for (const boneName of boneNames) {
    const bone = bones.get(boneName);
    if (!bone) {
      continue;
    }

    found += 1;
    if (isBoneOnDiscardSide(bone, plane, keepSign)) {
      onDiscard += 1;
    }
  }

  if (!found) {
    return false;
  }

  const distal = bones.get(boneNames[0]);
  if (isBoneOnDiscardSide(distal, plane, keepSign, distalThreshold)) {
    return true;
  }

  return onDiscard >= Math.max(1, Math.ceil(found * majorityRatio));
}

function isHeadRegionSevered(bones, plane, keepSign) {
  if (isLimbRegionSevered(bones, REGION_SEVERANCE_BONES.head, plane, keepSign, {
    distalThreshold: 0.012,
    majorityRatio: 0.34,
  })) {
    return true;
  }

  for (const boneName of REGION_SEVERANCE_BONES.head) {
    const bone = bones.get(boneName);
    if (bone && isBoneOnDiscardSide(bone, plane, keepSign, 0.01)) {
      return true;
    }
  }

  const head = bones.get('head');
  const neck = bones.get('neck');
  if (!head || !neck) {
    return false;
  }

  head.getWorldPosition(scratchPoint);
  const headDistance = signedPlaneDistance(plane, scratchPoint, keepSign);
  neck.getWorldPosition(scratchPoint);
  const neckDistance = signedPlaneDistance(plane, scratchPoint, keepSign);

  // Plane slices through the neck/head junction (partial decapitation counts).
  if (headDistance * neckDistance < 0) {
    return true;
  }

  // Chin/face graze: head mostly on discard even if neck stays.
  return headDistance < -0.02 && headDistance < neckDistance - 0.03;
}

function isArmRegionSevered(bones, side, plane, keepSign) {
  const boneNames = REGION_SEVERANCE_BONES[side];
  if (!boneNames) {
    return false;
  }

  if (isLimbRegionSevered(bones, boneNames, plane, keepSign, {
    distalThreshold: 0.008,
    majorityRatio: 0.25,
  })) {
    return true;
  }

  for (const boneName of boneNames) {
    const bone = bones.get(boneName);
    if (bone && isBoneOnDiscardSide(bone, plane, keepSign, 0.008)) {
      return true;
    }
  }

  const handName = side === 'armL' ? 'lefthand' : 'righthand';
  const hand = bones.get(handName);
  const forearm = bones.get(side === 'armL' ? 'leftforearm' : 'rightforearm');
  const upperArm = bones.get(side === 'armL' ? 'leftarm' : 'rightarm');
  if (!hand || !forearm) {
    return false;
  }

  hand.getWorldPosition(scratchPoint);
  const handDistance = signedPlaneDistance(plane, scratchPoint, keepSign);
  forearm.getWorldPosition(scratchPoint);
  const forearmDistance = signedPlaneDistance(plane, scratchPoint, keepSign);

  if (handDistance * forearmDistance < 0) {
    return true;
  }

  if (upperArm) {
    upperArm.getWorldPosition(scratchPoint);
    const upperArmDistance = signedPlaneDistance(plane, scratchPoint, keepSign);
    if (forearmDistance * upperArmDistance < 0 && handDistance < 0.02) {
      return true;
    }
  }

  return handDistance < -0.008;
}

function isLegRegionSevered(bones, side, plane, keepSign) {
  const boneNames = REGION_SEVERANCE_BONES[side];
  if (!boneNames) {
    return false;
  }

  if (isLimbRegionSevered(bones, boneNames, plane, keepSign, {
    distalThreshold: 0.01,
    majorityRatio: 0.3,
  })) {
    return true;
  }

  for (const boneName of boneNames) {
    const bone = bones.get(boneName);
    if (bone && isBoneOnDiscardSide(bone, plane, keepSign, 0.01)) {
      return true;
    }
  }

  return false;
}

function isCoreRegionSevered(bones, plane, keepSign) {
  const spine = bones.get('spine1') ?? bones.get('spine');
  const hips = bones.get('hips');

  if (!spine || !hips) {
    return false;
  }

  return isBoneOnDiscardSide(spine, plane, keepSign, 0.06)
    && isBoneOnDiscardSide(hips, plane, keepSign, 0.06);
}

export function analyzeSeveredRegions(enemy, plane, keepSign) {
  const bones = findMixamoBones(enemy.model);

  return {
    head: isHeadRegionSevered(bones, plane, keepSign),
    armL: isArmRegionSevered(bones, 'armL', plane, keepSign),
    armR: isArmRegionSevered(bones, 'armR', plane, keepSign),
    legL: isLegRegionSevered(bones, 'legL', plane, keepSign),
    legR: isLegRegionSevered(bones, 'legR', plane, keepSign),
    core: isCoreRegionSevered(bones, plane, keepSign),
  };
}

export function mergeLimbLoss(current, severedThisCut) {
  const next = { ...createSoldierLimbState(), ...current };

  for (const region of ['head', 'armL', 'armR', 'legL', 'legR']) {
    if (severedThisCut?.[region]) {
      next[region] = false;
    }
  }

  return next;
}

function countNewlyLost(current, next) {
  let count = 0;
  for (const region of ['head', 'armL', 'armR', 'legL', 'legR']) {
    if (current?.[region] && !next?.[region]) {
      count += 1;
    }
  }
  return count;
}

function isCoreVerticalBisect(enemy, plane) {
  const bones = findMixamoBones(enemy.model);
  const spine = bones.get('spine1') ?? bones.get('spine');
  const leftUpLeg = bones.get('leftupleg');
  const rightUpLeg = bones.get('rightupleg');
  if (!spine || !leftUpLeg || !rightUpLeg) {
    return false;
  }

  const normal = plane.normal;
  if (Math.hypot(normal.x, normal.z) <= 0.72) {
    return false;
  }

  // A true left/right bisection splits the legs to OPPOSITE sides of the plane.
  // An arm cut — even at the shoulder, whose plane passes within the old 0.22 m
  // spine threshold (the shoulder sits ~0.18 m from the spine) — leaves BOTH legs
  // on the keep side, so it must NOT count as a core bisect. Without this, any
  // shoulder/upper-arm chop was classified as a torso bisection and 1-shot KO'd.
  leftUpLeg.getWorldPosition(scratchPoint);
  const leftDist = plane.distanceToPoint(scratchPoint);
  rightUpLeg.getWorldPosition(scratchPoint);
  const rightDist = plane.distanceToPoint(scratchPoint);
  if (leftDist === 0 || rightDist === 0 || (leftDist > 0) === (rightDist > 0)) {
    return false;
  }

  spine.getWorldPosition(scratchPoint);
  return Math.abs(plane.distanceToPoint(scratchPoint)) < 0.22;
}

function isWaistSeparation(plane, severedThisCut) {
  const horizontalPlane = Math.abs(plane.normal.y) > 0.62;
  const bothLegsNow = severedThisCut.legL && severedThisCut.legR;
  return horizontalPlane && bothLegsNow;
}

export function decideSoldierCutOutcome({ enemy, plane, limbLoss, cutCount }) {
  const keepSign = getSoldierKeepSideSign(enemy, plane);
  const severedThisCut = analyzeSeveredRegions(enemy, plane, keepSign);
  const nextLoss = mergeLimbLoss(limbLoss, severedThisCut);
  const newlyLost = countNewlyLost(limbLoss, nextLoss);
  const totalLost = countLostLimbs(nextLoss);
  const waistCut = isWaistSeparation(plane, severedThisCut);
  const coreBisect = isCoreVerticalBisect(enemy, plane);
  const bothLegsLost = !nextLoss.legL && !nextLoss.legR;

  if (coreBisect || severedThisCut.core) {
    return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'core-bisect' };
  }

  if (severedThisCut.head && limbLoss.head) {
    return {
      mode: 'partial',
      locomotion: 'head',
      keepSign,
      severedThisCut,
      nextLoss,
      reason: 'head',
    };
  }

  if (cutCount >= 2 && newlyLost > 0) {
    return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'cut-limit' };
  }

  if (totalLost > 2 || newlyLost > 2) {
    return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'too-many-limbs' };
  }

  if (newlyLost === 0) {
    return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'no-severance' };
  }

  if (newlyLost === 2 && !(severedThisCut.legL && severedThisCut.legR)) {
    return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'multi-region' };
  }

  if (bothLegsLost || waistCut || (newlyLost === 2 && severedThisCut.legL && severedThisCut.legR)) {
    return {
      mode: 'partial',
      locomotion: 'crawl',
      keepSign,
      severedThisCut,
      nextLoss,
      reason: waistCut ? 'waist-cut' : 'both-legs',
    };
  }

  if (newlyLost >= 1) {
    return {
      mode: 'partial',
      locomotion: 'limb',
      keepSign,
      severedThisCut,
      nextLoss,
      reason: 'single-limb',
    };
  }

  return { mode: 'ragdoll', keepSign, severedThisCut, nextLoss, reason: 'fallback' };
}

export function applySeveranceFromProps(outcome, limbLoss, severedProps = []) {
  const blockedReasons = new Set(['core-bisect', 'cut-limit', 'too-many-limbs', 'multi-region']);
  if (blockedReasons.has(outcome?.reason) || outcome?.severedThisCut?.core) {
    return outcome;
  }

  const regions = [
    { region: 'head', locomotion: 'head', reason: 'head', minWeight: 0.28 },
    { region: 'armL', locomotion: 'limb', reason: 'armL', minWeight: 0.1 },
    { region: 'armR', locomotion: 'limb', reason: 'armR', minWeight: 0.1 },
    { region: 'legL', locomotion: 'limb', reason: 'legL', minWeight: 0.12 },
    { region: 'legR', locomotion: 'limb', reason: 'legR', minWeight: 0.12 },
  ];

  let nextOutcome = outcome;

  for (const entry of regions) {
    if (!limbLoss?.[entry.region] || nextOutcome?.severedThisCut?.[entry.region]) {
      continue;
    }

    const chunk = severedProps.find((prop) => severedPropMatchesRegion(prop, entry.region, entry.minWeight));
    if (!chunk) {
      continue;
    }

    const severedThisCut = { ...nextOutcome.severedThisCut, [entry.region]: true };
    nextOutcome = {
      ...nextOutcome,
      mode: 'partial',
      locomotion: entry.locomotion,
      severedThisCut,
      nextLoss: mergeLimbLoss(limbLoss, severedThisCut),
      reason: entry.reason,
    };
  }

  return nextOutcome;
}

export function applyHeadSeveranceToOutcome(outcome, limbLoss, severedProps = []) {
  return applySeveranceFromProps(outcome, limbLoss, severedProps);
}

/** Gun hits that can sever a limb (never core / waist bisect). */
export const GUN_SEVER_REGIONS = Object.freeze(['head', 'armL', 'armR', 'legL', 'legR']);

/**
 * Classify a gun impact into a severable Mixamo region (or 'body').
 * Uses bone proximity + height bands — no torso split.
 *
 * @param {object} enemy
 * @param {{x:number,y:number,z:number}} hitPoint
 * @param {'head'|'body'|'limb'|string|null} [coarseRegion] hitscan height band
 * @returns {'head'|'armL'|'armR'|'legL'|'legR'|'body'}
 */
export function classifyGunHitLimbRegion(enemy, hitPoint, coarseRegion = null) {
  if (!enemy?.model || enemy.limbLossProfile !== 'mixamo-humanoid' || !hitPoint) {
    return coarseRegion === 'head' ? 'head' : 'body';
  }

  enemy.model.updateMatrixWorld(true);
  const bones = findMixamoBones(enemy.model);
  const height = Math.max(0.5, enemy.collisionHeight ?? 1.8);
  const feetY = enemy.model.position.y;
  const t = (Number(hitPoint.y) - feetY) / height;

  if (t >= 0.78 || coarseRegion === 'head') {
    return 'head';
  }

  const candidates = [
    { id: 'armL', names: ['lefthand', 'leftforearm', 'leftarm', 'leftshoulder'] },
    { id: 'armR', names: ['righthand', 'rightforearm', 'rightarm', 'rightshoulder'] },
    { id: 'legL', names: ['lefttoe_end', 'lefttoebase', 'leftfoot', 'leftleg', 'leftupleg'] },
    { id: 'legR', names: ['righttoe_end', 'righttoebase', 'rightfoot', 'rightleg', 'rightupleg'] },
  ];

  let bestId = null;
  let bestD = Infinity;
  for (const c of candidates) {
    let minD = Infinity;
    for (const name of c.names) {
      const bone = bones.get(name);
      if (!bone) continue;
      bone.getWorldPosition(scratchPoint);
      const dx = scratchPoint.x - hitPoint.x;
      const dy = scratchPoint.y - hitPoint.y;
      const dz = scratchPoint.z - hitPoint.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < minD) minD = d;
    }
    if (minD < bestD) {
      bestD = minD;
      bestId = c.id;
    }
  }

  if (!bestId || !Number.isFinite(bestD)) {
    return 'body';
  }

  // Height gate: lower band prefers legs, mid band prefers arms.
  if (t < 0.28) {
    if (bestId === 'legL' || bestId === 'legR') return bestId;
    // Low hit but closest bone is an arm — still body (grazed hip area).
    return bestId.startsWith('leg') ? bestId : 'body';
  }

  if (t < 0.78) {
    if (bestId === 'armL' || bestId === 'armR') {
      // Require the arm to be closer than the torso, so chest hits stay body.
      const spine = bones.get('spine1') ?? bones.get('spine') ?? bones.get('hips');
      if (spine) {
        spine.getWorldPosition(scratchPoint);
        const dx = scratchPoint.x - hitPoint.x;
        const dy = scratchPoint.y - hitPoint.y;
        const dz = scratchPoint.z - hitPoint.z;
        const spineD = dx * dx + dy * dy + dz * dz;
        if (bestD <= spineD * 1.05) return bestId;
        return 'body';
      }
      return bestId;
    }
  }

  return 'body';
}

/**
 * Author a single clean cut plane that severs only `region`.
 * Never produces a vertical torso bisect or waist split (guns cannot do those).
 *
 * @param {object} enemy
 * @param {'head'|'armL'|'armR'|'legL'|'legR'} region
 * @returns {THREE.Plane|null}
 */
export function buildLimbSeverPlane(enemy, region) {
  if (!enemy?.model || !GUN_SEVER_REGIONS.includes(region)) {
    return null;
  }

  enemy.model.updateMatrixWorld(true);
  const bones = findMixamoBones(enemy.model);
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const distal = new THREE.Vector3();
  const proximal = new THREE.Vector3();

  if (region === 'head') {
    const neck = bones.get('neck') ?? bones.get('head');
    const head = bones.get('head') ?? bones.get('headtop_end') ?? neck;
    if (!neck || !head) return null;
    neck.getWorldPosition(proximal);
    head.getWorldPosition(distal);
    point.copy(proximal).lerp(distal, 0.35);
    // Prefer +Y so the head is clearly on the discard side of a neck slice.
    normal.set(0, 1, 0);
    if (distal.y < proximal.y) normal.y = -1;
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), point);
  }

  if (region === 'armL' || region === 'armR') {
    const isL = region === 'armL';
    const shoulder = bones.get(isL ? 'leftshoulder' : 'rightshoulder')
      ?? bones.get(isL ? 'leftarm' : 'rightarm');
    const hand = bones.get(isL ? 'lefthand' : 'righthand')
      ?? bones.get(isL ? 'leftforearm' : 'rightforearm');
    const spine = bones.get('spine1') ?? bones.get('spine') ?? bones.get('hips');
    if (!shoulder || !hand) return null;
    shoulder.getWorldPosition(proximal);
    hand.getWorldPosition(distal);
    // Plane just outboard of the shoulder, normal toward the hand.
    point.copy(proximal).lerp(distal, 0.12);
    normal.copy(distal).sub(proximal);
    // Flatten a bit so we don't drag the plane into the torso.
    if (spine) {
      spine.getWorldPosition(scratchPoint);
      const out = new THREE.Vector3().copy(proximal).sub(scratchPoint);
      out.y *= 0.25;
      if (out.lengthSq() > 1e-6) {
        normal.addScaledVector(out.normalize(), normal.length() * 0.55);
      }
    }
    if (normal.lengthSq() < 1e-8) {
      normal.set(isL ? -1 : 1, 0, 0);
    }
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), point);
  }

  // Legs: diagonal mid-shin plane (outward + down). Tuned so only one leg is
  // discard-side: pure lateral also takes the same-side arm; pure down is a
  // waist cut that severs both legs.
  {
    const isL = region === 'legL';
    const upLeg = bones.get(isL ? 'leftupleg' : 'rightupleg');
    const foot = bones.get(isL ? 'leftfoot' : 'rightfoot')
      ?? bones.get(isL ? 'leftleg' : 'rightleg');
    const hips = bones.get('hips');
    if (!upLeg || !foot) return null;

    upLeg.getWorldPosition(proximal);
    foot.getWorldPosition(distal);
    // Sit the plane lower on the limb (past the knee) so arms stay clear.
    point.copy(proximal).lerp(distal, 0.58);

    if (hips) {
      hips.getWorldPosition(scratchPoint);
      // Horizontal outward from hips through this hip joint.
      normal.copy(proximal).sub(scratchPoint);
      normal.y = 0;
      if (normal.lengthSq() < 1e-8) {
        normal.set(isL ? 1 : -1, 0, 0);
      }
      normal.normalize();
    } else {
      normal.set(isL ? 1 : -1, 0, 0);
    }
    // Blend outward + down (~pitch -35°): single-leg discard without waist-cut
    // or same-side arm sever (validated against Mixamo bone layout).
    normal.x *= 0.82;
    normal.z *= 0.82;
    normal.y = -0.57;
    normal.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);

    // Tiny constant nudge: the diagonal can leave the same-side hand a hair on
    // the discard side (→ multi-region ragdoll). Pull the plane so the hand
    // matches the hips while the foot stays discarded.
    // THREE.Plane distance = normal.dot(point) + constant; keep side is
    // distance * keepSign >= 0 (same convention as getSoldierKeepSideSign).
    const hand = bones.get(isL ? 'lefthand' : 'righthand');
    if (hand && hips) {
      hips.getWorldPosition(scratchPoint);
      const keepSign = plane.distanceToPoint(scratchPoint) >= 0 ? 1 : -1;
      hand.getWorldPosition(scratchMove);
      const handSigned = plane.distanceToPoint(scratchMove) * keepSign;
      foot.getWorldPosition(distal);
      const footSigned = plane.distanceToPoint(distal) * keepSign;
      if (handSigned < 0.02 && footSigned < -0.05) {
        const need = 0.03 - handSigned; // target handSigned ≈ +0.03
        plane.constant += need / keepSign;
      }
    }
    return plane;
  }
}

/**
 * True when this region is still attached and can be gun-severed.
 */
export function canGunSeverRegion(enemy, region) {
  if (!hasMixamoLimbLoss(enemy) || !GUN_SEVER_REGIONS.includes(region)) {
    return false;
  }
  // limbLoss.true = intact
  return enemy.limbLoss[region] !== false;
}

function severedPropMatchesRegion(prop, region, minWeight) {
  const weight = prop.region?.weights?.[region] ?? 0;
  return prop.region?.primary === region || weight >= minWeight;
}

export function pickHeadMissingClip(enemy) {
  const options = SOLDIER_LOCOMOTION_CLIPS.headMissing;
  const clip = options[Math.floor(Math.random() * options.length)];
  enemy.headMissingClip = clip;
  return clip;
}

function hasMixamoLimbLoss(enemy) {
  return enemy?.limbLossProfile === 'mixamo-humanoid' && Boolean(enemy?.limbLoss);
}

export function resolveSoldierLocomotionClip(enemy, { movingBackward = false } = {}) {
  if (!hasMixamoLimbLoss(enemy)) {
    return null;
  }

  const loss = enemy.limbLoss;
  const bothLegsLost = !loss.legL && !loss.legR;

  if (enemy.locomotionMode === 'crawl' || bothLegsLost) {
    return movingBackward
      ? SOLDIER_LOCOMOTION_CLIPS.crawlBack
      : SOLDIER_LOCOMOTION_CLIPS.crawlForward;
  }

  if (!loss.legL && loss.legR) {
    return SOLDIER_LOCOMOTION_CLIPS.legL;
  }

  if (!loss.legR && loss.legL) {
    return SOLDIER_LOCOMOTION_CLIPS.legR;
  }

  if (!loss.armL && loss.armR) {
    return SOLDIER_LOCOMOTION_CLIPS.armL;
  }

  if (!loss.armR && loss.armL) {
    return SOLDIER_LOCOMOTION_CLIPS.armR;
  }

  if (!loss.head) {
    return enemy.headMissingClip ?? pickHeadMissingClip(enemy);
  }

  return null;
}

export function resolveSoldierLocomotionSpeed(enemy, baseSpeed) {
  if (!hasMixamoLimbLoss(enemy)) {
    return baseSpeed;
  }

  const loss = enemy.limbLoss;
  const bothLegsLost = !loss.legL && !loss.legR;

  if (enemy.locomotionMode === 'crawl' || bothLegsLost) {
    return baseSpeed * 0.34;
  }

  if (!loss.legL || !loss.legR) {
    return baseSpeed * 0.58;
  }

  if (!loss.armL || !loss.armR) {
    return baseSpeed * 0.72;
  }

  if (!loss.head) {
    return baseSpeed * 0.82;
  }

  return baseSpeed;
}

export function isEnemyMovingBackward(enemy, target) {
  if (!target) {
    return false;
  }

  scratchMove.subVectors(target, enemy.model.position);
  scratchMove.y = 0;

  if (scratchMove.lengthSq() < 0.0001) {
    return false;
  }

  scratchMove.normalize();
  const forwardX = Math.sin(enemy.model.rotation.y);
  const forwardZ = Math.cos(enemy.model.rotation.y);
  return scratchMove.x * forwardX + scratchMove.z * forwardZ < -0.15;
}

export function resolveSoldierTargetHipsHeight(enemy, clipName) {
  if (isSoldierPronePosture(enemy, clipName)) {
    return PRONE_HIPS_CLEARANCE;
  }

  return 1.02;
}

export function resolveSoldierPostureOffsetFallback(enemy, clipName) {
  if (!enemy?.limbLoss) {
    return 0;
  }

  if (isSoldierPronePosture(enemy, clipName)) {
    return PRONE_POSTURE_OFFSET_FALLBACK;
  }

  return 0;
}

export function resolveSoldierCollisionHeight(enemy, clipName) {
  const base = enemy?.baseCollisionHeight ?? enemy?.collisionHeight ?? 1.7;

  if (!enemy?.limbLoss) {
    return base;
  }

  if (isSoldierPronePosture(enemy, clipName)) {
    return base * PRONE_COLLISION_HEIGHT_SCALE;
  }

  return base;
}
