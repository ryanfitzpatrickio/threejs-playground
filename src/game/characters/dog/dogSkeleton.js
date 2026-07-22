/**
 * Procedural ~40-bone dog skeleton.
 * Y-up, faces +Z. Rest pose is a standing quadruped with paws near y≈0.
 */

import * as THREE from 'three';
import { plantBindSoles, DOG_PAW_MESH_PAD as FOOT_PLANT_PAD } from './dogFootPlant.js';

/** Medium dog (golden-retriever scale), meters. */
export const DOG_PROPORTIONS = {
  withersHeight: 0.52,
  bodyLength: 0.58,
  chestWidth: 0.22,
  hipWidth: 0.18,
  headLength: 0.20,
  skullRadius: 0.072,
  muzzleLength: 0.10,
  tailLength: 0.36,
};

/**
 * Local rest offsets. Positions chosen so front/hind paws sit near ground.
 * Rest rotations give a natural standing bend (not stick-straight legs).
 *
 * @type {Array<{ name: string, parent: string|null, pos: [number,number,number], rot?: [number,number,number] }>}
 */
export const DOG_BONE_DEFS = [
  { name: 'Root', parent: null, pos: [0, 0, 0] },

  // Spine runs along +Z; pelvis at rump, chest at withers.
  // Mild standing arch: withers slightly higher than rump.
  { name: 'Pelvis', parent: 'Root', pos: [0, 0.44, -0.18] },
  { name: 'Spine', parent: 'Pelvis', pos: [0, 0.02, 0.12] },
  { name: 'Spine1', parent: 'Spine', pos: [0, 0.015, 0.13] },
  { name: 'Chest', parent: 'Spine1', pos: [0, 0.012, 0.14] },

  { name: 'Neck', parent: 'Chest', pos: [0, 0.055, 0.11], rot: [-8, 0, 0] },
  { name: 'Head', parent: 'Neck', pos: [0, 0.04, 0.1], rot: [4, 0, 0] },
  { name: 'Jaw', parent: 'Head', pos: [0, -0.028, 0.028], rot: [6, 0, 0] },
  // Shorter fuller golden muzzle (ref head-close is not a long snout).
  { name: 'Muzzle', parent: 'Head', pos: [0, -0.01, 0.07] },
  { name: 'NoseTip', parent: 'Muzzle', pos: [0, 0.0, 0.058] },

  // Tail — gentle upward plume base
  { name: 'Tail0', parent: 'Pelvis', pos: [0, 0.035, -0.065], rot: [-20, 0, 0] },
  { name: 'Tail1', parent: 'Tail0', pos: [0, 0.005, -0.075], rot: [-12, 0, 0] },
  { name: 'Tail2', parent: 'Tail1', pos: [0, 0.0, -0.072], rot: [-6, 0, 0] },
  { name: 'Tail3', parent: 'Tail2', pos: [0, -0.004, -0.068] },
  { name: 'Tail4', parent: 'Tail3', pos: [0, -0.008, -0.06] },

  // Flopped golden ears: attach high at the back of the skull, hang nearly
  // straight down beside the jaw, broad face outward (ref profile). Enough
  // outward lean that the leather clears the neck fluff cylinder.
  { name: 'EarL0', parent: 'Head', pos: [0.068, 0.04, -0.02], rot: [10, -8, 14] },
  { name: 'EarL1', parent: 'EarL0', pos: [0.006, -0.042, -0.01], rot: [4, 0, 1] },
  { name: 'EarL2', parent: 'EarL1', pos: [0.003, -0.048, -0.01], rot: [4, 0, 1] },
  { name: 'EarR0', parent: 'Head', pos: [-0.068, 0.04, -0.02], rot: [10, 8, -14] },
  { name: 'EarR1', parent: 'EarR0', pos: [-0.006, -0.042, -0.01], rot: [4, 0, -1] },
  { name: 'EarR2', parent: 'EarR1', pos: [-0.003, -0.048, -0.01], rot: [4, 0, -1] },

  // Front left — straight column like the fox reference (near-plumb shoulder→
  // elbow→wrist, short pastern break). Pure -Y + small X pitch.
  { name: 'ShoulderL', parent: 'Chest', pos: [0.105, -0.005, 0.04], rot: [6, 0, 0] },
  { name: 'UpperArmL', parent: 'ShoulderL', pos: [0.01, -0.135, 0], rot: [-6, 0, 0] },
  { name: 'ForearmL', parent: 'UpperArmL', pos: [0.0, -0.215, 0], rot: [-6, 0, 0] },
  { name: 'PasternL', parent: 'ForearmL', pos: [0.0, -0.06, 0] },
  { name: 'PawL', parent: 'PasternL', pos: [0.0, -0.012, 0.036] },

  // Front right
  { name: 'ShoulderR', parent: 'Chest', pos: [-0.105, -0.005, 0.04], rot: [6, 0, 0] },
  { name: 'UpperArmR', parent: 'ShoulderR', pos: [-0.01, -0.135, 0], rot: [-6, 0, 0] },
  { name: 'ForearmR', parent: 'UpperArmR', pos: [0.0, -0.215, 0], rot: [-6, 0, 0] },
  { name: 'PasternR', parent: 'ForearmR', pos: [0.0, -0.06, 0] },
  { name: 'PawR', parent: 'PasternR', pos: [0.0, -0.012, 0.036] },

  // Hind left — camped digitigrade S from the paw up (fox mesh reference).
  // Head = +Z. Bones sit at joints, pure translation (no rest pitch):
  //   pads → nearly vertical cannon up to high rear hock (Shin bone) →
  //   tibia up-FORWARD to stifle under the flank (Thigh bone) →
  //   femur up-BACK to hip.
  // Stifle must clear the thick haunch loft (+Z under belly); a mild +0.07
  // buried the forward knee so the silhouette read as a single reverse hock.
  { name: 'HipL', parent: 'Pelvis', pos: [0.088, -0.006, -0.012] },
  // The three long segments use the same compact scale. Keeping the femur
  // forward, tibia back, and cannon nearly vertical preserves the canine
  // stifle/hock profile without making the rear leg longer than the foreleg.
  { name: 'ThighL', parent: 'HipL', pos: [0.012, -0.108, 0.116] },
  { name: 'ShinL', parent: 'ThighL', pos: [0.0, -0.083, -0.154] },
  { name: 'HockL', parent: 'ShinL', pos: [0.0, -0.125, 0.017] },
  { name: 'HindPawL', parent: 'HockL', pos: [0.0, -0.016, 0.04] },

  // Hind right
  { name: 'HipR', parent: 'Pelvis', pos: [-0.088, -0.006, -0.012] },
  { name: 'ThighR', parent: 'HipR', pos: [-0.012, -0.108, 0.116] },
  { name: 'ShinR', parent: 'ThighR', pos: [0.0, -0.083, -0.154] },
  { name: 'HockR', parent: 'ShinR', pos: [0.0, -0.125, 0.017] },
  { name: 'HindPawR', parent: 'HockR', pos: [0.0, -0.016, 0.04] },
];

