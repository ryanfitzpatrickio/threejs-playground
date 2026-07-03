import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';

const _hitDir = new THREE.Vector3();

// Owns ALL player damage state. No death: health gates which hit-reaction plays
// and regenerates after a delay. This is the single funnel through which every
// source of player damage flows (enemy bites now; future collisions / falls), so
// i-frames, knockback, and reaction selection stay in one place. Flinch impact
// does not cancel/interrupt in-flight player actions (see dealPlayerDamage).
// AnimationStateSystem only READS character.hitReaction / hitReactionTimer.
export class PlayerDamageSystem {
  constructor() {
    // Monotonic seconds clock for regen timing (kept here so dealPlayerDamage,
    // which is called from outside this system's update, can stamp lastHitTime).
    this.clock = 0;
  }

  dealPlayerDamage(player, { amount = 0, kind = 'light', sourcePosition = null } = {}) {
    if (!player || player.invulnerable || amount <= 0) {
      return;
    }

    const cfg = GAME_CONFIG.character;
    player.health = Math.max(0, (player.health ?? cfg.maxHealth) - amount);
    player.lastHitTime = this.clock;

    // Heavy reaction on heavy hits, or once badly hurt. Otherwise a light stagger.
    const heavy = kind === 'heavy' || player.health <= cfg.lowHealthHeavyThreshold;
    player.hitReaction = heavy ? 'heavy' : 'light';
    player.hitReactionTimer = heavy ? cfg.heavyHitReactionSeconds : cfg.lightHitReactionSeconds;

    // Brief i-frames so one contact doesn't multi-tick across frames.
    player.iframeTimer = cfg.hitIframeSeconds;
    player.invulnerable = true;

    // Knockback away from the source, applied as an impulse MovementSystem decays.
    if (sourcePosition && player.group) {
      _hitDir.set(
        player.group.position.x - sourcePosition.x,
        0,
        player.group.position.z - sourcePosition.z,
      );
      if (_hitDir.lengthSq() < 1e-6) {
        _hitDir.set(0, 0, 1);
      } else {
        _hitDir.normalize();
      }
      const power = heavy ? cfg.knockbackPower * 1.6 : cfg.knockbackPower;
      player.pendingImpulse.addScaledVector(_hitDir, power);
    }

    // Flinch impact (knockback + i-frames + health) does NOT cancel in-flight player
    // actions/attacks/overrides. Player actions continue.
  }

  update({ delta, player }) {
    if (!player) {
      return;
    }

    this.clock += delta;
    const cfg = GAME_CONFIG.character;

    if ((player.iframeTimer ?? 0) > 0) {
      player.iframeTimer = Math.max(0, player.iframeTimer - delta);
      if (player.iframeTimer <= 0) {
        player.invulnerable = false;
      }
    }

    if ((player.hitReactionTimer ?? 0) > 0) {
      player.hitReactionTimer = Math.max(0, player.hitReactionTimer - delta);
      if (player.hitReactionTimer <= 0) {
        player.hitReaction = null;
      }
    }

    // Regen after the no-hit delay (no death — Mara recovers).
    const max = player.maxHealth ?? cfg.maxHealth;
    if (
      (player.health ?? max) < max
      && (this.clock - (player.lastHitTime ?? -Infinity)) >= cfg.healthRegenDelay
    ) {
      player.health = Math.min(max, (player.health ?? 0) + cfg.healthRegenRate * delta);
    }
  }
}
