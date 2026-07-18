export type ModelingControl = {
  id: string
  label: string
  tab: string
  section: string
  negativeLabel: string
  positiveLabel: string
  negativeTarget: string | null
  positiveTarget: string
  min: number
  max: number
}

export type ModelingValues = Record<string, number>
export type ModelingMode = 'transform' | 'sculpt'
export type ModelingHandleSide = 'center' | 'left' | 'right'
export type ModelingHandleAxis = 'x' | 'y' | 'z'

export type ModelingHandle = {
  id: string
  controlId: string
  controlIds: string[]
  mode: ModelingMode
  label: string
  position: [number, number, number]
  axis: ModelingHandleAxis
  side: ModelingHandleSide
  mirrored: boolean
}

function makeControl(
  morphBase: string,
  negLabel: string,
  posLabel: string,
  overrides?: {
    label?: string
    tab?: string
    section?: string
    negativeTarget?: string | null
    positiveTarget?: string
    min?: number
    max?: number
  },
): ModelingControl {
  // morphBase: e.g. "id.skull.browRidge.depth"
  // derives tab, section, label from the dot-separated path
  const parts = morphBase.split('.')
  // parts[0] = "id", parts[1] = category, parts[2..n-1] = subsections, parts[n] = property
  const category = parts[1]
  const property = parts[parts.length - 1]
  const subsections = parts.slice(2, parts.length - 1)

  const tab = overrides?.tab ?? capitalize(category)
  const section = overrides?.section ?? (subsections.length > 0 ? camelToLabel(subsections[subsections.length - 1]) : capitalize(category))
  const label = overrides?.label ?? camelToLabel(property)
  const negativeTarget = overrides?.negativeTarget === undefined
    ? `${morphBase}.neg`
    : overrides.negativeTarget

  return {
    id: morphBase,
    label,
    tab,
    section,
    negativeLabel: negLabel,
    positiveLabel: posLabel,
    negativeTarget,
    positiveTarget: overrides?.positiveTarget ?? `${morphBase}.pos`,
    min: overrides?.min ?? (negativeTarget ? -1 : 0),
    max: overrides?.max ?? 1,
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function camelToLabel(s: string) {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()
}

export const MODELING_CONTROLS: ModelingControl[] = [
  // ── HEAD ──
  makeControl('id.head.width',  'Narrow', 'Wide'),
  makeControl('id.head.height', 'Short',  'Tall'),
  makeControl('id.head.depth',  'Flat',   'Deep'),
  makeControl('id.head.scale',  'Small',  'Large'),

  // ── BODY > Global ──
  makeControl('id.body.global.mass',   'Lean', 'Heavy', { tab: 'Body', section: 'Global', label: 'Mass' }),
  makeControl('id.body.global.muscle', 'Soft', 'Muscular', { tab: 'Body', section: 'Global', label: 'Muscle' }),
  makeControl('id.body.global.fat',    'Base', 'Fat', { tab: 'Body', section: 'Global', label: 'Fat', negativeTarget: null }),

  // ── SKULL > Braincase ──
  makeControl('id.skull.braincase.scale',      'Small',   'Large'),
  makeControl('id.skull.braincase.width',      'Narrow',  'Wide'),
  makeControl('id.skull.braincase.depth',      'Flat',    'Deep'),
  makeControl('id.skull.braincase.height',     'Low',     'High'),
  makeControl('id.skull.braincase.backDepth',  'Flat',    'Deep'),
  makeControl('id.skull.braincase.backHeight', 'Low',     'High'),
  makeControl('id.skull.braincase.topWidth',   'Narrow',  'Wide'),
  makeControl('id.skull.braincase.sideVolume', 'Thin',    'Full'),
  makeControl('id.skull.braincase.roundness',  'Angular', 'Round'),

  // ── SKULL > Forehead ──
  makeControl('id.skull.forehead.width',       'Narrow', 'Wide'),
  makeControl('id.skull.forehead.height',      'Low',    'High'),
  makeControl('id.skull.forehead.depth',       'Flat',   'Deep'),
  makeControl('id.skull.forehead.slope',       'Upright','Sloped'),
  makeControl('id.skull.forehead.lowerVolume', 'Thin',   'Full'),
  makeControl('id.skull.forehead.upperVolume', 'Thin',   'Full'),

  // ── SKULL > Brow Ridge ──
  makeControl('id.skull.browRidge.width',      'Narrow', 'Wide'),
  makeControl('id.skull.browRidge.height',     'Low',    'High'),
  makeControl('id.skull.browRidge.depth',      'Flat',   'Prominent'),
  makeControl('id.skull.browRidge.innerDepth', 'Flat',   'Prominent'),
  makeControl('id.skull.browRidge.outerDepth', 'Flat',   'Prominent'),

  // ── SKULL > Cheekbone ──
  makeControl('id.skull.cheekbone.width',      'Narrow',  'Wide'),
  makeControl('id.skull.cheekbone.height',     'Low',     'High'),
  makeControl('id.skull.cheekbone.angularity', 'Rounded', 'Angular'),

  // ── SKULL > Temple ──
  makeControl('id.skull.temple.width', 'Narrow', 'Wide'),

  // ── SKULL > Eye socket ──
  makeControl('id.skull.eye.spacing',       'Close',    'Wide'),
  makeControl('id.skull.eye.width',         'Narrow',   'Wide'),
  makeControl('id.skull.eye.height',        'Low',      'High'),
  makeControl('id.skull.eye.depth',         'Shallow',  'Deep'),
  makeControl('id.skull.eye.tilt',          'Down',     'Up'),
  makeControl('id.skull.eye.angularity',    'Rounded',  'Angular'),
  makeControl('id.skull.eye.upperRimDepth', 'Flat',     'Prominent'),
  makeControl('id.skull.eye.upperRimHeight','Low',      'High'),
  makeControl('id.skull.eye.lowerRimDepth', 'Flat',     'Prominent'),
  makeControl('id.skull.eye.lowerRimHeight','Low',      'High'),

  // ── SKULL > Upper Jaw ──
  makeControl('id.skull.upperJaw.width',    'Narrow',   'Wide'),
  makeControl('id.skull.upperJaw.height',   'Low',      'High'),
  makeControl('id.skull.upperJaw.depth',    'Recessed', 'Forward'),
  makeControl('id.skull.upperJaw.roundness','Angular',  'Round'),

  // ── SKULL > Lower Jaw ──
  makeControl('id.skull.lowerJaw.width',      'Narrow',  'Wide'),
  makeControl('id.skull.lowerJaw.height',     'Low',     'High'),
  makeControl('id.skull.lowerJaw.depth',      'Back',    'Forward'),
  makeControl('id.skull.lowerJaw.roundedness','Angular', 'Round'),

  // ── SKULL > Chin ──
  makeControl('id.skull.chin.width',  'Narrow',   'Wide'),
  makeControl('id.skull.chin.height', 'Short',    'Tall'),
  makeControl('id.skull.chin.depth',  'Recessed', 'Prominent'),

  // ── NOSE > Bridge ──
  makeControl('id.nose.bridge.width',      'Narrow',  'Wide'),
  makeControl('id.nose.bridge.angularity', 'Rounded', 'Angular'),

  // ── NOSE > Nasal Bone ──
  makeControl('id.nose.nasalBone.width',     'Narrow',  'Wide'),
  makeControl('id.nose.nasalBone.height',    'Low',     'High'),
  makeControl('id.nose.nasalBone.depth',     'Flat',    'Prominent'),
  makeControl('id.nose.nasalBone.direction', 'Down',    'Up'),

  // ── NOSE > Upper Cartilage ──
  makeControl('id.nose.upperCartilage.width',     'Narrow', 'Wide'),
  makeControl('id.nose.upperCartilage.height',    'Short',  'Tall'),
  makeControl('id.nose.upperCartilage.depth',     'Flat',   'Deep'),
  makeControl('id.nose.upperCartilage.direction', 'Down',   'Up'),

  // ── NOSE > Lower Cartilage ──
  makeControl('id.nose.lowerCartilage.width',      'Narrow',  'Wide'),
  makeControl('id.nose.lowerCartilage.height',     'Low',     'High'),
  makeControl('id.nose.lowerCartilage.depth',      'Flat',    'Deep'),
  makeControl('id.nose.lowerCartilage.direction',  'Down',    'Up'),
  makeControl('id.nose.lowerCartilage.roundedness','Angular', 'Round'),

  // ── NOSE > Tip ──
  makeControl('id.nose.tip.direction',  'Down',    'Up'),
  makeControl('id.nose.tip.angularity', 'Rounded', 'Angular'),

  // ── NOSE > Nostril ──
  makeControl('id.nose.nostril.width',      'Narrow',  'Wide'),
  makeControl('id.nose.nostril.height',     'Low',     'High'),
  makeControl('id.nose.nostril.depth',      'Flat',    'Deep'),
  makeControl('id.nose.nostril.angularity', 'Rounded', 'Angular'),
  makeControl('id.nose.nostril.innerScale', 'Small',   'Large'),

  // ── MOUTH ──
  makeControl('id.mouth.width', 'Narrow', 'Wide'),

  // ── MOUTH > Philtrum ──
  makeControl('id.mouth.philtrum.width', 'Narrow', 'Wide'),
  makeControl('id.mouth.philtrum.depth', 'Flat',   'Deep'),

  // ── MOUTH > Upper Lip ──
  makeControl('id.mouth.upperLip.width',      'Narrow', 'Wide'),
  makeControl('id.mouth.upperLip.height',     'Low',    'High'),
  makeControl('id.mouth.upperLip.depth',      'Thin',   'Full'),
  makeControl('id.mouth.upperLip.roudnedness','Angular','Round'),

  // ── MOUTH > Lower Lip ──
  makeControl('id.mouth.lowerLip.width',  'Narrow', 'Wide'),
  makeControl('id.mouth.lowerLip.height', 'Low',    'High'),
  makeControl('id.mouth.lowerLip.depth',  'Thin',   'Full'),
]

// Fix: "id.nose.nasalBone.direction.neg.pos" is a bad target in the model - skip
const BAD_TARGETS = new Set(['id.nose.nasalBone.direction.neg.pos'])

export const MODELING_TABS = Array.from(
  new Set(MODELING_CONTROLS.map((c) => c.tab)),
)

const CONTROL_BY_ID = new Map(MODELING_CONTROLS.map((control) => [control.id, control]))

export function getModelingControlById(id: string | null | undefined) {
  return id ? CONTROL_BY_ID.get(id) ?? null : null
}

export function getControlsForTab(tab: string) {
  return MODELING_CONTROLS.filter((c) => c.tab === tab)
}

export function getSectionsForTab(tab: string) {
  return Array.from(new Set(getControlsForTab(tab).map((c) => c.section)))
}

export function createNeutralModelingValues(): ModelingValues {
  return Object.fromEntries(MODELING_CONTROLS.map((c) => [c.id, 0]))
}

export function clampModelingValue(controlId: string, value: number) {
  const control = getModelingControlById(controlId)
  return Math.max(control?.min ?? -1, Math.min(control?.max ?? 1, value))
}

export function buildModelingMorphs(values: ModelingValues): Record<string, number> {
  const morphs: Record<string, number> = {}

  for (const control of MODELING_CONTROLS) {
    const value = clampModelingValue(control.id, values[control.id] ?? 0)
    if (control.negativeTarget && !BAD_TARGETS.has(control.negativeTarget)) {
      morphs[control.negativeTarget] = value < 0 ? Math.abs(value) : 0
    }
    if (!BAD_TARGETS.has(control.positiveTarget)) {
      morphs[control.positiveTarget] = value > 0 ? value : 0
    }
  }

  return morphs
}

const TRANSFORM_HANDLE_SPECS: Array<{
  controlId: string
  position: [number, number, number]
  axis: ModelingHandleAxis
  mirrored?: boolean
}> = [
  { controlId: 'id.head.width', position: [0.245, 0.05, 0.1], axis: 'x', mirrored: true },
  { controlId: 'id.head.height', position: [0, 0.375, 0.08], axis: 'y' },
  { controlId: 'id.head.scale', position: [0, 0.275, 0.2], axis: 'y' },
  { controlId: 'id.head.depth', position: [0, 0.1, 0.29], axis: 'z' },
  { controlId: 'id.skull.braincase.scale', position: [0, 0.325, 0.09], axis: 'y' },
  { controlId: 'id.skull.braincase.width', position: [0.215, 0.2, 0.12], axis: 'x', mirrored: true },
  { controlId: 'id.skull.forehead.depth', position: [0, 0.19, 0.28], axis: 'z' },
  { controlId: 'id.skull.browRidge.depth', position: [0.08, 0.105, 0.29], axis: 'z', mirrored: true },
  { controlId: 'id.skull.eye.spacing', position: [0.052, 0.055, 0.31], axis: 'x', mirrored: true },
  { controlId: 'id.skull.eye.width', position: [0.098, 0.055, 0.3], axis: 'x', mirrored: true },
  { controlId: 'id.skull.eye.depth', position: [0.078, 0.063, 0.32], axis: 'z', mirrored: true },
  { controlId: 'id.skull.cheekbone.width', position: [0.15, -0.02, 0.27], axis: 'x', mirrored: true },
  { controlId: 'id.skull.cheekbone.height', position: [0.13, 0.025, 0.27], axis: 'y', mirrored: true },
  { controlId: 'id.nose.bridge.width', position: [0, 0.055, 0.33], axis: 'x' },
  { controlId: 'id.nose.upperCartilage.width', position: [0, 0.015, 0.35], axis: 'x' },
  { controlId: 'id.nose.lowerCartilage.width', position: [0, -0.025, 0.35], axis: 'x' },
  { controlId: 'id.nose.tip.direction', position: [0, -0.055, 0.36], axis: 'y' },
  { controlId: 'id.nose.nostril.width', position: [0.052, -0.075, 0.34], axis: 'x', mirrored: true },
  { controlId: 'id.mouth.width', position: [0.098, -0.15, 0.33], axis: 'x', mirrored: true },
  { controlId: 'id.mouth.upperLip.depth', position: [0, -0.13, 0.35], axis: 'z' },
  { controlId: 'id.mouth.lowerLip.depth', position: [0, -0.175, 0.35], axis: 'z' },
  { controlId: 'id.skull.upperJaw.depth', position: [0, -0.06, 0.32], axis: 'z' },
  { controlId: 'id.skull.lowerJaw.width', position: [0.145, -0.17, 0.2], axis: 'x', mirrored: true },
  { controlId: 'id.skull.chin.depth', position: [0, -0.27, 0.27], axis: 'z' },
  { controlId: 'id.skull.chin.height', position: [0, -0.315, 0.18], axis: 'y' },
]

const SCULPT_AREA_SPECS: Array<{
  id: string
  label: string
  controlId: string
  controlIds: string[]
  section: string
  position?: [number, number, number]
  axis?: ModelingHandleAxis
  mirrored?: boolean
}> = [
  {
    id: 'head',
    label: 'Head',
    controlId: 'id.head.scale',
    controlIds: ['id.head.scale', 'id.head.width', 'id.head.height', 'id.head.depth'],
    section: 'Head',
  },
  {
    id: 'braincase',
    label: 'Braincase',
    controlId: 'id.skull.braincase.scale',
    controlIds: [
      'id.skull.braincase.scale',
      'id.skull.braincase.width',
      'id.skull.braincase.depth',
      'id.skull.braincase.height',
      'id.skull.braincase.backDepth',
      'id.skull.braincase.backHeight',
      'id.skull.braincase.topWidth',
      'id.skull.braincase.sideVolume',
      'id.skull.braincase.roundness',
    ],
    section: 'Braincase',
    position: [0, 0.29, 0.16],
  },
  {
    id: 'forehead',
    label: 'Forehead',
    controlId: 'id.skull.forehead.depth',
    controlIds: [
      'id.skull.forehead.depth',
      'id.skull.forehead.width',
      'id.skull.forehead.height',
      'id.skull.forehead.slope',
      'id.skull.forehead.lowerVolume',
      'id.skull.forehead.upperVolume',
    ],
    section: 'Forehead',
    mirrored: true,
  },
  {
    id: 'brow-ridge',
    label: 'Brow Ridge',
    controlId: 'id.skull.browRidge.depth',
    controlIds: [
      'id.skull.browRidge.depth',
      'id.skull.browRidge.width',
      'id.skull.browRidge.height',
      'id.skull.browRidge.innerDepth',
      'id.skull.browRidge.outerDepth',
    ],
    section: 'Brow Ridge',
    mirrored: true,
  },
  {
    id: 'temple',
    label: 'Temple',
    controlId: 'id.skull.temple.width',
    controlIds: ['id.skull.temple.width'],
    section: 'Temple',
    mirrored: true,
  },
  {
    id: 'eye-shape',
    label: 'Eye Shape',
    controlId: 'id.skull.eye.width',
    controlIds: [
      'id.skull.eye.width',
      'id.skull.eye.height',
      'id.skull.eye.spacing',
      'id.skull.eye.depth',
      'id.skull.eye.tilt',
      'id.skull.eye.angularity',
    ],
    section: 'Eye',
    mirrored: true,
  },
  {
    id: 'upper-eyelid',
    label: 'Upper Eyelid',
    controlId: 'id.skull.eye.upperRimHeight',
    controlIds: ['id.skull.eye.upperRimHeight', 'id.skull.eye.upperRimDepth'],
    section: 'Eye',
    position: [0.083, 0.075, 0.32],
    axis: 'y',
    mirrored: true,
  },
  {
    id: 'lower-eyelid',
    label: 'Lower Eyelid',
    controlId: 'id.skull.eye.lowerRimHeight',
    controlIds: ['id.skull.eye.lowerRimHeight', 'id.skull.eye.lowerRimDepth'],
    section: 'Eye',
    position: [0.083, 0.035, 0.32],
    axis: 'y',
    mirrored: true,
  },
  {
    id: 'cheekbone',
    label: 'Cheekbone',
    controlId: 'id.skull.cheekbone.height',
    controlIds: [
      'id.skull.cheekbone.height',
      'id.skull.cheekbone.width',
      'id.skull.cheekbone.angularity',
    ],
    section: 'Cheekbone',
    mirrored: true,
  },
  {
    id: 'upper-jaw',
    label: 'Upper Jaw',
    controlId: 'id.skull.upperJaw.depth',
    controlIds: [
      'id.skull.upperJaw.depth',
      'id.skull.upperJaw.width',
      'id.skull.upperJaw.height',
      'id.skull.upperJaw.roundness',
    ],
    section: 'Upper Jaw',
    mirrored: true,
  },
  {
    id: 'lower-jaw',
    label: 'Lower Jaw',
    controlId: 'id.skull.lowerJaw.width',
    controlIds: [
      'id.skull.lowerJaw.width',
      'id.skull.lowerJaw.height',
      'id.skull.lowerJaw.depth',
      'id.skull.lowerJaw.roundedness',
    ],
    section: 'Lower Jaw',
    mirrored: true,
  },
  {
    id: 'chin',
    label: 'Chin',
    controlId: 'id.skull.chin.depth',
    controlIds: ['id.skull.chin.depth', 'id.skull.chin.width', 'id.skull.chin.height'],
    section: 'Chin',
  },
  {
    id: 'nose-root',
    label: 'Nose Root',
    controlId: 'id.nose.bridge.width',
    controlIds: ['id.nose.bridge.width', 'id.nose.bridge.angularity'],
    section: 'Bridge',
    position: [0, 0.085, 0.34],
  },
  {
    id: 'nasal-bone',
    label: 'Nasal Bone',
    controlId: 'id.nose.nasalBone.depth',
    controlIds: [
      'id.nose.nasalBone.depth',
      'id.nose.nasalBone.width',
      'id.nose.nasalBone.height',
      'id.nose.nasalBone.direction',
    ],
    section: 'Nasal Bone',
  },
  {
    id: 'upper-cartilage',
    label: 'Upper Cartilage',
    controlId: 'id.nose.upperCartilage.depth',
    controlIds: [
      'id.nose.upperCartilage.depth',
      'id.nose.upperCartilage.width',
      'id.nose.upperCartilage.height',
      'id.nose.upperCartilage.direction',
    ],
    section: 'Upper Cartilage',
    position: [0, -0.022, 0.36],
  },
  {
    id: 'lower-cartilage',
    label: 'Lower Cartilage',
    controlId: 'id.nose.lowerCartilage.depth',
    controlIds: [
      'id.nose.lowerCartilage.depth',
      'id.nose.lowerCartilage.width',
      'id.nose.lowerCartilage.height',
      'id.nose.lowerCartilage.direction',
      'id.nose.lowerCartilage.roundedness',
    ],
    section: 'Lower Cartilage',
    position: [0, -0.062, 0.36],
  },
  {
    id: 'nose-tip',
    label: 'Nose Tip',
    controlId: 'id.nose.tip.direction',
    controlIds: ['id.nose.tip.direction', 'id.nose.tip.angularity'],
    section: 'Tip',
  },
  {
    id: 'nostril',
    label: 'Nostril',
    controlId: 'id.nose.nostril.width',
    controlIds: [
      'id.nose.nostril.width',
      'id.nose.nostril.height',
      'id.nose.nostril.depth',
      'id.nose.nostril.angularity',
      'id.nose.nostril.innerScale',
    ],
    section: 'Nostril',
    mirrored: true,
  },
  {
    id: 'mouth',
    label: 'Mouth',
    controlId: 'id.mouth.width',
    controlIds: ['id.mouth.width'],
    section: 'Mouth',
    mirrored: true,
  },
  {
    id: 'philtrum',
    label: 'Philtrum',
    controlId: 'id.mouth.philtrum.depth',
    controlIds: ['id.mouth.philtrum.depth', 'id.mouth.philtrum.width'],
    section: 'Philtrum',
  },
  {
    id: 'upper-lip',
    label: 'Upper Lip',
    controlId: 'id.mouth.upperLip.height',
    controlIds: [
      'id.mouth.upperLip.height',
      'id.mouth.upperLip.width',
      'id.mouth.upperLip.depth',
      'id.mouth.upperLip.roudnedness',
    ],
    section: 'Upper Lip',
    mirrored: true,
  },
  {
    id: 'lower-lip',
    label: 'Lower Lip',
    controlId: 'id.mouth.lowerLip.height',
    controlIds: [
      'id.mouth.lowerLip.height',
      'id.mouth.lowerLip.width',
      'id.mouth.lowerLip.depth',
    ],
    section: 'Lower Lip',
    mirrored: true,
  },
]

const SECTION_POSITIONS: Record<string, [number, number, number]> = {
  Head: [0, 0.12, 0.28],
  Braincase: [0.16, 0.245, 0.17],
  Forehead: [0.08, 0.185, 0.27],
  'Brow Ridge': [0.082, 0.105, 0.3],
  Cheekbone: [0.145, -0.015, 0.28],
  Temple: [0.205, 0.105, 0.15],
  Eye: [0.083, 0.055, 0.31],
  'Upper Jaw': [0.085, -0.058, 0.31],
  'Lower Jaw': [0.13, -0.17, 0.21],
  Chin: [0, -0.268, 0.28],
  Bridge: [0, 0.058, 0.34],
  'Nasal Bone': [0, 0.015, 0.35],
  'Upper Cartilage': [0, -0.022, 0.36],
  'Lower Cartilage': [0.04, -0.062, 0.35],
  Tip: [0, -0.045, 0.37],
  Nostril: [0.055, -0.078, 0.34],
  Mouth: [0.103, -0.151, 0.34],
  Philtrum: [0, -0.103, 0.35],
  'Upper Lip': [0.042, -0.129, 0.35],
  'Lower Lip': [0.042, -0.176, 0.35],
}

const CENTER_SECTIONS = new Set([
  'Head',
  'Chin',
  'Bridge',
  'Nasal Bone',
  'Upper Cartilage',
  'Tip',
  'Philtrum',
])

function propertyFromControl(control: ModelingControl) {
  return control.id.split('.').at(-1) ?? control.label.toLowerCase()
}

function axisForControl(control: ModelingControl): ModelingHandleAxis {
  const property = propertyFromControl(control)
  if (
    property.includes('width') ||
    property === 'spacing' ||
    property === 'sideVolume' ||
    property === 'innerScale'
  ) {
    return 'x'
  }
  if (property.includes('height') || property === 'direction' || property === 'tilt') return 'y'
  return 'z'
}

function mirrorPosition(position: [number, number, number], side: ModelingHandleSide): [number, number, number] {
  if (side === 'left') return [-Math.abs(position[0]), position[1], position[2]]
  if (side === 'right') return [Math.abs(position[0]), position[1], position[2]]
  return position
}

function makeHandle(
  mode: ModelingMode,
  control: ModelingControl,
  position: [number, number, number],
  axis: ModelingHandleAxis,
  side: ModelingHandleSide,
  mirrored: boolean,
  overrides?: { id?: string; label?: string; controlIds?: string[] },
): ModelingHandle {
  return {
    id: overrides?.id ?? `${mode}:${control.id}:${side}`,
    controlId: control.id,
    controlIds: overrides?.controlIds ?? [control.id],
    mode,
    label: overrides?.label ?? (control.section === control.tab ? control.label : `${control.section} ${control.label}`),
    position: mirrorPosition(position, side),
    axis,
    side,
    mirrored,
  }
}

function expandMirroredHandle(
  mode: ModelingMode,
  control: ModelingControl,
  position: [number, number, number],
  axis: ModelingHandleAxis,
  mirrored: boolean,
  symmetric: boolean,
  overrides?: { idBase?: string; label?: string; controlIds?: string[] },
) {
  if (!mirrored) {
    return [
      makeHandle(mode, control, position, axis, 'center', false, {
        id: overrides?.idBase ? `${mode}:${overrides.idBase}:center` : undefined,
        label: overrides?.label,
        controlIds: overrides?.controlIds,
      }),
    ]
  }

  const left = makeHandle(mode, control, position, axis, 'left', true, {
    id: overrides?.idBase ? `${mode}:${overrides.idBase}:left` : undefined,
    label: overrides?.label,
    controlIds: overrides?.controlIds,
  })
  const right = makeHandle(mode, control, position, axis, 'right', true, {
    id: overrides?.idBase ? `${mode}:${overrides.idBase}:right` : undefined,
    label: overrides?.label,
    controlIds: overrides?.controlIds,
  })
  return symmetric ? [left, right] : [right]
}

function buildTransformHandles(symmetric: boolean) {
  return TRANSFORM_HANDLE_SPECS.flatMap((spec) => {
    const control = getModelingControlById(spec.controlId)
    if (!control) return []

    return expandMirroredHandle(
      'transform',
      control,
      spec.position,
      spec.axis,
      spec.mirrored ?? false,
      symmetric,
    )
  })
}

function buildSculptHandles(symmetric: boolean) {
  return SCULPT_AREA_SPECS.flatMap((spec) => {
    const control = getModelingControlById(spec.controlId)
    if (!control) return []

    const base = spec.position ?? SECTION_POSITIONS[spec.section] ?? [0, 0, 0.28]
    const axis = spec.axis ?? axisForControl(control)
    const mirrored = spec.mirrored ?? (!CENTER_SECTIONS.has(spec.section) || Math.abs(base[0]) > 0.001)

    return expandMirroredHandle(
      'sculpt',
      control,
      base,
      axis,
      mirrored,
      symmetric,
      {
        idBase: spec.id,
        label: spec.label,
        controlIds: spec.controlIds,
      },
    )
  })
}

export function getModelingHandles(mode: ModelingMode, symmetric: boolean): ModelingHandle[] {
  return mode === 'transform' ? buildTransformHandles(symmetric) : buildSculptHandles(symmetric)
}

export function getModelingHandleById(id: string | null | undefined, symmetric = true) {
  if (!id) return null
  return (
    getModelingHandles('transform', symmetric).find((handle) => handle.id === id) ??
    getModelingHandles('sculpt', symmetric).find((handle) => handle.id === id) ??
    null
  )
}