const DEFAULT_SKELETON_SHAPE = Object.freeze({
  bodyLength: 1,
  legLength: 1,
  chestWidth: 1,
  hipWidth: 1,
  neckLength: 1,
  headSize: 1,
  muzzleLength: 1,
  tailLength: 1,
  // Y lift of the whole topline (Pelvis/Spine/Spine1/Chest). The rig roots the
  // legs at a fixed shoulder/hip height and hangs them to the ground via CCD
  // sole-planting, so a long-legged breed (legLength > ~1.1) over-reaches and
  // the leg buckles — dropping the elbow to the floor and reading as
  // short-legged/stocky. Lifting the topline lifts the leg roots with it so the
  // full leg length stands straight and the body sits tall (leggier ungulate).
  withersLift: 0,
});

/** Generate breed bind offsets while preserving the shared bone-name contract. */
export function createDogBoneDefs(phenotype = null) {
  const shape = { ...DEFAULT_SKELETON_SHAPE, ...(phenotype?.skeleton ?? {}) };
  const geometry = phenotype?.geometry ?? {};
  const ear = phenotype?.ears ?? { type: 'floppy', length: 1, width: 1 };
  const tail = phenotype?.tail ?? { type: 'plume', curl: 0 };
  const defs = DOG_BONE_DEFS.map((def) => ({
    ...def,
    pos: [...def.pos],
    ...(def.rot ? { rot: [...def.rot] } : {}),
  }));
  const byName = new Map(defs.map((def) => [def.name, def]));

  for (const name of ['Pelvis', 'Spine', 'Spine1', 'Chest']) {
    const def = byName.get(name);
    if (name === 'Pelvis') def.pos[2] *= shape.bodyLength;
    else def.pos[2] *= shape.bodyLength;
    // Topline lift carries the leg roots (Shoulder on Chest, Hip on Pelvis) and
    // neck/head/tail up with it; CCD re-plants the paws straight at the ground.
    def.pos[1] += shape.withersLift ?? 0;
  }
  for (const name of ['Neck', 'Head']) {
    const def = byName.get(name);
    def.pos[1] *= shape.neckLength;
    def.pos[2] *= shape.neckLength;
  }
  // Neck carriage (equids): raise the neck column toward vertical by rotating
  // the Neck/Head offsets up around X. Offsets only — bone rest ROTATIONS are
  // untouched, so the head keeps facing forward instead of pitching skyward.
  {
    const carriage = Math.min(Math.max(shape.neckCarriage ?? 0, 0), 1);
    if (carriage > 0) {
      const ang = carriage * 0.7;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      for (const name of ['Neck', 'Head']) {
        const def = byName.get(name);
        const y = def.pos[1];
        const z = def.pos[2];
        def.pos[1] = y * cos + z * sin;
        def.pos[2] = z * cos - y * sin;
      }
    }
  }
  const jaw = byName.get('Jaw');
  jaw.pos[0] *= shape.headSize;
  jaw.pos[1] *= shape.headSize;
  jaw.pos[2] *= shape.headSize;

  // Keep brachycephalic noses outside the skull instead of shortening both
  // muzzle bones until the nose and snout are buried inside the face. Longer
  // breeds still use their authored muzzle multiplier without approximation.
  const muzzleReach = Math.max(0.075 * shape.headSize, 0.128 * shape.muzzleLength);
  const muzzle = byName.get('Muzzle');
  const noseTip = byName.get('NoseTip');
  muzzle.pos[0] *= shape.headSize;
  muzzle.pos[1] *= shape.headSize;
  muzzle.pos[2] = muzzleReach * (0.07 / 0.128);
  noseTip.pos[0] *= shape.headSize;
  noseTip.pos[1] *= shape.headSize;
  noseTip.pos[2] = muzzleReach * (0.058 / 0.128);

  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    const names = DOG_EAR_BONES[side];
    const base = byName.get(names[0]);
    const mid = byName.get(names[1]);
    const tip = byName.get(names[2]);
    const length = ear.length ?? 1;
    const width = ear.width ?? 1;
    base.pos[0] = sign * 0.068 * shape.headSize * width;
    base.pos[1] *= shape.headSize;
    base.pos[2] *= shape.headSize;

    if (ear.type === 'rounded') {
      // A raccoon pinna is a low rounded cup, not a shortened spitz triangle.
      base.pos = [sign * 0.072 * shape.headSize * (geometry.skullWidth ?? 1), 0.05 * shape.headSize, -0.003 * shape.headSize];
      base.rot = [-3, 0, sign * -4];
      mid.pos = [sign * 0.004 * width, 0.025 * length, 0];
      mid.rot = [-2, 0, sign * -2];
      tip.pos = [sign * 0.002 * width, 0.02 * length, 0.001];
      tip.rot = [0, 0, 0];
    } else if ((ear.type === 'erect' || ear.type === 'bat') && geometry.headShape === 'equid') {
      // Horse ears: narrow-set at the POLL (well back on the long skull,
      // near where head meets neck — not mid-skull like a canid pinna),
      // nearly parallel/upright, tips leaning slightly forward and inward
      // instead of splaying laterally.
      base.pos = [sign * 0.024 * shape.headSize * width, 0.058 * shape.headSize, -0.05 * shape.headSize];
      base.rot = [-16, 0, sign * -2];
      mid.pos = [sign * 0.003 * width, 0.05 * length, 0.006];
      mid.rot = [-4, 0, sign * -1];
      tip.pos = [sign * 0.001 * width, 0.046 * length, 0.005];
      tip.rot = [0, 0, sign * -1];
    } else if (ear.type === 'erect' || ear.type === 'bat') {
      const bat = ear.type === 'bat' ? 1.18 : 1;
      base.pos = [sign * 0.058 * shape.headSize * width, 0.052 * shape.headSize, -0.006 * shape.headSize];
      base.rot = [sign > 0 ? -4 : -4, 0, sign * -5];
      mid.pos = [sign * 0.005 * width * bat, 0.046 * length * bat, -0.002];
      mid.rot = [-2, 0, sign * -3];
      tip.pos = [sign * 0.003 * width, 0.044 * length * bat, 0];
      tip.rot = [0, 0, sign * -2];
    } else if (ear.type === 'folded') {
      const fold = ear.fold ?? 'drop';
      // Folded ears need their hinge on the lateral skull surface. Driving
      // this position from ear width put compact ears (most visibly the
      // Rottweiler) inside the cranium, leaving only a pinned-looking sliver.
      const skullSurfaceX = 0.074 * shape.headSize * (geometry.skullWidth ?? 1);
      if (fold === 'semi-prick') {
        // Short upright hinge with the broad upper pinna tipping outward and
        // forward, as on the uncropped Australian Shepherd reference.
        base.pos = [sign * skullSurfaceX, 0.04 * shape.headSize, 0.002 * shape.headSize];
        base.rot = [-2, 0, sign * -3];
        mid.pos = [sign * 0.018 * width, 0.022 * length, 0.002 * length];
        mid.rot = [20, 0, sign * -5];
        tip.pos = [sign * 0.027 * width, -0.035 * length, 0.028 * length];
        tip.rot = [24, 0, sign * -5];
      } else if (fold === 'rose') {
        // Small ear folding outward/back from the skull, used by bulldogs.
        base.pos = [sign * skullSurfaceX, 0.038 * shape.headSize, -0.005 * shape.headSize];
        base.rot = [8, sign * -4, sign * 9];
        mid.pos = [sign * 0.018 * width, -0.006 * length, -0.012 * length];
        mid.rot = [10, 0, sign * -7];
        tip.pos = [sign * 0.02 * width, -0.008 * length, 0.008 * length];
        tip.rot = [8, 0, sign * -4];
      } else if (fold === 'button') {
        // Compact V-fold held close beside the brow, used by schnauzers.
        base.pos = [sign * skullSurfaceX, 0.043 * shape.headSize, 0.005 * shape.headSize];
        base.rot = [5, 0, sign * 4];
        mid.pos = [sign * 0.02 * width, -0.02 * length, 0.014 * length];
        mid.rot = [12, 0, sign * -4];
        tip.pos = [sign * 0.018 * width, -0.026 * length, 0.012 * length];
        tip.rot = [8, 0, sign * -2];
      } else {
        // Natural triangular drop ear: high inner attachment, then down and
        // forward along the cheek (not out to the side — a path biased toward
        // X made the leaf plane land almost flat in the XY plane, so it read
        // as a wide paddle face-on and vanished edge-on in profile).
        base.pos = [sign * skullSurfaceX, 0.041 * shape.headSize, 0.006 * shape.headSize];
        base.rot = [4, 0, sign * 4];
        mid.pos = [sign * 0.011 * width, -0.04 * length, 0.026 * length];
        mid.rot = [16, 0, sign * -4];
        tip.pos = [sign * 0.007 * width, -0.043 * length, 0.03 * length];
        tip.rot = [14, 0, sign * -2];
      }
    } else {
      // Floppy hang (golden, lab, etc.)
      mid.pos = [sign * 0.006 * width, -0.042 * length, -0.01 * length];
      tip.pos = [sign * 0.003 * width, -0.048 * length, -0.01 * length];
    }
  }

  for (let i = 0; i < DOG_TAIL_BONES.length; i += 1) {
    const def = byName.get(DOG_TAIL_BONES[i]);
    if (tail.type === 'sciurid') {
      // Free tall plume *behind* the rump (rodent-ref S-curve). Prior ramps
      // with large +pitch curled the tip over the back into a backpack that
      // fused with the torso. Local chain is mostly +Y with small -Z so the
      // tip stays caudal of the pelvis; curl only eases a soft tip S.
      const curl = THREE.MathUtils.clamp(Number(tail.curl) || 0.35, 0, 1.2);
      const L = shape.tailLength;
      const tipPull = curl * 0.012 * L;
      const plumeStations = [
        [0, 0.048 * L, -0.058 * L],
        [0, 0.1 * L, -0.02 * L],
        [0, 0.095 * L, -0.008 * L],
        [0, 0.08 * L, 0.004 * L + tipPull * 0.4],
        [0, 0.055 * L, 0.008 * L + tipPull],
      ];
      def.pos = plumeStations[i];
      // Near-zero pitch — vertical stations carry the rise; curl tips distal.
      const tipOver = i >= 3 ? -curl * 10 * (i - 2) : 0;
      def.rot = [5 - i * 1.5 + tipOver, 0, 0];
    } else {
      def.pos[1] *= shape.tailLength;
      def.pos[2] *= shape.tailLength;
      if (tail.type === 'curled') {
        // Tight corkscrew (pug-like short tails) — large cumulative curl is fine
        // since the tail itself is short and coils close against the rump.
        const curl = tail.curl ?? 1;
        def.rot = [-28 - curl * (i === 0 ? 20 : 34), 0, i > 1 ? (i % 2 ? 8 : -8) * curl : 0];
      } else if (tail.type === 'sickle') {
        // Open sickle arc (husky/chihuahua): rises from the rump and curls
        // forward over the back. Note each bone's local rotation orients the
        // offset to its CHILD, not itself — Tail0's rotation places Tail1, etc.
        // A ramped-down sequence (large pitch near the base, easing off toward
        // the tip) is what actually produces a curl-over in this rig; the
        // previous uniform-per-bone angle just drooped the tail down and back
        // like a straight tail, never curling above the rump (verified by
        // querying bone world positions — Y fell monotonically instead of
        // rising through the middle of the chain).
        const curl = tail.curl ?? 0.65;
        def.rot = [-34 - curl * 36 - i * 2, 0, i > 1 ? (i % 2 ? 6 : -6) * curl * 0.5 : 0];
      } else if (tail.type === 'upright') {
        def.rot = [-62 + i * 5, 0, 0];
      } else if (tail.type === 'straight') {
        def.rot = [-8 + i * 2, 0, 0];
      } else if (tail.type === 'paddle') {
        // Flat horizontal paddle (beaver): laid straight back, near-level. The
        // wide flat plate is built in dogBodyGeometry; this chain just keeps
        // it caudal of the rump and roughly horizontal (not raised).
        def.rot = [-2 + i, 0, 0];
      } else if (tail.type === 'dock') {
        // Equid dock: hangs down-back from the rump (low carriage).
        def.rot = [i === 0 ? -52 : -14, 0, 0];
      }
    }
  }

  // Align with ANIMAL_NUMERIC_RANGES['skeleton.frontLegScale'] (0.45–1.2).
  const frontLegScale = THREE.MathUtils.clamp(Number(shape.frontLegScale) || 1, 0.45, 1.2);
  // Cursorial (equid) hind kit: much straighter stifle/hock at rest and a
  // long cannon under a shorter femur — a horse stands column-legged, not
  // crouch-ready. Same bones, retuned rest offsets/pitches only.
  if (shape.legStyle === 'cursorial') {
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? 1 : -1;
      const thigh = byName.get(`Thigh${side}`);
      const shin = byName.get(`Shin${side}`);
      const hock = byName.get(`Hock${side}`);
      thigh.pos = [sign * 0.01, -0.095, 0.03];
      thigh.rot = [20, 0, 0];
      shin.pos = [0, -0.12, 0];
      shin.rot = [-20, 0, 0];
      hock.pos = [0, -0.135, -0.006];
      hock.rot = [4, 0, 0];
    }
  }

  for (const chain of Object.values(DOG_LEG_CHAINS)) {
    const legMul = shape.legLength * (chain.front ? frontLegScale : 1);
    for (const name of chain.bones) {
      const def = byName.get(name);
      def.pos[1] *= legMul;
      // Scale sagittal offsets with leg length so long-legged breeds keep the
      // same S-curve proportions (otherwise hind Z stays short and pads diverge).
      if (name !== chain.hip) def.pos[2] *= legMul;
      if (name === chain.hip) {
        def.pos[0] *= chain.front ? shape.chestWidth : shape.hipWidth;
        def.pos[2] *= shape.bodyLength;
      }
    }
  }
  return defs;
}

