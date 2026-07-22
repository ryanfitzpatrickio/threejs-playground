/**
 * Isolated WebGPU scene for the procedural dog simulation.
 *
 * Boot: main menu "Dog" card, or ?view=dog-sim (aliases: dog, dogsim)
 * Harness: ?harness (or &harness=1) — deterministic scenarios, frozen blink/breeze,
 * camera/lighting presets, side-by-side photo panel hooks, gallery API.
 *
 * Global scripting API: window.__DOG_SIM_DEBUG__
 */

import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createProceduralDog } from '../characters/dog/createProceduralDog.js';
import {
  createProceduralGoose,
  GOOSE_CLIP_CATALOG,
} from '../characters/goose/createProceduralGoose.js';
import { createProceduralCat } from '../characters/cat/createProceduralCat.js';
import { createProceduralHorse } from '../characters/horse/createProceduralHorse.js';
import { HORSE_CLIP_CATALOG } from '../characters/horse/horseAnimation.js';
import { createProceduralLadybug } from '../characters/insect/createProceduralLadybug.js';
import { LADYBUG_CLIP_CATALOG } from '../characters/insect/ladybugAnimation.js';
import {
  DogClipPlayer,
  animalUsesDogClipLibrary,
} from '../characters/dog/DogClipPlayer.js';
import {
  ANIMAL_SPECIES,
  AUTHORED_DOG_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  plantDogFeet,
  getDogBreed,
  getDogBreeds,
  getDogVariants,
  getFamiliesForSpecies,
  getPopulatedFamiliesForSpecies,
  getSpeciesIdForBreed,
  getSpeciesIdForFamily,
  isBirdBreed,
  isCatRigBreed,
  isHorseRigBreed,
  isInsectBreed,
  isLadybugBreed,
  normalizeDogBreedId,
  normalizeDogSeed,
  normalizeDogVariantId,
} from '../characters/dog/index.js';
import { createDogSimStudioLighting } from './createDogSimStudioLighting.js';
import { DogCameraSystem } from '../systems/DogCameraSystem.js';
import { StudioFreeRoamController } from './StudioFreeRoamController.js';

const FIXED_DT = 1 / 60;

/** True for a breed's own default variant (e.g. dachshund's is 'smooth', not literally 'default'). */
function isDogDefaultVariant(breedId, variantId) {
  return (getDogBreed(breedId)?.defaultVariantId ?? 'default') === variantId;
}

/**
 * Root-level golden stills used older names (`head-close-profile.jpg`) while
 * breed folders and `refFile` use catalog names (`profile.jpg`). Map both so
 * compare never 404-loops on the default breed.
 */
const ROOT_REF_ALIASES = Object.freeze({
  'profile.jpg': ['head-close-profile.jpg'],
  'front-sit.jpg': ['head-close-front.jpg'],
  'head-close-profile.jpg': ['profile.jpg'],
  'head-close-front.jpg': ['front-sit.jpg'],
});

/**
 * Breeds without a photo board of their own borrow another breed's stills.
 * The procedural cat iterates against the existing tortoiseshell references.
 */
const CAT_REF_BREED_ALIASES = Object.freeze({
  'tortoiseshell-procedural': 'tortoiseshell',
});

/** Horse v2 iterates against the v1 domestic-horse equid-ref board. */
const EQUID_REF_BREED_ALIASES = Object.freeze({
  'domestic-horse-procedural': 'domestic-horse',
});

function isFelineBreed(breedId) {
  return getDogBreed(breedId)?.familyId === 'feline';
}

function isRodentBreed(breedId) {
  const breed = getDogBreed(breedId);
  return Boolean(breed?.conformationFlags?.includes('rodent'));
}

function isEquidaeBreed(breedId) {
  const breed = getDogBreed(breedId);
  return breed?.speciesId === 'equidae'
    || breed?.familyId === 'equid'
    || Boolean(breed?.conformationFlags?.includes('equidae'));
}

function isAvianBreed(breedId) {
  return isBirdBreed(breedId);
}

function isInsectCatalogBreed(breedId) {
  return isInsectBreed(breedId);
}

function isLadybugRigBreed(breedId) {
  return isLadybugBreed(breedId);
}

/** Resolve a still under public/assets/{dog,cat,rodent,equid,bird,insect}-ref/. */
export function dogRefUrl(filename, breedId = 'golden-retriever', variantId = 'default') {
  if (isAvianBreed(breedId)) {
    return `/assets/bird-ref/${breedId}/${filename}`;
  }
  if (isInsectCatalogBreed(breedId)) {
    return `/assets/insect-ref/${breedId}/${filename}`;
  }
  if (isFelineBreed(breedId)) {
    // Khao Manee eye variants use head-close-<variant>.jpg; other cats use head-close.jpg.
    if (breedId === 'khao-manee' && variantId && variantId !== 'default') {
      const stem = filename.replace(/\.jpg$/i, '');
      if (stem === 'head-close' || stem === 'three-quarter' || stem === 'profile' || stem === 'front-sit') {
        return `/assets/cat-ref/${breedId}/head-close-${variantId}.jpg`;
      }
    }
    const refBreedId = CAT_REF_BREED_ALIASES[breedId] ?? breedId;
    return `/assets/cat-ref/${refBreedId}/${filename}`;
  }
  if (isRodentBreed(breedId)) {
    return `/assets/rodent-ref/${breedId}/${filename}`;
  }
  if (isEquidaeBreed(breedId)) {
    const refBreedId = EQUID_REF_BREED_ALIASES[breedId] ?? breedId;
    return `/assets/equid-ref/${refBreedId}/${filename}`;
  }
  if (breedId === 'golden-retriever') return `/assets/dog-ref/${filename}`;
  if (variantId && !isDogDefaultVariant(breedId, variantId)) {
    return `/assets/dog-ref/${breedId}/${variantId}/${filename}`;
  }
  return `/assets/dog-ref/${breedId}/${filename}`;
}

/**
 * Fallback chain when a variant still hasn't been photographed yet:
 * 1. breed/variant path (dogs or cats)
 * 2. breed default path
 * 3. dog-ref root aliases (golden stills) for canines only
 * The UI tries each candidate in order via <img onError>, landing on a
 * placeholder only once every candidate 404s.
 */
