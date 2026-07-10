import { BaseGun } from './BaseGun.js';
import { GUN_FIRE_MODES } from './gunConfig.js';

export class Shotgun extends BaseGun {
  constructor(options = {}) {
    super({
      weaponKind: 'shotgun',
      ...options,
      profile: options.profile
        ? { weaponKind: 'shotgun', ...options.profile }
        : options.profile,
    });
    this.stats.fireMode = GUN_FIRE_MODES.pump;
    this.stats.pumpRequired = true;
    if (!this.stats.pellets || this.stats.pellets < 2) {
      this.stats.pellets = 8;
    }
  }

  /**
   * Pump shotguns auto-cycle after a short delay if the player isn't holding fire,
   * so the state machine is testable without an explicit pump input. Real play
   * will sync pump to left-hand IK (M7); tests call cyclePump() or wait for auto.
   */
  update(input = {}) {
    const result = super.update(input);
    // Auto-clear pump after cooldown if fire was released (simpler v1 feel).
    if (this.needsPump && this.fireCooldown <= 0 && !input.fireHeld) {
      this.cyclePump();
      result.events.push('pump');
    }
    return result;
  }
}