/**
 * Mesh pad hang below sole bones — shared with dogFootPlant bind/runtime plant.
 * Do NOT per-paw warp tip bones every frame (that creates tippy-toe stilts).
 */
export const DOG_PAW_MESH_PAD = FOOT_PLANT_PAD;

/** Leg chains for animation (local euler additives). */
export const DOG_LEG_CHAINS = {
  frontL: {
    side: 'L',
    front: true,
    bones: ['ShoulderL', 'UpperArmL', 'ForearmL', 'PasternL', 'PawL'],
    hip: 'ShoulderL',
    upper: 'UpperArmL',
    lower: 'ForearmL',
    pastern: 'PasternL',
    paw: 'PawL',
  },
  frontR: {
    side: 'R',
    front: true,
    bones: ['ShoulderR', 'UpperArmR', 'ForearmR', 'PasternR', 'PawR'],
    hip: 'ShoulderR',
    upper: 'UpperArmR',
    lower: 'ForearmR',
    pastern: 'PasternR',
    paw: 'PawR',
  },
  hindL: {
    side: 'L',
    front: false,
    bones: ['HipL', 'ThighL', 'ShinL', 'HockL', 'HindPawL'],
    hip: 'HipL',
    upper: 'ThighL',
    lower: 'ShinL',
    pastern: 'HockL',
    paw: 'HindPawL',
  },
  hindR: {
    side: 'R',
    front: false,
    bones: ['HipR', 'ThighR', 'ShinR', 'HockR', 'HindPawR'],
    hip: 'HipR',
    upper: 'ThighR',
    lower: 'ShinR',
    pastern: 'HockR',
    paw: 'HindPawR',
  },
};

