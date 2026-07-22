export {
  ANIMAL_ORDERS,
  ANIMAL_SPECIES,
  AUTHORED_BIRD_BREED_IDS,
  AUTHORED_DOG_BREED_IDS,
  AUTHORED_INSECT_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  DOG_LINEAGE_KEYS,
  getAnimalOrder,
  getAnimalSpecies,
  getAuthoredBreedsForSpecies,
  getAuthoredDogBreeds,
  getBreedsForSpecies,
  getDogBreed,
  getDogBreeds,
  getDogFamily,
  getDogVariants,
  getFamiliesForSpecies,
  getPopulatedFamiliesForSpecies,
  getSpeciesIdForBreed,
  getSpeciesIdForFamily,
  isAvianSpecies,
  isBirdBreed,
  isCatRigBreed,
  isHorseRigBreed,
  isInsectBreed,
  isInsectSpecies,
  isLadybugBreed,
  isSpeciesPopulated,
  normalizeDogBreedId,
  normalizeDogVariantId,
  normalizeRenderableDogBreedId,
} from './dogCatalog.js';
export {
  DOG_PHENOTYPE_PROFILES,
  hasAuthoredDogPhenotype,
  normalizeDogSeed,
  resolveDogPhenotype,
} from './dogPhenotypes.js';
export {
  ANIMAL_COAT_FIBERS,
  ANIMAL_COAT_PATTERNS,
  ANIMAL_EAR_FOLDS,
  ANIMAL_EAR_TYPES,
  ANIMAL_EYE_STYLES,
  ANIMAL_FOOT_TYPES,
  ANIMAL_GROOMING,
  ANIMAL_HEADGEAR_TYPES,
  ANIMAL_NUMERIC_RANGES,
  ANIMAL_SCHEMA_VERSION,
  ANIMAL_TAIL_TYPES,
  ANIMAL_TEMPLATES,
  PATTERN_ALIASES,
  TEMPLATE_BASE_ID,
  TEMPLATE_DEFAULT_PATTERN,
  TEMPLATE_FAMILY,
  TEMPLATE_SPECIES,
  toJsonSchemaEnums,
} from './animalPhenotypeEnums.js';
export {
  colorToCssHex,
  getBreedOrVirtual,
  isAnimalRefusal,
  nearestCoatPattern,
  normalizeDirectPhenotype,
  parseColorToHex,
  phenotypeToAuthorRecipe,
  recipeToResolvedPhenotype,
  resolveDogPhenotypeFromRecipe,
  slugifyAnimalName,
  validateAndClampAnimalRecipe,
} from './animalPhenotypeClamp.js';
export { createProceduralDog } from './createProceduralDog.js';
export { createProceduralLadybug } from '../insect/createProceduralLadybug.js';
export { LADYBUG_CLIP_CATALOG } from '../insect/ladybugAnimation.js';
export { LADYBUG_DIMS, createLadybugSkeleton } from '../insect/ladybugSkeleton.js';
export {
  BIRD_BREED_PRESENTATION,
  BIRD_CLIP_CATALOG,
  BIRD_MODEL_URL,
  birdModelUrlForBreed,
  createAuthoredBird,
  varyBirdPresentation,
  warmBirdTemplate,
} from './createAuthoredBird.js';
export {
  BODY_PLAN_PROFILES,
  BIRD_SHAPE_KIT,
  CANADA_GOOSE_ENVELOPE,
  CANADA_GOOSE_LANDMARKS,
  CANADA_GOOSE_MESH_BOUNDS,
  CANADA_GOOSE_PALETTE,
  getBodyPlanProfile,
  planStationRadii,
  sampleEnvelope,
  waterfowlStationRadii,
} from './birdProportionProfile.js';
export {
  createGoosePlumageMaterial,
} from './birdGooseMaterial.js';
export {
  BIRD_ZONE,
  buildBirdBodyGeometry,
  remapBirdSkinIndices,
} from './buildBirdBodyGeometry.js';
export {
  createBirdPlumageMaterial,
  resolveBirdZoneColor,
} from './birdPlumageMaterial.js';
export {
  COAT_ZONE,
  colorMaskAt,
  packCoatMask,
  unpackCoatMask,
  lengthAt,
} from './dogCoatFields.js';
export {
  plantBindSoles,
  plantDogFeet,
  ccdPlantLeg,
  getPadWorldPosition,
  DOG_PAW_MESH_PAD as FOOT_PLANT_PAD,
} from './dogFootPlant.js';
export {
  DogClipPlayer,
  DOG_CLIP_CATALOG,
  RODENT_CLIP_CATALOG,
  FARM_CLIP_CATALOG,
  animalClipLibraryKind,
  animalUsesDogClipLibrary,
  dogClipModeEnabled,
  clipCatalogForKind,
  clipLibraryBasePath,
} from './DogClipPlayer.js';
export {
  RAT_TO_DOG_BONE_MAP,
  mapRatBoneName,
  normalizeRatClipName,
} from './ratToDogBoneMap.js';
export {
  QUATERNIUS_TO_DOG_BONE_MAP,
  mapQuaterniusBoneName,
  normalizeQuaterniusClipName,
} from './quaterniusToDogBoneMap.js';
export { createAnimalHeadgear } from './animalHeadgear.js';
