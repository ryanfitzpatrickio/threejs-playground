export type BonePose = {
  position?: [number, number, number]
  worldPosition?: [number, number, number]
  rotation?: [number, number, number]
}

export type PoseMap = Record<string, BonePose>
export type MorphPose = Record<string, number>

export type FacsGroup = 'Brows' | 'Eyes' | 'Midface' | 'Mouth' | 'Jaw' | 'Performance'
export type FacsSide = 'L' | 'R' | 'C' | 'B'

export type FacsControl = {
  id: string
  au: string
  label: string
  group: FacsGroup
  side: FacsSide
  max?: number
  bones: PoseMap
}

export type FacsValues = Record<string, number>
export type FacsPreset = {
  id: string
  label: string
  values: Partial<FacsValues>
}

export type EyeLookValues = {
  leftX: number   // -1 (look right from model's perspective) to +1 (look left)
  leftY: number   // -1 (look down) to +1 (look up)
  rightX: number
  rightY: number
}
export const createNeutralEyeLook = (): EyeLookValues => ({ leftX: 0, leftY: 0, rightX: 0, rightY: 0 })

const move = (worldPosition: [number, number, number]): BonePose => ({ worldPosition })

const assign = (names: string[], pose: BonePose): PoseMap =>
  Object.fromEntries(names.map((name) => [name, pose]))

const combine = (...maps: PoseMap[]): PoseMap => Object.assign({}, ...maps)

const mirrorPose = (pose: BonePose): BonePose => ({
  position: pose.position ? [-pose.position[0], pose.position[1], pose.position[2]] : undefined,
  worldPosition: pose.worldPosition
    ? [-pose.worldPosition[0], pose.worldPosition[1], pose.worldPosition[2]]
    : undefined,
  rotation: pose.rotation ? [pose.rotation[0], -pose.rotation[1], -pose.rotation[2]] : undefined,
})

const mirrorMap = (map: PoseMap): PoseMap =>
  Object.fromEntries(
    Object.entries(map).map(([name, pose]) => [
      name.replace(/\.L/g, '.R'),
      mirrorPose(pose),
    ]),
  )

const leftRight = (left: PoseMap): PoseMap => combine(left, mirrorMap(left))

// Authored value = slider value that produces "natural full expression".
// Response at authored value is 1.0 (normalised). Values above authored drive into overdrive.
export const FACS_AUTHORED_VALUE = 5
export const FACS_VALUE_MAX = 5

// In this rig, the lower brow chain runs lateral-to-medial:
// brow.B.L is the outside tail, brow.B.L.004 is closest to the nose.
// The upper brow follows the same pattern: brow.T.L is outer, brow.T.L.003 is inner.
const browInnerLeft = ['brow.B.L.003', 'brow.B.L.004', 'brow.T.L.003']
const browMidLeft = ['brow.B.L.002', 'brow.T.L.002']
const browOuterLeft = ['brow.B.L', 'brow.B.L.001', 'brow.T.L', 'brow.T.L.001']
const foreheadLeft = ['forehead.L', 'forehead.L.001', 'forehead.L.002']
const lidTopLeft = ['lid.T.L', 'lid.T.L.001', 'lid.T.L.002', 'lid.T.L.003']
const lidBottomLeft = ['lid.B.L', 'lid.B.L.001', 'lid.B.L.002', 'lid.B.L.003']
const cheekLeft = ['cheek.B.L', 'cheek.B.L.001', 'cheek.T.L', 'cheek.T.L.001']
const noseCenter = ['nose', 'nose.001', 'nose.002', 'nose.003', 'nose.004']
const noseLeft = ['nose.L', 'nose.L.001']
const chin = ['chin', 'chin.001', 'chin.L', 'chin.R']

// All bone deltas are in world-space metres. WORLD_POSITION_GAIN scales them down.
// Calibration: full expression (response=1.0) × WORLD_POSITION_GAIN = actual bone travel.
// Brow travel: ~3-4 mm. Lid: ~2-3 mm. Lip corners: ~6-8 mm. Jaw open: ~15-20 mm.

const upperLidRaiseLeft = {
  'lid.T.L': move([0, 0.024, 0.002]),
  'lid.T.L.001': move([0, 0.042, 0.004]),
  'lid.T.L.002': move([0, 0.052, 0.004]),
  'lid.T.L.003': move([0, 0.038, 0.003]),
  'lid.B.L': move([0, -0.008, 0]),
  'lid.B.L.001': move([0, -0.012, 0]),
  'lid.B.L.002': move([0, -0.014, 0]),
  'lid.B.L.003': move([0, -0.01, 0]),
}

const lidTightenLeft = {
  'lid.T.L': move([0, -0.014, 0.001]),
  'lid.T.L.001': move([0, -0.022, 0.002]),
  'lid.T.L.002': move([0, -0.026, 0.002]),
  'lid.T.L.003': move([0, -0.02, 0.002]),
  'lid.B.L': move([0, 0.012, 0.001]),
  'lid.B.L.001': move([0, 0.02, 0.002]),
  'lid.B.L.002': move([0, 0.024, 0.002]),
  'lid.B.L.003': move([0, 0.018, 0.002]),
}

const eyeClosureLeft = {
  'lid.T.L': move([0, -0.034, 0.002]),
  'lid.T.L.001': move([0, -0.054, 0.004]),
  'lid.T.L.002': move([0, -0.062, 0.004]),
  'lid.T.L.003': move([0, -0.048, 0.003]),
  'lid.B.L': move([0, 0.012, 0.001]),
  'lid.B.L.001': move([0, 0.024, 0.002]),
  'lid.B.L.002': move([0, 0.03, 0.002]),
  'lid.B.L.003': move([0, 0.02, 0.002]),
}

// Helper: left-only bones from a leftRight definition
const leftOnly = (left: PoseMap): PoseMap => left
const rightOnly = (left: PoseMap): PoseMap => mirrorMap(left)

