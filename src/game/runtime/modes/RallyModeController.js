/**
 * Rally environment, vehicles, cinematic setup policy.
 */
export class RallyModeController {
  constructor(host) {
    this.id = 'rally';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    return { mode: this.id };
  }
  dispose() {}
}
