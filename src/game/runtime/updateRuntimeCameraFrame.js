import { isRootMotionCameraSmoothingActive } from './runtimeHelpers.js';

/** Mode-aware follow camera + post-camera body alignment frame step. */
export function updateRuntimeCameraFrame(host, scaledDelta, input, character) {
  const cameraInput = { ...input };
  const inVehicle = Boolean(host.vehicleSystem?.activeVehicle);
  cameraInput.rearViewHeld = inVehicle && Boolean(input.rearViewHeld || input.wingsuitHeld);
  if (host.enemyCutSystem.state === 'aiming' || inVehicle) {
    cameraInput.lookX = 0;
    cameraInput.lookY = 0;
  }

  // Photo-mode free-fly is applied earlier this frame; skip follow/vehicle/dog chase.
  if (host.cameraSystem.photoMode) {
    // Freecam already owns look + position this frame.
  } else if (host.simsFeature.active) {
    host.simsFeature.updateCamera(scaledDelta);
  } else if (host.dogParkFeature.active) {
    host.dogParkFeature.updateCamera(scaledDelta);
  } else {
    if (host.rallyCinematicDemo?.active) {
      host.rallyCinematicDemo.update(scaledDelta, {
        vehicle: host.vehicleSystem?.activeVehicle,
        camera: host.cameraSystem.camera,
        level: host.levelSystem,
      });
    } else {
      host.cameraSystem.update({
        delta: scaledDelta,
        target: character.group.position,
        viewport: host.rendererSystem.getViewport(),
        input: cameraInput,
        rootMotionActive: isRootMotionCameraSmoothingActive(character),
        character,
        vehicle: host.vehicleSystem?.activeVehicle ?? null,
      });
    }
  }

  // FP body yaw follows look input only when an avatar-mode camera is not active.
  if (!host.cameraSystem.photoMode && !host.simsFeature.active && !host.dogParkFeature.active) {
    host.firstPersonWeaponSystem.postCamera({
      character,
      cameraSystem: host.cameraSystem,
      input: cameraInput,
      delta: scaledDelta,
    });
  }
}

