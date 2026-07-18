export class SimsModeController {
  constructor(host) {
    this.id = 'sims';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    const snapshot = this._host.simsFeature?.snapshot?.() ?? null;
    return {
      mode: this.id,
      sims: snapshot?.sims ?? [],
      selectedSimId: snapshot?.selectedSimId ?? null,
      camera: snapshot?.camera ?? null,
    };
  }
  dispose() {}
}
