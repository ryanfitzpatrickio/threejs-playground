import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { getRecommendedCameraFar } from '../config/qualityPresets.js';
import { CITY_FURNITURE_LAYER } from '../render/renderLayers.js';

const desiredPosition = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
const offset = new THREE.Vector3();
const forwardDirection = new THREE.Vector3();
const rightDirection = new THREE.Vector3();
const vehicleForward = new THREE.Vector3();
const vehicleRight = new THREE.Vector3();
const vehicleVelocity = new THREE.Vector3();
const vehicleTarget = new THREE.Vector3();
const freeMove = new THREE.Vector3();
const freeForward = new THREE.Vector3();
const freeRight = new THREE.Vector3();
const freeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const seatEyePosition = new THREE.Vector3();
const seatEyeOffset = new THREE.Vector3();
const chassisEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function lerpAngle(from, to, alpha) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * alpha;
}

function clampAngleDelta(delta, maxAbs) {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) {
    return delta;
  }
  return THREE.MathUtils.clamp(delta, -maxAbs, maxAbs);
}

function smoothstep01(t) {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function extractVehicleYaw(quaternion) {
  vehicleForward.set(0, 0, -1).applyQuaternion(quaternion);
  return Math.atan2(-vehicleForward.x, -vehicleForward.z);
}

function getVehicleSteerInput(vehicle) {
  return vehicle?.steerTelemetry?.steer
    ?? vehicle?._smoothed?.steer
    ?? 0;
}

function getVehicleHorizontalSpeed(vehicle) {
  const velocity = vehicle?.linearVelocity;
  if (!velocity) {
    return 0;
  }
  return Math.hypot(velocity.x, velocity.z);
}

function snapshotModeParams(modeName) {
  const mode = GAME_CONFIG.camera.vehicleCameraModes[modeName]
    ?? GAME_CONFIG.camera.vehicleCameraModes.close;
  return {
    followDistance: mode.followDistance,
    followHeight: mode.followHeight,
    lookAhead: mode.lookAhead,
    lookHeight: mode.lookHeight,
    pitch: mode.pitch,
  };
}

function blendModeParams(from, to, alpha) {
  return {
    followDistance: THREE.MathUtils.lerp(from.followDistance, to.followDistance, alpha),
    followHeight: THREE.MathUtils.lerp(from.followHeight, to.followHeight, alpha),
    lookAhead: THREE.MathUtils.lerp(from.lookAhead, to.lookAhead, alpha),
    lookHeight: THREE.MathUtils.lerp(from.lookHeight, to.lookHeight, alpha),
    pitch: THREE.MathUtils.lerp(from.pitch, to.pitch, alpha),
  };
}

export class CameraSystem {
  initialize(scene, qualityPreset = {}) {
    const config = GAME_CONFIG.camera;
    const cameraFar = qualityPreset.cameraFar ?? getRecommendedCameraFar(qualityPreset);
    this.camera = new THREE.PerspectiveCamera(config.vehicle.defaultFov, 1, 0.1, cameraFar);
    this.camera.layers.enable(CITY_FURNITURE_LAYER);
    this.camera.name = 'Dreamfall Follow Camera';
    this.camera.position.set(0, 2.9, 6.8);
    this.smoothedTarget = new THREE.Vector3();
    this.hasSmoothedTarget = false;
    this.smoothedLookTarget = new THREE.Vector3();
    this.hasSmoothedLookTarget = false;
    this.smoothedTargetHeight = 0;
    this.hasSmoothedTargetHeight = false;
    this.smoothedVehicleSpeed = 0;
    this.yaw = 0;
    this.pitch = config.initialPitch;
    this.distance = config.followDistance;
    this.lastPositionSmoothing = GAME_CONFIG.camera.smoothing;
    this.lastTargetSmoothing = GAME_CONFIG.camera.targetSmoothing;
    this.driving = false;
    this.vehicleCameraMode = GAME_CONFIG.camera.vehicleCameraModeOrder[0];
    this._firstPersonHidCharacter = false;
    this.vehicleCameraYaw = 0;
    this.vehicleSteerOffset = 0;
    this.vehicleLateralOffset = 0;
    this.smoothedHorizonPitch = 0;
    this.smoothedFov = config.vehicle.defaultFov;
    this.photoMode = false;
    this.interiorFirstPerson = false;
    this.onFootFirstPerson = false;
    this.comfortEnabled = true;
    this.cameraFeel = 'comfort';
    this.modeBlend = null;
    this.rearViewBlend = 0;
    this.photoSettings = {
      fov: config.vehicle.defaultFov,
      aperture: 2.8,
      focusDistance: 10,
      speed: 12,
    };
    scene.add(this.camera);
  }

  setComfortOptions({ enabled = true, feel = 'comfort' } = {}) {
    this.comfortEnabled = Boolean(enabled);
    const validFeels = GAME_CONFIG.camera.vehicle.feels;
    this.cameraFeel = validFeels?.[feel] ? feel : 'comfort';
  }

  setOnFootFirstPerson(enabled) {
    this.onFootFirstPerson = Boolean(enabled);
  }

  setInteriorFirstPerson(enabled) {
    this.interiorFirstPerson = Boolean(enabled);
    if (!enabled) {
      this.hasSmoothedTarget = false;
    }
  }

  usesOnFootFirstPerson() {
    return this.interiorFirstPerson || this.onFootFirstPerson;
  }

  getVehicleTuning() {
    const shared = GAME_CONFIG.camera.vehicle;
    if (!this.comfortEnabled) {
      return { ...shared, ...(shared.feels?.cinematic ?? {}) };
    }
    return { ...shared, ...(shared.feels?.[this.cameraFeel] ?? shared.feels?.comfort ?? {}) };
  }

  setPhotoMode(enabled) {
    const next = Boolean(enabled);
    if (next === this.photoMode) return;
    this.photoMode = next;
    if (next) {
      freeEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.pitch = freeEuler.x;
      this.yaw = freeEuler.y;
      this.photoSettings.fov = this.camera.fov;
      this.camera.userData.photoMode = this.photoSettings;
    } else {
      this.hasSmoothedTarget = false;
      this.smoothedFov = this.camera.fov;
      delete this.camera.userData.photoMode;
    }
  }

  cycleVehicleCameraMode() {
    const order = GAME_CONFIG.camera.vehicleCameraModeOrder;
    const index = order.indexOf(this.vehicleCameraMode);
    const nextMode = order[(index + 1) % order.length];
    return this.setVehicleCameraMode(nextMode);
  }

  setVehicleCameraMode(mode) {
    const order = GAME_CONFIG.camera.vehicleCameraModeOrder;
    if (!order.includes(mode)) {
      return this.vehicleCameraMode;
    }
    if (mode === this.vehicleCameraMode) {
      return mode;
    }
    this._beginModeBlend(this.vehicleCameraMode, mode);
    this.vehicleCameraMode = mode;
    return mode;
  }

  _beginModeBlend(fromMode, toMode) {
    const tuning = this.getVehicleTuning();
    this.modeBlend = {
      fromMode,
      toMode,
      elapsed: 0,
      duration: tuning.modeBlendDuration ?? 0.45,
      from: snapshotModeParams(fromMode),
      to: snapshotModeParams(toMode),
    };
  }

  _resolveEffectiveMode() {
    const modes = GAME_CONFIG.camera.vehicleCameraModes;
    const target = modes[this.vehicleCameraMode] ?? modes.close;
    if (!this.modeBlend || this.vehicleCameraMode === 'firstPerson') {
      return target;
    }
    const alpha = smoothstep01(this.modeBlend.elapsed / Math.max(this.modeBlend.duration, 1e-4));
    return blendModeParams(this.modeBlend.from, this.modeBlend.to, alpha);
  }

  _advanceModeBlend(delta) {
    if (!this.modeBlend) {
      return;
    }
    this.modeBlend.elapsed += delta;
    if (this.modeBlend.elapsed >= this.modeBlend.duration) {
      this.modeBlend = null;
    }
  }

  setPhotoSetting(name, value) {
    const ranges = {
      fov: [15, 100],
      aperture: [1.2, 22],
      focusDistance: [0.5, 250],
      speed: [1, 60],
    };
    const range = ranges[name];
    const number = Number(value);
    if (!range || !Number.isFinite(number)) return;
    this.photoSettings[name] = THREE.MathUtils.clamp(number, range[0], range[1]);
    if (name === 'fov') {
      this.camera.fov = this.photoSettings.fov;
      this.smoothedFov = this.photoSettings.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  updatePhotoMode({ delta, input }) {
    const lookSensitivity = 0.0022;
    this.yaw -= input.lookX * lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - input.lookY * lookSensitivity,
      -Math.PI * 0.495,
      Math.PI * 0.495,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    freeForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    freeRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    freeMove.set(0, 0, 0)
      .addScaledVector(freeForward, -input.moveZ)
      .addScaledVector(freeRight, input.moveX);
    freeMove.y += Number(input.jump) - Number(input.brace);
    if (freeMove.lengthSq() > 0) {
      const boost = input.brace && !input.jump ? 0.35 : 1;
      this.camera.position.addScaledVector(
        freeMove.normalize(),
        this.photoSettings.speed * boost * delta,
      );
    }
  }

  update({
    delta,
    target,
    viewport,
    input,
    rootMotionActive = false,
    character = null,
    vehicle = null,
  }) {
    if (vehicle) {
      this.updateVehicleCamera({ delta, vehicle, viewport, character, input });
      return;
    }

    if (this.driving) {
      this.driving = false;
      this.hasSmoothedTarget = false;
      this.hasSmoothedLookTarget = false;
      this.hasSmoothedTargetHeight = false;
      this.vehicleSteerOffset = 0;
      this.vehicleLateralOffset = 0;
      this.modeBlend = null;
      this.rearViewBlend = 0;
      this._restoreCharacterVisibility(character);
    }

    const config = GAME_CONFIG.camera;
    const hookSwing = character?.hookSwing;
    this.updateOrbitInput({
      input, config, hookSwing, allowZoom: !this.usesOnFootFirstPerson(), invertPitch: this.usesOnFootFirstPerson(),
    });

    if (this.usesOnFootFirstPerson()) {
      this._setCharacterHiddenForFirstPerson(character, true);
      this.updateOnFootFirstPerson({ delta, target, config });
      return;
    }

    this._setCharacterHiddenForFirstPerson(character, false);

    const responsiveDistance = viewport?.aspect < 0.8 ? this.distance + 1.35 : this.distance;
    const responsiveHeight = viewport?.aspect < 0.8 ? config.followHeight + 0.42 : config.followHeight;
    const hookDistanceBoost = hookSwing?.active
      ? 1.6 + Math.min(2.4, (hookSwing.swingPhase ?? 0) * 1.8)
      : 0;
    const hookPitchBias = hookSwing?.active ? -0.08 : 0;
    const positionSmoothing = rootMotionActive
      ? config.rootMotionSmoothing
      : config.smoothing;
    const targetSmoothing = rootMotionActive
      ? config.rootMotionTargetSmoothing
      : config.targetSmoothing;

    this.updateSmoothedTarget({ target, delta, targetSmoothing, maxLag: config.maxTargetLag });
    this.lastPositionSmoothing = positionSmoothing;

    const horizontalDistance = Math.cos(this.pitch + hookPitchBias) * (responsiveDistance + hookDistanceBoost);
    offset.set(
      Math.sin(this.yaw) * horizontalDistance,
      responsiveHeight + Math.sin(this.pitch + hookPitchBias) * (responsiveDistance + hookDistanceBoost),
      Math.cos(this.yaw) * horizontalDistance,
    );
    desiredPosition.copy(this.smoothedTarget).add(offset);
    this.camera.position.lerp(desiredPosition, 1 - Math.exp(-positionSmoothing * delta));

    lookTarget.copy(this.smoothedTarget).add({ x: 0, y: config.lookHeight, z: 0 });
    this.camera.lookAt(lookTarget);

    this.updateFov({
      delta,
      targetFov: config.vehicle.defaultFov,
      smoothing: 10,
    });
  }

  updateOnFootFirstPerson({ delta, target, config }) {
    const eyeHeight = config.onFootEyeHeight ?? 1.62;
    const eyeForward = config.onFootEyeForward ?? 0.06;
    const smooth = config.onFootFirstPersonSmoothing ?? 28;

    desiredPosition.set(
      target.x + Math.sin(this.yaw) * eyeForward,
      target.y + eyeHeight,
      target.z + Math.cos(this.yaw) * eyeForward,
    );
    this.camera.position.lerp(desiredPosition, 1 - Math.exp(-smooth * delta));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    this.updateFov({
      delta,
      targetFov: config.onFootFirstPersonFov ?? 74,
      smoothing: 10,
    });
  }

  updateVehicleCamera({ delta, vehicle, viewport, character, input }) {
    const chassis = vehicle.group;
    if (!chassis) {
      return;
    }

    const enteringVehicle = !this.driving;
    this.driving = true;
    this._advanceModeBlend(delta);
    this._updateRearViewBlend({ delta, input });

    if (this.vehicleCameraMode === 'firstPerson') {
      this._setCharacterHiddenForFirstPerson(character, true);
      this.updateVehicleFirstPersonCamera({ delta, vehicle });
      return;
    }

    this._setCharacterHiddenForFirstPerson(character, false);
    this.updateVehicleChaseCamera({ delta, vehicle, viewport, enteringVehicle });
  }

  _updateRearViewBlend({ delta, input }) {
    const tuning = this.getVehicleTuning();
    const target = input?.rearViewHeld ? 1 : 0;
    const alpha = 1 - Math.exp(-(tuning.rearViewBlendSpeed ?? 14) * delta);
    this.rearViewBlend = THREE.MathUtils.lerp(this.rearViewBlend, target, alpha);
  }

  _rearViewYawOffset() {
    return this.rearViewBlend * Math.PI;
  }

  _computeVelocityLookYaw(headingYaw, vehicle, tuning) {
    const velocity = vehicle?.linearVelocity;
    if (!velocity || tuning.velocityLookBlend <= 0) {
      return headingYaw;
    }

    vehicleVelocity.set(velocity.x, 0, velocity.z);
    const speed = vehicleVelocity.length();
    if (speed < 0.75) {
      return headingYaw;
    }

    const velocityYaw = Math.atan2(-vehicleVelocity.x, -vehicleVelocity.z);
    const fwdX = -Math.sin(headingYaw);
    const fwdZ = -Math.cos(headingYaw);
    const dot = vehicleVelocity.x * fwdX + vehicleVelocity.z * fwdZ;
    const reversing = dot < 0;

    let delta = velocityYaw - headingYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxAngle = tuning.velocityLookMaxAngle ?? 0.42;
    delta = THREE.MathUtils.clamp(delta, -maxAngle, maxAngle);

    if (reversing) {
      // When reversing, velocityYaw ~ heading +/- PI. The sign after
      // normalization+clamp is unstable and can flip the small yaw bias
      // left/right. Prefer + (right side bias) to keep it simple and consistent.
      delta = Math.abs(delta);
    }

    return headingYaw + delta * tuning.velocityLookBlend;
  }

  _applyYawSmoothing({ currentYaw, targetYaw, delta, tuning }) {
    const yawAlpha = 1 - Math.exp(-tuning.yawSmoothing * delta);
    let nextYaw = lerpAngle(currentYaw, targetYaw, yawAlpha);
    const yawDelta = nextYaw - currentYaw;
    let normalizedDelta = yawDelta;
    while (normalizedDelta > Math.PI) normalizedDelta -= Math.PI * 2;
    while (normalizedDelta < -Math.PI) normalizedDelta += Math.PI * 2;
    const maxStep = (tuning.maxCameraYawRate ?? Infinity) * delta;
    normalizedDelta = clampAngleDelta(normalizedDelta, maxStep);
    nextYaw = currentYaw + normalizedDelta;
    return nextYaw;
  }

  updateVehicleChaseCamera({ delta, vehicle, viewport, enteringVehicle }) {
    const tuning = this.getVehicleTuning();
    const mode = this._resolveEffectiveMode();
    const chassis = vehicle.group;

    const headingYaw = extractVehicleYaw(chassis.quaternion);
    if (enteringVehicle) {
      this.vehicleCameraYaw = headingYaw;
      this.vehicleSteerOffset = 0;
      this.vehicleLateralOffset = 0;
      this.smoothedTarget.copy(chassis.position);
      this.hasSmoothedTarget = true;
      this.smoothedTargetHeight = chassis.position.y;
      this.hasSmoothedTargetHeight = true;
      this.hasSmoothedLookTarget = false;
      this.smoothedVehicleSpeed = getVehicleHorizontalSpeed(vehicle);
      this.yaw = headingYaw;
      this.pitch = mode.pitch;
    }

    const desiredLookYaw = this._computeVelocityLookYaw(headingYaw, vehicle, tuning);
    this.vehicleCameraYaw = this._applyYawSmoothing({
      currentYaw: this.vehicleCameraYaw,
      targetYaw: desiredLookYaw,
      delta,
      tuning,
    });

    const steer = getVehicleSteerInput(vehicle);
    const steerAlpha = 1 - Math.exp(-tuning.steerOffsetSmoothing * delta);
    const rearSteerScale = 1 - this.rearViewBlend;
    const desiredSteerOffset = steer * (tuning.steerLookStrength ?? 0) * rearSteerScale;
    this.vehicleSteerOffset = THREE.MathUtils.lerp(this.vehicleSteerOffset, desiredSteerOffset, steerAlpha);
    this.vehicleLateralOffset = THREE.MathUtils.lerp(
      this.vehicleLateralOffset,
      -steer * (tuning.lateralShift ?? 0) * rearSteerScale,
      steerAlpha,
    );

    const rearYaw = this._rearViewYawOffset();
    const cameraYaw = this.vehicleCameraYaw + this.vehicleSteerOffset + rearYaw;
    this.yaw = cameraYaw;
    this.pitch = mode.pitch;

    const horizontalSpeed = getVehicleHorizontalSpeed(vehicle);
    // Raw speed wobbles every physics step; filter before any framing / stiffness
    // use so tracking and FOV don't pump with suspension noise.
    const speedAlpha = 1 - Math.exp(-(tuning.speedSmoothing ?? 4) * delta);
    this.smoothedVehicleSpeed = THREE.MathUtils.lerp(this.smoothedVehicleSpeed, horizontalSpeed, speedAlpha);
    const maxSpeed = Math.max(tuning.maxSpeedForEffects ?? 1, 1e-3);
    const speedRatio = THREE.MathUtils.clamp(this.smoothedVehicleSpeed / maxSpeed, 0, 1);
    // Ease into the high-speed framing so mid-range stays near the idle distance.
    const speedEase = smoothstep01(speedRatio);
    const responsiveDistance = viewport?.aspect < 0.8 ? mode.followDistance + 1.1 : mode.followDistance;
    // speedDistanceBoost is max extra meters at top speed (clamped), not m per m/s.
    const distance = responsiveDistance + speedEase * (tuning.speedDistanceBoost ?? 0);
    const responsiveHeight = viewport?.aspect < 0.8 ? mode.followHeight + 0.35 : mode.followHeight;
    const lookAhead = mode.lookAhead + speedEase * (tuning.speedLookAheadBoost ?? 0);

    // Soft target lag is fine at idle, but at speed it yanks the chase cam far behind the car.
    // Scale *planar* target stiffness with smoothed speed so lag stays roughly constant
    // (lag ≈ v / λ). Camera position uses a softer spring so the follow still eases.
    const maxChaseLag = tuning.maxChaseLag ?? 1.25;
    const maxTracking = tuning.maxTrackingSmoothing ?? 42;
    const maxPosition = tuning.maxPositionSmoothing ?? 14;
    const trackSpeed = this.smoothedVehicleSpeed;
    const targetSmoothing = Math.min(
      maxTracking,
      Math.max(
        tuning.targetSmoothing,
        trackSpeed / Math.max(maxChaseLag, 1e-3),
      ),
    );
    // Camera position stays nearly as tight as the planar target at speed so the
    // car doesn't rubber-band; soft base rate still eases at idle / low speed.
    const positionSmoothing = Math.min(
      maxPosition,
      Math.max(
        tuning.positionSmoothing,
        trackSpeed / Math.max(maxChaseLag * 1.15, 1e-3),
      ),
    );
    this.updateSmoothedTarget({
      target: chassis.position,
      delta,
      targetSmoothing,
      maxLag: Math.max(tuning.maxTargetLag, maxChaseLag * 3),
      planarOnly: true,
    });

    // Vertical suspension heave is filtered harder than planar follow so bumps
    // don't bob the chase cam (and thus the whole world) every frame.
    const heightRate = tuning.targetHeightSmoothing ?? 3.6;
    if (!this.hasSmoothedTargetHeight) {
      this.smoothedTargetHeight = chassis.position.y;
      this.hasSmoothedTargetHeight = true;
    } else {
      const heightAlpha = 1 - Math.exp(-heightRate * delta);
      this.smoothedTargetHeight = THREE.MathUtils.lerp(
        this.smoothedTargetHeight,
        chassis.position.y,
        heightAlpha,
      );
    }
    // Keep the planar smoother from fighting the height filter.
    this.smoothedTarget.y = this.smoothedTargetHeight;

    // Bias planar framing toward the live chassis at speed so residual lag
    // doesn't read as "camera pulled way out" — never blend live Y (bounce).
    const liveAnchorBlend = speedEase * (tuning.speedLiveAnchor ?? 0.18);
    vehicleTarget.copy(this.smoothedTarget);
    if (liveAnchorBlend > 0) {
      vehicleTarget.x = THREE.MathUtils.lerp(vehicleTarget.x, chassis.position.x, liveAnchorBlend);
      vehicleTarget.z = THREE.MathUtils.lerp(vehicleTarget.z, chassis.position.z, liveAnchorBlend);
    }

    this.lastPositionSmoothing = positionSmoothing;
    this.lastTargetSmoothing = targetSmoothing;

    vehicleRight.set(1, 0, 0).applyQuaternion(chassis.quaternion);

    const horizontalDistance = Math.cos(mode.pitch) * distance;
    offset
      .set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw))
      .multiplyScalar(horizontalDistance);
    offset.y = responsiveHeight + Math.sin(mode.pitch) * distance;
    offset.addScaledVector(vehicleRight, this.vehicleLateralOffset);

    desiredPosition.copy(vehicleTarget).add(offset);
    this.camera.position.lerp(
      desiredPosition,
      1 - Math.exp(-positionSmoothing * delta),
    );

    // Look direction reuses the smoothed camera yaw (it already tracks the
    // velocity-lead yaw). Recomputing from the raw heading fed per-step physics
    // jitter straight into lookAt, which read as rotational stutter up close.
    const lookYaw = this.vehicleCameraYaw + rearYaw;
    const lookForwardX = -Math.sin(lookYaw);
    const lookForwardZ = -Math.cos(lookYaw);
    vehicleTarget
      .addScaledVector(vehicleForward.set(lookForwardX, 0, lookForwardZ).normalize(), lookAhead)
      .add({ x: 0, y: mode.lookHeight, z: 0 });

    // Final low-pass on the look point keeps orientation free of residual noise.
    const lookAlpha = 1 - Math.exp(-(tuning.lookTargetSmoothing ?? 9) * delta);
    if (!this.hasSmoothedLookTarget || this.smoothedLookTarget.distanceTo(vehicleTarget) > 20) {
      this.smoothedLookTarget.copy(vehicleTarget);
      this.hasSmoothedLookTarget = true;
    } else {
      this.smoothedLookTarget.lerp(vehicleTarget, lookAlpha);
    }
    this.camera.lookAt(this.smoothedLookTarget);

    this.updateFov({
      delta,
      targetFov: tuning.baseFov + speedEase * (tuning.speedFovBoost ?? 0),
      smoothing: 6,
    });
  }

  updateVehicleFirstPersonCamera({ delta, vehicle }) {
    const tuning = this.getVehicleTuning();
    const modeConfig = GAME_CONFIG.camera.vehicleCameraModes.firstPerson;
    const chassis = vehicle.group;
    const seat = vehicle.config?.seats?.[vehicle.driverSeatIndex];
    if (!chassis || !seat) {
      return;
    }

    seatEyePosition.fromArray(seat.offset);
    seatEyePosition.y += vehicle.frameParameters?.offsetFromTires ?? 0;
    seatEyeOffset.fromArray(modeConfig.eyeOffset);
    seatEyePosition.add(seatEyeOffset);
    chassis.updateWorldMatrix(true, false);
    this.camera.position.copy(seatEyePosition).applyMatrix4(chassis.matrixWorld);

    chassisEuler.setFromQuaternion(chassis.quaternion, 'YXZ');
    const chassisYaw = chassisEuler.y;
    const chassisPitch = chassisEuler.x;
    const chassisRoll = chassisEuler.z;

    if (tuning.horizonLock !== false) {
      const pitchAlpha = 1 - Math.exp(-(tuning.horizonPitchSmoothing ?? 1.8) * delta);
      this.smoothedHorizonPitch = THREE.MathUtils.lerp(
        Number.isFinite(this.smoothedHorizonPitch) ? this.smoothedHorizonPitch : chassisPitch,
        chassisPitch,
        pitchAlpha,
      );
      this.camera.rotation.set(
        this.smoothedHorizonPitch,
        chassisYaw + this._rearViewYawOffset(),
        tuning.cockpitRollLock !== false ? 0 : chassisRoll,
        'YXZ',
      );
    } else {
      chassisEuler.set(chassisPitch, chassisYaw + this._rearViewYawOffset(), chassisRoll, 'YXZ');
      this.camera.quaternion.setFromEuler(chassisEuler);
      this.smoothedHorizonPitch = chassisPitch;
    }

    vehicleForward.set(0, 0, -1).applyQuaternion(chassis.quaternion);
    this.yaw = Math.atan2(-vehicleForward.x, -vehicleForward.z);
    this.pitch = this.smoothedHorizonPitch;

    const targetFov = tuning.firstPersonFov ?? modeConfig.fov;
    this.updateFov({
      delta,
      targetFov,
      smoothing: 10,
    });
  }

  _setCharacterHiddenForFirstPerson(character, hidden) {
    if (!character?.group) {
      return;
    }
    if (hidden === this._firstPersonHidCharacter) {
      return;
    }
    character.group.visible = !hidden;
    this._firstPersonHidCharacter = hidden;
  }

  _restoreCharacterVisibility(character) {
    if (!this._firstPersonHidCharacter || !character?.group) {
      return;
    }
    character.group.visible = true;
    this._firstPersonHidCharacter = false;
  }

  updateFov({ delta, targetFov, smoothing }) {
    const alpha = 1 - Math.exp(-smoothing * delta);
    this.smoothedFov = THREE.MathUtils.lerp(this.smoothedFov, targetFov, alpha);
    if (Math.abs(this.camera.fov - this.smoothedFov) > 0.01) {
      this.camera.fov = this.smoothedFov;
      this.camera.updateProjectionMatrix();
    }
  }

  updateOrbitInput({ input, config, hookSwing = null, allowZoom = true, invertPitch = false }) {
    if (!input) {
      return;
    }

    const lookScale = hookSwing?.active ? 0.82 : 1;
    this.yaw -= input.lookX * config.lookSensitivity * lookScale;
    const pitchDelta = input.lookY * config.lookSensitivity * lookScale;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + (invertPitch ? -pitchDelta : pitchDelta),
      config.minPitch,
      config.maxPitch,
    );

    if (allowZoom && input.zoomDelta) {
      this.distance = THREE.MathUtils.clamp(
        this.distance + input.zoomDelta * config.zoomStep,
        config.minDistance,
        config.maxDistance,
      );
    }
  }

  updateSmoothedTarget({ target, delta, targetSmoothing, maxLag, planarOnly = false }) {
    if (
      !this.hasSmoothedTarget ||
      !Number.isFinite(delta) ||
      this.smoothedTarget.distanceTo(target) > maxLag
    ) {
      this.smoothedTarget.copy(target);
      this.hasSmoothedTarget = true;
      this.smoothedTargetHeight = target.y;
      this.hasSmoothedTargetHeight = true;
      this.lastTargetSmoothing = targetSmoothing;
      return;
    }

    this.lastTargetSmoothing = targetSmoothing;
    const alpha = 1 - Math.exp(-targetSmoothing * delta);
    this.smoothedTarget.x = THREE.MathUtils.lerp(this.smoothedTarget.x, target.x, alpha);
    this.smoothedTarget.z = THREE.MathUtils.lerp(this.smoothedTarget.z, target.z, alpha);
    // On foot, follow vertical motion (climb / jump / hang). Vehicle chase keeps
    // planar-only and applies its own suspension-filtered height after this call —
    // without Y follow here the third-person cam freezes at the old altitude while
    // the player climbs city buildings.
    if (!planarOnly) {
      this.smoothedTarget.y = THREE.MathUtils.lerp(this.smoothedTarget.y, target.y, alpha);
      this.smoothedTargetHeight = this.smoothedTarget.y;
      this.hasSmoothedTargetHeight = true;
    }
  }

  resize({ aspect }) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  snapshot() {
    if (!this.camera) {
      return {
        aspect: 1,
        fov: 0,
        yaw: 0,
        pitch: 0,
        distance: 0,
        positionSmoothing: 0,
        targetSmoothing: 0,
        driving: false,
        vehicleCameraMode: this.vehicleCameraMode ?? 'close',
        comfortEnabled: this.comfortEnabled !== false,
        cameraFeel: this.cameraFeel ?? 'comfort',
        focusReticle: false,
        rearViewBlend: 0,
        photoMode: false,
        onFootFirstPerson: false,
      };
    }
    const modeBlendT = this.modeBlend
      ? Number((this.modeBlend.elapsed / Math.max(this.modeBlend.duration, 1e-4)).toFixed(3))
      : 1;
    return {
      aspect: Number((this.camera.aspect ?? 1).toFixed(3)),
      fov: this.camera.fov,
      yaw: Number(this.yaw.toFixed(3)),
      pitch: Number(this.pitch.toFixed(3)),
      distance: Number(this.distance.toFixed(2)),
      positionSmoothing: Number((this.lastPositionSmoothing ?? 0).toFixed(2)),
      targetSmoothing: Number((this.lastTargetSmoothing ?? 0).toFixed(2)),
      driving: this.driving,
      vehicleCameraMode: this.vehicleCameraMode,
      comfortEnabled: this.comfortEnabled,
      cameraFeel: this.cameraFeel,
      focusReticle: this.driving && this.comfortEnabled && this.vehicleCameraMode !== 'firstPerson',
      rearViewBlend: Number(this.rearViewBlend.toFixed(3)),
      modeBlendT,
      photoMode: this.photoMode,
      onFootFirstPerson: this.usesOnFootFirstPerson(),
      interiorFirstPerson: this.interiorFirstPerson,
      onFootFirstPersonPreference: this.onFootFirstPerson,
      photoSettings: { ...this.photoSettings },
    };
  }

  getMovementBasis() {
    forwardDirection
      .set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
      .normalize();
    rightDirection
      .set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
      .normalize();

    return {
      forward: forwardDirection.clone(),
      right: rightDirection.clone(),
    };
  }
}
