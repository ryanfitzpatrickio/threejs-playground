import * as THREE from 'three';

const targetGoal = new THREE.Vector3();
const cameraGoal = new THREE.Vector3();
const lookGoal = new THREE.Vector3();
const offset = new THREE.Vector3();
const dogRight = new THREE.Vector3();
const dogForward = new THREE.Vector3();

function lerpAngle(from, to, alpha) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * alpha;
}

function clampAngleDelta(delta, maxAbs) {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return delta;
  return THREE.MathUtils.clamp(delta, -maxAbs, maxAbs);
}

function smoothstep01(t) {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Third-person chase camera for the dog park.
 * Feels closer to the vehicle chase cam: LMB drag orbits, RMB free-look,
 * push/pull on turns, close zoom, and a soft lerp back behind when moving.
 */
export class DogCameraSystem {
  constructor() {
    this.camera = null;
    this.targetObject = null;
    this.target = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.hasLookTarget = false;

    /** Orbit yaw around the dog (absolute world yaw; +PI is behind heading 0). */
    this.yaw = Math.PI;
    this.pitch = 0.26;
    this.distance = 2.15;

    this.minDistance = 0.72;
    this.maxDistance = 5.4;
    this.defaultDistance = 2.15;

    this.steerOffset = 0;
    this.lateralOffset = 0;
    this.smoothedSpeed = 0;
    this.smoothedYawRate = 0;

    /** After releasing LMB orbit, briefly keep free framing before auto-align. */
    this.orbitHold = 0;
    /** True while RMB free-look is held (or short settle after release). */
    this.freeLookHold = 0;
    this.active = false;
  }

  initialize(camera, targetObject, { yaw = Math.PI } = {}) {
    this.camera = camera;
    this.targetObject = targetObject;
    this.yaw = yaw;
    this.pitch = 0.26;
    this.distance = this.defaultDistance;
    this.steerOffset = 0;
    this.lateralOffset = 0;
    this.smoothedSpeed = 0;
    this.smoothedYawRate = 0;
    this.orbitHold = 0;
    this.freeLookHold = 0;
    this.hasLookTarget = false;
    this.active = true;
    this.snap();
  }

  /**
   * @param {number} delta
   * @param {object} [input]
   * @param {{
   *   headingYaw?: number,
   *   moving?: boolean,
   *   speed?: number,
   *   yawRate?: number,
   *   forwardIntent?: number,
   * }} [motion]
   */
  update(delta, input = {}, motion = {}) {
    if (!this.active || !this.camera || !this.targetObject) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);

    const headingYaw = Number.isFinite(motion.headingYaw) ? motion.headingYaw : this._readTargetYaw();
    const speed = Math.max(0, Number(motion.speed) || 0);
    const moving = motion.moving === true || speed > 0.08;
    const yawRate = Number.isFinite(motion.yawRate) ? motion.yawRate : 0;
    // Stick forward relative to camera / dog (1 = forward, -1 = back). Used so
    // reverse or pure strafe doesn't hard-lock the chase framing.
    const forwardIntent = Number.isFinite(motion.forwardIntent)
      ? THREE.MathUtils.clamp(motion.forwardIntent, -1, 1)
      : (moving ? 1 : 0);

    // LMB drag = orbit the chase cam around the dog.
    // RMB (or middle) hold = free look — same orbit controls, but no auto-behind
    // while held, and a longer settle after release.
    const orbitDrag = Boolean(input.mousePrimaryHeld);
    const freeLook = Boolean(input.mouseSecondaryHeld || input.mouseMiddleHeld);
    const looking = orbitDrag || freeLook || Boolean(input.pointerLocked);

    if (looking) {
      const sens = freeLook ? 0.0054 : 0.0048;
      const pitchSens = freeLook ? 0.0040 : 0.0036;
      this.yaw -= (input.lookX ?? 0) * sens;
      // Mouse-up (negative movementY) raises pitch — drag down to look down.
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + (input.lookY ?? 0) * pitchSens,
        -0.08,
        0.78,
      );
      if (freeLook) {
        this.freeLookHold = 0.85;
        this.orbitHold = 0;
      } else if (orbitDrag) {
        // Short hold so a flick orbit doesn't instantly snap behind on release.
        this.orbitHold = 0.45;
      }
    } else {
      this.orbitHold = Math.max(0, this.orbitHold - dt);
      this.freeLookHold = Math.max(0, this.freeLookHold - dt);
    }

    if (input.reloadPressed) this.recenter(headingYaw);

    // Closer zoom than the old park cam; still pulls out enough for a full dog.
    this.distance = THREE.MathUtils.clamp(
      this.distance + (input.zoomDelta ?? 0) * 0.28,
      this.minDistance,
      this.maxDistance,
    );

    const speedAlpha = 1 - Math.exp(-5 * dt);
    this.smoothedSpeed = THREE.MathUtils.lerp(this.smoothedSpeed, speed, speedAlpha);
    const yawRateAlpha = 1 - Math.exp(-8 * dt);
    this.smoothedYawRate = THREE.MathUtils.lerp(this.smoothedYawRate, yawRate, yawRateAlpha);

    // Auto-align behind the dog while moving forward (car chase habit).
    // Suppressed during LMB orbit, RMB free-look, and short post-release holds.
    const userFraming = looking || this.orbitHold > 0 || this.freeLookHold > 0;
    const behindYaw = headingYaw + Math.PI;
    const wantAlign = moving
      && !userFraming
      && forwardIntent > 0.15;
    if (wantAlign) {
      // Stronger align at higher speed; still gentle at a walk.
      const speedNorm = smoothstep01(this.smoothedSpeed / 3.2);
      const alignRate = 1.6 + speedNorm * 2.4;
      const maxYawRate = 1.35 + speedNorm * 1.1;
      let next = lerpAngle(this.yaw, behindYaw, 1 - Math.exp(-alignRate * dt));
      let step = next - this.yaw;
      while (step > Math.PI) step -= Math.PI * 2;
      while (step < -Math.PI) step += Math.PI * 2;
      step = clampAngleDelta(step, maxYawRate * dt);
      this.yaw += step;
    }

    // Push/pull on turns — outside lateral swing + small look-into-turn yaw.
    // Sign: positive yawRate (CCW / left turn) swings camera to the right side.
    // Mute while free-looking so the user owns the framing.
    const turnSign = freeLook
      ? 0
      : THREE.MathUtils.clamp(this.smoothedYawRate / 1.35, -1, 1);
    const steerAlpha = 1 - Math.exp(-7 * dt);
    const desiredSteer = turnSign * 0.2 * (moving ? 1 : 0.35);
    const desiredLateral = -turnSign * 0.42 * (moving ? 1 : 0.25);
    this.steerOffset = THREE.MathUtils.lerp(this.steerOffset, desiredSteer, steerAlpha);
    this.lateralOffset = THREE.MathUtils.lerp(this.lateralOffset, desiredLateral, steerAlpha);

    this.targetObject.getWorldPosition(targetGoal);
    // Aim around chest / withers so a close zoom doesn't bury into the rump.
    targetGoal.y += 0.48;
    const targetSmooth = 1 - Math.exp(-(moving ? 12 : 9) * dt);
    this.target.lerp(targetGoal, targetSmooth);

    const speedEase = smoothstep01(this.smoothedSpeed / 3.6);
    const turnEase = Math.abs(turnSign);
    // Slight pull-back when sprinting or carving a turn.
    const framedDistance = this.distance
      + speedEase * 0.55
      + turnEase * 0.22;

    const cameraYaw = this.yaw + this.steerOffset;
    const horizontal = Math.cos(this.pitch) * framedDistance;
    offset.set(
      Math.sin(cameraYaw) * horizontal,
      0.42 + Math.sin(this.pitch) * framedDistance + speedEase * 0.12,
      Math.cos(cameraYaw) * horizontal,
    );

    dogForward.set(Math.sin(headingYaw), 0, Math.cos(headingYaw));
    dogRight.set(Math.cos(headingYaw), 0, -Math.sin(headingYaw));
    offset.addScaledVector(dogRight, this.lateralOffset);

    cameraGoal.copy(this.target).add(offset);
    // Free look keeps position a bit looser so looking around feels less glued.
    const positionRate = freeLook ? 4.2 : (6.5 + speedEase * 4);
    const positionSmooth = 1 - Math.exp(-positionRate * dt);
    this.camera.position.lerp(cameraGoal, positionSmooth);

    // Look slightly ahead of the dog along heading; steer softens into the turn.
    // Free look aims more toward the orbit focus so the view is mouse-driven.
    const lookAhead = freeLook ? 0.12 : (0.35 + speedEase * 0.85);
    lookGoal.copy(this.target).addScaledVector(dogForward, lookAhead);
    if (!freeLook) lookGoal.addScaledVector(dogRight, this.lateralOffset * 0.35);
    lookGoal.y = this.target.y + 0.06 + (freeLook ? 0 : speedEase * 0.04);

    const lookAlpha = 1 - Math.exp(-(freeLook ? 14 : 10) * dt);
    if (!this.hasLookTarget || this.lookTarget.distanceTo(lookGoal) > 8) {
      this.lookTarget.copy(lookGoal);
      this.hasLookTarget = true;
    } else {
      this.lookTarget.lerp(lookGoal, lookAlpha);
    }
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld(true);
  }

  recenter(headingYaw = this._readTargetYaw()) {
    this.yaw = headingYaw + Math.PI;
    this.orbitHold = 0;
    this.freeLookHold = 0;
    this.steerOffset = 0;
    this.lateralOffset = 0;
  }

  _readTargetYaw() {
    const rotY = this.targetObject?.rotation?.y;
    return Number.isFinite(rotY) ? rotY : 0;
  }

  snap() {
    if (!this.camera || !this.targetObject) return;
    this.targetObject.getWorldPosition(this.target);
    this.target.y += 0.48;
    const horizontal = Math.cos(this.pitch) * this.distance;
    offset.set(
      Math.sin(this.yaw) * horizontal,
      0.42 + Math.sin(this.pitch) * this.distance,
      Math.cos(this.yaw) * horizontal,
    );
    this.camera.position.copy(this.target).add(offset);
    this.lookTarget.copy(this.target);
    this.hasLookTarget = true;
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld(true);
  }

  snapshot() {
    return {
      active: this.active,
      target: { x: this.target.x, y: this.target.y, z: this.target.z },
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      steerOffset: this.steerOffset,
      lateralOffset: this.lateralOffset,
      position: this.camera
        ? { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }
        : null,
    };
  }

  dispose() {
    this.active = false;
    this.camera = null;
    this.targetObject = null;
    this.hasLookTarget = false;
  }
}
