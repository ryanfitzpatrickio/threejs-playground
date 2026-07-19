import * as THREE from 'three';
import { getAnimalSpecies, getDogBreed } from './dogCatalog.js';

/** @type {Map<string, Promise<THREE.AnimationClip[]>>} */
const clipLibraryPromises = new Map();

/**
 * Horse-rigged.glb clips retargeted onto the shared dog skeleton
 * (`public/assets/dog-anims/`). Labels match the source GLB clip names.
 * `loop` = continuous studio playback; one-shots recover to Idle.
 */
export const DOG_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Idle Alert', label: 'Idle Alert', loop: true, behavior: 'look' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Run', label: 'Run', loop: true, behavior: 'trot' },
  { name: 'Sit', label: 'Sit', loop: true, behavior: 'sit' },
  { name: 'Sneak', label: 'Sneak', loop: true, behavior: null },
  { name: 'Rest Pose', label: 'Rest Pose', loop: true, behavior: null },
  { name: 'Bark', label: 'Bark', loop: false, behavior: null },
  { name: 'Bite', label: 'Bite', loop: false, behavior: null },
  { name: 'Howl', label: 'Howl', loop: false, behavior: null },
  { name: 'Jump', label: 'Jump', loop: false, behavior: null },
  { name: 'Fetch', label: 'Fetch', loop: false, behavior: null },
  { name: 'Fall', label: 'Fall', loop: false, behavior: null },
  { name: 'Death', label: 'Death', loop: false, behavior: null },
]);

/**
 * Rat.fbx (Enemy Pack) retargeted onto the shared dog skeleton
 * (`public/assets/rodent-anims/`). Used for Rodentia breeds.
 */
export const RODENT_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Run', label: 'Run', loop: true, behavior: 'trot' },
  { name: 'Jump', label: 'Jump', loop: false, behavior: null },
  { name: 'Attack', label: 'Attack', loop: false, behavior: null },
  { name: 'Death', label: 'Death', loop: false, behavior: null },
]);

/**
 * Quaternius Farm Animals Animated (Horse / Cow) retargeted onto the dog
 * skeleton (`public/assets/equid-anims/`, `public/assets/bovid-anims/`).
 * Shared clip names across full locomotion packs.
 */
export const FARM_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Walk Slow', label: 'Walk Slow', loop: true, behavior: 'walk' },
  { name: 'Run', label: 'Run', loop: true, behavior: 'trot' },
  { name: 'Jump', label: 'Jump', loop: false, behavior: null },
  { name: 'Death', label: 'Death', loop: false, behavior: null },
]);

const DOG_LOOP_NAMES = new Set(
  DOG_CLIP_CATALOG.filter((entry) => entry.loop).map((entry) => entry.name),
);
const RODENT_LOOP_NAMES = new Set(
  RODENT_CLIP_CATALOG.filter((entry) => entry.loop).map((entry) => entry.name),
);
const FARM_LOOP_NAMES = new Set(
  FARM_CLIP_CATALOG.filter((entry) => entry.loop).map((entry) => entry.name),
);

/** `?dogAnims=procedural` opts out of the retargeted clip library entirely. */
export function dogClipModeEnabled() {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  return params.get('dogAnims') !== 'procedural';
}

/**
 * Which retargeted clip pack to load for this animal.
 *
 * Libraries:
 *  - `'dog'`    — Mixamo/horse-rigged.glb pack (`public/assets/dog-anims/`).
 *                 Default for carnivorans (canids, felids, ursids, …).
 *  - `'rodent'` — rat-rigged pack (`public/assets/rodent-anims/`) for Rodentia.
 *  - `'equid'`  — Quaternius Farm Horse retarget (`public/assets/equid-anims/`).
 *                 Perissodactyla + giraffe/hippo + `horse-clips` / `equid-clips`.
 *  - `'bovid'`  — Quaternius Farm Cow retarget (`public/assets/bovid-anims/`).
 *                 Most artiodactyls (cattle, deer, camelids, pigs, …) + `cow-clips`.
 *  - `null`     — procedural gait only (`?dogAnims=procedural`).
 *
 * Accepts `speciesId`, `breedId` (catalog lookup), `phenotype`, breed flags, or a
 * full createProceduralDog handle (`speciesId` + `breed.conformationFlags`).
 *
 * @param {{
 *   speciesId?: string,
 *   breedId?: string,
 *   familyId?: string,
 *   phenotype?: object,
 *   breed?: object,
 *   conformationFlags?: string[],
 *   flags?: string[],
 * } | null | undefined} animal
 * @returns {'dog' | 'rodent' | 'equid' | 'bovid' | null}
 */
