export class DogParkModeController {
  constructor(host) {
    this.id = 'dog-park';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    return {
      mode: this.id,
      ...this._host.dogParkFeature?.snapshot?.(),
    };
  }
  dispose() {}
}