const controls: FacsControl[] = [
  // AU01 — split L/R
  {
    id: 'au01_inner_brow_raiser_l',
    au: 'AU01',
    label: 'Inner Brow Raiser L',
    group: 'Brows',
    side: 'L',
    bones: leftOnly(combine(
      assign(browInnerLeft, move([0.008, 0.06, 0.008])),
      assign(browMidLeft, move([0.002, 0.022, 0.003])),
      assign(foreheadLeft, move([0.003, 0.026, 0.003])),
    )),
  },
  {
    id: 'au01_inner_brow_raiser_r',
    au: 'AU01',
    label: 'Inner Brow Raiser R',
    group: 'Brows',
    side: 'R',
    bones: rightOnly(combine(
      assign(browInnerLeft, move([0.008, 0.06, 0.008])),
      assign(browMidLeft, move([0.002, 0.022, 0.003])),
      assign(foreheadLeft, move([0.003, 0.026, 0.003])),
    )),
  },
  // AU02 — split L/R
  {
    id: 'au02_outer_brow_raiser_l',
    au: 'AU02',
    label: 'Outer Brow Raiser L',
    group: 'Brows',
    side: 'L',
    bones: leftOnly(combine(
      assign(browOuterLeft, move([0.009, 0.065, 0.008])),
      assign(browMidLeft, move([0.003, 0.026, 0.004])),
      assign(foreheadLeft, move([0.007, 0.028, 0.003])),
    )),
  },
  {
    id: 'au02_outer_brow_raiser_r',
    au: 'AU02',
    label: 'Outer Brow Raiser R',
    group: 'Brows',
    side: 'R',
    bones: rightOnly(combine(
      assign(browOuterLeft, move([0.009, 0.065, 0.008])),
      assign(browMidLeft, move([0.003, 0.026, 0.004])),
      assign(foreheadLeft, move([0.007, 0.028, 0.003])),
    )),
  },
  // AU04 — split L/R
  {
    id: 'au04_brow_lowerer_l',
    au: 'AU04',
    label: 'Brow Lowerer L',
    group: 'Brows',
    side: 'L',
    bones: leftOnly(combine(
      assign(browInnerLeft, move([-0.026, -0.058, 0.002])),
      assign(browMidLeft, move([-0.013, -0.032, 0])),
      assign(browOuterLeft, move([0.009, -0.024, 0])),
      assign(foreheadLeft, move([-0.009, -0.023, 0.002])),
    )),
  },
  {
    id: 'au04_brow_lowerer_r',
    au: 'AU04',
    label: 'Brow Lowerer R',
    group: 'Brows',
    side: 'R',
    bones: rightOnly(combine(
      assign(browInnerLeft, move([-0.026, -0.058, 0.002])),
      assign(browMidLeft, move([-0.013, -0.032, 0])),
      assign(browOuterLeft, move([0.009, -0.024, 0])),
      assign(foreheadLeft, move([-0.009, -0.023, 0.002])),
    )),
  },
  {
    id: 'brow_compress',
    au: 'CTRL',
    label: 'Brow Compress',
    group: 'Brows',
    side: 'B',
    bones: leftRight(
      combine(
        assign(browInnerLeft, move([-0.016, -0.041, 0.002])),
        assign(browMidLeft, move([-0.009, -0.026, 0])),
        assign(foreheadLeft, move([-0.006, -0.017, 0.001])),
      ),
    ),
  },
  // AU05 — split L/R
  {
    id: 'au05_upper_lid_raiser_l',
    au: 'AU05',
    label: 'Upper Lid Raiser L',
    group: 'Eyes',
    side: 'L',
    bones: leftOnly(combine(upperLidRaiseLeft, assign(browMidLeft, move([0.002, 0.012, 0])))),
  },
  {
    id: 'au05_upper_lid_raiser_r',
    au: 'AU05',
    label: 'Upper Lid Raiser R',
    group: 'Eyes',
    side: 'R',
    bones: rightOnly(combine(upperLidRaiseLeft, assign(browMidLeft, move([0.002, 0.012, 0])))),
  },
  // AU06 — split L/R
  {
    id: 'au06_cheek_raiser_l',
    au: 'AU06',
    label: 'Cheek Raiser L',
    group: 'Midface',
    side: 'L',
    bones: leftOnly(combine(
      assign(cheekLeft, move([0.026, 0.052, 0.017])),
      assign(lidBottomLeft, move([0.001, 0.026, 0.002])),
      assign(lidTopLeft, move([0, -0.013, 0.001])),
    )),
  },
  {
    id: 'au06_cheek_raiser_r',
    au: 'AU06',
    label: 'Cheek Raiser R',
    group: 'Midface',
    side: 'R',
    bones: rightOnly(combine(
      assign(cheekLeft, move([0.026, 0.052, 0.017])),
      assign(lidBottomLeft, move([0.001, 0.026, 0.002])),
      assign(lidTopLeft, move([0, -0.013, 0.001])),
    )),
  },
  // AU07 — split L/R
  {
    id: 'au07_lid_tightener_l',
    au: 'AU07',
    label: 'Lid Tightener L',
    group: 'Eyes',
    side: 'L',
    bones: leftOnly(combine(lidTightenLeft, assign(cheekLeft, move([0.009, 0.018, 0.005])))),
  },
  {
    id: 'au07_lid_tightener_r',
    au: 'AU07',
    label: 'Lid Tightener R',
    group: 'Eyes',
    side: 'R',
    bones: rightOnly(combine(lidTightenLeft, assign(cheekLeft, move([0.009, 0.018, 0.005])))),
  },
  // Glare — split L/R
  {
    id: 'glare_l',
    au: 'CTRL',
    label: 'Glare L',
    group: 'Eyes',
    side: 'L',
    bones: leftOnly(combine(
      lidTightenLeft,
      assign(browInnerLeft, move([-0.009, -0.025, 0.001])),
      assign(browMidLeft, move([-0.006, -0.019, 0])),
      assign(cheekLeft, move([0.005, 0.011, 0.002])),
    )),
  },
  {
    id: 'glare_r',
    au: 'CTRL',
    label: 'Glare R',
    group: 'Eyes',
    side: 'R',
    bones: rightOnly(combine(
      lidTightenLeft,
      assign(browInnerLeft, move([-0.009, -0.025, 0.001])),
      assign(browMidLeft, move([-0.006, -0.019, 0])),
      assign(cheekLeft, move([0.005, 0.011, 0.002])),
    )),
  },
  {
    id: 'au09_nose_wrinkler',
    au: 'AU09',
    label: 'Nose Wrinkler',
    group: 'Midface',
    side: 'B',
    bones: combine(
      assign(noseCenter, move([0, 0.03, -0.01])),
      leftRight(
        combine(
          assign(noseLeft, move([0.021, 0.044, -0.009])),
          assign(cheekLeft, move([0.017, 0.036, 0.007])),
          assign(lidBottomLeft, move([0, 0.014, 0.001])),
        ),
      ),
    ),
  },
  {
    id: 'au38_nostril_dilator',
    au: 'AU38',
    label: 'Nostril Dilator',
    group: 'Midface',
    side: 'B',
    bones: combine(
      assign(noseCenter, move([0, -0.006, 0.003])),
      leftRight(
        combine(
          assign(noseLeft, move([0.026, -0.006, 0.009])),
          assign(['cheek.B.L', 'cheek.T.L.001'], move([0.009, -0.006, 0.004])),
        ),
      ),
    ),
  },
  {
    id: 'au10_upper_lip_raiser_l',
    au: 'AU10',
    label: 'Upper Lip Raiser L',
    group: 'Mouth',
    side: 'L',
    bones: combine(
      {
        'lip.T.L': move([0.011, 0.04, 0.009]),
        'lip.T.L.001': move([0.028, 0.057, 0.013]),
        'lip.B.L': move([0.008, 0.018, -0.003]),
      },
      assign(noseLeft, move([0.011, 0.023, -0.004])),
      assign(['cheek.B.L', 'cheek.T.L'], move([0.018, 0.035, 0.01])),
    ),
  },
  {
    id: 'au10_upper_lip_raiser_r',
    au: 'AU10',
    label: 'Upper Lip Raiser R',
    group: 'Mouth',
    side: 'R',
    bones: mirrorMap({
      'lip.T.L': move([0.011, 0.04, 0.009]),
      'lip.T.L.001': move([0.028, 0.057, 0.013]),
      'lip.B.L': move([0.008, 0.018, -0.003]),
      'nose.L': move([0.011, 0.023, -0.004]),
      'nose.L.001': move([0.011, 0.023, -0.004]),
      'cheek.B.L': move([0.018, 0.035, 0.01]),
      'cheek.T.L': move([0.018, 0.035, 0.01]),
    }),
  },
  {
    id: 'au12_lip_corner_puller_l',
    au: 'AU12',
    label: 'Lip Corner Puller L',
    group: 'Mouth',
    side: 'L',
    bones: combine(
      {
        'lip.T.L': move([0.009, 0.012, 0.005]),
        'lip.T.L.001': move([0.041, 0.037, 0.013]),
        'lip.B.L': move([0.007, 0.01, 0.004]),
        'lip.B.L.001': move([0.036, 0.031, 0.011]),
      },
      assign(cheekLeft, move([0.026, 0.048, 0.016])),
      assign(lidBottomLeft, move([0, 0.017, 0.001])),
    ),
  },
  {
    id: 'au12_lip_corner_puller_r',
    au: 'AU12',
    label: 'Lip Corner Puller R',
    group: 'Mouth',
    side: 'R',
    bones: mirrorMap({
      'lip.T.L': move([0.009, 0.012, 0.005]),
      'lip.T.L.001': move([0.041, 0.037, 0.013]),
      'lip.B.L': move([0.007, 0.01, 0.004]),
      'lip.B.L.001': move([0.036, 0.031, 0.011]),
      'cheek.B.L': move([0.026, 0.048, 0.016]),
      'cheek.B.L.001': move([0.026, 0.048, 0.016]),
      'cheek.T.L': move([0.026, 0.048, 0.016]),
      'cheek.T.L.001': move([0.026, 0.048, 0.016]),
      'lid.B.L': move([0, 0.017, 0.001]),
      'lid.B.L.001': move([0, 0.017, 0.001]),
      'lid.B.L.002': move([0, 0.017, 0.001]),
      'lid.B.L.003': move([0, 0.017, 0.001]),
    }),
  },
  {
    id: 'au14_dimpler_l',
    au: 'AU14',
    label: 'Dimpler L',
    group: 'Mouth',
    side: 'L',
    bones: leftOnly({
      'lip.T.L.001': move([0.022, -0.006, -0.009]),
      'lip.B.L.001': move([0.026, -0.006, -0.009]),
      'cheek.B.L': move([0.014, 0.012, -0.006]),
      'cheek.T.L': move([0.011, 0.013, -0.006]),
    }),
  },
  {
    id: 'au14_dimpler_r',
    au: 'AU14',
    label: 'Dimpler R',
    group: 'Mouth',
    side: 'R',
    bones: rightOnly({
      'lip.T.L.001': move([0.022, -0.006, -0.009]),
      'lip.B.L.001': move([0.026, -0.006, -0.009]),
      'cheek.B.L': move([0.014, 0.012, -0.006]),
      'cheek.T.L': move([0.011, 0.013, -0.006]),
    }),
  },
  {
    id: 'au15_lip_corner_depressor_l',
    au: 'AU15',
    label: 'Corner Depressor L',
    group: 'Mouth',
    side: 'L',
    bones: combine(
      {
        'lip.T.L.001': move([-0.023, -0.017, -0.008]),
        'lip.B.L.001': move([-0.03, -0.039, -0.007]),
        'lip.B.L': move([-0.007, -0.017, -0.004]),
      },
      assign(['chin.L', 'chin.001'], move([-0.006, -0.017, -0.003])),
    ),
  },
  {
    id: 'au15_lip_corner_depressor_r',
    au: 'AU15',
    label: 'Corner Depressor R',
    group: 'Mouth',
    side: 'R',
    bones: mirrorMap({
      'lip.T.L.001': move([-0.023, -0.017, -0.008]),
      'lip.B.L.001': move([-0.03, -0.039, -0.007]),
      'lip.B.L': move([-0.007, -0.017, -0.004]),
      'chin.L': move([-0.006, -0.017, -0.003]),
      'chin.001': move([-0.006, -0.017, -0.003]),
    }),
  },
  {
    id: 'au17_chin_raiser',
    au: 'AU17',
    label: 'Chin Raiser',
    group: 'Mouth',
    side: 'C',
    bones: combine(
      assign(chin, move([0, 0.032, 0.005])),
      {
        'lip.B.L': move([0.006, 0.019, 0.005]),
        'lip.B.R': move([-0.006, 0.019, 0.005]),
        'lip.B.L.001': move([0.014, 0.022, 0.006]),
        'lip.B.R.001': move([-0.014, 0.022, 0.006]),
      },
    ),
  },
  {
    id: 'au16_lower_lip_depressor_l',
    au: 'AU16',
    label: 'Lower Lip Depressor L',
    group: 'Mouth',
    side: 'L',
    bones: leftOnly({
      'lip.B.L': move([0.005, -0.026, 0.005]),
      'lip.B.L.001': move([0.015, -0.041, 0.006]),
      'chin.L': move([0.006, -0.015, 0.001]),
      'chin.001': move([0, -0.012, 0.001]),
    }),
  },
  {
    id: 'au16_lower_lip_depressor_r',
    au: 'AU16',
    label: 'Lower Lip Depressor R',
    group: 'Mouth',
    side: 'R',
    bones: rightOnly({
      'lip.B.L': move([0.005, -0.026, 0.005]),
      'lip.B.L.001': move([0.015, -0.041, 0.006]),
      'chin.L': move([0.006, -0.015, 0.001]),
      'chin.001': move([0, -0.012, 0.001]),
    }),
  },
  {
    id: 'au18_lip_pucker',
    au: 'AU18',
    label: 'Lip Pucker',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.T.L': move([0.004, 0.006, 0.015]),
      'lip.T.R': move([-0.004, 0.006, 0.015]),
      'lip.T.L.001': move([-0.015, 0.002, 0.018]),
      'lip.T.R.001': move([0.015, 0.002, 0.018]),
      'lip.B.L': move([0.004, -0.004, 0.016]),
      'lip.B.R': move([-0.004, -0.004, 0.016]),
      'lip.B.L.001': move([-0.016, -0.003, 0.019]),
      'lip.B.R.001': move([0.016, -0.003, 0.019]),
      chin: move([0, 0.006, 0.003]),
    },
  },
  {
    id: 'au20_lip_stretcher_l',
    au: 'AU20',
    label: 'Lip Stretcher L',
    group: 'Mouth',
    side: 'L',
    bones: leftOnly({
      'lip.T.L': move([0.012, -0.005, -0.007]),
      'lip.T.L.001': move([0.048, -0.017, -0.015]),
      'lip.B.L': move([0.012, -0.013, -0.002]),
      'lip.B.L.001': move([0.045, -0.022, -0.013]),
      'cheek.B.L': move([0.018, -0.019, -0.009]),
    }),
  },
  {
    id: 'au20_lip_stretcher_r',
    au: 'AU20',
    label: 'Lip Stretcher R',
    group: 'Mouth',
    side: 'R',
    bones: rightOnly({
      'lip.T.L': move([0.012, -0.005, -0.007]),
      'lip.T.L.001': move([0.048, -0.017, -0.015]),
      'lip.B.L': move([0.012, -0.013, -0.002]),
      'lip.B.L.001': move([0.045, -0.022, -0.013]),
      'cheek.B.L': move([0.018, -0.019, -0.009]),
    }),
  },
  {
    id: 'au23_lip_tightener',
    au: 'AU23',
    label: 'Lip Tightener',
    group: 'Mouth',
    side: 'B',
    bones: leftRight({
      'lip.T.L': move([0.01, -0.011, -0.009]),
      'lip.T.L.001': move([0.026, -0.017, -0.013]),
      'lip.B.L': move([0.01, 0.012, -0.009]),
      'lip.B.L.001': move([0.026, 0.014, -0.013]),
    }),
  },
  {
    id: 'au24_lip_pressor',
    au: 'AU24',
    label: 'Lip Pressor',
    group: 'Mouth',
    side: 'B',
    bones: leftRight({
      'lip.T.L': move([0.003, -0.012, -0.009]),
      'lip.T.L.001': move([0.014, -0.016, -0.014]),
      'lip.B.L': move([0.003, 0.015, -0.009]),
      'lip.B.L.001': move([0.015, 0.019, -0.014]),
      chin: move([0, 0.01, -0.003]),
      'chin.001': move([0, 0.012, -0.004]),
    }),
  },
  {
    id: 'au25_lips_part',
    au: 'AU25',
    label: 'Lips Part',
    group: 'Jaw',
    side: 'C',
    bones: {
      'lip.T.L': move([0, 0.014, 0.004]),
      'lip.T.R': move([0, 0.014, 0.004]),
      'lip.T.L.001': move([0, 0.008, 0.004]),
      'lip.T.R.001': move([0, 0.008, 0.004]),
      'lip.B.L': move([0, -0.023, 0.005]),
      'lip.B.R': move([0, -0.023, 0.005]),
      'lip.B.L.001': move([0, -0.019, 0.005]),
      'lip.B.R.001': move([0, -0.019, 0.005]),
      jaw: move([0, -0.009, -0.003]),
      jaw_master: move([0, -0.005, -0.002]),
      chin: move([0, -0.018, -0.001]),
      'chin.001': move([0, -0.015, -0.001]),
    },
  },
  {
    id: 'au26_jaw_drop',
    au: 'AU26',
    label: 'Jaw Drop',
    group: 'Jaw',
    side: 'C',
    bones: combine(
      {
        jaw: move([0, -0.024, -0.007]),
        jaw_master: move([0, -0.013, -0.005]),
        'jaw.L': move([0.004, -0.017, -0.005]),
        'jaw.R': move([-0.004, -0.017, -0.005]),
        'jaw.L.001': move([0.003, -0.028, -0.007]),
        'jaw.R.001': move([-0.003, -0.028, -0.007]),
        'lip.B.L': move([0.003, -0.052, 0.006]),
        'lip.B.R': move([-0.003, -0.052, 0.006]),
        'lip.B.L.001': move([0.003, -0.042, 0.007]),
        'lip.B.R.001': move([-0.003, -0.042, 0.007]),
        'lip.T.L': move([0.003, 0.017, 0.004]),
        'lip.T.R': move([-0.003, 0.017, 0.004]),
      },
      assign(chin, move([0, -0.044, -0.005])),
    ),
  },
  {
    id: 'au27_mouth_stretch',
    au: 'AU27',
    label: 'Mouth Stretch',
    group: 'Jaw',
    side: 'C',
    bones: {
      jaw: move([0, -0.03, -0.009]),
      jaw_master: move([0, -0.016, -0.006]),
      'jaw.L': move([0.005, -0.022, -0.006]),
      'jaw.R': move([-0.005, -0.022, -0.006]),
      'jaw.L.001': move([0.005, -0.035, -0.009]),
      'jaw.R.001': move([-0.005, -0.035, -0.009]),
      'lip.T.L': move([0.009, 0.026, 0.006]),
      'lip.T.R': move([-0.009, 0.026, 0.006]),
      'lip.T.L.001': move([0.013, 0.017, 0.007]),
      'lip.T.R.001': move([-0.013, 0.017, 0.007]),
      'lip.B.L': move([0.009, -0.064, 0.008]),
      'lip.B.R': move([-0.009, -0.064, 0.008]),
      'lip.B.L.001': move([0.012, -0.052, 0.009]),
      'lip.B.R.001': move([-0.012, -0.052, 0.009]),
      chin: move([0, -0.056, -0.007]),
      'chin.001': move([0, -0.05, -0.006]),
      'chin.L': move([0.009, -0.047, -0.006]),
      'chin.R': move([-0.009, -0.047, -0.006]),
    },
  },
  {
    id: 'au43_eye_closure_l',
    au: 'AU43',
    label: 'Eye Closure L',
    group: 'Eyes',
    side: 'L',
    bones: leftOnly(combine(eyeClosureLeft, assign(cheekLeft, move([0.004, 0.009, 0.002])))),
  },
  {
    id: 'au43_eye_closure_r',
    au: 'AU43',
    label: 'Eye Closure R',
    group: 'Eyes',
    side: 'R',
    bones: rightOnly(combine(eyeClosureLeft, assign(cheekLeft, move([0.004, 0.009, 0.002])))),
  },
  {
    id: 'jaw_forward',
    au: 'CTRL',
    label: 'Jaw Forward',
    group: 'Jaw',
    side: 'C',
    bones: combine(
      {
        jaw: move([0, -0.002, 0.025]),
        jaw_master: move([0, 0, 0.016]),
        'jaw.L': move([0, -0.001, 0.017]),
        'jaw.R': move([0, -0.001, 0.017]),
        'jaw.L.001': move([0, -0.002, 0.021]),
        'jaw.R.001': move([0, -0.002, 0.021]),
      },
      assign(chin, move([0, -0.002, 0.02])),
    ),
  },
  {
    id: 'jaw_left',
    au: 'CTRL',
    label: 'Jaw Left',
    group: 'Jaw',
    side: 'C',
    bones: combine(
      {
        jaw: move([0.019, 0, 0]),
        jaw_master: move([0.013, 0, 0]),
        'jaw.L': move([0.018, 0, 0]),
        'jaw.R': move([0.015, 0, 0]),
        'jaw.L.001': move([0.021, 0, 0]),
        'jaw.R.001': move([0.017, 0, 0]),
      },
      assign(chin, move([0.018, 0, 0])),
    ),
  },
  {
    id: 'jaw_right',
    au: 'CTRL',
    label: 'Jaw Right',
    group: 'Jaw',
    side: 'C',
    bones: combine(
      {
        jaw: move([-0.019, 0, 0]),
        jaw_master: move([-0.013, 0, 0]),
        'jaw.L': move([-0.015, 0, 0]),
        'jaw.R': move([-0.018, 0, 0]),
        'jaw.L.001': move([-0.017, 0, 0]),
        'jaw.R.001': move([-0.021, 0, 0]),
      },
      assign(chin, move([-0.018, 0, 0])),
    ),
  },
  {
    id: 'scowl',
    au: 'CTRL',
    label: 'Scowl',
    group: 'Performance',
    side: 'B',
    bones: combine(
      leftRight(
        combine(
          assign(browInnerLeft, move([-0.02, -0.046, 0.003])),
          assign(browMidLeft, move([-0.013, -0.028, 0])),
          assign(browOuterLeft, move([0.006, -0.015, 0])),
          lidTightenLeft,
          assign(cheekLeft, move([0.005, 0.008, 0.001])),
        ),
      ),
      {
        'lip.T.L': move([-0.003, -0.009, -0.003]),
        'lip.T.R': move([0.003, -0.009, -0.003]),
        'lip.B.L': move([-0.004, 0.006, -0.004]),
        'lip.B.R': move([0.004, 0.006, -0.004]),
        chin: move([0, 0.01, -0.003]),
        'chin.001': move([0, 0.009, -0.003]),
      },
    ),
  },
  {
    id: 'snarl_l',
    au: 'CTRL',
    label: 'Snarl L',
    group: 'Performance',
    side: 'L',
    bones: combine(
      {
        'lip.T.L': move([0.012, 0.038, 0.009]),
        'lip.T.L.001': move([0.031, 0.057, 0.012]),
        'lip.B.L': move([0.006, 0.009, -0.004]),
        'lip.B.L.001': move([0.014, -0.013, -0.007]),
      },
      assign(noseLeft, move([0.017, 0.03, -0.005])),
      assign(['cheek.B.L', 'cheek.T.L'], move([0.018, 0.033, 0.007])),
      assign(['lid.B.L.001', 'lid.B.L.002'], move([0, 0.007, 0])),
    ),
  },
  {
    id: 'snarl_r',
    au: 'CTRL',
    label: 'Snarl R',
    group: 'Performance',
    side: 'R',
    bones: mirrorMap({
      'lip.T.L': move([0.012, 0.038, 0.009]),
      'lip.T.L.001': move([0.031, 0.057, 0.012]),
      'lip.B.L': move([0.006, 0.009, -0.004]),
      'lip.B.L.001': move([0.014, -0.013, -0.007]),
      'nose.L': move([0.017, 0.03, -0.005]),
      'nose.L.001': move([0.017, 0.03, -0.005]),
      'cheek.B.L': move([0.018, 0.033, 0.007]),
      'cheek.T.L': move([0.018, 0.033, 0.007]),
      'lid.B.L.001': move([0, 0.007, 0]),
      'lid.B.L.002': move([0, 0.007, 0]),
    }),
  },
  {
    id: 'tongue_out',
    au: 'CTRL',
    label: 'Tongue Out',
    group: 'Mouth',
    side: 'C',
    bones: { tongue: move([0, 0, 0.04]) },
  },
  {
    id: 'cheek_puff',
    au: 'AU33',
    label: 'Cheek Puff',
    group: 'Midface',
    side: 'B',
    bones: combine(
      assign(['cheek.B.L', 'cheek.B.L.001', 'cheek.T.L', 'cheek.T.L.001'], move([0.02, 0.01, 0.015])),
      assign(['cheek.B.R', 'cheek.B.R.001', 'cheek.T.R', 'cheek.T.R.001'], move([-0.02, 0.01, 0.015])),
    ),
  },
  {
    id: 'mouth_funnel',
    au: 'CTRL',
    label: 'Mouth Funnel',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.T.L': move([0.006, 0.01, 0.012]),
      'lip.T.R': move([-0.006, 0.01, 0.012]),
      'lip.T.L.001': move([-0.018, 0.006, 0.014]),
      'lip.T.R.001': move([0.018, 0.006, 0.014]),
      'lip.B.L': move([0.006, -0.01, 0.012]),
      'lip.B.R': move([-0.006, -0.01, 0.012]),
      'lip.B.L.001': move([-0.018, -0.006, 0.014]),
      'lip.B.R.001': move([0.018, -0.006, 0.014]),
    },
  },
  {
    id: 'mouth_suck',
    au: 'CTRL',
    label: 'Mouth Suck',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.T.L': move([0.004, -0.004, -0.014]),
      'lip.T.R': move([-0.004, -0.004, -0.014]),
      'lip.T.L.001': move([-0.01, -0.002, -0.016]),
      'lip.T.R.001': move([0.01, -0.002, -0.016]),
      'lip.B.L': move([0.004, 0.004, -0.014]),
      'lip.B.R': move([-0.004, 0.004, -0.014]),
      'lip.B.L.001': move([-0.01, 0.002, -0.016]),
      'lip.B.R.001': move([0.01, 0.002, -0.016]),
    },
  },
  {
    id: 'lips_bite',
    au: 'CTRL',
    label: 'Lips Bite',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.B.L': move([0.003, 0.018, -0.01]),
      'lip.B.R': move([-0.003, 0.018, -0.01]),
      'lip.B.L.001': move([0.006, 0.022, -0.014]),
      'lip.B.R.001': move([-0.006, 0.022, -0.014]),
    },
  },
  {
    id: 'lip_roll_lower',
    au: 'CTRL',
    label: 'Roll Lower',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.B.L': move([0.002, 0.012, -0.008]),
      'lip.B.R': move([-0.002, 0.012, -0.008]),
      'lip.B.L.001': move([0.004, 0.014, -0.012]),
      'lip.B.R.001': move([-0.004, 0.014, -0.012]),
    },
  },
  {
    id: 'lip_roll_upper',
    au: 'CTRL',
    label: 'Roll Upper',
    group: 'Mouth',
    side: 'C',
    bones: {
      'lip.T.L': move([0.002, -0.012, -0.008]),
      'lip.T.R': move([-0.002, -0.012, -0.008]),
      'lip.T.L.001': move([0.004, -0.014, -0.012]),
      'lip.T.R.001': move([-0.004, -0.014, -0.012]),
    },
  },
]

