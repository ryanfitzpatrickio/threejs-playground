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
const vehicleTarget = new THREE.Vector3();
const freeMove = new THREE.Vector3();
const freeForward = new THREE.Vector3();
const freeRight = new THREE.Vector3();
const freeEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function lerpAngle(from, to, alpha) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * alpha;
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
    this.yaw = 0;
    this.pitch = config.initialPitch;
    this.distance = config.followDistance;
    this.lastPositionSmoothing = GAME_CONFIG.camera.smoothing;
    this.lastTargetSmoothing = GAME_CONFIG.camera.targetSmoothing;
    this.driving = false;
    this.vehicleCameraYaw = 0;
    this.vehicleSteerOffset = 0;
    this.vehicleLateralOffset = 0;
    this.smoothedFov = config.vehicle.defaultFov;
    this.photoMode = false;
    this.photoSettings = {
      fov: config.vehicle.defaultFov,
      aperture: 2.8,
      focusDistance: 10,
      speed: 12,
    };
    scene.add(this.camera);
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
      this.updateVehicleChaseCamera({ delta, vehicle, viewport });
      return;
    }

    if (this.driving) {
      this.driving = false;
      this.hasSmoothedTarget = false;
      this.vehicleSteerOffset = 0;
      this.vehicleLateralOffset = 0;
    }

    const config = GAME_CONFIG.camera;
    const hookSwing = character?.hookSwing;
    this.updateOrbitInput({ input, config, hookSwing });

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

  updateVehicleChaseCamera({ delta, vehicle, viewport }) {
    const config = GAME_CONFIG.camera.vehicle;
    const chassis = vehicle.group;
    if (!chassis) {
      return;
    }

    const enteringVehicle = !this.driving;
    this.driving = true;

    const headingYaw = extractVehicleYaw(chassis.quaternion);
    if (enteringVehicle) {
      this.vehicleCameraYaw = headingYaw;
      this.vehicleSteerOffset = 0;
      this.vehicleLateralOffset = 0;
      this.smoothedTarget.copy(chassis.position);
      this.hasSmoothedTarget = true;
      this.yaw = headingYaw;
      this.pitch = config.pitch;
    }

    const yawAlpha = 1 - Math.exp(-config.yawSmoothing * delta);
    this.vehicleCameraYaw = lerpAngle(this.vehicleCameraYaw, headingYaw, yawAlpha);

    const steer = getVehicleSteerInput(vehicle);
    const steerAlpha = 1 - Math.exp(-config.steerOffsetSmoothing * delta);
    const desiredSteerOffset = steer * config.steerLookStrength;
    this.vehicleSteerOffset = THREE.MathUtils.lerp(this.vehicleSteerOffset, desiredSteerOffset, steerAlpha);
    this.vehicleLateralOffset = THREE.MathUtils.lerp(
      this.vehicleLateralOffset,
      -steer * config.lateralShift,
      steerAlpha,
    );

    const cameraYaw = this.vehicleCameraYaw + this.vehicleSteerOffset;
    this.yaw = cameraYaw;
    this.pitch = config.pitch;

    const horizontalSpeed = getVehicleHorizontalSpeed(vehicle);
    const speedRatio = THREE.MathUtils.clamp(
      horizontalSpeed / config.maxSpeedForEffects,
      0,
      1,
    );
    const responsiveDistance = viewport?.aspect < 0.8 ? config.followDistance + 1.1 : config.followDistance;
    const distance = responsiveDistance + horizontalSpeed * config.speedDistanceBoost;
    const responsiveHeight = viewport?.aspect < 0.8 ? config.followHeight + 0.35 : config.followHeight;

    this.updateSmoothedTarget({
      target: chassis.position,
      delta,
      targetSmoothing: config.targetSmoothing,
      // At maximum speed the old fixed 14 m threshold represented only ~0.2 s
      // and turned an otherwise smooth catch-up into a hard target snap.
      maxLag: Math.max(config.maxTargetLag, horizontalSpeed * 0.45),
    });
    this.lastPositionSmoothing = config.positionSmoothing;
    this.lastTargetSmoothing = config.targetSmoothing;

    vehicleForward.set(0, 0, -1).applyQuaternion(chassis.quaternion);
    vehicleRight.set(1, 0, 0).applyQuaternion(chassis.quaternion);

    const horizontalDistance = Math.cos(config.pitch) * distance;
    offset
      .set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw))
      .multiplyScalar(horizontalDistance);
    offset.y = responsiveHeight + Math.sin(config.pitch) * distance;
    offset.addScaledVector(vehicleRight, this.vehicleLateralOffset);

    desiredPosition.copy(this.smoothedTarget).add(offset);
    this.camera.position.lerp(
      desiredPosition,
      1 - Math.exp(-config.positionSmoothing * delta),
    );

    vehicleTarget
      .copy(this.smoothedTarget)
      .addScaledVector(vehicleForward, config.lookAhead)
      .add({ x: 0, y: config.lookHeight, z: 0 });
    this.camera.lookAt(vehicleTarget);

    this.updateFov({
      delta,
      targetFov: config.baseFov + speedRatio * config.speedFovBoost,
      smoothing: 8,
    });
  }

  updateFov({ delta, targetFov, smoothing }) {
    const alpha = 1 - Math.exp(-smoothing * delta);
    this.smoothedFov = THREE.MathUtils.lerp(this.smoothedFov, targetFov, alpha);
    if (Math.abs(this.camera.fov - this.smoothedFov) > 0.01) {
      this.camera.fov = this.smoothedFov;
      this.camera.updateProjectionMatrix();
    }
  }

  updateOrbitInput({ input, config, hookSwing = null }) {
    if (!input) {
      return;
    }

    const lookScale = hookSwing?.active ? 0.82 : 1;
    this.yaw -= input.lookX * config.lookSensitivity * lookScale;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + input.lookY * config.lookSensitivity * lookScale,
      config.minPitch,
      config.maxPitch,
    );

    if (input.zoomDelta) {
      this.distance = THREE.MathUtils.clamp(
        this.distance + input.zoomDelta * config.zoomStep,
        config.minDistance,
        config.maxDistance,
      );
    }
  }

  updateSmoothedTarget({ target, delta, targetSmoothing, maxLag }) {
    if (
      !this.hasSmoothedTarget ||
      !Number.isFinite(delta) ||
      this.smoothedTarget.distanceTo(target) > maxLag
    ) {
      this.smoothedTarget.copy(target);
      this.hasSmoothedTarget = true;
      this.lastTargetSmoothing = targetSmoothing;
      return;
    }

    this.lastTargetSmoothing = targetSmoothing;
    this.smoothedTarget.lerp(target, 1 - Math.exp(-targetSmoothing * delta));
  }

  resize({ aspect }) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  snapshot() {
    return {
      aspect: Number(this.camera.aspect.toFixed(3)),
      fov: this.camera.fov,
      yaw: Number(this.yaw.toFixed(3)),
      pitch: Number(this.pitch.toFixed(3)),
      distance: Number(this.distance.toFixed(2)),
      positionSmoothing: Number((this.lastPositionSmoothing ?? 0).toFixed(2)),
      targetSmoothing: Number((this.lastTargetSmoothing ?? 0).toFixed(2)),
      driving: this.driving,
      photoMode: this.photoMode,
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