export function dogRefUrlChain(filename, breedId = 'golden-retriever', variantId = 'default') {
  const chain = [];
  const seen = new Set();
  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    chain.push(url);
  };

  if (isAvianBreed(breedId)) {
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/bird-ref/${breedId}/three-quarter.jpg`);
    push(`/assets/bird-ref/${breedId}/head-close.jpg`);
    return chain;
  }

  if (isInsectCatalogBreed(breedId)) {
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/insect-ref/${breedId}/three-quarter.jpg`);
    push(`/assets/insect-ref/${breedId}/head-close.jpg`);
    return chain;
  }

  if (isFelineBreed(breedId)) {
    const refBreedId = CAT_REF_BREED_ALIASES[breedId] ?? breedId;
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/cat-ref/${refBreedId}/head-close.jpg`);
    push(`/assets/cat-ref/${refBreedId}/three-quarter.jpg`);
    // Eye-specific stills if variant was a generic filename.
    if (breedId === 'khao-manee') {
      push(`/assets/cat-ref/khao-manee/head-close-${variantId || 'odd-eye'}.jpg`);
      push('/assets/cat-ref/khao-manee/head-close-odd-eye.jpg');
      push('/assets/cat-ref/khao-manee/head-close-blue.jpg');
      push('/assets/cat-ref/khao-manee/head-close-regular.jpg');
    }
    return chain;
  }

  if (isRodentBreed(breedId)) {
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/rodent-ref/${breedId}/head-close.jpg`);
    push(`/assets/rodent-ref/${breedId}/three-quarter.jpg`);
    return chain;
  }

  if (isEquidaeBreed(breedId)) {
    const refBreedId = EQUID_REF_BREED_ALIASES[breedId] ?? breedId;
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/equid-ref/${refBreedId}/head-close.jpg`);
    push(`/assets/equid-ref/${refBreedId}/three-quarter.jpg`);
    return chain;
  }

  if (breedId !== 'golden-retriever' && variantId && !isDogDefaultVariant(breedId, variantId)) {
    push(dogRefUrl(filename, breedId, variantId));
  }
  if (breedId !== 'golden-retriever') {
    push(dogRefUrl(filename, breedId, getDogBreed(breedId)?.defaultVariantId ?? 'default'));
  }
  // Root stills (golden + shared fallbacks for missing breed boards).
  push(`/assets/dog-ref/${filename}`);
  for (const alias of ROOT_REF_ALIASES[filename] ?? []) {
    push(`/assets/dog-ref/${alias}`);
  }
  return chain;
}

/**
 * Reference photo slots for the 5-pair gallery.
 * `refImage` is the primary still shown in the side-by-side compare panel.
 * Extra stills for a preset can live as `{id}-*.jpg` in the same folder.
 */
export const DOG_REFERENCE_PRESETS = [
  {
    id: 'three-quarter',
    label: 'Three-quarter',
    camera: { pos: [1.45, 0.85, 1.55], target: [0, 0.42, 0.05] },
    light: { key: [2.8, 5.5, 2.2], keyIntensity: 1.7, hemi: 1.1 },
    behavior: 'idle',
    settleSeconds: 1.2,
    // Placeholder full-body until authored; currently a head three-quarter still.
    refImage: dogRefUrl('three-quarter.jpg'),
    refFile: 'three-quarter.jpg',
  },
  {
    id: 'profile',
    label: 'Profile',
    camera: { pos: [2.1, 0.55, 0.15], target: [0, 0.45, 0.1] },
    light: { key: [1.2, 4.5, 3.5], keyIntensity: 1.55, hemi: 1.05 },
    behavior: 'look',
    settleSeconds: 1.0,
    refImage: dogRefUrl('head-close-profile.jpg'),
    refFile: 'profile.jpg',
  },
  {
    id: 'front-sit',
    label: 'Front sit',
    camera: { pos: [0.15, 0.7, 2.0], target: [0, 0.38, 0.05] },
    light: { key: [2.0, 5.0, 3.0], keyIntensity: 1.65, hemi: 1.15 },
    behavior: 'sit',
    settleSeconds: 1.6,
    refImage: dogRefUrl('head-close-front.jpg'),
    refFile: 'front-sit.jpg',
  },
  {
    id: 'walk-side',
    label: 'Walk side',
    camera: { pos: [2.4, 0.7, 0.4], target: [0, 0.4, 0] },
    light: { key: [3.0, 5.0, 1.0], keyIntensity: 1.6, hemi: 1.0 },
    behavior: 'walk',
    settleSeconds: 2.0,
    refImage: dogRefUrl('head-close-profile.jpg'),
    refFile: 'profile.jpg',
  },
  {
    id: 'head-close',
    label: 'Head close-up',
    // Framed to match ref portrait: slightly three-quarter, eyes center.
    camera: { pos: [0.42, 0.72, 0.78], target: [0, 0.62, 0.42] },
    light: { key: [1.6, 3.6, 2.6], keyIntensity: 1.5, hemi: 1.1 },
    behavior: 'look',
    settleSeconds: 1.0,
    refImage: dogRefUrl('head-close.jpg'),
    refFile: 'head-close.jpg',
    refAlts: [
      dogRefUrl('head-close-front.jpg'),
      dogRefUrl('head-close-profile.jpg'),
    ],
  },
];

function isTruthyParam(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === '';
}

export class DogSimScene {
  /**
   * @param {{ canvas: HTMLCanvasElement, onSnapshot?: (s: object) => void }} opts
   */
  constructor({ canvas, onSnapshot } = {}) {
    this.canvas = canvas;
    this.onSnapshot = onSnapshot;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.animationFrame = 0;
    this.resizeObserver = null;
    this._disposed = false;

    this.dog = null;
    /** @type {DogClipPlayer | null} */
    this.clipPlayer = null;
    this.status = 'booting';
    this.error = null;
    this.liveMotion = true;
    this.harnessMode = false;
    this.activePresetId = DOG_REFERENCE_PRESETS[0].id;
    this.galleryIndex = 0;
    this.compareEnabled = false;
    this._lastSnapshotEmitMs = 0;
    this.shellCount = 64;
    this.speciesId = 'canidae';
    this.familyId = 'retriever-sporting';
    this.breedId = 'golden-retriever';
    this.variantId = 'default';
    this.seed = 1;
    this._bootNaked = false;

    this.keyLight = null;
    this.hemiLight = null;
    this.fillLight = null;
    /** @type {ReturnType<typeof createDogSimStudioLighting> | null} */
    this.studioLighting = null;

    /** Free-roam: third-person walk-around (shared DogCameraSystem with dog park). */
    this.freeRoam = false;
    /** @type {DogCameraSystem | null} */
    this.chaseCamera = null;
    /** @type {StudioFreeRoamController | null} */
    this.freeRoamController = null;
    /** @type {ReturnType<DogSimScene['_createFreeRoamInput']> | null} */
    this.freeRoamInput = null;
    this._freeRoamSaved = null;
    this._bootFreeRoam = false;

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      this.harnessMode = isTruthyParam(params.get('harness'));
      const shells = Number(params.get('shells'));
      if (Number.isFinite(shells) && shells >= 4 && shells <= 80) {
        this.shellCount = Math.floor(shells);
      }
      if (params.get('naked') === '1') this._bootNaked = true;
      if (params.get('motion') === '0') this.liveMotion = false;
      if (isTruthyParam(params.get('freeRoam')) || isTruthyParam(params.get('roam'))) {
        this._bootFreeRoam = true;
      }
    }
  }

  async start() {
    this.scene = new THREE.Scene();
    // Overwritten in setupEnvironment to match ref stills.
    this.scene.background = new THREE.Color(0xc5cdc6);
    this.scene.fog = new THREE.Fog(0xc5cdc6, 6, 18);

    // Far plane opens further for free-roam; studio orbit stays close.
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
    this.camera.position.set(1.45, 0.85, 1.55);

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    await this.renderer.init();

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.42, 0.05);
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 8;

    this.setupEnvironment();
    this.installResizeObserver();
    this.resize();

    try {
      // Same factory routing as rebuildDog (cat-rig / horse-rig / birds / dog).
      await this.rebuildDog({
        breedId: this.breedId,
        seed: this.seed,
        variantId: this.variantId,
      });
      if (this._bootNaked) this.dog?.setNakedBody(true);

      if (this.harnessMode) {
        this.enterHarnessDefaults();
      } else if (this.dog) {
        // Default framing matches the primary reference still for side-by-side.
        const headClose = DOG_REFERENCE_PRESETS.find((p) => p.id === 'head-close');
        if (headClose) {
          this.dog.animation.setAutopilot(false);
          this.dog.animation.setBehavior('look');
          this.applyPreset(headClose, { settle: false });
        }
      }

      this.status = 'ready';
      this.installDebugApi();
      if (this._bootFreeRoam && !this.harnessMode) {
        this.setFreeRoam(true);
      }
    } catch (err) {
      console.error('[DogSim] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.emitSnapshot();
    this.renderFrame();
  }

  /**
   * Framing scale for chase cam (dog skeleton scale, bird presentation scale).
   * @param {object | null} [animal]
   */
  _animalFramingScale(animal = this.dog) {
    if (!animal) return 1;
    const sk = animal.phenotype?.skeleton?.scale;
    if (Number.isFinite(sk) && sk > 0) return sk;
    const pres = animal.presentation?.scale;
    if (Number.isFinite(pres) && pres > 0) return pres;
    return 1;
  }

  /**
   * Orbit focus bone/root for chase cam (prefer skeleton root when nested).
   * @param {object | null} [animal]
   */
  _chaseTarget(animal = this.dog) {
    if (!animal) return null;
    return animal.rig?.root ?? animal.root ?? null;
  }

  _createFreeRoamInput() {
    const state = {
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      zoomDelta: 0,
      brace: false,
      crouchHeld: false,
      crouchPressed: false,
      mousePrimaryHeld: false,
      mouseSecondaryHeld: false,
      mouseMiddleHeld: false,
      reloadPressed: false,
      keys: new Set(),
    };
    const codeToAxis = () => {
      // Match InputSystem: moveX = right-left, moveZ = backward-forward
      // (W/forward → moveZ = -1). StudioFreeRoamController / DogPlayerController
      // both do desired += cameraForward * (-moveZ); a flipped sign here makes
      // W aim 180° off camera and the chase cam auto-align fights it forever.
      let x = 0;
      let z = 0;
      if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) x -= 1;
      if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) x += 1;
      if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) z -= 1;
      if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) z += 1;
      state.moveX = x;
      state.moveZ = z;
      state.brace = state.keys.has('ShiftLeft') || state.keys.has('ShiftRight');
      state.crouchHeld = state.keys.has('KeyC') || state.keys.has('ControlLeft');
    };

    const onKeyDown = (e) => {
      if (!this.freeRoam) return;
      if (e.code === 'Escape') {
        this.setFreeRoam(false);
        return;
      }
      if (e.code === 'KeyR' && !e.repeat && (e.metaKey || e.ctrlKey)) {
        // avoid browser reload conflict — free roam recenter is plain R
      }
      if (e.code === 'KeyR' && !e.repeat && !e.metaKey && !e.ctrlKey) {
        state.reloadPressed = true;
      }
      state.keys.add(e.code);
      codeToAxis();
      // Don't steal typing in panel selects — only when canvas focused or body.
      if (e.target === this.canvas || e.target === document.body || e.target === document.documentElement) {
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
      }
    };
    const onKeyUp = (e) => {
      state.keys.delete(e.code);
      codeToAxis();
    };
    const onMouseDown = (e) => {
      if (!this.freeRoam) return;
      if (e.button === 0) state.mousePrimaryHeld = true;
      if (e.button === 2) state.mouseSecondaryHeld = true;
      if (e.button === 1) state.mouseMiddleHeld = true;
      this.canvas?.focus?.();
    };
    const onMouseUp = (e) => {
      if (e.button === 0) state.mousePrimaryHeld = false;
      if (e.button === 2) state.mouseSecondaryHeld = false;
      if (e.button === 1) state.mouseMiddleHeld = false;
    };
    const onMouseMove = (e) => {
      if (!this.freeRoam) return;
      if (state.mousePrimaryHeld || state.mouseSecondaryHeld || state.mouseMiddleHeld) {
        state.lookX += e.movementX || 0;
        state.lookY += e.movementY || 0;
      }
    };
    const onWheel = (e) => {
      if (!this.freeRoam) return;
      state.zoomDelta += Math.sign(e.deltaY);
      e.preventDefault();
    };
    const onContextMenu = (e) => {
      if (this.freeRoam) e.preventDefault();
    };
    const onBlur = () => {
      state.keys.clear();
      state.moveX = 0;
      state.moveZ = 0;
      state.brace = false;
      state.crouchHeld = false;
      state.mousePrimaryHeld = false;
      state.mouseSecondaryHeld = false;
      state.mouseMiddleHeld = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.canvas?.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    this.canvas?.addEventListener('wheel', onWheel, { passive: false });
    this.canvas?.addEventListener('contextmenu', onContextMenu);
    if (this.canvas) this.canvas.tabIndex = 0;

    return {
      state,
      consumeFrame() {
        const frame = {
          moveX: state.moveX,
          moveZ: state.moveZ,
          lookX: state.lookX,
          lookY: state.lookY,
          zoomDelta: state.zoomDelta,
          brace: state.brace,
          crouchHeld: state.crouchHeld,
          crouchPressed: false,
          mousePrimaryHeld: state.mousePrimaryHeld,
          mouseSecondaryHeld: state.mouseSecondaryHeld,
          mouseMiddleHeld: state.mouseMiddleHeld,
          reloadPressed: state.reloadPressed,
        };
        state.lookX = 0;
        state.lookY = 0;
        state.zoomDelta = 0;
        state.reloadPressed = false;
        return frame;
      },
      dispose: () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
        this.canvas?.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mousemove', onMouseMove);
        this.canvas?.removeEventListener('wheel', onWheel);
        this.canvas?.removeEventListener('contextmenu', onContextMenu);
      },
    };
  }

  /**
   * Toggle third-person free roam (WASD + dog-park chase camera).
   * @param {boolean} [on]
   */
  setFreeRoam(on) {
    if (this.harnessMode) return false;
    const next = on === undefined ? !this.freeRoam : Boolean(on);
    if (next === this.freeRoam) return this.freeRoam;
    if (next) this._enterFreeRoam();
    else this._exitFreeRoam();
    this.emitSnapshot();
    return this.freeRoam;
  }

  getFreeRoam() {
    return this.freeRoam;
  }

  _enterFreeRoam() {
    if (!this.dog || !this.camera || !this.canvas) return;
    this.freeRoam = true;
    this.liveMotion = true;

    this._freeRoamSaved = {
      camPos: this.camera.position.clone(),
      target: this.controls?.target.clone() ?? new THREE.Vector3(),
      fov: this.camera.fov,
      animalPos: this.dog.root.position.clone(),
      animalYaw: this.dog.animation.getRootYaw?.() ?? 0,
      behavior: this.dog.animation.getBehavior?.() ?? 'idle',
      autopilot: this.dog.animation.getAutopilot?.() ?? false,
      controlsEnabled: this.controls?.enabled ?? true,
    };

    if (this.controls) this.controls.enabled = false;
    this.dog.animation.setAutopilot?.(false);

    // Wider fog so the open floor reads as a roam pad.
    if (this.scene?.fog) {
      this.scene.fog.near = 10;
      this.scene.fog.far = 36;
    }
    this.camera.fov = 48;
    this.camera.updateProjectionMatrix();

    const target = this._chaseTarget();
    const yaw = (this.dog.animation.getRootYaw?.() ?? 0) + Math.PI;
    const framingScale = this._animalFramingScale();
    if (!this.chaseCamera) this.chaseCamera = new DogCameraSystem();
    this.chaseCamera.initialize(this.camera, target, {
      yaw,
      subjectMode: 'player',
      framingScale,
    });

    if (!this.freeRoamController) {
      this.freeRoamController = new StudioFreeRoamController({
        animal: this.dog,
        camera: this.camera,
      });
    } else {
      this.freeRoamController.setAnimal(this.dog);
    }
    this.freeRoamController.enabled = true;

    if (!this.freeRoamInput) {
      this.freeRoamInput = this._createFreeRoamInput();
    }

    // Drop the animal onto the floor origin facing +Z if it was in a portrait pose.
    this.dog.root.position.set(0, 0, 0);
    this.dog.animation.setRootPosition?.(0, 0, 0);
    this.dog.animation.setRootYaw?.(0);
    this.dog.animation.setBehavior?.('idle');
    this.chaseCamera.recenter(0);
    this.chaseCamera.snap();
    this.canvas?.focus?.();
  }

  _exitFreeRoam() {
    this.freeRoam = false;
    if (this.freeRoamController) this.freeRoamController.enabled = false;
    if (this.controls) this.controls.enabled = this._freeRoamSaved?.controlsEnabled ?? true;

    if (this.scene?.fog) {
      this.scene.fog.near = 6;
      this.scene.fog.far = 18;
    }
    if (this._freeRoamSaved) {
      this.camera.fov = this._freeRoamSaved.fov ?? 40;
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this._freeRoamSaved.camPos);
      if (this.controls && this._freeRoamSaved.target) {
        this.controls.target.copy(this._freeRoamSaved.target);
        this.controls.update();
      }
      if (this.dog) {
        this.dog.root.position.copy(this._freeRoamSaved.animalPos);
        const p = this._freeRoamSaved.animalPos;
        this.dog.animation.setRootPosition?.(p.x, p.y, p.z);
        this.dog.animation.setRootYaw?.(this._freeRoamSaved.animalYaw);
        this.dog.animation.setBehavior?.(this._freeRoamSaved.behavior ?? 'idle');
        this.dog.animation.setAutopilot?.(this._freeRoamSaved.autopilot ?? false);
      }
    } else {
      this.camera.fov = 40;
      this.camera.updateProjectionMatrix();
    }
    this._freeRoamSaved = null;
  }

  _rebindFreeRoamAnimal() {
    if (!this.freeRoam || !this.dog) return;
    this.freeRoamController?.setAnimal(this.dog);
    const target = this._chaseTarget();
    this.chaseCamera?.setTarget(target, {
      yaw: (this.dog.animation.getRootYaw?.() ?? 0) + Math.PI,
      subjectMode: 'player',
      framingScale: this._animalFramingScale(),
      snap: true,
    });
  }

  enterHarnessDefaults() {
    this.liveMotion = false;
    this.dog?.animation.setAutopilot(false);
    this.dog?.animation.setFrozenBlink(true);
    this.dog?.animation.setFrozenBreeze(true);
    this.dog?.animation.setBehavior('idle');
    this.applyPreset(DOG_REFERENCE_PRESETS[0], { settle: true });
  }

  setupEnvironment() {
    // Realtime studio stack: SSGI + AO, SSR, denoisers, LightProbeGrid probes.
    this.studioLighting?.dispose?.();
    this.studioLighting = createDogSimStudioLighting({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
    });
    // Compatibility aliases used by applyPreset / harness lighting.
    this.hemiLight = this.studioLighting.lights.hemi;
    this.keyLight = this.studioLighting.lights.sun;
    this.fillLight = this.studioLighting.lights.fill;
  }

  /**
   * Live studio lighting / post / sky / floor controls.
   * @param {object} patch
   * @param {{ rebakeProbes?: boolean, rebuildPipeline?: boolean }} [opts]
   */
  setStudioLighting(patch = {}, opts = {}) {
    this.studioLighting?.setSettings?.(patch, opts);
    this.emitSnapshot();
  }

  getStudioLighting() {
    return this.studioLighting?.snapshot?.() ?? null;
  }

  rebakeStudioProbes() {
    return this.studioLighting?.bakeProbes?.();
  }

  /**
   * @param {typeof DOG_REFERENCE_PRESETS[0]} preset
   * @param {{ settle?: boolean }} [opts]
   */
  applyPreset(preset, opts = {}) {
    if (!preset || !this.dog) return;
    this.activePresetId = preset.id;

    if (preset.light && this.studioLighting) {
      // Map legacy preset key position → sun azimuth/elevation + intensities.
      const [kx, ky, kz] = preset.light.key ?? [2.2, 5, 3];
      const az = THREE.MathUtils.radToDeg(Math.atan2(kx, kz));
      const elev = THREE.MathUtils.radToDeg(Math.atan2(ky, Math.hypot(kx, kz)));
      this.studioLighting.setSettings({
        sunAzimuth: az,
        sunElevation: elev,
        sunIntensity: preset.light.keyIntensity ?? 1.6,
        hemiIntensity: preset.light.hemi ?? 1.1,
      });
    } else if (preset.light && this.keyLight && this.hemiLight) {
      this.keyLight.position.fromArray(preset.light.key);
      this.keyLight.intensity = preset.light.keyIntensity ?? 1.6;
      this.hemiLight.intensity = preset.light.hemi ?? 1.1;
    }

    this.dog.animation.setAutopilot(false);
    // Free roam owns root TRS + chase cam — only apply lighting/mouth here.
    if (!this.freeRoam) {
      this.dog.animation.setBehavior(preset.behavior ?? 'idle');
      this.dog.animation.setRootPosition(0, 0, 0);
      this.dog.animation.setRootYaw(0);
    }
    // Studio/harness stills keep a closed mouth so faces match photo boards
    // (open pant reads as a dog gape on rodents/cats). Sit is still a
    // quadruped crouch — upright sciurid sit needs a dedicated pose kit.
    this.dog.animation.setMouthState(preset.mouthState ?? 'closed');

    if (opts.settle !== false && this.harnessMode) {
      this.settleSeconds(preset.settleSeconds ?? 1.0);
      // Snap closed after damp so residual pant blend can't flash teeth/jaw.
      if ((preset.mouthState ?? 'closed') === 'closed') {
        this.dog.animation.setMouthState('closed');
        this.dog.face?.setMouthOpen?.(0, 0, 0, 0, false);
      }
    }
    if (!this.freeRoam) this.frameDogForPreset(preset);
    this.emitSnapshot();
  }

  frameDogForPreset(preset) {
    if (this.freeRoam) return;
    if (!this.dog || !this.camera || !this.controls) return;
    this.dog.root.updateMatrixWorld(true);
    const isBird = Boolean(this.dog.isBird);
    // Birds: core-body bones only — Flap/bind hang wing tips to y≈-2 and blow
    // out the full mesh AABB, which pins the camera too far back.
    const bounds = isBird && this.dog.animation?.getCoreBounds
      ? this.dog.animation.getCoreBounds()
      : new THREE.Box3().setFromObject(this.dog.root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    center.y = bounds.min.y + size.y * 0.5;

    const sourcePos = new THREE.Vector3().fromArray(preset.camera.pos);
    const sourceTarget = new THREE.Vector3().fromArray(preset.camera.target);
    const direction = sourcePos.sub(sourceTarget).normalize();
    let target = center;
    let framingExtent = Math.max(size.x, size.y, size.z, 0.2);
    if (isBird) {
      framingExtent = Math.max(size.x, size.z * 0.9, size.y, 0.16);
    }
    if (preset.id === 'head-close') {
      const head = this.dog.rig?.bonesByName?.get('Head')
        ?? this.dog.rig?.bonesByName?.get('head');
      if (head) target = head.getWorldPosition(new THREE.Vector3());
      const headSize = this.dog.phenotype?.skeleton?.headSize ?? 1;
      const scale = this.dog.phenotype?.skeleton?.scale ?? 1;
      framingExtent = Math.max(
        isBird ? 0.08 : 0.12,
        (isBird ? 0.2 : 0.24) * headSize * scale,
      );
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const pad = isBird ? (preset.id === 'head-close' ? 1.35 : 1.12) : (preset.id === 'head-close' ? 1.16 : 0.88);
    const distance = (framingExtent * pad) / Math.tan(fov * 0.5);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.controls.target.copy(target);
    this.controls.minDistance = Math.max(0.15, framingExtent * 0.7);
    this.controls.maxDistance = Math.max(4, framingExtent * 12);
    this.controls.update();
  }

  /**
   * Synchronous fixed-timestep settle for deterministic harness frames.
   * @param {number} seconds
   */
  settleSeconds(seconds) {
    if (!this.dog) return;
    const steps = Math.max(1, Math.round(seconds / FIXED_DT));
    const isBird = Boolean(this.dog.isBird);
    for (let i = 0; i < steps; i += 1) {
      const clipReady = !this.harnessMode && Boolean(this.clipPlayer?.ready);
      // Skeleton clips own body TRS when the library is ready — skip procedural gait.
      this.dog.animation?.setClipDriven?.(isBird || clipReady);
      this.dog.update(FIXED_DT, {
        fixed: true,
        time: this.dog.animation.getTime(),
        plantFeet: !isBird && !clipReady,
      });
      // Harness stays procedural-only for deterministic screenshots; live studio
      // advances retargeted skeleton clips as the sole body pose writer.
      if (!this.harnessMode && !isBird) {
        this.clipPlayer?.update?.(FIXED_DT, this.dog.animation.getBehavior());
        if (this.clipPlayer?.ready) {
          this.dog.animation?.applyPostClipOverlays?.();
          plantDogFeet(this.dog, { getGroundHeight: () => 0 });
        }
      }
    }
  }

  /**
   * Attach the shared dog-bone clip library (Walk/Run/Sit/Idle) when enabled.
   * Skipped in harness mode so visual probes stay deterministic.
   * @param {ReturnType<typeof createProceduralDog>} dog
   */
  _bindClipPlayer(dog) {
    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;
    // Birds embed Flap/Glide/Idle/Walk on the GLB — animation facade owns them.
    if (dog?.isBird || this.harnessMode || !animalUsesDogClipLibrary(dog)) return;
    this.clipPlayer = new DogClipPlayer(dog);
    void this.clipPlayer.initialize();
  }

  /**
   * One-click 5-pair gallery cycle.
   * @param {number} [index]
   */
  showGalleryPair(index) {
    const i = ((index ?? this.galleryIndex) % DOG_REFERENCE_PRESETS.length + DOG_REFERENCE_PRESETS.length)
      % DOG_REFERENCE_PRESETS.length;
    this.galleryIndex = i;
    this.applyPreset(DOG_REFERENCE_PRESETS[i], { settle: true });
    return DOG_REFERENCE_PRESETS[i];
  }

  nextGalleryPair() {
    return this.showGalleryPair(this.galleryIndex + 1);
  }

  setBehavior(id) {
    this.dog?.animation.setAutopilot(false);
    // Behavior grid owns procedural mapping — release any studio clip pin.
    this.clipPlayer?.clearPin?.();
    this.dog?.animation.setBehavior(id);
    this.emitSnapshot();
  }

  /**
   * Play a retargeted horse→dog GLB clip by source name (Idle, Walk, Bark, …).
   * @param {string} name
   */
  setClip(name) {
    if (!name) return false;
    this.liveMotion = true;
    this.dog?.animation.setAutopilot(false);
    // Bird / goose / cat clips are driven by the animation facade (GLB or
    // procedural) rather than the retargeted dog-bone clip player.
    if (this.dog?.isBird || this.dog?.rigKind === 'cat' || this.dog?.rigKind === 'horse') {
      const catalog = this.dog.birdClips ?? this.dog.catClips ?? this.dog.horseClips ?? GOOSE_CLIP_CATALOG;
      const entry = catalog.find((item) => item.name === name) ?? null;
      if (entry?.behavior) this.dog.animation.setBehavior(entry.behavior);
      const ok = this.dog.animation.playClip?.(name) ?? false;
      this.emitSnapshot();
      return ok;
    }
    if (!this.clipPlayer) return false;
    const catalog = this.clipPlayer.snapshot?.()?.catalog
      ?? null;
    const entry = Array.isArray(catalog)
      ? catalog.find((item) => item.name === name)
      : null;
    // Align procedural behavior when the clip has a matching gait slot so
    // secondary motion (mouth/tail) stays consistent.
    if (entry?.behavior) {
      this.dog?.animation.setBehavior(entry.behavior);
    }
    const ok = this.clipPlayer.playClip(name);
    this.emitSnapshot();
    return ok;
  }

  setMouthState(id) {
    this.dog?.animation.setMouthState(id);
    this.emitSnapshot();
  }

  setLiveMotion(on) {
    this.liveMotion = Boolean(on);
    this.emitSnapshot();
  }

  setNakedBody(on) {
    this.dog?.setNakedBody(on);
    this.emitSnapshot();
  }

  /**
   * Rebuild the active animal. Birds are async goose-body varieties; cat-rig
   * breeds build the bespoke procedural cat; insects update catalog identity
   * only (no mesh yet); other quadrupeds stay synchronous via createProceduralDog.
   */
  async rebuildDog({ breedId = this.breedId, seed = this.seed, variantId } = {}) {
    if (!this.scene) return null;
    // Keep catalog identity; silhouette falls back inside resolveDogPhenotype
    // when the breed is not authored. `cat-rig` / `horse-rig` breeds route to
    // their bespoke pipelines below.
    const normalizedBreedId = isAvianBreed(breedId)
      ? normalizeDogBreedId(breedId, 'eastern-phoebe')
      : isInsectCatalogBreed(breedId)
        ? normalizeDogBreedId(breedId, 'seven-spotted-ladybug')
        : normalizeDogBreedId(breedId);
    const normalizedSeed = normalizeDogSeed(seed);
    const breedChanged = normalizedBreedId !== this.breedId;
    // Explicit variantId always wins. Otherwise: breed change resets to that
    // breed's default variant; seed-only changes (randomize) keep the current
    // variant so gallery pairs stay a fair A/B of the same coat.
    const normalizedVariantId = normalizeDogVariantId(
      normalizedBreedId,
      variantId ?? (breedChanged ? undefined : this.variantId),
    );

    // Other Insecta entries stay catalog-only until their mesh ships. Ladybug
    // routes through createProceduralLadybug below.
    if (isInsectCatalogBreed(normalizedBreedId) && !isLadybugRigBreed(normalizedBreedId)) {
      const insectBreed = getDogBreed(normalizedBreedId);
      this.breedId = normalizedBreedId;
      this.familyId = insectBreed?.familyId ?? this.familyId;
      this.speciesId = getSpeciesIdForBreed(normalizedBreedId)
        ?? getSpeciesIdForFamily(this.familyId)
        ?? 'coccinellidae';
      this.variantId = normalizedVariantId;
      this.seed = normalizedSeed;
      this.emitSnapshot();
      return this.dog;
    }

    const previous = this.dog;
    const state = previous ? {
      behavior: previous.animation.getBehavior(),
      autopilot: previous.animation.getAutopilot(),
      mouthState: previous.animation.getMouthState(),
      time: previous.animation.getTime(),
      rootPosition: previous.animation.getRootPosition(),
      rootYaw: previous.animation.getRootYaw(),
      nakedBody: previous.getNakedBody(),
      showFur: previous.getShowFur(),
    } : null;

    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;

    const gen = (this._rebuildGen = (this._rebuildGen ?? 0) + 1);

    let next;
    if (isAvianBreed(normalizedBreedId)) {
      // All birds are varieties of the procedural Canada-goose body (own 53-bone
      // rig + shell plumage). Per-breed identity is scale/palette/pattern knobs.
      next = await createProceduralGoose({
        breedId: normalizedBreedId,
        seed: normalizedSeed,
        variantId: normalizedVariantId,
        shellCount: this.shellCount,
      });
      if (this._disposed || gen !== this._rebuildGen) {
        next.dispose();
        return this.dog;
      }
    } else if (isCatRigBreed(normalizedBreedId)) {
      // The "Tortoiseshell (Procedural)" catalog entry (flag: cat-rig) gets its
      // own fully-procedural pipeline (bespoke ~50-bone rig, ring-loft body,
      // tortoiseshell shell coat, feline IK/FSM animation) instead of deriving
      // from the shared dog rig. All other felines stay dog-derived stubs.
      next = createProceduralCat({
        breedId: normalizedBreedId,
        seed: normalizedSeed,
        variantId: normalizedVariantId,
        shellCount: this.shellCount,
      });
    } else if (isHorseRigBreed(normalizedBreedId)) {
      // "Domestic Horse v2 (Procedural)" (flag: horse-rig) gets its own
      // fully-procedural pipeline (bespoke ~120-bone rig, ring-loft body,
      // bay shell coat, equine gait/IK/FSM animation) instead of deriving
      // from the shared dog rig. v1 domestic-horse stays dog-derived.
      next = createProceduralHorse({
        breedId: normalizedBreedId,
        seed: normalizedSeed,
        variantId: normalizedVariantId,
        shellCount: this.shellCount,
      });
    } else if (isLadybugRigBreed(normalizedBreedId)) {
      next = createProceduralLadybug({
        breedId: normalizedBreedId,
        seed: normalizedSeed,
        variantId: normalizedVariantId,
        shellCount: Math.min(this.shellCount ?? 12, 16),
      });
    } else {
      next = createProceduralDog({
        breedId: normalizedBreedId,
        seed: normalizedSeed,
        variantId: normalizedVariantId,
        shellCount: this.shellCount,
      });
    }

    this.scene.add(next.root);
    if (state) {
      next.animation.setBehavior(state.behavior);
      next.animation.setAutopilot(state.autopilot);
      next.animation.setMouthState(state.mouthState);
      next.animation.setTime(state.time);
      next.animation.setRootPosition(state.rootPosition.x, state.rootPosition.y, state.rootPosition.z);
      next.animation.setRootYaw(state.rootYaw);
      next.setNakedBody?.(state.nakedBody);
      next.setShowFur?.(state.showFur);
    }
    if (this.harnessMode) {
      next.animation.setFrozenBlink?.(true);
      next.animation.setFrozenBreeze?.(true);
    }
    this.dog = next;
    this.breedId = next.breedId;
    this.familyId = next.familyId;
    this.speciesId = next.speciesId
      ?? getSpeciesIdForFamily(next.familyId)
      ?? 'canidae';
    this.variantId = next.variantId;
    this.seed = next.seed;
    previous?.dispose();
    this._bindClipPlayer(next);
    // Subject changed — refresh probe SH so bounce matches the new coat/shape.
    void this.studioLighting?.bakeProbes?.();

    if (this.freeRoam) {
      // Keep free roam through breed swaps; re-bind chase cam + controller.
      this.dog.root.position.set(0, 0, 0);
      this.dog.animation.setRootPosition?.(0, 0, 0);
      this.dog.animation.setRootYaw?.(0);
      this.dog.animation.setAutopilot?.(false);
      this._rebindFreeRoamAnimal();
    } else {
      const preset = DOG_REFERENCE_PRESETS.find((item) => item.id === this.activePresetId)
        ?? DOG_REFERENCE_PRESETS[0];
      this.frameDogForPreset(preset);
    }
    this.emitSnapshot();
    return next;
  }

  setBreed(breedId) {
    return this.rebuildDog({ breedId });
  }

  setSpecies(speciesId) {
    const key = String(speciesId ?? '').trim().toLowerCase();
    const species = ANIMAL_SPECIES.find((entry) => entry.id === key);
    if (!species) return null;
    this.speciesId = key;
    const families = getPopulatedFamiliesForSpecies(key);
    if (!families.length) {
      // Master list entry with no authored breeds yet — keep selection, clear active dog choice.
      this.familyId = getFamiliesForSpecies(key)[0]?.id ?? null;
      this.emitSnapshot();
      return this.dog;
    }
    if (families.some((family) => family.id === this.familyId)) {
      this.emitSnapshot();
      return this.dog;
    }
    return this.setFamily(families[0].id);
  }

  setFamily(familyId) {
    const breeds = getDogBreeds(familyId);
    if (!breeds.length) {
      this.familyId = familyId;
      this.speciesId = getSpeciesIdForFamily(familyId) ?? this.speciesId;
      this.emitSnapshot();
      return null;
    }
    this.speciesId = getSpeciesIdForFamily(familyId) ?? this.speciesId;
    if (breeds.some((breed) => breed.id === this.breedId)) {
      this.familyId = familyId;
      this.emitSnapshot();
      return this.dog;
    }
    return this.setBreed(breeds[0].id);
  }

  setSeed(seed) {
    return this.rebuildDog({ seed });
  }

  setVariant(variantId) {
    return this.rebuildDog({ variantId });
  }

  randomize() {
    let nextSeed;
    if (globalThis.crypto?.getRandomValues) {
      nextSeed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    } else {
      nextSeed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    }
    if (nextSeed === this.seed) nextSeed = (nextSeed + 1) >>> 0;
    return this.setSeed(nextSeed);
  }

  setCompareEnabled(on) {
    this.compareEnabled = Boolean(on);
    this.emitSnapshot();
  }

  petImpulse() {
    this.dog?.furDynamics.addImpulse(new THREE.Vector3(
      (Math.random() - 0.5) * 0.4,
      0.15,
      (Math.random() - 0.5) * 0.3,
    ));
  }

  installDebugApi() {
    if (typeof window === 'undefined') return;
    const api = {
      get status() { return thisRef.status; },
      get harness() { return thisRef.harnessMode; },
      get snapshot() { return thisRef.buildSnapshot(); },
      settle: (s) => thisRef.settleSeconds(s),
      applyPreset: (id) => {
        const p = DOG_REFERENCE_PRESETS.find((x) => x.id === id);
        if (p) thisRef.applyPreset(p, { settle: true });
        return p ?? null;
      },
      gallery: () => DOG_REFERENCE_PRESETS.map((p) => p.id),
      catalog: () => ({
        species: ANIMAL_SPECIES,
        families: DOG_FAMILIES,
        breeds: DOG_BREEDS,
        authoredBreedIds: AUTHORED_DOG_BREED_IDS,
      }),
      getResolvedTraits: () => thisRef.dog?.resolvedTraits ?? null,
      showGalleryPair: (i) => thisRef.showGalleryPair(i),
      nextGalleryPair: () => thisRef.nextGalleryPair(),
      setBehavior: (b) => thisRef.setBehavior(b),
      setClip: (name) => thisRef.setClip(name),
      setMouthState: (m) => thisRef.setMouthState(m),
      setLiveMotion: (v) => thisRef.setLiveMotion(v),
      setNakedBody: (v) => thisRef.setNakedBody(v),
      setCompareEnabled: (v) => thisRef.setCompareEnabled(v),
      setStudioLighting: (patch, opts) => thisRef.setStudioLighting(patch, opts),
      getStudioLighting: () => thisRef.getStudioLighting(),
      rebakeStudioProbes: () => thisRef.rebakeStudioProbes(),
      setBreed: (id) => thisRef.setBreed(id)?.breedId ?? null,
      setSpecies: (id) => thisRef.setSpecies(id)?.speciesId ?? thisRef.speciesId,
      setFamily: (id) => thisRef.setFamily(id)?.familyId ?? thisRef.familyId,
      setSeed: (seed) => thisRef.setSeed(seed)?.seed ?? null,
      setVariant: (id) => thisRef.setVariant(id)?.variantId ?? null,
      getVariants: () => getDogVariants(thisRef.breedId),
      randomize: () => thisRef.randomize()?.seed ?? null,
      setCamera: (pos, target) => {
        thisRef.camera?.position.fromArray(pos);
        if (target) thisRef.controls?.target.fromArray(target);
        thisRef.controls?.update();
      },
      pet: () => thisRef.petImpulse(),
      setFreeRoam: (on) => thisRef.setFreeRoam(on),
      getFreeRoam: () => thisRef.getFreeRoam(),
      renderOnce: async () => {
        thisRef.dog?.update(0, { fixed: true });
        thisRef.controls?.update();
        if (thisRef.studioLighting) {
          thisRef.studioLighting.render();
        } else if (thisRef.renderer && thisRef.scene && thisRef.camera) {
          await thisRef.renderer.renderAsync(thisRef.scene, thisRef.camera);
        }
      },
      // Live handle for look-dev probes (harness iteration only).
      getDog: () => thisRef.dog,
      getBreedId: () => thisRef.breedId,
      rebuildDog: (opts) => thisRef.rebuildDog(opts ?? {}),
      getBoneCount: () => thisRef.dog?.boneCount ?? 0,
      getBoneWorldPosition: (name) => {
        const bone = thisRef.dog?.rig.bonesByName.get(name);
        return bone ? bone.getWorldPosition(new THREE.Vector3()).toArray() : null;
      },
      getVertexCount: () => thisRef.dog?.vertexCount ?? 0,
      getShellCount: () => thisRef.dog?.shellCount ?? 0,
    };
    const thisRef = this;
    window.__DOG_SIM_DEBUG__ = api;
  }

  buildSnapshot() {
    const breed = getDogBreed(this.breedId);
    const preset = DOG_REFERENCE_PRESETS.find((item) => item.id === this.activePresetId);
    const variants = getDogVariants(this.breedId);
    return {
      status: this.status,
      error: this.error,
      harness: this.harnessMode,
      freeRoam: this.freeRoam,
      liveMotion: this.liveMotion,
      nakedBody: this.dog?.getNakedBody() ?? false,
      showFur: this.dog?.getShowFur() ?? true,
      compareEnabled: this.compareEnabled,
      behavior: this.dog?.animation.getBehavior() ?? '—',
      autopilot: this.dog?.animation.getAutopilot() ?? false,
      mouthState: this.dog?.animation.getMouthState() ?? 'closed',
      bones: this.dog?.boneCount ?? 0,
      verts: this.dog?.vertexCount ?? 0,
      shells: this.dog?.shellCount ?? 0,
      speciesId: this.speciesId,
      speciesLabel: ANIMAL_SPECIES.find((entry) => entry.id === this.speciesId)?.label ?? this.speciesId,
      familyId: this.familyId,
      breedId: this.breedId,
      breedLabel: breed?.label ?? 'Golden Retriever',
      isInsect: isInsectCatalogBreed(this.breedId)
        || this.dog?.isInsect
        || this.dog?.rigKind === 'insect'
        || ANIMAL_SPECIES.find((entry) => entry.id === this.speciesId)?.orderId === 'insecta',
      animationClips: (this.dog?.isBird || this.dog?.rigKind === 'cat' || this.dog?.rigKind === 'horse' || this.dog?.rigKind === 'insect')
        ? (() => {
          const catalog = this.dog.ladybugClips
            ?? this.dog.birdClips
            ?? this.dog.catClips
            ?? this.dog.horseClips
            ?? (this.dog?.rigKind === 'insect' ? LADYBUG_CLIP_CATALOG
              : this.dog?.rigKind === 'horse' ? HORSE_CLIP_CATALOG : GOOSE_CLIP_CATALOG);
          return {
            enabled: true,
            ready: true,
            library: this.dog.rigKind === 'insect'
              ? 'ladybug'
              : this.dog.rigKind === 'cat'
                ? 'cat'
                : this.dog.rigKind === 'horse'
                  ? 'horse'
                  : (this.dog.isBird || this.dog.rigKind === 'goose' || this.dog.phenotype?.rigKind === 'goose')
                    ? 'goose'
                    : 'bird',
            clip: this.dog.animation.getCurrentClip?.()
              ?? this.dog.animation.getBehavior?.()
              ?? null,
            clips: catalog.length,
            available: catalog.map((c) => c.name),
            pinned: null,
            catalog,
          };
        })()
        : (this.clipPlayer?.snapshot?.() ?? {
          enabled: false,
          ready: false,
          clip: null,
          clips: 0,
          available: [],
          pinned: null,
          catalog: null,
        }),
      seed: this.seed,
      breedSummary: breed?.summary ?? null,
      akcRank: breed?.popularity.rank ?? null,
      resolvedTraits: this.dog?.resolvedTraits ?? null,
      variantId: this.variantId,
      variantLabel: variants.find((variant) => variant.id === this.variantId)?.label ?? 'Standard',
      variants,
      referenceImage: preset
        ? dogRefUrl(preset.refFile ?? 'three-quarter.jpg', this.breedId, this.variantId)
        : null,
      referenceImageChain: preset
        ? dogRefUrlChain(preset.refFile ?? 'three-quarter.jpg', this.breedId, this.variantId)
        : [],
      preset: this.activePresetId,
      galleryIndex: this.galleryIndex,
      speed: Number((
        this.freeRoamController?.horizontalSpeed
        ?? this.dog?.animation.getMoveSpeed()
        ?? 0
      ).toFixed(2)),
      time: Number((this.dog?.animation.getTime() ?? 0).toFixed(2)),
      studioLighting: this.studioLighting?.snapshot?.() ?? null,
      freeRoamMotion: this.freeRoam ? this.freeRoamController?.snapshot?.() ?? null : null,
      chaseCamera: this.freeRoam ? this.chaseCamera?.snapshot?.() ?? null : null,
    };
  }

  emitSnapshot() {
    this.onSnapshot?.(this.buildSnapshot());
  }

  installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  resize() {
    if (!this.canvas || !this.renderer || !this.camera) return;
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  renderFrame = () => {
    if (this._disposed) return;
    this.animationFrame = requestAnimationFrame(this.renderFrame);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.dog && this.status === 'ready') {
      if (this.freeRoam && this.freeRoamController?.enabled) {
        const input = this.freeRoamInput?.consumeFrame?.() ?? {};
        const isBird = Boolean(this.dog.isBird);
        const clipReady = Boolean(this.clipPlayer?.ready);
        this.dog.animation?.setClipDriven?.(isBird || clipReady);
        // Controller advances root + calls animal.update for pose.
        this.freeRoamController.update(dt, input);
        this.clipPlayer?.update?.(dt, this.dog.animation.getBehavior());
        if (clipReady && !isBird) {
          this.dog.animation?.applyPostClipOverlays?.();
          plantDogFeet(this.dog, { getGroundHeight: () => 0 });
        }
        const anim = this.dog.animation;
        const controller = this.freeRoamController;
        this.chaseCamera?.update(dt, input, {
          headingYaw: anim?.getRootYaw?.() ?? 0,
          yawRate: anim?.getYawRate?.() ?? controller?.yawRate ?? 0,
          moving: (controller?.horizontalSpeed ?? 0) > 0.08
            || anim?.getBehavior?.() === 'walk'
            || anim?.getBehavior?.() === 'trot',
          speed: controller?.horizontalSpeed ?? anim?.getMoveSpeed?.() ?? 0,
          forwardIntent: controller?.forwardIntent ?? 0,
        });
      } else if (this.liveMotion) {
        const isBird = Boolean(this.dog.isBird);
        const clipReady = Boolean(this.clipPlayer?.ready);
        // Retargeted clips take priority: no procedural body gait when ready.
        // Birds always drive pose from embedded GLB clips.
        this.dog.animation?.setClipDriven?.(isBird || clipReady);
        this.dog.update(dt, { plantFeet: !isBird && !clipReady });
        this.clipPlayer?.update?.(dt, this.dog.animation.getBehavior());
        // Clip is the sole body pose writer — plant pads after the mixer.
        // Mouth/jaw/ears reapply after the sample so pant/alert still work.
        // Birds plant toes inside createBirdAnimation.update (foot bones only).
        if (clipReady && !isBird) {
          this.dog.animation?.applyPostClipOverlays?.();
          plantDogFeet(this.dog, { getGroundHeight: () => 0 });
        }
      } else if (!this.harnessMode && this.dog.furDynamics?.update) {
        // Still advance fur time gently when paused? keep frozen in harness.
        this.dog.furDynamics.update(dt, this.dog.animation.getRootPosition(), {
          time: this.dog.animation.getTime(),
          breeze: this.dog.animation.isFrozenBreeze() ? 0 : 0.2,
        });
      }
    }

    if (!this.freeRoam) this.controls?.update();
    if (this.studioLighting) {
      this.studioLighting.render();
    } else if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    // Throttle snapshot UI updates (~4 Hz). Avoid recreating ref URL chains
    // every frame — that reset the compare <img> fallback index and flashed.
    const now = performance.now();
    if (now - this._lastSnapshotEmitMs >= 250) {
      this._lastSnapshotEmitMs = now;
      this.emitSnapshot();
    }
  };

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.freeRoam) this._exitFreeRoam();
    this.freeRoamInput?.dispose?.();
    this.freeRoamInput = null;
    this.freeRoamController = null;
    this.chaseCamera?.dispose?.();
    this.chaseCamera = null;
    this.controls?.dispose();
    this.controls = null;
    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;
    this.dog?.dispose();
    this.dog = null;
    this.studioLighting?.dispose?.();
    this.studioLighting = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    if (typeof window !== 'undefined' && window.__DOG_SIM_DEBUG__) {
      delete window.__DOG_SIM_DEBUG__;
    }
  }
}
