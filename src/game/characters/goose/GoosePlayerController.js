/**
 * Dog-park controller for the procedural Canada goose.
 *
 * Ground: camera-relative WASD walk (same stick convention as DogPlayerController).
 * Space: jump → takeoff → flight. Hold Space to climb with flap; release to glide.
 * Touching the ground while airborne runs land_feet (or land_water over water).
 */

import * as THREE from 'three';

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const bodyForward = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const prevPos = new THREE.Vector3();
const candidate = new THREE.Vector3();

const WALK_SPEED = 1.55;
const SPRINT_SPEED = 2.35;
const FLY_SPEED = 4.2;
const DIVE_SPEED = 5.5;
const TAKEOFF_BOOST = 4.8;
const FLAP_THRUST = 11.5;
const GRAVITY = 9.5;
const GLIDE_GRAVITY = 3.2;
const DIVE_GRAVITY = 14;
const LAND_TRIGGER_HEIGHT = 0.55;
const MIN_FLIGHT_HEIGHT = 0.35;

/**
 * @param {{
 *   goose: object,
 *   levelSystem: object,
 *   camera: THREE.Camera,
 * }} opts
 */
export class GoosePlayerController {
  constructor({ goose, levelSystem, camera }) {
    this.goose = goose;
    this.levelSystem = levelSystem;
    this.camera = camera;
    this.enabled = true;
    this.surfaceClass = 'grass';
    this.radius = 0.38;
    this.height = 0.95;
    /** @type {'grounded' | 'takeoff' | 'flying' | 'landing'} */
    this.flightPhase = 'grounded';
    this.verticalVelocity = 0;
    this.altitude = 0;
    this.horizontalSpeed = 0;
    this.forwardIntent = 0;
    this.yawRate = 0;
    this._prevYaw = 0;
    this._hadPrevPos = false;
    this._hadPrevYaw = false;
    /** Compatible with dog park jump hooks (always false for goose). */
    this.jumpPhase = 'none';
    this.jumpStartedThisFrame = false;
    this._landingTimer = 0;
    this._takeoffTimer = 0;
    this._bindGoose(goose);
  }

  setDog(goose) {
    this.setGoose(goose);
  }

  setGoose(goose) {
    this.goose = goose;
    this.flightPhase = 'grounded';
    this.verticalVelocity = 0;
    this.altitude = 0;
    this.jumpPhase = 'none';
    this.jumpStartedThisFrame = false;
    this._landingTimer = 0;
    this._takeoffTimer = 0;
    this._hadPrevPos = false;
    this._hadPrevYaw = false;
    this.horizontalSpeed = 0;
    this.forwardIntent = 0;
    this.yawRate = 0;
    this._bindGoose(goose);
  }

  _bindGoose(goose) {
    if (!goose?.animation) return;
    goose.animation.setAutopilot?.(false);
    goose.animation.setExternalRootMotion?.(true);
  }

