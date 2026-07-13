/**
 * DeathmatchCombatAdapter (M4) — network-authoritative fire/reload/death.
 *
 * When a networked deathmatch match is RUNNING:
 *   - Intercepts local gun fire before enemy hitscan so clients never own damage
 *   - Suppresses local mag burn while dead / in countdown (no SHOT_RESULT to correct)
 *   - Sends FIRE / RELOAD intents on the single DeathmatchNetworkSystem socket
 *   - Applies SHOT_RESULT ammo corrections + hit markers (monotonic shotSeq only)
 *   - Applies DEATH / DAMAGE / RESPAWN events with sticky life/health vs stale snaps
 *   - Spawns short local death VFX (disposable Three.js group)
 *
 * Offline `?level=deathmatch` (no network) is a full no-op so solo arena review
 * keeps the offline gun path.
 *
 * Clock domain: wall clock via feature._wallNow / network._now (never performance.now).
 */

import * as THREE from 'three';
import { disposeObject3D } from '../../../utils/disposeObject3D.js';
import { EVENT_KIND } from '../../../net/deathmatchProtocol.js';
import { MATCH_PHASE, STARTING_WEAPON, HEALTH } from '../../../config/deathmatch/deathmatchRules.js';
import {
  buildFireMessage,
  buildReloadMessage,
  estimateCombatClientTime,
  applyShotResult,
  loadoutFromRespawn,
  isSpawnProtected,
} from '../../../net/deathmatchCombatReplication.js';

const DEATH_VFX_LIFE = 1.1;

export class DeathmatchCombatAdapter {
  /**
   * @param {import('./DeathmatchRuntimeFeature.js').DeathmatchRuntimeFeature} feature
   */
  constructor(feature) {
    this._feature = feature;
    this.shotSeq = 0;
    this.actionSeq = 0;
    /** Last SHOT_RESULT shotSeq applied (ignore late/out-of-order results). */
    this._lastAppliedShotSeq = -1;
    this.authoritativeHealth = HEALTH.spawn;
    this.authoritativeAmmo = null;
    this.authoritativeReserve = null;
    this.currentWeaponId = STARTING_WEAPON;
    this.spawnProtectedUntil = 0;
    this.lifeSeq = 0;
    this.localAlive = true;
    /**
     * Sticky death: when set to current lifeSeq, presentation stays dead even if a
     * stale snapshot still shows alive for that life. Cleared on RESPAWN.
     * @type {number|null}
     */
    this._deadLifeSeq = null;
    /**
     * Sticky respawn: when set, presentation stays alive for this lifeSeq even if a
     * stale snapshot still shows dead/older life. Cleared on DEATH.
     * @type {number|null}
     */
    this._aliveLifeSeq = null;
    /**
     * Snapshot generation at which the last self DAMAGE/DEATH/RESPAWN event applied.
     * Snapshot health is ignored while generation <= this (stale HUD).
     * @type {number}
     */
    this._healthStickyUntilGen = -1;
    /** @type {{ shotSeq: number, hitPlayerId: string, hitKind: string|null, damage: number, at: number }|null} */
    this.lastHitMarker = null;
    /** @type {{ victimId: string, attackerId: string|null, cause: string, at: number }|null} */
    this.lastDeath = null;
    this.stats = {
      firesSent: 0,
      reloadsSent: 0,
      accepted: 0,
      rejected: 0,
      hitsConfirmed: 0,
      damageEvents: 0,
      deaths: 0,
      respawns: 0,
      localFrags: 0,
      shotResultsIgnored: 0,
    };
    /** @type {THREE.Group|null} */
    this._deathVfx = null;
    this._deathVfxAge = 0;
    this._interceptorInstalled = false;
  }

  /** Networked deathmatch combat is live (not offline arena review). */
  isNetworkCombatActive() {
    const net = this._feature?._network;
    if (!this._feature?._active || !net?.isNetworkReady?.()) return false;
    return net.phase === MATCH_PHASE.RUNNING || net.phase === MATCH_PHASE.COUNTDOWN;
  }

  /**
   * True when local gun tryFire must not run (would burn mag with no server correction).
   * Dead / countdown / non-running networked phases suppress predicted fire.
   */
  shouldSuppressLocalFire() {
    if (!this.isNetworkCombatActive()) return false;
    const net = this._feature._network;
    if (net.phase !== MATCH_PHASE.RUNNING) return true;
    if (!this.localAlive) return true;
    const local = net.getLocalPlayer?.();
    if (local && local.alive === false && this._aliveLifeSeq == null) return true;
    return false;
  }

