/**
 * Single source of truth for AI Animal Compiler recipe enums, ranges,
 * template priors, and coat-pattern aliases.
 *
 * Coat patterns must stay a superset of every `pattern === '…'` branch in
 * `dogCoatFields.js` `colorMaskAt` (plus `golden-shade` default fallthrough).
 * `scripts/verify-animal-phenotype.mjs` enforces that contract.
 */

export const ANIMAL_SCHEMA_VERSION = 1;

export const ANIMAL_EAR_TYPES = Object.freeze([
  'floppy',
  'erect',
  'folded',
  'bat',
  'rounded',
]);

export const ANIMAL_EAR_FOLDS = Object.freeze([
  'drop',
  'rose',
  'semi-prick',
  'button',
]);

export const ANIMAL_TAIL_TYPES = Object.freeze([
  'plume',
  'straight',
  'saber',
  'upright',
  'curled',
  'sickle',
  // Tall vertical sciurid plume (grey squirrel) — rises above the rump.
  'sciurid',
  // Flat horizontal scaly paddle (beaver) — laid against the rump, not raised.
  'paddle',
]);

/** Supported coat.pattern values consumed by dogCoatFields.colorMaskAt. */
export const ANIMAL_COAT_PATTERNS = Object.freeze([
  'solid',
  'golden-shade',
  'black-tan',
  'saddle',
  'brindle-mask',
  'salt-pepper',
  'tan-points',
  'hound-saddle',
  'liver-roan',
  'pied',
  'blenheim',
  'blue-tan',
  'blue-merle',
  'red-white',
  'fawn-mask',
  'parti',
  'tuxedo',
  'husky-mask',
  'tortoiseshell',
  'solid-white',
  'raccoon-mask',
  // Sciurid / rodent pattern kit (rodent-ref boards)
  'squirrel-grey',
  'chipmunk-stripe',
  'murine-agouti',
  'hamster-golden',
  // Ursid kit
  'panda-bicolor',
  // Procyonid kit (beyond raccoon-mask)
  'coati-snout',
  'ringed-tail',
  // Feline pattern kit (cat-ref reference boards)
  'cat-tabby',
  'cat-spotted',
  'cat-ticked',
  'cat-colorpoint',
  'cat-van',
  'cat-mike',
  // Ungulate / herbivore patterns
  'goat-pied',
  'dorsal-stripe',
  // Iconic-species coat kit
  'skunk-striped', // mephitid: twin dorsal stripes + white crown/bushy tail
  'hyena-spotted', // hyaenid: tawny ground + dark blotches
  'genet-spotted', // viverrid: grey-ticked + small dark spots + ringed tail
  'red-panda', // ailurid: red fur + black belly + white face mask
  'cervid-fawn', // cervid: fawn white spots over tawny, fading toward legs
  'badger-faced', // mustelid: white crown/face stripe + black cheek patches
  'chinchilla-silver', // chinchillid: ultra-dense silver-grey with darker guard tips
]);

/** Descriptive / density prior only for v1 materials (plus fiber enum). */
export const ANIMAL_GROOMING = Object.freeze([
  'smooth',
  'smooth-double',
  'short',
  'short-double',
  'double',
  'medium-double',
  'long-double',
  'dense-double',
  'stand-off-double',
  'feathered',
  'silky',
  'curly',
  'wire',
  'grizzled',
  'coarse',
]);

/** Coat fiber model — biases shell length distribution. */
export const ANIMAL_COAT_FIBERS = Object.freeze([
  'soft',
  'double',
  'coarse-guard',
]);

/** End-effector / foot geometry kit. */
export const ANIMAL_FOOT_TYPES = Object.freeze([
  'paw',
  'rodent-paw',
  'cloven-hoof',
  'solid-hoof',
  // Paw sole with a webbing membrane between toes (otter, beaver).
  'webbed-paw',
]);

/** Eye presentation (pupil shape / sclera). */
export const ANIMAL_EYE_STYLES = Object.freeze([
  'canid',
  'feline',
  'caprine',
]);

/** Headgear attached to Head bone. */
export const ANIMAL_HEADGEAR_TYPES = Object.freeze([
  'none',
  'horn-caprine',
  'horn-bovid',
  'antler-simple',
  // Branched multi-tine antler rack (cervid): main beam + brow/surroyal tines.
  'antler-rack',
  // Paired lower canines curving up out of the jaw (suid/warthog).
  'tusk-boar',
]);