export const FACS_CONTROLS = controls
export const FACS_GROUPS: FacsGroup[] = ['Brows', 'Eyes', 'Midface', 'Mouth', 'Jaw', 'Performance']

export const createNeutralFacsValues = (): FacsValues =>
  Object.fromEntries(FACS_CONTROLS.map((control) => [control.id, 0]))

export const createFacsPresetValues = (values: Partial<FacsValues>): FacsValues => {
  const next = createNeutralFacsValues()
  for (const [id, value] of Object.entries(values)) {
    if (typeof value === 'number') next[id] = value
  }
  return next
}

export const FACS_PRESETS: FacsPreset[] = [
  {
    id: 'happy',
    label: 'Happy',
    values: {
      au06_cheek_raiser_l: 2.2, au06_cheek_raiser_r: 2.2,
      au07_lid_tightener_l: 0.8, au07_lid_tightener_r: 0.8,
      au12_lip_corner_puller_l: 2.6, au12_lip_corner_puller_r: 2.6,
    },
  },
  {
    id: 'angry',
    label: 'Angry',
    values: {
      au04_brow_lowerer_l: 2.4, au04_brow_lowerer_r: 2.4,
      brow_compress: 2.0,
      glare_l: 1.6, glare_r: 1.6,
      scowl: 1.8,
      au23_lip_tightener: 0.4,
      au38_nostril_dilator: 1.0,
    },
  },
  {
    id: 'sad',
    label: 'Sad',
    values: {
      au01_inner_brow_raiser_l: 1.8, au01_inner_brow_raiser_r: 1.8,
      au04_brow_lowerer_l: 0.6, au04_brow_lowerer_r: 0.6,
      au15_lip_corner_depressor_l: 1.6, au15_lip_corner_depressor_r: 1.6,
      au17_chin_raiser: 0.8,
      au43_eye_closure_l: 0.4, au43_eye_closure_r: 0.4,
    },
  },
  {
    id: 'surprise',
    label: 'Surprise',
    values: {
      au01_inner_brow_raiser_l: 2.0, au01_inner_brow_raiser_r: 2.0,
      au02_outer_brow_raiser_l: 2.2, au02_outer_brow_raiser_r: 2.2,
      au05_upper_lid_raiser_l: 2.0, au05_upper_lid_raiser_r: 2.0,
      au25_lips_part: 1.2,
      au26_jaw_drop: 1.8,
    },
  },
  {
    id: 'fear',
    label: 'Fear',
    values: {
      au01_inner_brow_raiser_l: 2.2, au01_inner_brow_raiser_r: 2.2,
      au02_outer_brow_raiser_l: 1.4, au02_outer_brow_raiser_r: 1.4,
      au04_brow_lowerer_l: 0.5, au04_brow_lowerer_r: 0.5,
      au05_upper_lid_raiser_l: 1.8, au05_upper_lid_raiser_r: 1.8,
      au20_lip_stretcher_l: 1.4, au20_lip_stretcher_r: 1.4,
      au25_lips_part: 1.0,
      au26_jaw_drop: 0.8,
    },
  },
  {
    id: 'disgust',
    label: 'Disgust',
    values: {
      au09_nose_wrinkler: 1.8,
      au10_upper_lip_raiser_l: 1.4, au10_upper_lip_raiser_r: 0.8,
      snarl_l: 1.4,
      au04_brow_lowerer_l: 0.8, au04_brow_lowerer_r: 0.8,
      au15_lip_corner_depressor_r: 0.9,
    },
  },
  {
    id: 'snarl',
    label: 'Snarl',
    values: {
      scowl: 1.4,
      glare_l: 1.2, glare_r: 1.2,
      au09_nose_wrinkler: 1.4,
      snarl_l: 2.0,
      au24_lip_pressor: 0.6,
      au26_jaw_drop: 0.5,
    },
  },
]