export function animalClipLibraryKind(animal = null) {
  if (!dogClipModeEnabled()) return null;
  const catalogBreed = animal?.breedId
    ? getDogBreed(animal.breedId)
    : (animal?.breed?.id ? getDogBreed(animal.breed.id) : null);
  const speciesId = animal?.speciesId
    ?? animal?.phenotype?.speciesId
    ?? catalogBreed?.speciesId
    ?? animal?.breed?.speciesId
    ?? null;
  const orderId = getAnimalSpecies(speciesId)?.orderId ?? null;
  // Catalog conformationFlags on breed object if present.
  const flags = animal?.conformationFlags
    ?? animal?.flags
    ?? animal?.phenotype?.flags
    ?? animal?.breed?.conformationFlags
    ?? animal?.breed?.flags
    ?? catalogBreed?.conformationFlags;
  const flagList = Array.isArray(flags) ? flags : [];

  if (orderId === 'rodentia' || flagList.includes('rat-clips') || flagList.includes('rodent')) {
    return 'rodent';
  }
  // Horse / zebra / rhino / tapir / giraffe / hippo — Quaternius Horse pack.
  if (
    orderId === 'perissodactyla'
    || speciesId === 'giraffidae'
    || speciesId === 'hippopotamidae'
    || flagList.includes('horse-clips')
    || flagList.includes('equid-clips')
  ) {
    return 'equid';
  }
  // Cattle / deer / camelids / pigs / sheep proxies — Quaternius Cow pack.
  // (Giraffe/hippo already returned equid above.)
  if (
    orderId === 'artiodactyla'
    || flagList.includes('cow-clips')
    || flagList.includes('bovid-clips')
  ) {
    return 'bovid';
  }
  return 'dog';
}

/**
 * Whether this animal should use a retargeted dog-bone clip library.
 * Opt out with `?dogAnims=procedural`.
 *
 * @param {{ familyId?: string, speciesId?: string, breedId?: string, phenotype?: object } | null | undefined} animal
 */
export function animalUsesDogClipLibrary(animal = null) {
  return animalClipLibraryKind(animal) != null;
}

export function clipCatalogForKind(kind) {
  if (kind === 'rodent') return RODENT_CLIP_CATALOG;
  if (kind === 'equid' || kind === 'bovid') return FARM_CLIP_CATALOG;
  return DOG_CLIP_CATALOG;
}

/** Asset directory for a library kind. */
export function clipLibraryBasePath(kind = 'dog') {
  if (kind === 'rodent') return '/assets/rodent-anims';
  if (kind === 'equid') return '/assets/equid-anims';
  if (kind === 'bovid') return '/assets/bovid-anims';
  return '/assets/dog-anims';
}