export const ANIMAL_TEMPLATES = Object.freeze([
  'canid',
  'feline',
  'procyonid',
  'ursid',
  'mustelid',
  'caprine',
  'generic-quad',
]);

/** Profile id from DOG_PHENOTYPE_PROFILES used as merge base for each template. */
export const TEMPLATE_BASE_ID = Object.freeze({
  canid: 'german-shepherd-dog',
  feline: 'tortoiseshell',
  procyonid: 'raccoon',
  ursid: 'brown-bear',
  mustelid: 'river-otter',
  caprine: 'domestic-goat',
  'generic-quad': 'golden-retriever',
});

/** Default silhouette familyId when recipe omits familyId. */
export const TEMPLATE_FAMILY = Object.freeze({
  canid: 'wild-canid',
  feline: 'feline',
  procyonid: 'raccoon',
  ursid: 'ursine',
  mustelid: 'mustelid-otter',
  caprine: 'caprine',
  'generic-quad': 'retriever-sporting',
});

/** Default taxonomic speciesId (ANIMAL_SPECIES) for each recipe template. */
export const TEMPLATE_SPECIES = Object.freeze({
  canid: 'canidae',
  feline: 'felidae',
  procyonid: 'procyonidae',
  ursid: 'ursidae',
  mustelid: 'mustelidae',
  caprine: 'bovidae',
  'generic-quad': 'canidae',
});

/** Default coat.pattern when recipe omits pattern (after alias resolution). */
export const TEMPLATE_DEFAULT_PATTERN = Object.freeze({
  canid: 'husky-mask',
  feline: 'solid',
  procyonid: 'raccoon-mask',
  ursid: 'solid',
  mustelid: 'solid',
  'generic-quad': 'solid',
});

/** Map free-form / species names → supported patterns. */
export const PATTERN_ALIASES = Object.freeze({
  'silver-fox': 'husky-mask',
  'red-fox': 'saddle',
  wolf: 'saddle',
  coyote: 'saddle',
  tabby: 'brindle-mask',
  calico: 'tortoiseshell',
  'ringed-tail': 'raccoon-mask',
  bandit: 'raccoon-mask',
  'grey-squirrel': 'squirrel-grey',
  'eastern-grey': 'squirrel-grey',
  'squirrel-agouti': 'squirrel-grey',
  chipmunk: 'chipmunk-stripe',
  'norway-rat': 'murine-agouti',
  'house-mouse': 'murine-agouti',
  muridae: 'murine-agouti',
  rat: 'murine-agouti',
  mouse: 'murine-agouti',
  'syrian-hamster': 'hamster-golden',
  hamster: 'hamster-golden',
  'golden-hamster': 'hamster-golden',
  panda: 'panda-bicolor',
  'giant-panda': 'panda-bicolor',
  coati: 'coati-snout',
  'white-nosed-coati': 'coati-snout',
  ringtail: 'ringed-tail',
  'ring-tail': 'ringed-tail',
  // Generic agouti → feline ticked (not sciurid countershading).
  agouti: 'cat-ticked',
  merle: 'blue-merle',
  brindle: 'brindle-mask',
  white: 'solid-white',
  black: 'solid',
  orange: 'saddle',
  ginger: 'saddle',
  'black-and-tan': 'black-tan',
  'black_tan': 'black-tan',
  goat: 'goat-pied',
  'goat-piebald': 'goat-pied',
  piebald: 'goat-pied',
  stripe: 'dorsal-stripe',
  'dorsal': 'dorsal-stripe',
  // Iconic-species aliases
  skunk: 'skunk-striped',
  'striped-skunk': 'skunk-striped',
  'hooded-skunk': 'skunk-striped',
  hyena: 'hyena-spotted',
  'spotted-hyena': 'hyena-spotted',
  genet: 'genet-spotted',
  'common-genet': 'genet-spotted',
  'red-panda': 'red-panda',
  // NB: bare 'panda' stays mapped to 'panda-bicolor' (ursid giant panda above).
  deer: 'cervid-fawn',
  fawn: 'cervid-fawn',
  'red-deer': 'cervid-fawn',
  'red-fawn': 'cervid-fawn',
  badger: 'badger-faced',
  'european-badger': 'badger-faced',
  chinchilla: 'chinchilla-silver',
});

