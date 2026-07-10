import { BaseGun } from './BaseGun.js';
import { GUN_FIRE_MODES } from './gunConfig.js';

export class Pistol extends BaseGun {
  constructor(options = {}) {
    super({
      weaponKind: 'pistol',
      ...options,
      profile: options.profile
        ? { weaponKind: 'pistol', ...options.profile }
        : options.profile,
    });
    this.stats.fireMode = GUN_FIRE_MODES.semi;
    this.slideLocked = false;
  }

  tryFire() {
    const shot = super.tryFire();
    if (shot && this.ammoInMag <= 0) {
      this.slideLocked = true;
    }
    return shot;
  }

  _finishReload() {
    super._finishReload();
    this.slideLocked = false;
  }

  snapshot() {
    return {
      ...super.snapshot(),
      slideLocked: this.slideLocked,
    };
  }
}