export class DogClipPlayer {
  constructor(dog) {
    this.dog = dog;
    // Fail closed under `?dogAnims=procedural` (kind null) — do not pretend dog pack.
    this.libraryKind = animalClipLibraryKind(dog);
    this.catalog = this.libraryKind ? clipCatalogForKind(this.libraryKind) : DOG_CLIP_CATALOG;
    this.loopNames = this.libraryKind === 'rodent'
      ? RODENT_LOOP_NAMES
      : (this.libraryKind === 'equid' || this.libraryKind === 'bovid')
        ? FARM_LOOP_NAMES
        : DOG_LOOP_NAMES;
    this.mixer = new THREE.AnimationMixer(dog.rig.root);
    this.actions = new Map();
    this.currentName = null;
    this.ready = false;
    this.enabled = this.libraryKind != null;
    /** When set, studio/debug pin overrides behavior→clip mapping. */
    this.pinnedClip = null;
    /** @type {'none'|'playing'|'holding'|'recovering'} */
    this.oneShotPhase = 'none';
    this.phaseRemaining = 0;
    this.recoverTo = null;
    this.recoverFade = 0.34;
    this.holdEnd = 0;
    this.oneShotDuration = 0;
    this.impactProgress = null;
    this.impactFired = false;
    this.puddleImpactThisFrame = false;
    this.impactSequence = 0;
    this.disposed = false;
    // AnimationMixer avoids property writes when its sampled value is equal to
    // the previous frame. The procedural animator runs before this player and
    // resets bones to their rest pose, so an omitted mixer write would expose
    // that rest pose for one frame (most visibly on duplicated loop keys).
    // Preserve only mixer-owned properties and restore them before sampling;
    // procedural-only Jaw/Muzzle/face bones remain untouched.
    this.mixerPoseBindings = [];
    this.hasMixerPose = false;
  }

  async initialize() {
    if (!this.libraryKind || !this.enabled) {
      this.ready = false;
      return false;
    }
    try {
      const clips = await loadClipLibrary(this.libraryKind);
      if (this.disposed) return false;
      for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
      this._bindMixerPoseProperties(clips);
      this.ready = this.actions.size > 0;
      if (this.ready) this.playLoop('Idle', 0);
    } catch (error) {
      this.enabled = false;
      console.warn(
        `[dog-park] ${this.libraryKind} clip library unavailable; using procedural gait`,
        error,
      );
    }
    return this.ready;
  }

  /** True while a one-shot (jump / bark / splash) owns the mixer. */
  isBusy() {
    return this.enabled && this.ready && this.oneShotPhase !== 'none';
  }

  update(delta, behavior) {
    if (!this.enabled || !this.ready) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    this.puddleImpactThisFrame = false;

    this._restoreMixerPose();

    if (this.oneShotPhase !== 'none') {
      this._updateOneShot(dt);
      this.mixer.update(dt);
      this._pinFinishedOneShot();
      this._captureMixerPose();
      this._syncSkeleton();
      return;
    }

    if (this.pinnedClip && this.actions.has(this.pinnedClip)) {
      this.playLoop(this.pinnedClip);
    } else {
      // Rodent pack has no Sit / Idle Alert — map sit/look onto Idle.
      const desired = behavior === 'trot' ? 'Run'
        : behavior === 'walk' ? 'Walk'
          : behavior === 'sit' || behavior === 'lie'
            ? (this.actions.has('Sit') ? 'Sit' : 'Idle')
            : behavior === 'look'
              ? (this.actions.has('Idle Alert') ? 'Idle Alert' : 'Idle')
              : 'Idle';
      this.playLoop(desired);
    }
    this.mixer.update(dt);
    this._captureMixerPose();
    this._syncSkeleton();
  }

  _bindMixerPoseProperties(clips) {
    const seen = new Set();
    const bones = this.dog?.rig?.bonesByName;
    const root = this.dog?.rig?.root;
    this.mixerPoseBindings = [];
    this.hasMixerPose = false;

    for (const clip of clips) {
      for (const track of clip.tracks) {
        const dot = track.name.lastIndexOf('.');
        if (dot <= 0) continue;
        const nodeName = track.name.slice(0, dot);
        const property = track.name.slice(dot + 1);
        if (property !== 'position' && property !== 'quaternion' && property !== 'scale') continue;
        const key = `${nodeName}.${property}`;
        if (seen.has(key)) continue;

        const target = bones?.get(nodeName)
          ?? (root?.name === nodeName ? root : root?.getObjectByName?.(nodeName));
        const source = target?.[property];
        if (!source?.clone || !source?.copy) continue;
        seen.add(key);
        this.mixerPoseBindings.push({ target, property, value: source.clone() });
      }
    }
  }

  _restoreMixerPose() {
    if (!this.hasMixerPose) return;
    for (const binding of this.mixerPoseBindings) {
      binding.target[binding.property].copy(binding.value);
    }
  }

