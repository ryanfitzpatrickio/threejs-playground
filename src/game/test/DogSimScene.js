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
  getSpeciesIdForFamily,
  normalizeDogBreedId,
  normalizeDogSeed,
  normalizeDogVariantId,
} from '../characters/dog/index.js';
import { createDogSimStudioLighting } from './createDogSimStudioLighting.js';

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

function isFelineBreed(breedId) {
  return getDogBreed(breedId)?.familyId === 'feline';
}

function isRodentBreed(breedId) {
  const breed = getDogBreed(breedId);
  return Boolean(breed?.conformationFlags?.includes('rodent'));
}

/** Resolve a still under public/assets/dog-ref/, cat-ref/, or rodent-ref/. */
export function dogRefUrl(filename, breedId = 'golden-retriever', variantId = 'default') {
  if (isFelineBreed(breedId)) {
    // Khao Manee eye variants use head-close-<variant>.jpg; other cats use head-close.jpg.
    if (breedId === 'khao-manee' && variantId && variantId !== 'default') {
      const stem = filename.replace(/\.jpg$/i, '');
      if (stem === 'head-close' || stem === 'three-quarter' || stem === 'profile' || stem === 'front-sit') {
        return `/assets/cat-ref/${breedId}/head-close-${variantId}.jpg`;
      }
    }
    return `/assets/cat-ref/${breedId}/${filename}`;
  }
  if (isRodentBreed(breedId)) {
    return `/assets/rodent-ref/${breedId}/${filename}`;
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

  if (isFelineBreed(breedId)) {
    push(dogRefUrl(filename, breedId, variantId));
    push(`/assets/cat-ref/${breedId}/head-close.jpg`);
    push(`/assets/cat-ref/${breedId}/three-quarter.jpg`);
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

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      this.harnessMode = isTruthyParam(params.get('harness'));
      const shells = Number(params.get('shells'));
      if (Number.isFinite(shells) && shells >= 4 && shells <= 80) {
        this.shellCount = Math.floor(shells);
      }
      if (params.get('naked') === '1') this._bootNaked = true;
      if (params.get('motion') === '0') this.liveMotion = false;
    }
  }

  async start() {
    this.scene = new THREE.Scene();
    // Overwritten in setupEnvironment to match ref stills.
    this.scene.background = new THREE.Color(0xc5cdc6);
    this.scene.fog = new THREE.Fog(0xc5cdc6, 6, 18);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
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
      this.dog = createProceduralDog({
        breedId: this.breedId,
        seed: this.seed,
        variantId: this.variantId,
        shellCount: this.shellCount,
      });
      this.variantId = this.dog.variantId;
      this.scene.add(this.dog.root);
      if (this._bootNaked) this.dog.setNakedBody(true);
      this._bindClipPlayer(this.dog);
      // Bake probes after the dog is in the scene so SH capture sees the subject.
      void this.studioLighting?.bakeProbes?.();

      if (this.harnessMode) {
        this.enterHarnessDefaults();
      } else {
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
    } catch (err) {
      console.error('[DogSim] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.emitSnapshot();
    this.renderFrame();
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
    this.dog.animation.setBehavior(preset.behavior ?? 'idle');
    this.dog.animation.setRootPosition(0, 0, 0);
    this.dog.animation.setRootYaw(0);
    // Studio/harness stills keep a closed mouth so faces match photo boards
    // (open pant reads as a dog gape on rodents/cats). Sit is still a
    // quadruped crouch — upright sciurid sit needs a dedicated pose kit.
    this.dog.animation.setMouthState(preset.mouthState ?? 'closed');

    if (opts.settle !== false && this.harnessMode) {
      this.settleSeconds(preset.settleSeconds ?? 1.0);
      // Snap closed after damp so residual pant blend can't flash teeth/jaw.
      if ((preset.mouthState ?? 'closed') === 'closed') {
        this.dog.animation.setMouthState('closed');
        this.dog.face?.setMouthOpen(0, 0, 0, 0, false);
      }
    }
    this.frameDogForPreset(preset);
    this.emitSnapshot();
  }

  frameDogForPreset(preset) {
    if (!this.dog || !this.camera || !this.controls) return;
    this.dog.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.dog.root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    center.y = bounds.min.y + size.y * 0.5;

    const sourcePos = new THREE.Vector3().fromArray(preset.camera.pos);
    const sourceTarget = new THREE.Vector3().fromArray(preset.camera.target);
    const direction = sourcePos.sub(sourceTarget).normalize();
    let target = center;
    let framingExtent = Math.max(size.x, size.y, size.z, 0.2);
    if (preset.id === 'head-close') {
      const head = this.dog.rig.bonesByName.get('Head');
      if (head) target = head.getWorldPosition(new THREE.Vector3());
      framingExtent = Math.max(
        0.12,
        0.24 * this.dog.phenotype.skeleton.headSize * this.dog.phenotype.skeleton.scale,
      );
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (framingExtent * (preset.id === 'head-close' ? 1.16 : 0.88)) / Math.tan(fov * 0.5);
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
    for (let i = 0; i < steps; i += 1) {
      const clipReady = !this.harnessMode && Boolean(this.clipPlayer?.ready);
      // Skeleton clips own body TRS when the library is ready — skip procedural gait.
      this.dog.animation?.setClipDriven?.(clipReady);
      this.dog.update(FIXED_DT, {
        fixed: true,
        time: this.dog.animation.getTime(),
        plantFeet: !clipReady,
      });
      // Harness stays procedural-only for deterministic screenshots; live studio
      // advances retargeted skeleton clips as the sole body pose writer.
      if (!this.harnessMode) {
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
    if (this.harnessMode || !animalUsesDogClipLibrary(dog)) return;
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
    if (!name || !this.clipPlayer) return false;
    this.liveMotion = true;
    this.dog?.animation.setAutopilot(false);
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

  rebuildDog({ breedId = this.breedId, seed = this.seed, variantId } = {}) {
    if (!this.scene) return null;
    // Keep catalog identity (feline stubs stay "siamese"); silhouette falls back
    // inside resolveDogPhenotype when the breed is not authored.
    const normalizedBreedId = normalizeDogBreedId(breedId);
    const normalizedSeed = normalizeDogSeed(seed);
    const breedChanged = normalizedBreedId !== this.breedId;
    // Explicit variantId always wins. Otherwise: breed change resets to that
    // breed's default variant; seed-only changes (randomize) keep the current
    // variant so gallery pairs stay a fair A/B of the same coat.
    const normalizedVariantId = normalizeDogVariantId(
      normalizedBreedId,
      variantId ?? (breedChanged ? undefined : this.variantId),
    );
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

    const next = createProceduralDog({
      breedId: normalizedBreedId,
      seed: normalizedSeed,
      variantId: normalizedVariantId,
      shellCount: this.shellCount,
    });
    this.scene.add(next.root);
    if (state) {
      next.animation.setBehavior(state.behavior);
      next.animation.setAutopilot(state.autopilot);
      next.animation.setMouthState(state.mouthState);
      next.animation.setTime(state.time);
      next.animation.setRootPosition(state.rootPosition.x, state.rootPosition.y, state.rootPosition.z);
      next.animation.setRootYaw(state.rootYaw);
      next.setNakedBody(state.nakedBody);
      next.setShowFur(state.showFur);
    }
    if (this.harnessMode) {
      next.animation.setFrozenBlink(true);
      next.animation.setFrozenBreeze(true);
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

    const preset = DOG_REFERENCE_PRESETS.find((item) => item.id === this.activePresetId)
      ?? DOG_REFERENCE_PRESETS[0];
    this.frameDogForPreset(preset);
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
      renderOnce: async () => {
        thisRef.dog?.update(0, { fixed: true });
        thisRef.controls?.update();
        if (thisRef.studioLighting) {
          thisRef.studioLighting.render();
        } else if (thisRef.renderer && thisRef.scene && thisRef.camera) {
          await thisRef.renderer.renderAsync(thisRef.scene, thisRef.camera);
        }
      },
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
      animationClips: this.clipPlayer?.snapshot?.() ?? {
        enabled: false,
        ready: false,
        clip: null,
        clips: 0,
        available: [],
        pinned: null,
        catalog: null,
      },
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
      speed: Number((this.dog?.animation.getMoveSpeed() ?? 0).toFixed(2)),
      time: Number((this.dog?.animation.getTime() ?? 0).toFixed(2)),
      studioLighting: this.studioLighting?.snapshot?.() ?? null,
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
      if (this.liveMotion) {
        const clipReady = Boolean(this.clipPlayer?.ready);
        // Retargeted clips take priority: no procedural body gait when ready.
        this.dog.animation?.setClipDriven?.(clipReady);
        this.dog.update(dt, { plantFeet: !clipReady });
        this.clipPlayer?.update?.(dt, this.dog.animation.getBehavior());
        // Clip is the sole body pose writer — plant pads after the mixer.
        // Mouth/jaw/ears reapply after the sample so pant/alert still work.
        if (clipReady) {
          this.dog.animation?.applyPostClipOverlays?.();
          plantDogFeet(this.dog, { getGroundHeight: () => 0 });
        }
      } else if (!this.harnessMode) {
        // Still advance fur time gently when paused? keep frozen in harness.
        this.dog.furDynamics.update(dt, this.dog.animation.getRootPosition(), {
          time: this.dog.animation.getTime(),
          breeze: this.dog.animation.isFrozenBreeze() ? 0 : 0.2,
        });
      }
    }

    this.controls?.update();
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
