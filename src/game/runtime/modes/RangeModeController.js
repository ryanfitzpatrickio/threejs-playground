/**
 * Range environment, FP loadout, targets policy.
 */
export class RangeModeController {
  constructor(host) {
    this.id = 'range';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    return { mode: this.id };
  }
  dispose() {}
}
