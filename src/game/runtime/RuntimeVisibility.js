import { bindRuntimeHost } from './bindRuntimeHost.js';


/** Tab visibility, audio muting coordination. */
export class RuntimeVisibility {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  handleVisibilityChange() {
    this._visibilityPaused = document.visibilityState === 'hidden';
    this.lastFrameAt = performance.now();
    this.physicsSystem.stepAccumulator = 0;
    for (const vehicle of this.vehicleSystem?.vehicles ?? []) {
      vehicle.engineAudio?.mute?.(this._visibilityPaused);
      vehicle.tireEffects?.mute?.(this._visibilityPaused);
      vehicle.exteriorIdleAudio?.mute?.(this._visibilityPaused);
      vehicle.crashAudio?.mute?.(this._visibilityPaused);
    }
  }

}