  _captureMixerPose() {
    for (const binding of this.mixerPoseBindings) {
      binding.value.copy(binding.target[binding.property]);
    }
    this.hasMixerPose = this.mixerPoseBindings.length > 0;
  }

  _updateOneShot(dt) {
    this.phaseRemaining = Math.max(0, this.phaseRemaining - dt);

    if (
      this.oneShotPhase === 'playing'
      && !this.impactFired
      && Number.isFinite(this.impactProgress)
      && this.oneShotDuration > 0
      && 1 - this.phaseRemaining / this.oneShotDuration >= this.impactProgress
    ) {
      this.impactFired = true;
      this.puddleImpactThisFrame = true;
      this.impactSequence += 1;
    }

    if (this.oneShotPhase === 'playing' && this.phaseRemaining <= 0) {
      // Clip finished — freeze last evaluated frame, then hold.
      this._pinFinishedOneShot();
      if (this.holdEnd > 0) {
        this.oneShotPhase = 'holding';
        this.phaseRemaining = this.holdEnd;
      } else if (this.recoverTo) {
        this._beginRecover();
      } else {
        this._clearOneShot();
      }
      return;
    }

    if (this.oneShotPhase === 'holding' && this.phaseRemaining <= 0) {
      if (this.recoverTo) this._beginRecover();
      else this._clearOneShot();
      return;
    }

    if (this.oneShotPhase === 'recovering' && this.phaseRemaining <= 0) {
      this._clearOneShot();
    }
  }

  /** Force the active one-shot action onto its final key and keep weight full. */
  _pinFinishedOneShot() {
    if (this.oneShotPhase !== 'holding' && this.oneShotPhase !== 'playing') return;
    const action = this.currentName ? this.actions.get(this.currentName) : null;
    if (!action) return;
    const duration = action.getClip().duration;
    if (action.time < duration - 1e-4 && this.oneShotPhase === 'playing') return;
    action.enabled = true;
    action.paused = true;
    action.setEffectiveWeight(1);
    action.time = duration;
    action.clampWhenFinished = true;
  }

  _beginRecover() {
    const fade = this.recoverFade;
    this.oneShotPhase = 'recovering';
    this.phaseRemaining = fade;
    if (this.recoverTo) this.playLoop(this.recoverTo, fade);
  }

  _clearOneShot() {
    this.oneShotPhase = 'none';
    this.phaseRemaining = 0;
    this.recoverTo = null;
    this.holdEnd = 0;
    this.oneShotDuration = 0;
    this.impactProgress = null;
    this.impactFired = false;
  }

  _syncSkeleton() {
    const rig = this.dog?.rig;
    if (!rig?.root || !rig?.skeleton) return;
    rig.root.updateMatrixWorld(true);
    rig.skeleton.update();
  }

  playLoop(name, fade = 0.18) {
    const action = this.actions.get(name) ?? this.actions.get('Idle');
    if (!action || this.currentName === action.getClip().name) return;
    const previous = this.currentName ? this.actions.get(this.currentName) : null;
    action.enabled = true;
    action.paused = false;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.setEffectiveWeight(1);
    action.reset().fadeIn(fade).play();
    previous?.fadeOut(fade);
    this.currentName = action.getClip().name;
  }

  clearPin() {
    this.pinnedClip = null;
  }

  /**
   * Studio/debug: play any library clip by name.
   * Loop clips pin until clearPin / behavior remaps; one-shots recover to Idle.
   * @param {string} name
   * @param {{ loop?: boolean, recoverTo?: string | null }} [opts]
   */
  playClip(name, opts = {}) {
    if (!this.enabled || !this.ready) return false;
    if (!this.actions.has(name)) return false;
    const catalog = this.catalog.find((entry) => entry.name === name);
    const loop = opts.loop ?? catalog?.loop ?? this.loopNames.has(name);
    if (loop) {
      this._clearOneShot();
      this.pinnedClip = name;
      this.playLoop(name, 0.14);
      return true;
    }
    this.pinnedClip = null;
    return this.playOneShot(name, {
      recoverTo: opts.recoverTo === undefined ? 'Idle' : opts.recoverTo,
      holdEnd: name === 'Death' ? 1.2 : 0,
      recoverFade: 0.34,
      fadeIn: 0.1,
    });
  }

