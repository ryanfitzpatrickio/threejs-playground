import { BaseGun } from './BaseGun.js';
import { GUN_FIRE_MODES } from './gunConfig.js';

/** Auto/semi rifles, carbines, bullpups, DMRs — config drives the differences. */
export class Rifle extends BaseGun {
  constructor(options = {}) {
    super({
      weaponKind: 'rifle',
      ...options,
      profile: options.profile
        ? { weaponKind: 'rifle', ...options.profile }
        : options.profile,
    });
    if (!this.stats.fireMode) {
      this.stats.fireMode = GUN_FIRE_MODES.auto;
    }
  }
}
