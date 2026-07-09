import * as THREE from 'three';
import {
  GARAGE_DEFAULT_CHASSIS_TRANSFORM,
  GARAGE_FRAME_PRESETS,
} from '../game/vehicles/garageBuilds.js';

export const BODYSHOP_FLOOR_Y = -0.02;
export const BODYSHOP_FLOOR_CLEARANCE = 0.02;

export function getBodyshopFramePreset(framePresetId = 'street') {
  return GARAGE_FRAME_PRESETS.find((entry) => entry.id === framePresetId)
    ?? GARAGE_FRAME_PRESETS.find((entry) => entry.id === 'street')
    ?? GARAGE_FRAME_PRESETS[0];
}

export function applyChassisTransformToGroup(
  group,
  transform = GARAGE_DEFAULT_CHASSIS_TRANSFORM,
) {
  group.position.set(
    transform.position[0],
    transform.position[1],
    transform.position[2],
  );
  group.rotation.set(
    THREE.MathUtils.degToRad(transform.rotationDegrees[0]),
    THREE.MathUtils.degToRad(transform.rotationDegrees[1]),
    THREE.MathUtils.degToRad(transform.rotationDegrees[2]),
    'XYZ',
  );
  group.scale.set(
    transform.scale[0],
    transform.scale[1],
    transform.scale[2],
  );
  group.updateMatrixWorld(true);
}

export function createBodyshopVehicleOptions({
  framePresetId = 'street',
  chassisOverlay = false,
  hideEngine = true,
  chassisTransform = GARAGE_DEFAULT_CHASSIS_TRANSFORM,
} = {}) {
  const preset = getBodyshopFramePreset(framePresetId);
  const frame = preset.frame;
  const options = {
    hideEngine,
    frameParameters: { ...frame },
    config: {
      body: {
        size: [frame.frameWidth, frame.frameHeight, frame.frameLength],
      },
      ground: {
        enginePower: 8,
        traction: 0.55,
        wheelRadius: 0.38,
        wheelWidth: 0.3,
        wheelInset: 0.12,
        rayCast: {
          wheelRadius: 0.38,
          suspensionStiffness: 24,
          suspensionCompression: 12,
          suspensionRelaxation: 12,
          maxSteerYawRate: 0.75,
          highSpeedSteerYawRate: 0.42,
        },
      },
    },
  };

  if (chassisOverlay === false) {
    return { ...options, chassisOverlay: false };
  }

  return {
    ...options,
    chassisOverlay: {
      chassisSurfaceMode: 'metallic',
      position: [...chassisTransform.position],
      rotationDegrees: [...chassisTransform.rotationDegrees],
      scale: [...chassisTransform.scale],
      ...chassisOverlay,
    },
  };
}