/**
 * Numeric clamp ranges for **recipe/AI input only**.
 * Padded above live DOG_PHENOTYPE_PROFILES extremes (e.g. Great Dane scale 1.38,
 * Pom coat.tail 1.65) so catalog extremes remain expressible via recipes.
 * Catalog resolveDogPhenotype does NOT apply these clamps.
 */
export const ANIMAL_NUMERIC_RANGES = Object.freeze({
  // Min padded for toy rodents (house-mouse 0.28, naked-mole-rat 0.3).
  // Max padded for giant ungulates (giraffe 1.55, hippo/horse ~1.36–1.45).
  'skeleton.scale': { min: 0.25, max: 1.6 },
  'skeleton.bodyLength': { min: 0.55, max: 1.55 },
  // Min: fossorial stilts (naked-mole-rat 0.38); max: giraffe / horse legs.
  'skeleton.legLength': { min: 0.35, max: 1.5 },
  // Optional front-column scale relative to legLength (sciurid / jerboa short forelegs).
  'skeleton.frontLegScale': { min: 0.45, max: 1.2 },
  'skeleton.chestWidth': { min: 0.5, max: 1.45 },
  'skeleton.hipWidth': { min: 0.5, max: 1.4 },
  // Max padded for giraffe neck (~1.95).
  'skeleton.neckLength': { min: 0.35, max: 2.0 },
  'skeleton.headSize': { min: 0.5, max: 1.4 },
  'skeleton.muzzleLength': { min: 0.28, max: 1.45 },
  'skeleton.tailLength': { min: 0.15, max: 1.45 },

  'geometry.torsoWidth': { min: 0.35, max: 1.55 },
  'geometry.torsoDepth': { min: 0.35, max: 1.55 },
  'geometry.neckWidth': { min: 0.35, max: 1.55 },
  'geometry.skullWidth': { min: 0.35, max: 1.55 },
  'geometry.skullHeight': { min: 0.35, max: 1.55 },
  'geometry.skullLength': { min: 0.35, max: 1.55 },
  'geometry.muzzleWidth': { min: 0.3, max: 1.55 },
  // Vertical depth of the muzzle loft (hydrochoerine blocky snouts).
  'geometry.muzzleHeight': { min: 0.5, max: 1.55 },
  'geometry.legThickness': { min: 0.35, max: 1.55 },
  'geometry.hindLegThickness': { min: 0.35, max: 1.55 },
  'geometry.pawSize': { min: 0.35, max: 1.55 },
  'geometry.cheekFullness': { min: 0.35, max: 1.55 },
  // Absolute-ish geometry extras (raccoon profile uses ~0.024 / 0.84).
  'geometry.backArch': { min: 0, max: 0.08 },
  'geometry.frontTaper': { min: 0.3, max: 1.5 },
  // Dorsal fat mass over the withers (camel hump). 0 = none; ~0.04 single
  // dromedary peak; ~0.06 double bactrian read.
  'geometry.hump': { min: 0, max: 0.1 },

  // Min padded for fossorial tiny pinnae (naked-mole-rat authored ~0.32 length
  // after ear-centerline floor; floor keeps room for future vestigial retunes).
  'ears.length': { min: 0.05, max: 1.5 },
  // Fossorial pinnae stay narrow (naked-mole-rat authored ~0.4 width).
  'ears.width': { min: 0.15, max: 1.5 },
  'ears.dynamics': { min: 0, max: 1.5 },

  // House-mouse thin tail is 0.28; jerboa/kangaroo-rat can be thinner (~0.34).
  'tail.thickness': { min: 0.25, max: 1.8 },
  'tail.curl': { min: 0, max: 1.5 },
  'tail.motion': { min: 0, max: 1.5 },
  'tail.taper': { min: 0.3, max: 1.5 },

  // Fossorial nearly-eyeless forms (naked-mole-rat 0.28, blind-mole-rat 0.35).
  'face.eyeScale': { min: 0.2, max: 1.5 },
  'face.eyeSpacing': { min: 0.5, max: 1.4 },
  'face.eyeHeight': { min: 0.5, max: 1.4 },
  'face.eyeForward': { min: 0.5, max: 1.4 },
  'face.noseScale': { min: 0.4, max: 1.5 },
  'face.brow': { min: 0, max: 1 },

  // Near-hairless (naked-mole-rat / hippo / rhino sparse shells ~0.04–0.1).
  'coat.length': { min: 0.02, max: 1.45 },
  'coat.body': { min: 0.02, max: 1.8 },
  'coat.head': { min: 0.02, max: 1.8 },
  'coat.muzzle': { min: 0.02, max: 1.8 },
  'coat.ears': { min: 0.02, max: 1.8 },
  'coat.legs': { min: 0.02, max: 1.8 },
  'coat.paws': { min: 0.02, max: 1.8 },
  'coat.tail': { min: 0.02, max: 1.8 },
  'coat.gravityDroop': { min: 0, max: 1 },
  'coat.density': { min: 180, max: 900 },

  'furnishings.brows': { min: 0, max: 1.5 },
  'furnishings.beard': { min: 0, max: 1.5 },
  'furnishings.mustache': { min: 0, max: 1.5 },
  'furnishings.neckSkirt': { min: 0, max: 1.5 },
  'furnishings.ruff': { min: 0, max: 1.5 },
  'furnishings.topknot': { min: 0, max: 1.5 },
  'furnishings.anklePuffs': { min: 0, max: 1.5 },
  'furnishings.tailPom': { min: 0, max: 1.5 },
  // Stand-up dorsal fur ridge (hyena/badger/warthog mane along the spine).
  'furnishings.dorsalCrest': { min: 0, max: 1.5 },
  // Dorsal/lumbar field of cone quills layered over the back (porcupine).
  'furnishings.quills': { min: 0, max: 1.5 },

  // Fossorial scurry (naked-mole-rat 0.36); cursorial max (pronghorn/horse ~1.2–1.28).
  'motion.stride': { min: 0.3, max: 1.35 },
  'motion.speed': { min: 0.4, max: 1.35 },
  'motion.sitDepth': { min: 0.35, max: 1.3 },
  'motion.earDynamics': { min: 0, max: 1.5 },
  'motion.tailMotion': { min: 0, max: 1.5 },

  'personality.energy': { min: 1, max: 5 },
  'personality.trainability': { min: 1, max: 5 },
  'personality.sociability': { min: 1, max: 5 },
  'personality.vigilance': { min: 1, max: 5 },

  'variation.scale': { min: 0, max: 0.15 },
  'variation.build': { min: 0, max: 0.15 },
  'variation.coatShade': { min: 0, max: 0.35 },
  'variation.coatLength': { min: 0, max: 0.25 },
  'variation.energy': { min: 0, max: 0.5 },
  'variation.trainability': { min: 0, max: 0.5 },

  'extremities.hoofSize': { min: 0.4, max: 1.6 },
  'extremities.dewclaw': { min: 0, max: 1.5 },
  'extremities.bareBelow': { min: 0.3, max: 1 },

  'headgear.length': { min: 0.15, max: 2.2 },
  'headgear.curl': { min: 0, max: 1.5 },
  'headgear.spread': { min: 0.4, max: 1.8 },
  'headgear.thickness': { min: 0.35, max: 1.8 },

  // Feline vertical slits use <1; caprine horizontal slits use >1.
  'face.pupilAspect': { min: 0.12, max: 5 },
  'face.scleraAmount': { min: 0, max: 1 },
});

/** Enum sets for JSON Schema generation / Grok constrained decoding. */
export function toJsonSchemaEnums() {
  return {
    template: [...ANIMAL_TEMPLATES],
    earType: [...ANIMAL_EAR_TYPES],
    earFold: [...ANIMAL_EAR_FOLDS],
    tailType: [...ANIMAL_TAIL_TYPES],
    coatPattern: [...ANIMAL_COAT_PATTERNS],
    grooming: [...ANIMAL_GROOMING],
    coatFiber: [...ANIMAL_COAT_FIBERS],
    footType: [...ANIMAL_FOOT_TYPES],
    eyeStyle: [...ANIMAL_EYE_STYLES],
    headgearType: [...ANIMAL_HEADGEAR_TYPES],
  };
}
