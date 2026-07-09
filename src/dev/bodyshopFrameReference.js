import * as THREE from 'three';
import { BaseVehicle } from '../game/vehicles/BaseVehicle.js';
import { liftObjectToFloor } from './bodyshopViewport.js';
import {
  BODYSHOP_FLOOR_CLEARANCE,
  BODYSHOP_FLOOR_Y,
  createBodyshopVehicleOptions,
  getBodyshopFramePreset,
} from './bodyshopVehicleConfig.js';

function tintReferenceMeshes(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material || material.userData._bodyshopFrameTinted) continue;
      material.userData._bodyshopFrameTinted = true;
      material.transparent = true;
      material.opacity = 0.42;
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  });
}

export async function createBodyshopFrameReference({
  framePresetId = 'street',
  floorY = BODYSHOP_FLOOR_Y,
} = {}) {
  const preset = getBodyshopFramePreset(framePresetId);

  const vehicle = new BaseVehicle({
    name: 'Bodyshop Frame Reference',
    ...createBodyshopVehicleOptions({ framePresetId: preset.id, chassisOverlay: false }),
  });

  const group = vehicle.buildMesh();
  vehicle.group = group;
  await vehicle.assembleGroundVehicleVisuals({ syncParkedWheels: true });

  group.name = '__bodyshop_frame_reference__';
  group.userData._builderHelper = true;
  group.traverse((child) => {
    child.userData._builderHelper = true;
    child.userData._frameReference = true;
  });
  tintReferenceMeshes(group);
  liftObjectToFloor(group, floorY, BODYSHOP_FLOOR_CLEARANCE);

  let activePresetId = preset.id;

  return {
    vehicle,
    group,
    get chassisSocket() {
      return vehicle.chassisSocket;
    },
    get presetId() {
      return activePresetId;
    },
    setPreset(id) {
      const next = getBodyshopFramePreset(id);
      activePresetId = next.id;
      vehicle.setFrameParameters(next.frame);
      vehicle._syncParkedWheelVisuals();
      liftObjectToFloor(group, floorY, BODYSHOP_FLOOR_CLEARANCE);
      return next;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      group.parent?.remove(group);
      vehicle.dispose?.({ scene: null, physics: null });
    },
  };
}