  /**
   * @param {number} delta
   * @param {object} [input]
   */
  update(delta, input = {}) {
    if (!this.enabled || !this.goose?.root || !this.camera) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    const locked = Boolean(input.actionLocked);
    const anim = this.goose.animation;
    const position = this.goose.root.position;

    this.jumpStartedThisFrame = false;
    this.jumpPhase = this.flightPhase === 'grounded' ? 'none' : 'air';

    // --- stick → camera-relative desire (InputSystem: W → moveZ = -1) ---
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    else forward.normalize();
    right.crossVectors(forward, this.camera.up).normalize();
    desired.set(0, 0, 0)
      .addScaledVector(right, locked ? 0 : (input.moveX ?? 0))
      .addScaledVector(forward, locked ? 0 : -(input.moveZ ?? 0));
    const inputMagnitude = Math.min(1, desired.length());
    const stickMoving = inputMagnitude > 0.05;
    if (stickMoving) desired.normalize();

    const floorY = this._sampleFloor(position);
    const water = this.levelSystem.level?.getWaterHeightAt?.(position);
    const overWater = (water?.weight ?? 0) > 0.35;
    this.surfaceClass = this.levelSystem.level?.getSurfaceAt?.(position.x, position.z) ?? 'grass';

    // --- flight state machine ---
    if (!locked && this.flightPhase === 'grounded' && input.jumpPressed) {
      this.flightPhase = 'takeoff';
      this._takeoffTimer = 0.85;
      this.verticalVelocity = TAKEOFF_BOOST;
      this.altitude = Math.max(0.05, position.y - floorY);
      this.jumpStartedThisFrame = true;
      anim.setBehavior?.('takeoff');
    }

    if (this.flightPhase === 'takeoff') {
      this._takeoffTimer -= dt;
      this.verticalVelocity += FLAP_THRUST * 0.55 * dt;
      this.verticalVelocity -= GRAVITY * 0.35 * dt;
      if (this._takeoffTimer <= 0 || this.altitude > 1.2) {
        this.flightPhase = 'flying';
      }
    } else if (this.flightPhase === 'flying') {
      const flapping = Boolean(input.jump || input.jumpPressed || input.brace);
      const diving = Boolean(input.crouchHeld) && !flapping;
      if (diving) {
        anim.setBehavior?.('fly_dive');
        this.verticalVelocity -= DIVE_GRAVITY * dt;
      } else if (flapping) {
        anim.setBehavior?.('fly_flap');
        this.verticalVelocity += FLAP_THRUST * dt;
        this.verticalVelocity -= GRAVITY * 0.25 * dt;
      } else {
        anim.setBehavior?.('fly_glide');
        this.verticalVelocity -= GLIDE_GRAVITY * dt;
        // Terminal glide sink
        this.verticalVelocity = Math.max(this.verticalVelocity, -2.8);
      }
      // Cap climb
      if (this.altitude > 8) {
        this.altitude = 8;
        this.verticalVelocity = Math.min(this.verticalVelocity, 0);
      }

      // Approach ground → landing
      if (this.altitude < LAND_TRIGGER_HEIGHT && this.verticalVelocity <= 0.4) {
        this.flightPhase = 'landing';
        this._landingTimer = 0.55;
        anim.setBehavior?.(overWater ? 'land_water' : 'land_feet');
      }
    } else if (this.flightPhase === 'landing') {
      this._landingTimer -= dt;
      this.verticalVelocity -= GRAVITY * 0.9 * dt;
      // Soft settle onto floor
      if (this.altitude <= 0.06 || this._landingTimer <= 0) {
        this.flightPhase = 'grounded';
        this.verticalVelocity = 0;
        this.altitude = 0;
        position.y = floorY;
        anim.setBehavior?.('idle');
      }
    }

    // Integrate altitude when airborne
    if (this.flightPhase !== 'grounded') {
      this.altitude += this.verticalVelocity * dt;
      if (this.altitude < 0) {
        this.altitude = 0;
        this.verticalVelocity = 0;
        this.flightPhase = 'grounded';
        anim.setBehavior?.(overWater ? 'land_water' : 'land_feet');
        // Brief land pose then idle next frames via timer
        this._landingTimer = 0.2;
        this.flightPhase = 'landing';
      }
      position.y = floorY + this.altitude;
    } else {
      this.altitude = 0;
      this.verticalVelocity = 0;
      position.y = floorY;
    }

    // --- horizontal move ---
    const yaw = anim.getRootYaw?.() ?? 0;
    bodyForward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.forwardIntent = stickMoving ? bodyForward.dot(desired) : 0;

    if (this._hadPrevYaw) {
      let dy = yaw - this._prevYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yawRate = THREE.MathUtils.lerp(this.yawRate, dy / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
    } else {
      this._hadPrevYaw = true;
    }
    this._prevYaw = yaw;

    const airborne = this.flightPhase !== 'grounded';
    if (!locked && (stickMoving || airborne)) {
      // Ground: setMoveIntent steers + walk. Air: steer via intent but keep flight behavior.
      if (!airborne) {
        const sit = Boolean(input.crouchHeld) && !stickMoving;
        anim.setMoveIntent?.({
          x: stickMoving ? desired.x : 0,
          z: stickMoving ? desired.z : 0,
          moving: stickMoving,
          sprint: Boolean(input.brace) && stickMoving,
          sit,
          look: false,
        });
      } else if (stickMoving) {
        // Yaw toward stick while flying (don't call setMoveIntent — it forces walk).
        const targetYaw = Math.atan2(desired.x, desired.z);
        let nextYaw = yaw;
        let dyaw = targetYaw - nextYaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        nextYaw += THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-3.5 * dt)), -2.4 * dt, 2.4 * dt);
        anim.setRootYaw?.(nextYaw);
        bodyForward.set(Math.sin(nextYaw), 0, Math.cos(nextYaw));
      }

