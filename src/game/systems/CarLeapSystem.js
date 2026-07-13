/**
 * CarLeapSystem (M3) — hold-to-commit car-to-car / platform leap.
 *
 * Hold leap key → acquire nearest platform target + drain bullet-time meter.
 * Release → commit leap with inherited platform/vehicle velocity, or plain
 * inherited-velocity jump if no target.
 *
 * Targets come from PlatformRidingSystem (not static level.colliders).
 * Animation: reuses vault / freeFall until a dedicated leap clip exists.
 */

import * as THREE from 'three';

const _toTarget = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _face = new THREE.Vector3();
const _euler = new THREE.Euler();

/** Hold-to-aim leap (not jump). */
export const CAR_LEAP_HOLD_MIN = 0.08; // s before aim counts as "acquired"
export const CAR_LEAP_RANGE_MIN = 1.5;
/** Highway platforms are often 15–35 m ahead; keep generous for catch-up. */
export const CAR_LEAP_RANGE_MAX = 38;
export const CAR_LEAP_LATERAL_MAX = 9;
export const CAR_LEAP_UP_IMPULSE = 5.8;
export const CAR_LEAP_FORWARD_IMPULSE = 4.2;
export const CAR_LEAP_DURATION_MAX = 1.35;
export const CAR_LEAP_LAND_TOLERANCE = 0.85;

/** Bullet-time meter (0–1). */
export const BULLET_TIME_MAX = 1;
export const BULLET_TIME_DRAIN_PER_SEC = 0.38;
export const BULLET_TIME_RECHARGE_PER_SEC = 0.12;
export const BULLET_TIME_SCALE = 0.22; // sim scale while aiming
export const BULLET_TIME_MIN_TO_START = 0.08;

export class CarLeapSystem {
  constructor() {
    this.bulletTime = BULLET_TIME_MAX;
    this.aiming = false;
    this.aimTarget = null; // { bodyHandle, worldSurfacePoint, score, owner }
    this._lastAimTarget = null;
    this.holdElapsed = 0;
    this.status = 'ready';
    this._marker = null;
    this.scene = null;
  }

  initialize({ scene = null } = {}) {
    this.scene = scene;
    this._ensureMarker();
    return this;
  }

  /**
   * Called once per frame BEFORE physics planning so timeScale can slow the sim.
   * @returns {{ timeScale: number, aiming: boolean, target: object|null }}
   */
  updateBulletTime({ delta, input, character, platforms, vehicleSystem }) {
    const canAim = this._canAimLeap(character, vehicleSystem);
    const leap = this._resolveLeapInput(input, character, vehicleSystem);
    const holding = Boolean(leap.held) && canAim;

    if (holding) {
      this.aiming = true;
      this.holdElapsed += delta; // real-time hold (caller passes unscaled delta for meter UX)
      if (this.bulletTime > 0) {
        this.bulletTime = Math.max(0, this.bulletTime - BULLET_TIME_DRAIN_PER_SEC * delta);
      }
      this.aimTarget = this.findLeapTarget({ character, platforms, vehicleSystem });
      // Keep last acquired target so release (same frame as hold ends) can still commit.
      if (this.aimTarget) this._lastAimTarget = this.aimTarget;
    } else {
      // Do not clear aimTarget here — update() consumes release and clears.
      this.aiming = false;
      if (!character?.carLeap?.active) {
        this.bulletTime = Math.min(
          BULLET_TIME_MAX,
          this.bulletTime + BULLET_TIME_RECHARGE_PER_SEC * delta,
        );
      }
    }

    this._updateMarker(this.aiming ? this.aimTarget : null);

    const useSlowMo = this.aiming
      && this.bulletTime > 0
      && this.holdElapsed >= CAR_LEAP_HOLD_MIN;
    return {
      timeScale: useSlowMo ? BULLET_TIME_SCALE : 1,
      aiming: this.aiming,
      target: this.aimTarget,
      bulletTime: this.bulletTime,
    };
  }