  /** True when fire hitscan must be network-owned (skip local enemy damage). */
  shouldInterceptFire() {
    if (!this.isNetworkCombatActive()) return false;
    return true; // networked deathmatch never trusts local hitscan for scoring
  }

  /**
   * Install WeaponSystem combat hooks. Idempotent.
   * Offline (no network) leaves WeaponSystem untouched.
   */
  installWeaponInterceptor(weaponSystem) {
    if (!weaponSystem || this._interceptorInstalled) return;
    if (!this._feature?._network) return;
    weaponSystem.setCombatInterceptor?.((payload) => this._onWeaponFire(payload));
    weaponSystem.setReloadInterceptor?.((payload) => this._onWeaponReload(payload));
    weaponSystem.setCombatFireGate?.(() => this.shouldSuppressLocalFire());
    this._interceptorInstalled = true;
  }

  clearWeaponInterceptor(weaponSystem) {
    // Always clear hooks when asked (offline / dispose), even if never installed.
    weaponSystem?.setCombatInterceptor?.(null);
    weaponSystem?.setReloadInterceptor?.(null);
    weaponSystem?.setCombatFireGate?.(null);
    this._interceptorInstalled = false;
  }

  /**
   * WeaponSystem fire hook. Returns true when local hitscan damage must be skipped.
   * Cosmetic muzzle/recoil still run when a shot was predicted (RUNNING + alive).
   */
  _onWeaponFire({ origin, direction, weaponId } = {}) {
    if (!this.shouldInterceptFire()) return false;

    const net = this._feature._network;
    // Dead / countdown: fire gate should already have suppressed tryFire; if we
    // still get here, swallow hitscan and do not send / do not count a shot.
    if (net.phase !== MATCH_PHASE.RUNNING || !this.localAlive) {
      return true;
    }
    if (!Array.isArray(origin) || !Array.isArray(direction)) return true;

    const wid = weaponId || this.currentWeaponId || STARTING_WEAPON;
    this.shotSeq += 1;
    const now = this._feature._wallNow();
    const clientTime = estimateCombatClientTime(now, net.clockOffsetMs ?? 0);
    const msg = buildFireMessage({
      shotSeq: this.shotSeq,
      clientTime,
      weaponId: wid,
      origin,
      direction,
    });
    net.send(msg);
    this.stats.firesSent += 1;
    this.currentWeaponId = wid;
    return true;
  }

  _onWeaponReload({ weaponId } = {}) {
    if (!this.isNetworkCombatActive()) return false;
    const net = this._feature._network;
    if (net.phase !== MATCH_PHASE.RUNNING) return false;
    if (!this.localAlive) return false;

    const wid = weaponId || this.currentWeaponId || STARTING_WEAPON;
    this.actionSeq += 1;
    const msg = buildReloadMessage({ actionSeq: this.actionSeq, weaponId: wid });
    net.send(msg);
    this.stats.reloadsSent += 1;
    return true;
  }

  /**
   * Drain SHOT_RESULT + combat events. Call from applyAuthoritative each frame.
   */
  tick({ character, physics, weaponSystem, firstPersonWeaponSystem, nowMs } = {}) {
    if (!this._feature?._active || !this._feature._network?.isNetworkReady?.()) return;
    const net = this._feature._network;
    const now = this._feature._wallNow(nowMs);

    this.installWeaponInterceptor(weaponSystem ?? this._feature._host?.weaponSystem);

    this._syncFromSnapshot(net, character, weaponSystem, firstPersonWeaponSystem);

    // SHOT_RESULT queue (shooter-only). Monotonic — ignore late/out-of-order.
    // Skip entirely while dead: previous-life results must not clobber loadout
    // after death and before respawn (discard also runs on DEATH/RESPAWN).
    if (this.localAlive) {
      const results = net.drainShotResults?.() ?? [];
      for (const result of results) {
        const seq = typeof result.shotSeq === 'number' ? result.shotSeq : -1;
        if (seq >= 0 && seq <= this._lastAppliedShotSeq) {
          this.stats.shotResultsIgnored += 1;
          continue;
        }
        if (seq >= 0) this._lastAppliedShotSeq = seq;

        const applied = applyShotResult(result, null);
        if (applied.ammo != null) this.authoritativeAmmo = applied.ammo;
        if (applied.accepted) {
          this.stats.accepted += 1;
          if (applied.hit) {
            this.stats.hitsConfirmed += 1;
            this.lastHitMarker = {
              shotSeq: applied.shotSeq,
              hitPlayerId: applied.hitPlayerId,
              hitKind: applied.hitKind,
              damage: applied.damage,
              at: now,
            };
          }
        } else {
          this.stats.rejected += 1;
        }
        this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
      }
    }

    // Freeze local locomotion while dead (sample/send already gated).
    if (!this.localAlive && character) {
      if (character.velocity?.set) character.velocity.set(0, 0, 0);
      if (typeof character.verticalVelocity === 'number') character.verticalVelocity = 0;
    }

    // Death VFX aging.
    if (this._deathVfx) {
      this._deathVfxAge += 1 / 60;
      const t = Math.min(1, this._deathVfxAge / DEATH_VFX_LIFE);
      this._deathVfx.scale.setScalar(1 + t * 1.4);
      for (const child of this._deathVfx.children) {
        if (child.material) {
          child.material.opacity = Math.max(0, 1 - t);
          child.material.transparent = true;
        }
      }
      if (this._deathVfxAge >= DEATH_VFX_LIFE) this._clearDeathVfx();
    }

    void physics;
  }

