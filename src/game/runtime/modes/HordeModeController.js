/**
 * Arena environment + activates the reusable horde feature.
 */
export class HordeModeController {
  constructor(host) {
    this.id = 'horde';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    return {
      mode: this.id,
      horde: this._host.hordeScaleSnapshot?.() ?? null,
    };
  }
  dispose() {}
}