      let baseSpeed = WALK_SPEED;
      if (airborne) {
        baseSpeed = anim.getBehavior?.() === 'fly_dive' ? DIVE_SPEED : FLY_SPEED;
      } else if (input.brace && stickMoving) {
        baseSpeed = SPRINT_SPEED;
      }

      if (stickMoving || airborne) {
        const align = THREE.MathUtils.clamp(
          stickMoving ? bodyForward.dot(desired) : 1,
          -1,
          1,
        );
        const turnSlow = airborne
          ? THREE.MathUtils.lerp(0.75, 1, THREE.MathUtils.smoothstep(align, -0.2, 0.85))
          : THREE.MathUtils.lerp(0.62, 1, THREE.MathUtils.smoothstep(align, -0.2, 0.85));
        if (stickMoving) {
          moveDir
            .copy(bodyForward)
            .multiplyScalar(airborne ? 0.55 : 0.78)
            .addScaledVector(desired, airborne ? 0.45 : 0.22);
          if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
          else moveDir.copy(bodyForward);
        } else {
          moveDir.copy(bodyForward);
        }
        const mag = stickMoving ? inputMagnitude : (airborne ? 0.55 : 0);
        const distance = baseSpeed * mag * turnSlow * dt;
        if (distance > 0) {
          candidate.copy(position).addScaledVector(moveDir, distance);
          this._moveWithCollision(position, candidate);
        }
      }
    } else if (!airborne && !locked) {
      anim.setMoveIntent?.({
        x: 0, z: 0, moving: false, sprint: false, sit: Boolean(input.crouchHeld), look: false,
      });
    }

    // Speed meter
    if (this._hadPrevPos) {
      const dx = position.x - prevPos.x;
      const dz = position.z - prevPos.z;
      const measured = Math.hypot(dx, dz) / Math.max(dt, 1e-5);
      this.horizontalSpeed = THREE.MathUtils.lerp(
        this.horizontalSpeed,
        measured,
        1 - Math.exp(-10 * dt),
      );
    } else {
      this._hadPrevPos = true;
    }
    prevPos.copy(position);

    // Keep animation rootPos in sync (goose rewrites root from rootPos each tick).
    anim.setRootPosition?.(position.x, position.y, position.z);
    // Zero internal flyHeight — park owns world altitude via root.y
    if (typeof anim.setFlightAltitudeOverride === 'function') {
      anim.setFlightAltitudeOverride(0);
    }

    this.goose.update?.(dt);
  }

  _sampleFloor(position) {
    const sampled = this.levelSystem.getGroundHeightAt(position, this.radius, {
      maxStepUp: 0.48,
      maxSnapDown: 1.2,
      requiredInset: Math.min(this.radius * 0.35, 0.12),
    });
    let floorY = Number.isFinite(sampled) ? sampled : position.y;
    const water = this.levelSystem.level?.getWaterHeightAt?.(position);
    if ((water?.weight ?? 0) > 0) {
      floorY = Math.max(floorY, water.waterY - 0.12 * water.weight);
    }
    return floorY;
  }

  _moveWithCollision(position, target) {
    const targetX = target.x;
    const targetZ = target.z;
    const blocked = (point) => this.levelSystem.getBlockingColliderAt?.({
      position: point,
      radius: this.radius,
      feetY: position.y,
      height: this.height,
      stepHeight: 0.32,
    });
    if (!blocked || !blocked(target)) {
      position.x = target.x;
      position.z = target.z;
      return;
    }
    candidate.set(targetX, position.y, position.z);
    if (!blocked(candidate)) position.x = targetX;
    candidate.set(position.x, position.y, targetZ);
    if (!blocked(candidate)) position.z = targetZ;
  }

  snapshot() {
    const position = this.goose?.root?.position;
    return {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      behavior: this.goose?.animation?.getBehavior?.() ?? 'idle',
      speed: this.horizontalSpeed,
      forwardIntent: this.forwardIntent,
      surfaceClass: this.surfaceClass,
      radius: this.radius,
      jump: this.jumpPhase,
      flightPhase: this.flightPhase,
      altitude: this.altitude,
    };
  }
}