  /**
   * Apply snapshot baseline without undoing discrete DEATH/RESPAWN/DAMAGE.
   */
  _syncFromSnapshot(net, character, weaponSystem, firstPersonWeaponSystem) {
    const local = net.getLocalPlayer?.();
    if (!local) return;

    const snapGen = typeof net.snapshotGeneration === 'number' ? net.snapshotGeneration : 0;
    const snapLife = typeof local.lifeSeq === 'number' ? local.lifeSeq : 0;

    // Older life than our sticky event state — ignore entirely.
    if (snapLife < this.lifeSeq) {
      this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
      this._syncCharacterHealth(character);
      return;
    }

    // Sticky death wins over same-life snapshot that still says alive.
    if (this._deadLifeSeq != null && this._deadLifeSeq === this.lifeSeq && snapLife <= this.lifeSeq) {
      this.localAlive = false;
      this.authoritativeHealth = 0;
      if (typeof local.spawnProtectedUntil === 'number') {
        this.spawnProtectedUntil = local.spawnProtectedUntil;
      }
      this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
      this._syncCharacterHealth(character);
      return;
    }

    // Sticky respawn wins over same-life snapshot that still says dead / older pose.
    if (this._aliveLifeSeq != null && this._aliveLifeSeq === this.lifeSeq && snapLife <= this.lifeSeq) {
      this.localAlive = true;
      // Health: only take snapshot when a newer generation arrived after the event.
      // Never adopt health <= 0 or alive:false while sticky-alive (stale dead snap).
      if (
        snapGen > this._healthStickyUntilGen
        && typeof local.health === 'number'
        && local.health > 0
        && local.alive !== false
      ) {
        this.authoritativeHealth = local.health;
        this._healthStickyUntilGen = -1;
      }
      if (typeof local.spawnProtectedUntil === 'number') {
        this.spawnProtectedUntil = local.spawnProtectedUntil;
      }
      if (local.currentWeapon) this.currentWeaponId = local.currentWeapon;
      this._applyWeaponsFromSnap(local);
      this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
      this._syncCharacterHealth(character);
      return;
    }

    // Snapshot is a newer life (missed respawn event) or no sticky conflict.
    if (snapLife > this.lifeSeq) {
      this.lifeSeq = snapLife;
      this._deadLifeSeq = local.alive === false ? snapLife : null;
      this._aliveLifeSeq = local.alive !== false ? snapLife : null;
      this.localAlive = local.alive !== false;
      if (typeof local.health === 'number') this.authoritativeHealth = local.health;
      this._healthStickyUntilGen = -1;
    } else {
      // Same life, no sticky conflict.
      if (typeof local.alive === 'boolean') this.localAlive = local.alive;
      if (snapGen > this._healthStickyUntilGen && typeof local.health === 'number') {
        this.authoritativeHealth = local.health;
        this._healthStickyUntilGen = -1;
      } else if (this._healthStickyUntilGen < 0 && typeof local.health === 'number') {
        this.authoritativeHealth = local.health;
      }
    }

    if (typeof local.spawnProtectedUntil === 'number') {
      this.spawnProtectedUntil = local.spawnProtectedUntil;
    }
    if (local.currentWeapon) this.currentWeaponId = local.currentWeapon;
    this._applyWeaponsFromSnap(local);
    this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
    this._syncCharacterHealth(character);
  }

