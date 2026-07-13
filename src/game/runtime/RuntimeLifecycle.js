import { bindRuntimeHost } from './bindRuntimeHost.js';


/** Play-ready barrier, load progress, generation cancellation. */
export class RuntimeLifecycle {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  _aborted(generation) {
    return this.disposed || generation !== this._loadGeneration;
  }

  _setLoadProgress({ phase, label, detail, sub } = {}) {
    if (sub && typeof sub === 'object') {
      for (const [key, value] of Object.entries(sub)) {
        if (!(key in this._loadSubs)) continue;
        const next = Math.min(1, Math.max(0, Number(value) || 0));
        this._loadSubs[key] = Math.max(this._loadSubs[key] ?? 0, next);
      }
    }
    const weights = {
      level: 0.15,
      character: 0.15,
      near_field: 0.25,
      pipelines: 0.3,
      systems: 0.15,
    };
    let fraction = 0;
    for (const [key, weight] of Object.entries(weights)) {
      fraction += weight * (this._loadSubs[key] ?? 0);
    }
    fraction = Math.max(this.loadProgress.fraction, Math.min(1, fraction));
    this.loadProgress = {
      phase: phase ?? this.loadProgress.phase,
      label: label ?? this.loadProgress.label,
      fraction,
      detail: { ...this.loadProgress.detail, ...(detail ?? {}) },
      ready: this.stage === 'running',
    };
    this.emitSnapshot(performance.now(), { force: true });
  }

  _tryEnterRunning() {
    if (this.disposed) return;
    if (!this._systemsReady || !this._prewarmFinished || !this._nearFieldReady) return;
    if (this.stage === 'running') return;
    // Prewarm deliberately renders expensive first-seen shader/shadow contexts.
    // Do not report those loading frames as gameplay FPS.
    this.frameStats.reset();
    this.stage = 'running';
    this.inputEnabled = true;
    this.simEnabled = true;
    this._setLoadProgress({
      phase: 'ready',
      label: 'Ready',
      sub: {
        level: 1,
        character: 1,
        near_field: 1,
        pipelines: 1,
        systems: 1,
      },
      detail: { prewarm: null },
    });
    // _setLoadProgress sets ready from stage; ensure ready true after stage write
    this.loadProgress = { ...this.loadProgress, ready: true, fraction: 1 };
    this.emitSnapshot(performance.now(), { force: true });
  }

  async _waitNearFieldReady({ generation, timeoutMs = 20_000 } = {}) {
    if (this.levelSystem.isNearFieldReady()) {
      this._setLoadProgress({
        phase: 'near_field',
        label: 'Near field ready',
        sub: { near_field: 1 },
      });
      return true;
    }
    const start = performance.now();
    while (!this._aborted(generation)) {
      if (this.levelSystem.isNearFieldReady()) {
        this._setLoadProgress({
          phase: 'near_field',
          label: 'Near field ready',
          sub: { near_field: 1 },
        });
        return true;
      }
      const elapsed = performance.now() - start;
      if (elapsed > timeoutMs) {
        console.warn('[GameRuntime] near-field wait timed out; entering play fail-open');
        this._setLoadProgress({
          phase: 'near_field',
          label: 'Near field timeout',
          sub: { near_field: 1 },
        });
        return true;
      }
      const fraction = Math.min(0.95, elapsed / timeoutMs);
      this._setLoadProgress({
        phase: 'near_field',
        label: 'Streaming nearby world…',
        sub: { near_field: fraction },
        detail: {
          nearField: { completed: 0, total: 1, label: 'streaming' },
        },
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  }

}