  /**
   * Traversal-style update in the movement chain (scaled delta).
   */
  update({
    delta,
    input,
    movement,
    character,
    platforms,
    vehicleSystem,
    physics,
  }) {
    if (character.carLeap?.active) {
      return this._updateActiveLeap({
        delta,
        movement,
        character,
        platforms,
        physics,
      });
    }

    // Commit on release after a hold (Space while roof-surf / on platform).
    const leap = this._resolveLeapInput(input, character, vehicleSystem);
    const released = Boolean(leap.released);
    if (!released) {
      return movement;
    }

    if (!this._canAimLeap(character, vehicleSystem) && !character.platformSupport) {
      return movement;
    }

    const heldLongEnough = this.holdElapsed >= CAR_LEAP_HOLD_MIN
      || this.aimTarget
      || this._lastAimTarget;
    const target = this.aimTarget
      ?? this._lastAimTarget
      ?? (heldLongEnough
        ? this.findLeapTarget({ character, platforms, vehicleSystem })
        : null);

    // Always clear aim state on release.
    this.aiming = false;
    this.holdElapsed = 0;
    this.aimTarget = null;
    this._lastAimTarget = null;
    this._updateMarker(null);

    if (target) {
      this.startLeap({ character, target, vehicleSystem, platforms });
      return this._overrideMovement(movement, character);
    }

    // No target: plain inherited-velocity jump off roof / platform.
    this._plainLeapJump({ character, vehicleSystem, platforms });
    // Mark carLeaping for one frame so MovementSystem does not immediately
    // re-snap / re-drive; free-fall residual is then normal locomotion.
    character.carLeap = {
      active: true,
      state: 'jump',
      targetHandle: null,
      targetPoint: character.group.position.clone(),
      startPosition: character.group.position.clone(),
      elapsed: 0,
      duration: 0.45,
      owner: null,
      plainJump: true,
    };
    return this._overrideMovement(movement, character);
  }

  startLeap({ character, target, vehicleSystem, platforms }) {
    // Detach from roof-surf / vehicle first; inherit velocity.
    const sourceVel = this._detachSource(character, vehicleSystem, platforms);

    const start = character.group.position.clone();
    const land = target.worldSurfacePoint.clone();
    land.y += 0.02;

    _toTarget.copy(land).sub(start);
    const horiz = Math.hypot(_toTarget.x, _toTarget.z);
    const duration = THREE.MathUtils.clamp(horiz / 12, 0.35, CAR_LEAP_DURATION_MAX);

    // Ballistic-ish: average horizontal velocity to reach target + lift.
    const vx = _toTarget.x / duration;
    const vz = _toTarget.z / duration;
    const g = 18; // approx match GAME_CONFIG gravity feel for arc
    const vy = (_toTarget.y / duration) + 0.5 * g * duration;

    character.velocity.set(
      sourceVel.x * 0.55 + vx * 0.45,
      0,
      sourceVel.z * 0.55 + vz * 0.45,
    );
    character.verticalVelocity = Math.max(vy, CAR_LEAP_UP_IMPULSE * 0.65) + sourceVel.y * 0.35;
    character.grounded = false;
    character.vehicle = null;
    character.platformSupport = null;
    character.platformResnapBlockTimer = 0.05;

    character.carLeap = {
      active: true,
      state: 'leap',
      targetHandle: target.bodyHandle,
      targetPoint: land.clone(),
      startPosition: start,
      elapsed: 0,
      duration,
      owner: target.owner ?? null,
    };

    // Face leap direction, upright only (no seat pitch/roll).
    if (character.velocity.x * character.velocity.x + character.velocity.z * character.velocity.z > 0.04) {
      forceUprightYaw(character, Math.atan2(character.velocity.x, character.velocity.z));
    } else {
      forceUprightYaw(character, null);
    }

    character.animationController?.play?.('runVault', 0.12);
    this.aimTarget = null;
  }