  _applyWeaponsFromSnap(local) {
    if (local.weapons && local.currentWeapon && local.weapons[local.currentWeapon]) {
      const inv = local.weapons[local.currentWeapon];
      if (typeof inv.ammo === 'number') this.authoritativeAmmo = inv.ammo;
      if (typeof inv.reserve === 'number') this.authoritativeReserve = inv.reserve;
    }
  }

  /**
   * Handle a drained server event (called by the feature's event loop).
   */
  handleEvent(ev, { character, physics, weaponSystem, firstPersonWeaponSystem } = {}) {
    if (!ev) return;
    const net = this._feature._network;
    const now = this._feature._wallNow();
    const payload = ev.payload ?? {};
    const snapGen = typeof net?.snapshotGeneration === 'number' ? net.snapshotGeneration : 0;

    switch (ev.kind) {
      case EVENT_KIND.DAMAGE: {
        this.stats.damageEvents += 1;
        if (payload.victimId === net?.playerId && typeof payload.amount === 'number') {
          this.authoritativeHealth = Math.max(0, this.authoritativeHealth - payload.amount);
          this._healthStickyUntilGen = snapGen;
          this._syncCharacterHealth(character);
        }
        // Remote hit flash on puppet + shooter fire kick (M6 presentation).
        if (payload.victimId && payload.victimId !== net?.playerId) {
          this._feature._host?.remotePlayerSystem?.flashHit?.(payload.victimId);
        }
        if (payload.attackerId && payload.attackerId !== net?.playerId) {
          this._feature._host?.remotePlayerSystem?.playFire?.(payload.attackerId);
        }
        break;
      }
      case EVENT_KIND.DEATH: {
        this.stats.deaths += 1;
        this.lastDeath = {
          victimId: payload.victimId,
          attackerId: payload.attackerId ?? null,
          cause: payload.cause ?? 'kill',
          at: now,
        };
        if (payload.attackerId === net?.playerId && payload.victimId !== net?.playerId) {
          this.stats.localFrags += 1;
        }
        if (payload.victimId === net?.playerId) {
          this.localAlive = false;
          this.authoritativeHealth = 0;
          this._deadLifeSeq = this.lifeSeq;
          this._aliveLifeSeq = null;
          this._healthStickyUntilGen = snapGen;
          // Drop undrained previous-life SHOT_RESULTs so they cannot apply later.
          this._discardPendingShotResults(net);
          this._syncCharacterHealth(character);
          this._spawnLocalDeathVfx(character);
          if (character?.group) character.group.visible = false;
          if (character?.velocity?.set) character.velocity.set(0, 0, 0);
          if (typeof character?.verticalVelocity === 'number') character.verticalVelocity = 0;
        } else if (payload.victimId) {
          // Brief remote death flash (match-only puppets already hide when !alive).
          this._feature._host?.remotePlayerSystem?.flashHit?.(payload.victimId);
        }
        break;
      }
      case EVENT_KIND.RESPAWN: {
        if (payload.playerId !== net?.playerId) break;
        this.stats.respawns += 1;
        // Only discard/reset fire sequencing when this is a real dead→alive
        // transition. A late-drained match-start RESPAWN must not drop SHOT_RESULTs
        // already queued for shots taken this life.
        const wasDead = this.localAlive === false || this._deadLifeSeq != null;
        this.localAlive = true;
        this._deadLifeSeq = null;
        const loadout = loadoutFromRespawn(payload);
        this.authoritativeHealth = loadout.health;
        this.currentWeaponId = loadout.weaponId;
        this.spawnProtectedUntil = loadout.spawnProtectedUntil;
        this.lifeSeq = loadout.lifeSeq;
        this._aliveLifeSeq = loadout.lifeSeq;
        this._healthStickyUntilGen = snapGen;
        const inv = loadout.weapons[loadout.weaponId];
        this.authoritativeAmmo = inv?.ammo ?? null;
        this.authoritativeReserve = inv?.reserve ?? null;
        this._clearDeathVfx();
        if (character?.group) {
          character.group.visible = true;
          if (Array.isArray(loadout.position)) {
            this._feature._snapCharacter?.(
              character,
              physics ?? this._feature._host?.physicsSystem,
              loadout.position,
              loadout.yaw,
              { forceYaw: true },
            );
          }
        }
        // Critical: discard pending previous-life SHOT_RESULTs BEFORE resetting the
        // shotSeq watermark. Otherwise shotSeq 1…N from the old life re-apply and
        // block new-life results (and clobber starting ammo).
        if (wasDead) {
          this._discardPendingShotResults(net);
          this.shotSeq = 0;
          this._lastAppliedShotSeq = -1;
        }
        this._applyLoadoutToWeapons(weaponSystem, firstPersonWeaponSystem, loadout);
        this._syncCharacterHealth(character);
        this._feature._activePredictedJumpPadId = null;
        this._feature._activePredictedTeleporterId = null;
        break;
      }
      case EVENT_KIND.RELOAD_COMPLETE:
      case 'reload_complete': {
        if (payload.playerId !== net?.playerId) break;
        // Server owns mag contents — apply only from this event (not local gun refill).
        if (typeof payload.ammo === 'number') this.authoritativeAmmo = payload.ammo;
        if (typeof payload.reserve === 'number') this.authoritativeReserve = payload.reserve;
        if (payload.weaponId) this.currentWeaponId = payload.weaponId;
        this._syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem);
        break;
      }
      default:
        break;
    }
  }

  isLocalSpawnProtected(serverTime) {
    return isSpawnProtected(this.spawnProtectedUntil, serverTime);
  }

  snapshot() {
    return {
      shotSeq: this.shotSeq,
      actionSeq: this.actionSeq,
      health: this.authoritativeHealth,
      ammo: this.authoritativeAmmo,
      reserve: this.authoritativeReserve,
      weaponId: this.currentWeaponId,
      alive: this.localAlive,
      lifeSeq: this.lifeSeq,
      spawnProtectedUntil: this.spawnProtectedUntil,
      lastHitMarker: this.lastHitMarker,
      lastDeath: this.lastDeath,
      stats: { ...this.stats },
    };
  }

  dispose() {
    this.clearWeaponInterceptor(this._feature?._host?.weaponSystem);
    this._clearDeathVfx();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Drop undrained SHOT_RESULTs for the prior life. Safe no-op without a network.
   */
  _discardPendingShotResults(net) {
    const n = net?.discardPendingShotResults?.() ?? 0;
    if (n > 0) this.stats.shotResultsIgnored += n;
  }

  _syncCharacterHealth(character) {
    if (!character) return;
    character.health = this.authoritativeHealth;
    character.maxHealth = HEALTH.max;
  }

  _syncLocalGunAmmo(weaponSystem, firstPersonWeaponSystem) {
    if (this.authoritativeAmmo == null) return;
    const gun = firstPersonWeaponSystem?.gunView?.gun
      ?? weaponSystem?._preloadedGun
      ?? null;
    if (gun && typeof gun.ammoInMag === 'number') {
      gun.ammoInMag = this.authoritativeAmmo;
      if (this.authoritativeReserve != null && typeof gun.reserveAmmo === 'number') {
        gun.reserveAmmo = this.authoritativeReserve;
      }
    }
  }

  _applyLoadoutToWeapons(weaponSystem, firstPersonWeaponSystem, loadout) {
    const ws = weaponSystem ?? this._feature._host?.weaponSystem;
    const fp = firstPersonWeaponSystem ?? this._feature._host?.firstPersonWeaponSystem;
    if (ws?.equipAndDraw && loadout.weaponId) {
      try {
        ws.equipAndDraw(loadout.weaponId, {
          character: this._feature._host?.characterSystem?.player,
          firstPersonWeaponSystem: fp,
        });
      } catch {
        // equip is best-effort during node harnesses without full FP setup
      }
    }
    this._syncLocalGunAmmo(ws, fp);
  }

  _spawnLocalDeathVfx(character) {
    this._clearDeathVfx();
    const scene = this._feature._host?.sceneSystem?.scene;
    if (!scene || !character?.group) return;

    const root = new THREE.Group();
    root.name = 'DeathmatchDeathVfx';
    root.userData.skipLevelRaycast = true;
    root.userData.noStaticMerge = true;
    const pos = character.group.position;
    root.position.set(pos.x, pos.y + 0.9, pos.z);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5533,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const geo = new THREE.SphereGeometry(0.35, 10, 8);
    const mesh = new THREE.Mesh(geo, mat);
    root.add(mesh);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.55, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffaa66,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    root.add(ring);

    scene.add(root);
    this._deathVfx = root;
    this._deathVfxAge = 0;
  }

  _clearDeathVfx() {
    if (!this._deathVfx) return;
    this._deathVfx.parent?.remove(this._deathVfx);
    disposeObject3D(this._deathVfx);
    this._deathVfx = null;
    this._deathVfxAge = 0;
  }
}