const addTuple = (
  current: [number, number, number] | undefined,
  next: [number, number, number],
  weight: number,
): [number, number, number] => [
  (current?.[0] ?? 0) + next[0] * weight,
  (current?.[1] ?? 0) + next[1] * weight,
  (current?.[2] ?? 0) + next[2] * weight,
]

const addPose = (target: BonePose, source: BonePose, weight: number) => {
  if (source.position) {
    target.position = addTuple(target.position, source.position, weight)
  }
  if (source.worldPosition) {
    target.worldPosition = addTuple(target.worldPosition, source.worldPosition, weight)
  }
  if (source.rotation) {
    target.rotation = addTuple(target.rotation, source.rotation, weight)
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const saturate = (value: number) => clamp(value, 0, 1)

const getControlResponse = (values: FacsValues, controlId: string) => {
  const control = FACS_CONTROLS.find((item) => item.id === controlId)
  const max = control?.max ?? FACS_VALUE_MAX
  const value = clamp(values[controlId] ?? 0, 0, max)
  // Linear 0→1 over the authored range. No overdrive needed since we've calibrated bone values.
  return value / FACS_AUTHORED_VALUE
}

const addDentalFollow = (pose: PoseMap, values: FacsValues) => {
  const lipsPart = getControlResponse(values, 'au25_lips_part')
  const jawDrop = getControlResponse(values, 'au26_jaw_drop')
  const mouthStretch = getControlResponse(values, 'au27_mouth_stretch')
  const lowerLipDepressor = Math.max(getControlResponse(values, 'au16_lower_lip_depressor_l'), getControlResponse(values, 'au16_lower_lip_depressor_r'))
  const upperLipRaise = Math.max(
    getControlResponse(values, 'au10_upper_lip_raiser_l'),
    getControlResponse(values, 'au10_upper_lip_raiser_r'),
    getControlResponse(values, 'snarl_l'),
    getControlResponse(values, 'snarl_r'),
  )
  const smile = Math.max(
    getControlResponse(values, 'au12_lip_corner_puller_l'),
    getControlResponse(values, 'au12_lip_corner_puller_r'),
  )
  const cornerDepress = Math.max(
    getControlResponse(values, 'au15_lip_corner_depressor_l'),
    getControlResponse(values, 'au15_lip_corner_depressor_r'),
  )
  const jawForward = getControlResponse(values, 'jaw_forward')
  const jawLeft = getControlResponse(values, 'jaw_left')
  const jawRight = getControlResponse(values, 'jaw_right')
  const jawSide = jawLeft - jawRight
  const jawOpen = clamp(lipsPart * 0.35 + jawDrop * 0.8 + mouthStretch, 0, 2)
  const upperReveal = clamp(upperLipRaise * 0.75 + smile * 0.18 + jawOpen * 0.22, 0, 2)
  const lowerReveal = clamp(lowerLipDepressor * 0.45 + cornerDepress * 0.22 + jawOpen * 0.85, 0, 2)

  if (upperReveal > 0.001 || jawOpen > 0.001) {
    pose['teeth.T'] ??= {}
    addPose(
      pose['teeth.T'],
      move([
        jawSide * 0.002,
        upperReveal * 0.011 + jawOpen * 0.005,
        upperReveal * -0.003 + jawForward * 0.003,
      ]),
      1,
    )
  }

  if (lowerReveal > 0.001 || jawOpen > 0.001 || jawForward > 0.001 || Math.abs(jawSide) > 0.001) {
    pose['teeth.B'] ??= {}
    addPose(
      pose['teeth.B'],
      move([
        jawSide * 0.014,
        lowerReveal * -0.026,
        jawForward * 0.012 - jawOpen * 0.005,
      ]),
      1,
    )
  }
}

export function buildFacsMorphs(values: FacsValues): MorphPose {
  const r = (id: string) => getControlResponse(values, id)

  const browDownL = Math.max(r('au04_brow_lowerer_l'), r('brow_compress') * 0.88, r('glare_l') * 0.74, r('scowl'))
  const browDownR = Math.max(r('au04_brow_lowerer_r'), r('brow_compress') * 0.88, r('glare_r') * 0.74, r('scowl'))
  const browInnerUpL = r('au01_inner_brow_raiser_l')
  const browInnerUpR = r('au01_inner_brow_raiser_r')
  const browOuterUpL = r('au02_outer_brow_raiser_l')
  const browOuterUpR = r('au02_outer_brow_raiser_r')
  const eyeBlinkL = r('au43_eye_closure_l')
  const eyeBlinkR = r('au43_eye_closure_r')
  const eyeSquintL = Math.max(r('au07_lid_tightener_l'), r('glare_l') * 0.82, r('scowl') * 0.54, r('au06_cheek_raiser_l') * 0.41)
  const eyeSquintR = Math.max(r('au07_lid_tightener_r'), r('glare_r') * 0.82, r('scowl') * 0.54, r('au06_cheek_raiser_r') * 0.41)
  const eyeWideL = r('au05_upper_lid_raiser_l')
  const eyeWideR = r('au05_upper_lid_raiser_r')
  const jawOpen = saturate(r('au25_lips_part') * 0.24 + r('au26_jaw_drop') * 0.68 + r('au27_mouth_stretch') * 0.92)
  const jawForward = saturate(r('jaw_forward'))
  const jawLR = clamp(r('jaw_left') - r('jaw_right'), -1, 1)

  const smileL = r('au12_lip_corner_puller_l')
  const smileR = r('au12_lip_corner_puller_r')
  const frownL = r('au15_lip_corner_depressor_l')
  const frownR = r('au15_lip_corner_depressor_r')
  const upperUpL = Math.max(r('au10_upper_lip_raiser_l'), r('snarl_l') * 0.88)
  const upperUpR = Math.max(r('au10_upper_lip_raiser_r'), r('snarl_r') * 0.88)
  const lowerDownL = r('au16_lower_lip_depressor_l')
  const lowerDownR = r('au16_lower_lip_depressor_r')
  const pucker = r('au18_lip_pucker')
  const funnel = saturate(Math.max(r('mouth_funnel'), r('au18_lip_pucker') * 0.55))
  const stretchL = r('au20_lip_stretcher_l')
  const stretchR = r('au20_lip_stretcher_r')
  const press = r('au24_lip_pressor')
  const dimpleL = r('au14_dimpler_l')
  const dimpleR = r('au14_dimpler_r')
  const rollLower = saturate(r('au24_lip_pressor') * 0.5 + r('au23_lip_tightener') * 0.4 + r('lip_roll_lower') + r('lips_bite') * 0.7)
  const rollUpper = saturate(r('au24_lip_pressor') * 0.5 + r('au23_lip_tightener') * 0.4 + r('lip_roll_upper'))
  const shrugLower = saturate(r('au17_chin_raiser') * 0.6 + r('mouth_suck') * 0.5)
  const noseSneerL = Math.max(r('au09_nose_wrinkler'), r('snarl_l') * 0.72)
  const noseSneerR = Math.max(r('au09_nose_wrinkler'), r('snarl_r') * 0.72)
  const cheekSquintL = Math.max(r('au06_cheek_raiser_l'), r('au12_lip_corner_puller_l') * 0.44)
  const cheekSquintR = Math.max(r('au06_cheek_raiser_r'), r('au12_lip_corner_puller_r') * 0.44)
  const cheekPuff = saturate(Math.max(r('cheek_puff'), r('au18_lip_pucker') * 0.25))
  const mouthClose = saturate(r('au24_lip_pressor') * 0.45 + r('au23_lip_tightener') * 0.35 + r('tongue_out') * -0.3)
  const tongue = saturate(r('tongue_out'))
  const mouthLeft = saturate(jawLR > 0 ? jawLR * 0.5 : 0)
  const mouthRight = saturate(jawLR < 0 ? -jawLR * 0.5 : 0)

  return {
    browDownLeft: saturate(browDownL),
    browDownRight: saturate(browDownR),
    browInnerUp: saturate(Math.max(browInnerUpL, browInnerUpR)),
    browOuterUpLeft: saturate(browOuterUpL),
    browOuterUpRight: saturate(browOuterUpR),
    eyeBlinkLeft: saturate(eyeBlinkL),
    eyeBlinkRight: saturate(eyeBlinkR),
    eyeSquintLeft: saturate(eyeSquintL),
    eyeSquintRight: saturate(eyeSquintR),
    eyeWideLeft: saturate(eyeWideL),
    eyeWideRight: saturate(eyeWideR),
    jawForward: saturate(jawForward),
    jawLeft: saturate(mouthLeft),
    jawRight: saturate(mouthRight),
    jawOpen: saturate(jawOpen),
    mouthClose: saturate(mouthClose),
    mouthDimpleLeft: saturate(dimpleL),
    mouthDimpleRight: saturate(dimpleR),
    mouthFrownLeft: saturate(frownL),
    mouthFrownRight: saturate(frownR),
    mouthFunnel: saturate(funnel),
    mouthLeft: mouthLeft,
    mouthRight: mouthRight,
    mouthLowerDownLeft: saturate(lowerDownL),
    mouthLowerDownRight: saturate(lowerDownR),
    mouthPressLeft: saturate(press),
    mouthPressRight: saturate(press),
    mouthPucker: saturate(pucker),
    mouthRollLower: saturate(rollLower),
    mouthRollUpper: saturate(rollUpper),
    mouthShrugLower: saturate(shrugLower),
    mouthSmileLeft: saturate(smileL),
    mouthSmileRight: saturate(smileR),
    mouthStretchLeft: saturate(stretchL),
    mouthStretchRight: saturate(stretchR),
    moutherUpperUpLeft: saturate(upperUpL),
    mouthUpperUpRight: saturate(upperUpR),
    noseSneerLeft: saturate(noseSneerL),
    noseSneerRight: saturate(noseSneerR),
    cheekSquintLeft: saturate(cheekSquintL),
    cheekSquintRight: saturate(cheekSquintR),
    cheekPuff: saturate(cheekPuff),
    tongue: saturate(tongue),
  }
}

export function buildFacsPose(values: FacsValues): PoseMap {
  const pose: PoseMap = {}

  for (const control of FACS_CONTROLS) {
    const value = getControlResponse(values, control.id)
    if (value <= 0.001) continue

    for (const [boneName, bonePose] of Object.entries(control.bones)) {
      pose[boneName] ??= {}
      addPose(pose[boneName], bonePose, value)
    }
  }

  addDentalFollow(pose, values)

  return pose
}
