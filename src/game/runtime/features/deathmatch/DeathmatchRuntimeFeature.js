/**
 * DeathmatchRuntimeFeature (M3) — binds the network system to runtime services.
 *
 * Owns:
 *   - movement sample collection / send cadence
 *   - authoritative correction application (soft + hard snap)
 *   - local prediction of jump pads / teleporters + server TELEPORT correction
 *   - remote puppet ingest + interpolation tick
 *   - join/leave puppet lifecycle (via RemotePlayerSystem)
 *
 * Does not own the socket (App + DeathmatchNetworkSystem). Offline deathmatch
 * (no networkSystem) is a no-op so solo arena review still works.
 *
 * Clock domain: wall clock via `Date.now` / network `_now` end-to-end. Never
 * `performance.now` for clientTime / sample cadence / remote serverTime — the
 * server and pong RTT use epoch ms (`Date.now`).
 */

import { EVENT_KIND } from '../../../net/deathmatchProtocol.js';
import { MATCH_PHASE, MOVEMENT } from '../../../config/deathmatch/deathmatchRules.js';
import { findTriggerAt } from '../../../config/deathmatch/railCrucibleMap.js';
import {
  buildPlayerStateMessage,
  planCorrection,
  applyTeleportPayload,
  shouldSample,
  estimateClientTime,
} from '../../../net/deathmatchMovementReplication.js';
import { attachDeathmatchRuntimeSnapshot } from './deathmatchRuntimeSnapshot.js';
import { DeathmatchCombatAdapter } from './DeathmatchCombatAdapter.js';

export class DeathmatchRuntimeFeature {
  /**
   * @param {object} host RuntimeKernel
   */
  constructor(host) {
    this._host = host;
    this._active = host.levelMode === 'deathmatch';
    /** @type {import('../../../systems/DeathmatchNetworkSystem.js').DeathmatchNetworkSystem|null} */
    this._network = host.networkSystem ?? null;
    this._sampleSeq = 0;
    this._lastSampleAt = 0;
    this._lastSnapshotGeneration = -1;
    /** One-shot jump-pad id until the local player leaves that volume. */
    this._activePredictedJumpPadId = null;
    /** One-shot teleporter id until exit (prevents re-snap every frame in volume). */
    this._activePredictedTeleporterId = null;
    this._stats = {
      correctionsApplied: 0,
      hardSnaps: 0,
      softCorrects: 0,
      teleportsApplied: 0,
      jumpPadsApplied: 0,
      samplesSent: 0,
      predictedTriggers: 0,
    };
    this._attachedScene = false;
    /** M4: authoritative combat / death / respawn presentation. */
    this.combat = new DeathmatchCombatAdapter(this);
    attachDeathmatchRuntimeSnapshot(this);
  }

  /** Inject / replace the network system after construction (App path). */
  setNetworkSystem(network) {
    this._network = network ?? null;
    if (this._network?.playerId) {
      this._host.remotePlayerSystem?.setLocalPlayerId?.(this._network.playerId);
    }
    // Force a re-ingest on the next applyAuthoritative even if no new snapshot
    // has arrived (socket may already hold a full player list from welcome).
    this._lastSnapshotGeneration = -1;
    if (this._network) {
      this.combat?.installWeaponInterceptor?.(this._host.weaponSystem);
    } else {
      this.combat?.clearWeaponInterceptor?.(this._host.weaponSystem);
    }
  }

  /**
   * Wall-clock ms in the same domain as the server / ping path.
   * Prefer the network system's injectable clock; never performance.now.
   */
  _wallNow(nowMs) {
    if (Number.isFinite(nowMs)) return nowMs;
    if (typeof this._network?._now === 'function') return this._network._now();
    return Date.now();
  }

  // ── Named frame steps ─────────────────────────────────────────────────────