  listClips() {
    return [...this.actions.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {string} name
   * @param {{
   *   recoverTo?: string | null,
   *   holdEnd?: number,
   *   recoverFade?: number,
   *   fadeIn?: number,
   *   impactProgress?: number | null,
   * }} [opts]
   */
  playOneShot(name, {
    recoverTo = null,
    holdEnd = 0,
    recoverFade = 0.34,
    fadeIn = 0.1,
    impactProgress = null,
  } = {}) {
    if (!this.enabled || !this.ready) return false;
    const action = this.actions.get(name);
    if (!action) return false;
    const previous = this.currentName ? this.actions.get(this.currentName) : null;
    action.enabled = true;
    action.paused = false;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.reset().fadeIn(fadeIn).play();
    previous?.fadeOut(fadeIn);
    this.currentName = name;
    const duration = Math.max(0.1, action.getClip().duration);
    this.holdEnd = Math.max(0, Number(holdEnd) || 0);
    this.recoverTo = recoverTo;
    this.recoverFade = recoverTo ? Math.max(0.12, Number(recoverFade) || 0.34) : 0;
    this.oneShotPhase = 'playing';
    this.phaseRemaining = duration;
    this.oneShotDuration = duration;
    this.impactProgress = Number.isFinite(impactProgress)
      ? THREE.MathUtils.clamp(impactProgress, 0, 1)
      : null;
    this.impactFired = false;
    this.puddleImpactThisFrame = false;
    return true;
  }

  /**
   * Playful "splash in a puddle": Death flop, hold final frame 3s, then Idle.
   */
  playPuddleSplash() {
    return this.playOneShot('Death', {
      recoverTo: 'Idle',
      holdEnd: 3,
      recoverFade: 0.45,
      fadeIn: 0.08,
      impactProgress: 0.45,
    });
  }

  /** Consume the single update-frame impact edge emitted by playPuddleSplash. */
  consumePuddleImpact() {
    const impact = this.puddleImpactThisFrame;
    this.puddleImpactThisFrame = false;
    return impact;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      library: this.libraryKind,
      clip: this.currentName,
      clips: this.actions.size,
      available: this.listClips(),
      pinned: this.pinnedClip,
      catalog: this.catalog,
      busy: this.isBusy(),
      phase: this.oneShotPhase,
      phaseRemaining: this.phaseRemaining,
      impactThisFrame: this.puddleImpactThisFrame,
      impactSequence: this.impactSequence,
    };
  }

  dispose() {
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.dog.rig.root);
    this.actions.clear();
    this.mixerPoseBindings.length = 0;
    this.hasMixerPose = false;
    this.ready = false;
    this.pinnedClip = null;
    this._clearOneShot();
  }
}

/**
 * @param {'dog' | 'rodent' | 'equid'} kind
 */
async function loadClipLibrary(kind = 'dog') {
  // Cache key is the asset base so dog + equid share one fetch of dog-anims.
  const base = clipLibraryBasePath(kind);
  if (!clipLibraryPromises.has(base)) {
    const promise = fetch(`${base}/manifest.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`manifest HTTP ${response.status} (${base})`);
        const manifest = await response.json();
        return Promise.all((manifest.clips ?? []).map(async (entry) => {
          const clipResponse = await fetch(`${base}/${entry.file}`);
          if (!clipResponse.ok) throw new Error(`${entry.file} HTTP ${clipResponse.status}`);
          return THREE.AnimationClip.parse(await clipResponse.json());
        }));
      })
      .catch((error) => {
        // Drop rejected promises so a later player can retry (dog+equid share this key).
        clipLibraryPromises.delete(base);
        throw error;
      });
    clipLibraryPromises.set(base, promise);
  }
  return clipLibraryPromises.get(base);
}
