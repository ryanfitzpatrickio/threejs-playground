/**
 * City / world / wilds ambient + spawn policy.
 * Mode-specific branches still run via host loader until fully migrated;
 * this controller is the ownership boundary for further extraction.
 */
export class OpenWorldModeController {
  constructor(host, levelMode = 'city') {
    this.id = levelMode === 'world' || levelMode === 'wilds' ? levelMode : 'city';
    this._host = host;
  }

  initializeAfterLevel() {}
  preSimulation() {}
  snapshot() {
    return { mode: this.id };
  }
  dispose() {}
}
