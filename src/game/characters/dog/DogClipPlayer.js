import * as THREE from 'three';
import { getAnimalSpecies, getDogBreed } from './dogCatalog.js';

/** @type {Map<string, Promise<THREE.AnimationClip[]>>} */
const clipLibraryPromises = new Map();

/**
 * Horse→dog Jump has long near-idle lead-in / settle tails (legs hold idle while
 * the middle carries crouch→launch→land). Trim those pads so one-shots only play
 * the athletic middle. Other packs that already start on motion are unchanged.
 */
const JUMP_TRIM = Object.freeze({
  /**
   * Expand from the peak motion sample while energy stays above this fraction
   * of the peak. Higher = tighter “athletic middle” (drops idle lead/tail).
   */
  energyFrac: 0.20,
  /** Keep a few frames before first active / after last. */
  padSec: 0.06,
  /** Only trim if we remove at least this much idle. */
  minTrimSec: 0.18,
  /** Active window must be at least this long. */
  minActiveSec: 0.5,
  probeSteps: 72,
});

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

/**
 * Retargeted skeleton clip packs are the default. Procedural gait is a
 * fallback when packs fail to load, for birds/bespoke rigs, or when forced.
 *
 * Force clips: `?dogAnims=clips` | `retarget` | `library` | `1` | `on` (default)
 * Force procedural: `?dogAnims=procedural` | `0` | `off` | `false`
 */
export function dogClipModeEnabled() {
  const params = new URLSearchParams(
    typeof location !== 'undefined' ? location.search : '',
  );
  const raw = String(params.get('dogAnims') ?? '').trim().toLowerCase();
  // Explicit procedural opt-out only.
  if (raw === 'procedural' || raw === '0' || raw === 'off' || raw === 'false') {
    return false;
  }
  // Empty, clips, retarget, library, 1, on, true, or unknown → clips priority.
  return true;
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
 *  - `null`     — no pack (bird/bespoke rig, or `?dogAnims=procedural`).
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

  // Birds use the procedural goose-body FSM (createProceduralGoose varieties),
  // not dog-bone retarget packs. Bespoke procedural rigs (goose, cat) own their
  // own animation facade and must never be driven by the shared dog-bone packs —
  // their skeletons don't match the retarget bone map. Insects are catalog-only
  // (no mesh/clips yet).
  if (
    orderId === 'aves'
    || orderId === 'insecta'
    || flagList.includes('bird-rig')
    || flagList.includes('avian')
    || flagList.includes('insect')
    || animal?.isBird
    || animal?.isInsect
    || animal?.phenotype?.rigKind === 'bird'
    || animal?.phenotype?.rigKind === 'insect'
    || animal?.rigKind === 'insect'
    || flagList.includes('ladybug-rig')
    || animal?.isInsect
    || animal?.rigKind === 'cat'
    || animal?.phenotype?.rigKind === 'cat'
    || flagList.includes('horse-rig')
    || animal?.rigKind === 'horse'
    || animal?.phenotype?.rigKind === 'horse'
  ) {
    return null;
  }

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
 * Default yes (skeleton clips); opt out with `?dogAnims=procedural`.
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
      const prepared = clips.map((clip) => (
        clip.name === 'Jump' ? trimJumpIdlePads(clip) : clip
      ));
      for (const clip of prepared) {
        this.actions.set(clip.name, this.mixer.clipAction(clip));
      }
      this._bindMixerPoseProperties(prepared);
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
   * Playful "splash in a puddle" via Death clip — studio/debug only.
   * Park gameplay flop uses procedural flop + ragdoll instead (see
   * DogParkRuntimeFeature); do not call this from park Z-input.
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

  /**
   * Release mixer ownership so procedural flop / ragdoll can drive bones.
   * Stops loops and one-shots (including Death) without recovering through Idle.
   */
  suspendForProcedural() {
    if (!this.enabled) return;
    this._clearOneShot();
    this.pinnedClip = null;
    this.puddleImpactThisFrame = false;
    for (const action of this.actions.values()) {
      try {
        action.stop();
        action.setEffectiveWeight(0);
        action.enabled = false;
      } catch {
        /* ignore */
      }
    }
    this.currentName = null;
    this.hasMixerPose = false;
  }

  /**
   * Resume locomotion clips after procedural flop / ragdoll ends.
   * @param {string} [name='Idle']
   */
  resumeFromProcedural(name = 'Idle') {
    if (!this.enabled || !this.ready) return false;
    for (const action of this.actions.values()) {
      action.enabled = true;
    }
    this.playLoop(name, 0.22);
    return true;
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

/**
 * Detect [start, end] of real motion from quaternion track deltas.
 * @param {THREE.AnimationClip} clip
 * @returns {{ start: number, end: number } | null}
 */
export function findClipActiveWindow(clip, {
  energyFrac = JUMP_TRIM.energyFrac,
  probeSteps = JUMP_TRIM.probeSteps,
} = {}) {
  if (!clip || !(clip.duration > 0)) return null;
  const steps = Math.max(16, probeSteps | 0);
  const energy = new Array(steps + 1).fill(0);
  const qTracks = clip.tracks.filter((tr) => tr.name?.endsWith('.quaternion'));
  if (!qTracks.length) return null;

  for (const track of qTracks) {
    const times = track.times;
    const values = track.values;
    if (!times?.length || values.length < 4) continue;
    let prev = null;
    for (let s = 0; s <= steps; s += 1) {
      const t = (s / steps) * clip.duration;
      const q = sampleQuatTrack(times, values, t);
      if (prev) {
        let d = Math.abs(prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3]);
        d = Math.min(1, d);
        energy[s] += 2 * Math.acos(d);
      }
      prev = q;
    }
  }

  const maxE = Math.max(...energy.slice(1), 0);
  if (!(maxE > 1e-6)) return null;
  const thr = maxE * energyFrac;

  // Peak-centric window: avoid counting mild idle fidget as “active start”.
  let peakI = 1;
  for (let s = 1; s <= steps; s += 1) {
    if (energy[s] > energy[peakI]) peakI = s;
  }
  let lo = peakI;
  let hi = peakI;
  while (lo > 1 && energy[lo - 1] >= thr) lo -= 1;
  while (hi < steps && energy[hi + 1] >= thr) hi += 1;

  // Also absorb a second landing peak if it sits just after a quiet gap.
  for (let s = hi + 1; s <= steps; s += 1) {
    if (energy[s] >= thr) hi = s;
    else if (s - hi > Math.max(3, Math.floor(steps * 0.08))) break;
  }

  const first = ((lo - 1) / steps) * clip.duration;
  const last = (hi / steps) * clip.duration;
  if (!(last > first)) return null;
  return { start: Math.max(0, first), end: Math.min(clip.duration, last) };
}

/**
 * @param {THREE.AnimationClip} clip
 * @returns {THREE.AnimationClip}
 */
export function trimJumpIdlePads(clip) {
  if (!clip || clip.name !== 'Jump') return clip;
  if (!(clip.duration > 0)) {
    try { clip.resetDuration(); } catch { /* ignore */ }
  }
  const window = findClipActiveWindow(clip);
  if (!window) return clip;

  const pad = JUMP_TRIM.padSec;
  const start = Math.max(0, window.start - pad);
  const end = Math.min(clip.duration, window.end + pad);
  const activeLen = end - start;
  const trimmedLead = start;
  const trimmedTail = clip.duration - end;
  if (
    activeLen < JUMP_TRIM.minActiveSec
    || (trimmedLead + trimmedTail) < JUMP_TRIM.minTrimSec
  ) {
    return clip;
  }

  const trimmed = subclipByTime(clip, start, end, 'Jump');
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(
      `[dog-clips] Jump trim ${clip.duration.toFixed(2)}s → ${trimmed.duration.toFixed(2)}s `
      + `(${start.toFixed(2)}–${end.toFixed(2)})`,
    );
  }
  return trimmed;
}