  /**
   * Early frame: drain teleport events + apply corrections from new snapshots.
   * Runs after input planning, before/around predicted movement.
   */
  applyAuthoritative({ character, physics, nowMs } = {}) {
    if (!this._active || !this._network?.isNetworkReady?.()) return;
    const net = this._network;
    const remotes = this._host.remotePlayerSystem;
    const now = this._wallNow(nowMs);

    this._ensureRemotesAttached();

    if (net.playerId) remotes?.setLocalPlayerId?.(net.playerId);

    // Drain discrete events first (teleports / death / respawn before correction).
    const events = net.drainEvents();
    for (const ev of events) {
      this._handleEvent(ev, character, physics);
    }

    // M4 combat: SHOT_RESULT drain + health/ammo sync (after events so respawn wins).
    this.combat?.tick?.({
      character,
      physics,
      weaponSystem: this._host.weaponSystem,
      firstPersonWeaponSystem: this._host.firstPersonWeaponSystem,
      nowMs: now,
    });

    // Ingest remotes whenever a new snapshot generation lands, or if we have
    // zero puppets but the net list already has peers (missed first ingest).
    const peerCount = Array.isArray(net.players)
      ? net.players.filter((p) => p?.playerId && p.playerId !== net.playerId && p.connected !== false).length
      : 0;
    const puppetCount = remotes?.puppets?.size ?? 0;
    const generationChanged = net.snapshotGeneration !== this._lastSnapshotGeneration;
    const missedPeerIngest = peerCount > 0 && puppetCount === 0;
    if (generationChanged || missedPeerIngest) {
      this._lastSnapshotGeneration = net.snapshotGeneration;
      const serverTime = net.estimateServerTime(now);
      remotes?.ingestPlayers?.(net.players, serverTime, { localPlayerId: net.playerId });
      // Corrections only on real snapshot ticks — not on recovery re-ingest, which
      // would fight local teleporter/jump prediction against a stale self pose.
      if (generationChanged) {
        this._applyLocalCorrection(character, physics);
      }
    }
  }

  /**
   * After predicted movement: sample/send, then local trigger prediction.
   *
   * Teleporter order is critical (sample-then-predict):
   *   1. Detect new teleporter entry at current feet pose
   *   2. Send `player_state` from the **entrance** pose so the server can
   *      validate the volume and emit TELEPORT
   *   3. Immediately after send, snap locally to the exit for responsiveness
   *
   * Jump pads only set velocity (no pose jump), so they may predict before or
   * after the sample without breaking server validation.
   *
   * Locomotion label is derived from live movement fields (not the previous
   * animation frame) so the sample matches the pose being sent.
   */
  sampleAndSend({ character, animationStateSystem, cameraSystem, nowMs } = {}) {
    if (!this._active || !this._network?.isNetworkReady?.()) return;
    if (!character?.group) return;

    const net = this._network;
    const phase = net.phase;
    if (phase !== MATCH_PHASE.RUNNING && phase !== MATCH_PHASE.COUNTDOWN) return;

    // Alive gate: sticky combat death always blocks. Snapshot dead blocks unless
    // a sticky RESPAWN (_aliveLifeSeq) has already restored localAlive before the
    // next snapshot catches up.
    if (this.combat?.localAlive === false) return;
    const local = net.getLocalPlayer();
    if (local && local.alive === false) {
      const stickyRespawn = this.combat?._aliveLifeSeq != null && this.combat.localAlive === true;
      if (!stickyRespawn) return;
    }

    const physics = this._host.physicsSystem;
    const pos = character.group.position;
    const feet = [pos.x, pos.y, pos.z];
    const trigger = findTriggerAt(feet);

    // Jump pad: velocity-only prediction (safe before sample).
    this._predictJumpPad(character, trigger);

    // Teleporter: new entry forces a sample from the entrance pose first.
    const newTeleporter = trigger?.type === 'teleporter'
      && this._activePredictedTeleporterId !== trigger.trigger.id;
    if (trigger?.type !== 'teleporter') {
      this._activePredictedTeleporterId = null;
    }

    const now = this._wallNow(nowMs);
    if (!newTeleporter && !shouldSample(this._lastSampleAt, now, MOVEMENT.sampleIntervalMs)) {
      return;
    }

    // Build from the *current* pose (still entrance for new teleporter).
    // Only advance seq / lastSampleAt and apply exit snap after a successful send.
    // Under backpressure send returns false — keep feet at entrance and do not
    // set the one-shot id so the next frame can retry.
    const vel = character.velocity;
    // MovementSystem and traversal systems rotate the visual/body group. The
    // legacy character.yaw field is only maintained by a few spawn/vehicle
    // paths and can remain frozen, which made every remote face spawn-forward.
    const yaw = Number.isFinite(character.group.rotation?.y)
      ? character.group.rotation.y
      : (Number.isFinite(character.yaw) ? character.yaw : (cameraSystem?.yaw ?? 0));
    const pitch = Number.isFinite(cameraSystem?.pitch) ? cameraSystem.pitch : 0;
    const locomotionState = resolveLocomotionLabel(character, animationStateSystem);

    const nextSeq = this._sampleSeq + 1;
    const msg = buildPlayerStateMessage({
      seq: nextSeq,
      clientTime: estimateClientTime(now, net.clockOffsetMs),
      position: [pos.x, pos.y, pos.z],
      velocity: [
        vel?.x ?? 0,
        (typeof character.verticalVelocity === 'number' ? character.verticalVelocity : (vel?.y ?? 0)),
        vel?.z ?? 0,
      ],
      yaw,
      pitch,
      movementFlags: packMovementFlags(character),
      locomotionState,
      animation: buildAnimationReplicationState(character, animationStateSystem),
    });
    if (!net.send(msg)) {
      // Backpressure / closed socket: leave entrance pose and one-shot unset.
      return;
    }
    this._sampleSeq = nextSeq;
    this._lastSampleAt = now;
    this._stats.samplesSent += 1;

    // Entrance sample is on the wire — now apply local exit snap for feel.
    if (newTeleporter) {
      this._applyLocalTeleporterExit(character, physics, trigger);
    }
  }

