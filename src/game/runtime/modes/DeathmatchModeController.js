/**
 * Deathmatch mode policy (M1–M3).
 *
 * Selects the Rail Crucible environment and delegates movement-replication
 * lifecycle to DeathmatchRuntimeFeature. Offline solo arena review works with
 * no networkSystem; multiplayer injects the App-owned socket via the feature.
 */
import { DEATHMATCH_ENVIRONMENT } from '../../world/createDeathmatchArenaLevel.js';

export class DeathmatchModeController {
  constructor(host) {
    this.id = 'deathmatch';
    this._host = host;
  }

  /** Environment applied by the scene system after the level loads. */
  get environment() {
    return { ...DEATHMATCH_ENVIRONMENT };
  }

  initializeAfterLevel() {
    // Re-bind network if the App attached it after kernel construction.
    const feature = this._host.deathmatchFeature;
    if (feature && this._host.networkSystem) {
      feature.setNetworkSystem(this._host.networkSystem);
    }
  }

  preSimulation() {}

  snapshot() {
    return this._host.deathmatchFeature?.snapshot?.() ?? { mode: this.id };
  }

  dispose() {
    this._host.deathmatchFeature?.dispose?.();
  }
}