/**
 * Time-based subclip (AnimationUtils.subclip is frame-based).
 * @param {THREE.AnimationClip} clip
 * @param {number} startSec
 * @param {number} endSec
 * @param {string} [name]
 */
export function subclipByTime(clip, startSec, endSec, name = clip.name) {
  const start = Math.max(0, startSec);
  const end = Math.min(clip.duration, endSec);
  if (!(end > start + 1e-3)) return clip;

  // High fps keeps frame rounding tight to the time window.
  const fps = 60;
  const startFrame = Math.max(0, Math.floor(start * fps));
  const endFrame = Math.max(startFrame + 1, Math.ceil(end * fps));
  if (typeof THREE.AnimationUtils?.subclip === 'function') {
    const cut = THREE.AnimationUtils.subclip(clip, name, startFrame, endFrame, fps);
    cut.name = name;
    return cut;
  }

  // Fallback: shift tracks manually.
  const tracks = [];
  for (const track of clip.tracks) {
    const times = [];
    const values = [];
    const stride = track.getValueSize?.()
      ?? (track.name.endsWith('.quaternion') ? 4
        : track.name.endsWith('.position') || track.name.endsWith('.scale') ? 3
          : 1);
    for (let i = 0; i < track.times.length; i += 1) {
      const t = track.times[i];
      if (t < start - 1e-5 || t > end + 1e-5) continue;
      times.push(t - start);
      for (let k = 0; k < stride; k += 1) {
        values.push(track.values[i * stride + k]);
      }
    }
    if (times.length < 2) continue;
    const TypedTrack = track.constructor;
    tracks.push(new TypedTrack(track.name, times, values));
  }
  return new THREE.AnimationClip(name, end - start, tracks.length ? tracks : clip.tracks);
}

function sampleQuatTrack(times, values, t) {
  if (t <= times[0]) return [values[0], values[1], values[2], values[3]];
  const last = times.length - 1;
  if (t >= times[last]) {
    const i = last;
    return [values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]];
  }
  let i = 0;
  while (i < last && times[i + 1] < t) i += 1;
  const t0 = times[i];
  const t1 = times[i + 1];
  const u = (t - t0) / Math.max(1e-9, t1 - t0);
  const a = [values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]];
  const b = [values[(i + 1) * 4], values[(i + 1) * 4 + 1], values[(i + 1) * 4 + 2], values[(i + 1) * 4 + 3]];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const o = [
    a[0] * (1 - u) + b[0] * s * u,
    a[1] * (1 - u) + b[1] * s * u,
    a[2] * (1 - u) + b[2] * s * u,
    a[3] * (1 - u) + b[3] * s * u,
  ];
  const len = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
  return [o[0] / len, o[1] / len, o[2] / len, o[3] / len];
}