export const DOG_TAIL_BONES = ['Tail0', 'Tail1', 'Tail2', 'Tail3', 'Tail4'];
export const DOG_EAR_BONES = {
  L: ['EarL0', 'EarL1', 'EarL2'],
  R: ['EarR0', 'EarR1', 'EarR2'],
};

/**
 * @returns {{
 *   root: THREE.Bone,
 *   bones: THREE.Bone[],
 *   bonesByName: Map<string, THREE.Bone>,
 *   skeleton: THREE.Skeleton,
 *   boneIndex: Map<string, number>,
 *   restQuaternions: Map<string, THREE.Quaternion>,
 *   restPositions: Map<string, THREE.Vector3>,
 *   boneCount: number,
 *   worldBindPos: Map<string, THREE.Vector3>,
 *   worldBindQuaternions: Map<string, THREE.Quaternion>,
 * }}
 */
export function createDogSkeleton(options = {}) {
  const phenotype = options?.skeleton ? options : options.phenotype ?? null;
  const boneDefs = createDogBoneDefs(phenotype);
  /** @type {Map<string, THREE.Bone>} */
  const bonesByName = new Map();
  /** @type {THREE.Bone[]} */
  const bones = [];
  /** @type {Map<string, number>} */
  const boneIndex = new Map();

  for (const def of boneDefs) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.fromArray(def.pos);
    if (def.rot) {
      bone.rotation.set(
        THREE.MathUtils.degToRad(def.rot[0]),
        THREE.MathUtils.degToRad(def.rot[1]),
        THREE.MathUtils.degToRad(def.rot[2]),
        'XYZ',
      );
    }
    bonesByName.set(def.name, bone);
    boneIndex.set(def.name, bones.length);
    bones.push(bone);
  }

  const root = bonesByName.get('Root');
  for (const def of boneDefs) {
    if (!def.parent) continue;
    bonesByName.get(def.parent)?.add(bonesByName.get(def.name));
  }

  root.updateMatrixWorld(true);

  // Breed-agnostic sole plant: pelvis lift + per-leg CCD so front/hind match
  // despite legLength phenotype (see dogFootPlant.js). Geometry is built after
  // this so bind skinning matches the planted rest pose.
  plantBindSoles({ root, bonesByName, skeleton: null }, FOOT_PLANT_PAD);

  const skeleton = new THREE.Skeleton(bones);

  /** @type {Map<string, THREE.Quaternion>} */
  const restQuaternions = new Map();
  /** @type {Map<string, THREE.Vector3>} */
  const restPositions = new Map();
  /** @type {Map<string, THREE.Vector3>} */
  const worldBindPos = new Map();
  /** @type {Map<string, THREE.Quaternion>} */
  const worldBindQuaternions = new Map();

  for (const bone of bones) {
    restQuaternions.set(bone.name, bone.quaternion.clone());
    restPositions.set(bone.name, bone.position.clone());
    worldBindPos.set(
      bone.name,
      new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld),
    );
    worldBindQuaternions.set(
      bone.name,
      bone.getWorldQuaternion(new THREE.Quaternion()),
    );
  }

  return {
    root,
    bones,
    bonesByName,
    skeleton,
    boneIndex,
    restQuaternions,
    restPositions,
    worldBindPos,
    worldBindQuaternions,
    boneCount: bones.length,
    boneDefs,
    phenotype,
  };
}

/**
 * Reset pose to bind rest (does not touch Root translation — animation owns that).
 * @param {ReturnType<typeof createDogSkeleton>} rig
 */
export function resetDogRestPose(rig) {
  for (const bone of rig.bones) {
    if (bone.name === 'Root') continue;
    const q = rig.restQuaternions.get(bone.name);
    const p = rig.restPositions.get(bone.name);
    if (q) bone.quaternion.copy(q);
    if (p) bone.position.copy(p);
  }
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();
}