  /**
   * Interpolate remote puppets each frame.
   */
  updateRemotes({ delta, nowMs } = {}) {
    if (!this._active) return;
    this._ensureRemotesAttached();
    const remotes = this._host.remotePlayerSystem;
    if (!remotes) return;
    const net = this._network;
    const now = this._wallNow(nowMs);
    const serverTime = net?.estimateServerTime?.(now) ?? now;
    remotes.update({ delta: delta ?? 0, serverTime });
  }

  dispose() {
    // Network is App-owned; RemotePlayerSystem is services-owned (kernel dispose).
    this.combat?.dispose?.();
    this._network = null;
    this._attachedScene = false;
    this._activePredictedJumpPadId = null;
    this._activePredictedTeleporterId = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _ensureRemotesAttached() {
    if (this._attachedScene) return;
    const scene = this._host.sceneSystem?.scene;
    if (!scene || !this._host.remotePlayerSystem) return;
    this._host.remotePlayerSystem.attach(scene);
    this._attachedScene = true;
  }

  /**
   * Jump-pad velocity prediction (one-shot until volume exit). Safe before
   * sample send because it does not relocate the capsule.
   * @param {object} character
   * @param {{ type: string, trigger: object }|null} [trigger] precomputed; if omitted, sampled from feet
   */
  _predictJumpPad(character, trigger = null) {
    if (!character?.group) return;
    const t = trigger ?? findTriggerAt([
      character.group.position.x,
      character.group.position.y,
      character.group.position.z,
    ]);
    if (t?.type !== 'jumpPad') {
      this._activePredictedJumpPadId = null;
      return;
    }
    const padId = t.trigger.id;
    if (this._activePredictedJumpPadId === padId) return;
    this._activePredictedJumpPadId = padId;
    const v = t.trigger.velocity;
    if (Array.isArray(v)) {
      if (character.velocity?.set) character.velocity.set(v[0], v[1], v[2]);
      character.verticalVelocity = v[1];
      character.grounded = false;
      this._stats.jumpPadsApplied += 1;
      this._stats.predictedTriggers += 1;
    }
  }

  /**
   * Local teleporter exit snap — only after the entrance `player_state` was sent.
   */
  _applyLocalTeleporterExit(character, physics, trigger) {
    if (!character?.group || trigger?.type !== 'teleporter') return;
    const tpId = trigger.trigger.id;
    this._activePredictedTeleporterId = tpId;
    const exit = trigger.trigger.exitPosition;
    const exitYaw = trigger.trigger.exitYaw;
    if (!Array.isArray(exit)) return;
    this._snapCharacter(character, physics, exit, exitYaw, { forceYaw: true });
    if (character.velocity?.set) character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    this._stats.teleportsApplied += 1;
    this._stats.predictedTriggers += 1;
  }

  /**
   * @deprecated Use `_predictJumpPad` + sample-then-predict teleporter path.
   * Kept for verifier harnesses that call prediction in isolation.
   */
  _predictLocalTriggers(character, physics) {
    if (!character?.group) return;
    const pos = [
      character.group.position.x,
      character.group.position.y,
      character.group.position.z,
    ];
    const trigger = findTriggerAt(pos);
    this._predictJumpPad(character, trigger);
    if (trigger?.type === 'teleporter'
      && this._activePredictedTeleporterId !== trigger.trigger.id) {
      // Isolated harness path: does not send — tests that need sample-then-predict
      // should go through sampleAndSend.
      this._applyLocalTeleporterExit(character, physics, trigger);
    }
    if (trigger?.type !== 'teleporter') {
      this._activePredictedTeleporterId = null;
    }
  }

  _handleEvent(ev, character, physics) {
    if (!ev) return;
    const net = this._network;
    switch (ev.kind) {
      case EVENT_KIND.PLAYER_LEAVE:
        if (ev.payload?.playerId) {
          this._host.remotePlayerSystem?.removePlayer?.(ev.payload.playerId);
        }
        break;
      case EVENT_KIND.PLAYER_JOIN:
        break;
      case EVENT_KIND.TELEPORT:
        this._applyTeleportEvent(ev.payload, character, physics);
        break;
      case EVENT_KIND.RESPAWN:
        // Combat adapter owns health/loadout/protection + snap; keep M3 flags clear here too.
        this.combat?.handleEvent?.(ev, {
          character,
          physics,
          weaponSystem: this._host.weaponSystem,
          firstPersonWeaponSystem: this._host.firstPersonWeaponSystem,
        });
        break;
      case EVENT_KIND.DEATH:
      case EVENT_KIND.DAMAGE:
      case EVENT_KIND.RELOAD_COMPLETE:
      case 'reload_complete':
        this.combat?.handleEvent?.(ev, {
          character,
          physics,
          weaponSystem: this._host.weaponSystem,
          firstPersonWeaponSystem: this._host.firstPersonWeaponSystem,
        });
        break;
      default:
        break;
    }
  }

  _applyTeleportEvent(payload, character, physics) {
    if (!payload || payload.playerId !== this._network?.playerId) return;
    if (!character?.group) return;

    const pose = {
      position: [
        character.group.position.x,
        character.group.position.y,
        character.group.position.z,
      ],
      velocity: [
        character.velocity?.x ?? 0,
        typeof character.verticalVelocity === 'number' ? character.verticalVelocity : (character.velocity?.y ?? 0),
        character.velocity?.z ?? 0,
      ],
      yaw: Number.isFinite(character.yaw) ? character.yaw : 0,
    };
    const result = applyTeleportPayload(pose, payload);
    if (!result.applied) return;

    if (result.kind === 'teleporter') {
      this._snapCharacter(character, physics, pose.position, pose.yaw, { forceYaw: true });
      if (character.velocity?.set) character.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
      this._activePredictedJumpPadId = null;
      this._activePredictedTeleporterId = payload.triggerId ?? this._activePredictedTeleporterId;
      this._stats.teleportsApplied += 1;
    } else if (result.kind === 'jumpPad') {
      // Already predicted this pad locally: treat server event as confirmation
      // only. Re-applying the full launch under latency (after gravity has run)
      // would double-boost.
      if (payload.triggerId && payload.triggerId === this._activePredictedJumpPadId) {
        return;
      }
      if (character.velocity?.set) {
        character.velocity.set(pose.velocity[0], pose.velocity[1], pose.velocity[2]);
      }
      character.verticalVelocity = pose.velocity[1];
      character.grounded = false;
      if (payload.triggerId) this._activePredictedJumpPadId = payload.triggerId;
      this._stats.jumpPadsApplied += 1;
    }
  }

  _applyLocalCorrection(character, physics) {
    if (!character?.group) return;
    // Sticky combat death blocks corrections; snapshot dead blocks unless sticky respawn.
    if (this.combat?.localAlive === false) return;
    const local = this._network.getLocalPlayer();
    if (!local || !Array.isArray(local.position)) return;
    if (local.alive === false) {
      const stickyRespawn = this.combat?._aliveLifeSeq != null && this.combat.localAlive === true;
      if (!stickyRespawn) return;
    }

    const localPos = [
      character.group.position.x,
      character.group.position.y,
      character.group.position.z,
    ];
    const plan = planCorrection(localPos, local.position);
    if (plan.kind === 'none' || !plan.position) return;

    // Soft corrections blend position only — forcing yaw every snapshot jitters look.
    // Hard snaps / teleports / respawns still adopt server yaw.
    const yaw = plan.kind === 'hard' && Number.isFinite(local.yaw) ? local.yaw : undefined;
    this._snapCharacter(character, physics, plan.position, yaw, { forceYaw: plan.kind === 'hard' });
    if (Array.isArray(local.velocity) && character.velocity?.set) {
      if (plan.kind === 'hard') {
        character.velocity.set(local.velocity[0], local.velocity[1], local.velocity[2]);
        character.verticalVelocity = local.velocity[1];
      }
    }
    this._stats.correctionsApplied += 1;
    if (plan.kind === 'hard') this._stats.hardSnaps += 1;
    else this._stats.softCorrects += 1;
  }

  _snapCharacter(character, physics, position, yaw, { forceYaw = false } = {}) {
    if (!character?.group || !Array.isArray(position)) return;
    character.group.position.set(position[0], position[1], position[2]);
    if (forceYaw && Number.isFinite(yaw)) {
      character.yaw = yaw;
      if (this._host.cameraSystem && this._host.levelMode === 'deathmatch') {
        this._host.cameraSystem.yaw = yaw;
      }
    }
    physics?.syncCharacterBody?.(character);
  }
}

function packMovementFlags(character) {
  let flags = 0;
  if (character?.grounded === false) flags |= 1;
  if (character?.crouching) flags |= 2;
  if ((character?.speed ?? 0) > 6) flags |= 4;
  return flags;
}

/**
 * Lightweight locomotion label from live movement fields so samples are not
 * one animation frame behind. Falls back to animation state when present.
 */
export function resolveLocomotionLabel(character, animationStateSystem) {
  if (character?.grounded === false) {
    const vy = typeof character.verticalVelocity === 'number'
      ? character.verticalVelocity
      : (character.velocity?.y ?? 0);
    if (vy > 1) return 'jump';
    if (vy < -2) return 'fall';
    return 'airborne';
  }
  const speed = Number(character?.speed);
  if (Number.isFinite(speed)) {
    if (speed > 6) return 'run';
    if (speed > 0.5) return 'walk';
    return 'idle';
  }
  const anim = animationStateSystem?.state ?? animationStateSystem?.playbackState;
  return anim ? String(anim) : 'idle';
}

/**
 * Capture the animation controller's actual presentation graph after the local
 * single-player resolver has applied full-body, upper/lower, attack-leg, and
 * feet-only layers. This keeps networking out of the animation decision tree:
 * remote players reproduce its result instead of maintaining a second resolver.
 */
export function buildAnimationReplicationState(character, animationStateSystem) {
  const controller = character?.animationController;
  const fallback = animationStateSystem?.playbackState
    ?? animationStateSystem?.state
    ?? 'idle';
  const base = typeof controller?.currentState === 'string'
    ? controller.currentState
    : String(fallback);
  const optionalState = (value) => typeof value === 'string' && value.length > 0 ? value : null;
  return {
    base,
    upper: optionalState(controller?.upperBodyState),
    layered: controller?.layered === true,
    attackLeg: optionalState(controller?.attackLegState),
    attackLegWeight: Math.max(0, Math.min(1, Number(controller?.attackLegTarget) || 0)),
    footwork: controller?.footworkActive === true,
    footworkLeg: optionalState(controller?.footworkLegState),
    footworkBody: optionalState(controller?.footworkBodyState),
    mirrorX: controller?.mirrorX === -1,
    lean: Math.max(-1, Math.min(1, Number(animationStateSystem?.leanAmount) || 0)),
  };
}