  /**
   * Nearest valid platform ahead within leap envelope.
   */
  findLeapTarget({ character, platforms, vehicleSystem }) {
    const registry = platforms?.platforms;
    if (!registry || registry.size === 0) return null;

    const veh = vehicleSystem?.activeVehicle;
    // Use chassis origin when roof-surfing — hip anchor is offset and throws range checks.
    const origin = veh?.group?.position ?? character.group?.position;
    if (!origin) return null;
    const exclude = this._excludedHandles(character, vehicleSystem);

    // Facing: vehicle yaw or character yaw (chassis travels world −Z at yaw 0).
    let yaw = character.group?.rotation?.y ?? 0;
    if (veh?.group) {
      // Prefer euler Y from chassis quaternion (seat-lock sets character quat, not always .rotation.y).
      const e = new THREE.Euler().setFromQuaternion(veh.group.quaternion, 'YXZ');
      yaw = e.y;
    }
    _forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));

    let best = null;
    let bestScore = -Infinity;

    for (const [handle, entry] of registry) {
      if (exclude.has(handle)) continue;
      const body = platforms.physics?.getFreshBody?.(handle);
      if (!body) continue;
      let t;
      let r;
      try {
        t = body.translation();
        r = body.rotation();
      } catch {
        continue;
      }

      // Surface center in world
      _tmp.set(entry.localCenter.x, entry.surfaceY, entry.localCenter.z);
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      _tmp.applyQuaternion(q);
      _tmp.x += t.x;
      _tmp.y += t.y;
      _tmp.z += t.z;

      _toTarget.set(_tmp.x - origin.x, _tmp.y - origin.y, _tmp.z - origin.z);
      const horiz = Math.hypot(_toTarget.x, _toTarget.z);
      if (horiz < CAR_LEAP_RANGE_MIN || horiz > CAR_LEAP_RANGE_MAX) continue;

      const lateral = Math.abs(_toTarget.x * _forward.z - _toTarget.z * _forward.x);
      if (lateral > CAR_LEAP_LATERAL_MAX) continue;

      const ahead = _toTarget.x * _forward.x + _toTarget.z * _forward.z;
      // Prefer ahead; allow slight behind for traffic windows.
      if (ahead < -4) continue;

      // Score: closer + more ahead + less lateral
      const score = ahead * 2.2 - horiz * 0.55 - lateral * 1.0;
      if (score > bestScore) {
        bestScore = score;
        best = {
          bodyHandle: handle,
          worldSurfacePoint: _tmp.clone(),
          score,
          owner: entry.owner,
          kind: entry.kind,
          hijackable: entry.hijackable,
        };
      }
    }
    return best;
  }

  snapshot(character) {
    return {
      status: this.status,
      aiming: this.aiming,
      bulletTime: this.bulletTime,
      holdElapsed: this.holdElapsed,
      hasTarget: Boolean(this.aimTarget),
      targetHandle: this.aimTarget?.bodyHandle ?? null,
      carLeap: character?.carLeap?.active
        ? {
            active: true,
            state: character.carLeap.state,
            elapsed: character.carLeap.elapsed,
            targetHandle: character.carLeap.targetHandle,
          }
        : null,
    };
  }

  dispose() {
    if (this._marker) {
      this._marker.parent?.remove?.(this._marker);
      this._marker.geometry?.dispose?.();
      this._marker.material?.dispose?.();
      this._marker = null;
    }
    this.scene = null;
    this.aimTarget = null;
    this.aiming = false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Leap uses Space (jump) while roof-surfing or standing on a platform.
   * Optional KeyL still works as an alias if bound.
   */
  _resolveLeapInput(input, character, vehicleSystem) {
    const can = this._canAimLeap(character, vehicleSystem)
      || Boolean(character?.platformSupport && !character?.vehicle?.active);
    if (!can || !input) {
      return {
        held: Boolean(input?.carLeapHeld),
        released: Boolean(input?.carLeapReleased),
        pressed: Boolean(input?.carLeapPressed),
      };
    }
    return {
      held: Boolean(input.carLeapHeld || input.jump),
      released: Boolean(input.carLeapReleased || input.jumpReleased),
      pressed: Boolean(input.carLeapPressed || input.jumpPressed),
    };
  }

  _canAimLeap(character, vehicleSystem) {
    if (!character) return false;
    if (character.carLeap?.active) return false;
    if (character.vault?.active || character.hang?.active || character.hookSwing?.active) {
      return false;
    }
    // Roof-surf on controlled car, or free feet on a registered platform.
    if (character.vehicle?.active && character.vehicle?.roofSurfing) return true;
    if (character.platformSupport && !character.vehicle?.active) return true;
    // Also allow from roof seat index without flag (belt-and-suspenders).
    const v = vehicleSystem?.activeVehicle;
    if (v && character.vehicle?.active) {
      const seat = v.config?.seats?.[character.vehicle.seatIndex];
      if (seat?.name === 'roof') return true;
    }
    return false;
  }

  _excludedHandles(character, vehicleSystem) {
    const set = new Set();
    if (character?.platformSupport?.bodyHandle != null) {
      set.add(character.platformSupport.bodyHandle);
    }
    const v = vehicleSystem?.activeVehicle;
    if (v?.bodyHandle != null) set.add(v.bodyHandle);
    return set;
  }

  _detachSource(character, vehicleSystem, platforms) {
    const vel = { x: 0, y: 0, z: 0 };
    const feet = character.group.position;
    let faceYaw = null;

    if (character.vehicle?.active && vehicleSystem?.activeVehicle) {
      const vehicle = vehicleSystem.activeVehicle;
      const body = vehicleSystem.physics?.getFreshBody?.(vehicle.bodyHandle);
      if (body) {
        try {
          const lv = body.linvel();
          vel.x = lv.x;
          vel.y = lv.y;
          vel.z = lv.z;
        } catch { /* ignore */ }
      } else if (Number.isFinite(vehicle.speed)) {
        const yaw = vehicle.group?.rotation.y ?? 0;
        vel.x = -Math.sin(yaw) * vehicle.speed;
        vel.z = -Math.cos(yaw) * vehicle.speed;
      }
      // Chassis travel (−Z at yaw 0) → body facing convention atan2(vx,vz).
      if (vehicle.group) {
        _euler.setFromQuaternion(vehicle.group.quaternion, 'YXZ');
        faceYaw = _euler.y + Math.PI;
      }
      vehicleSystem.detachRiderForLeap?.(character);
    } else if (character.platformSupport && platforms) {
      const pv = platforms.getPointVelocity(
        character.platformSupport.bodyHandle,
        feet,
        _tmp,
      );
      vel.x = pv.x;
      vel.y = pv.y;
      vel.z = pv.z;
      platforms.clearSupport?.(character);
      character.platformResnapBlockTimer = Math.max(
        character.platformResnapBlockTimer ?? 0,
        0.1,
      );
    }

    // Seat-lock copies a full chassis-aligned quaternion; force upright yaw so
    // first-person body / on-foot rig are not left inverted mid-leap.
    if (faceYaw == null && Number.isFinite(vel.x) && Number.isFinite(vel.z)
      && (vel.x * vel.x + vel.z * vel.z) > 0.04) {
      faceYaw = Math.atan2(vel.x, vel.z);
    }
    forceUprightYaw(character, faceYaw);

    return vel;
  }

  _plainLeapJump({ character, vehicleSystem, platforms }) {
    const sourceVel = this._detachSource(character, vehicleSystem, platforms);
    character.velocity.x = sourceVel.x;
    character.velocity.z = sourceVel.z;
    character.verticalVelocity = CAR_LEAP_UP_IMPULSE + sourceVel.y * 0.25;
    // Nudge along upright body forward (atan2 body convention: yaw 0 faces +Z).
    let yaw = character.group?.rotation?.y ?? 0;
    if (character.velocity.x * character.velocity.x + character.velocity.z * character.velocity.z > 0.04) {
      yaw = Math.atan2(character.velocity.x, character.velocity.z);
    }
    forceUprightYaw(character, yaw);
    // Body forward for yaw θ is (sin θ, 0, cos θ) with atan2(vx,vz) convention.
    character.velocity.x += Math.sin(yaw) * CAR_LEAP_FORWARD_IMPULSE;
    character.velocity.z += Math.cos(yaw) * CAR_LEAP_FORWARD_IMPULSE;
    character.grounded = false;
    character.vehicle = null;
    character.platformResnapBlockTimer = 0.12;
  }

  _updateActiveLeap({ delta, movement, character, platforms, physics }) {
    const leap = character.carLeap;
    if (!leap?.active) return movement;

    leap.elapsed += delta;

    // Plain jump off roof: short ownership then hand off to normal airborne move.
    if (leap.plainJump) {
      const g = 18;
      character.verticalVelocity -= g * delta;
      character.group.position.x += character.velocity.x * delta;
      character.group.position.y += character.verticalVelocity * delta;
      character.group.position.z += character.velocity.z * delta;
      if (leap.elapsed >= leap.duration) {
        character.carLeap = null;
        return {
          ...movement,
          carLeaping: false,
          grounded: false,
          airborne: true,
          height: character.group.position.y,
          verticalVelocity: character.verticalVelocity,
        };
      }
      return this._overrideMovement(movement, character);
    }

    // Integrate simple ballistic motion (MovementSystem may also run — we own pose).
    const g = 18;
    character.verticalVelocity -= g * delta;
    character.group.position.x += character.velocity.x * delta;
    character.group.position.y += character.verticalVelocity * delta;
    character.group.position.z += character.velocity.z * delta;

    // Face travel — always rewrite full upright quat (never only .rotation.y).
    if (character.velocity.x * character.velocity.x + character.velocity.z * character.velocity.z > 0.04) {
      forceUprightYaw(character, Math.atan2(character.velocity.x, character.velocity.z));
    }

    // Landing: near target platform surface
    const hit = platforms?.getPlatformAt?.(
      character.group.position,
      character.group.position.y,
      { verticalTolerance: CAR_LEAP_LAND_TOLERANCE },
    );
    const nearTarget = hit
      && (hit.bodyHandle === leap.targetHandle
        || character.group.position.distanceTo(leap.targetPoint) < 2.2);

    if (nearTarget && character.verticalVelocity <= 2.5) {
      this._landOnPlatform(character, hit, platforms, physics);
      return {
        ...movement,
        carLeaping: false,
        carLeapState: null,
        grounded: true,
        airborne: false,
        justLanded: true,
        height: character.group.position.y,
        verticalVelocity: 0,
      };
    }

    if (leap.elapsed >= leap.duration) {
      // Missed — free fall residual
      character.carLeap = null;
      character.grounded = false;
      return {
        ...movement,
        carLeaping: false,
        carLeapState: null,
        grounded: false,
        airborne: true,
        height: character.group.position.y,
        verticalVelocity: character.verticalVelocity,
      };
    }

    return this._overrideMovement(movement, character);
  }

  _landOnPlatform(character, hit, platforms, physics) {
    character.group.position.x = hit.worldSurfacePoint.x;
    character.group.position.y = hit.worldSurfacePoint.y;
    character.group.position.z = hit.worldSurfacePoint.z;
    character.verticalVelocity = 0;
    character.velocity.set(0, 0, 0);
    character.grounded = true;
    character.carLeap = null;
    platforms?.attachSupport?.(character, hit);
    // Brief block so we don't immediately re-jump.
    character.traversalRecoveryTimer = 0.15;
    character.animationController?.play?.('land', 0.1);
    void physics;
  }

  _overrideMovement(movement, character) {
    return {
      ...movement,
      moving: false,
      wantsMove: false,
      speed: Math.hypot(character.velocity.x, character.velocity.z),
      grounded: false,
      airborne: true,
      driving: false,
      carLeaping: true,
      carLeapState: character.carLeap?.state ?? 'leap',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: character.verticalVelocity,
    };
  }

  _ensureMarker() {
    if (this._marker || !this.scene) return;
    const geo = new THREE.RingGeometry(0.55, 0.75, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xf0b24a,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._marker = new THREE.Mesh(geo, mat);
    this._marker.rotation.x = -Math.PI / 2;
    this._marker.visible = false;
    this._marker.name = 'CarLeap Target Marker';
    this.scene.add(this._marker);
  }

  _updateMarker(target) {
    if (!this._marker) return;
    if (!target?.worldSurfacePoint) {
      this._marker.visible = false;
      return;
    }
    this._marker.visible = true;
    this._marker.position.set(
      target.worldSurfacePoint.x,
      target.worldSurfacePoint.y + 0.05,
      target.worldSurfacePoint.z,
    );
  }
}

/**
 * Clear seat-lock pitch/roll. Body yaw uses MovementSystem convention:
 * atan2(vx, vz) so facing world −Z is π (see firstPersonRig.cameraYawToBodyYaw).
 */
function forceUprightYaw(character, yawRadians = null) {
  const g = character?.group;
  if (!g) return;

  let yaw = yawRadians;
  if (!Number.isFinite(yaw)) {
    // Project current facing onto XZ; if inverted, fall back to world −Z.
    _face.set(0, 0, 1).applyQuaternion(g.quaternion);
    _face.y = 0;
    if (_face.lengthSq() < 0.05) {
      _face.set(0, 0, -1);
    } else {
      _face.normalize();
    }
    yaw = Math.atan2(_face.x, _face.z);
  }

  g.rotation.order = 'YXZ';
  g.rotation.set(0, yaw, 0);
  g.quaternion.setFromAxisAngle(_up, yaw);
  if (character) character.yaw = yaw;
}
