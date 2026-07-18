import * as THREE from 'three';

let clipLibraryPromise = null;

export class DogClipPlayer {
  constructor(dog) {
    this.dog = dog;
    this.mixer = new THREE.AnimationMixer(dog.rig.root);
    this.actions = new Map();
    this.currentName = null;
    this.ready = false;
    this.enabled = true;
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
  }

  async initialize() {
    try {
      const clips = await loadDogClipLibrary();
      if (this.disposed) return false;
      for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
      this.ready = this.actions.size > 0;
      if (this.ready) this.playLoop('Idle', 0);
    } catch (error) {
      this.enabled = false;
      console.warn('[dog-park] retargeted clip library unavailable; using procedural gait', error);
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

    if (this.oneShotPhase !== 'none') {
      this._updateOneShot(dt);
      this.mixer.update(dt);
      this._pinFinishedOneShot();
      this._syncSkeleton();
      return;
    }

    const desired = behavior === 'trot' ? 'Run'
      : behavior === 'walk' ? 'Walk'
        : behavior === 'sit' || behavior === 'lie' ? 'Sit'
          : behavior === 'look' ? 'Idle Alert'
            : 'Idle';
    this.playLoop(desired);
    this.mixer.update(dt);
    this._syncSkeleton();
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
      clip: this.currentName,
      clips: this.actions.size,
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
    this.ready = false;
    this._clearOneShot();
  }
}

async function loadDogClipLibrary() {
  if (!clipLibraryPromise) {
    clipLibraryPromise = fetch('/assets/dog-anims/manifest.json')
      .then(async (response) => {
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
        const manifest = await response.json();
        return Promise.all((manifest.clips ?? []).map(async (entry) => {
          const clipResponse = await fetch(`/assets/dog-anims/${entry.file}`);
          if (!clipResponse.ok) throw new Error(`${entry.file} HTTP ${clipResponse.status}`);
          return THREE.AnimationClip.parse(await clipResponse.json());
        }));
      });
  }
  return clipLibraryPromise;
}
