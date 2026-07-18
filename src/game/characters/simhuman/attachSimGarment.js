import { toPatternDocument } from '../../../vendor/vibe-human/features/clothing/document/legacyAdapter.ts';
import { GarmentSimulationRuntime } from './GarmentSimulationRuntime.ts';
import { getSimGarment } from './simGarmentStore.js';

export function attachSimGarment({ actor, garment, scene, quality = 'low' }) {
  const placements = garment.placements && typeof garment.placements === 'object'
    ? garment.placements
    : {};
  const document = toPatternDocument(garment, placements);
  const runtime = new GarmentSimulationRuntime({ document, quality });
  runtime.bindAvatar({
    root: actor.group,
    skinnedMeshes: actor.model.skinnedMeshes,
    modelScale: actor.model.scale,
  });
  scene.add(runtime.group);
  return runtime;
}

export function attachPresetGarments({ actor, scene, quality = 'low' }) {
  const runtimes = [];
  for (const garmentId of actor.preset.garmentIds ?? []) {
    const garment = getSimGarment(garmentId);
    if (!garment) {
      console.warn(`[sims] preset ${actor.id} references missing garment ${garmentId}`);
      continue;
    }
    try {
      runtimes.push(attachSimGarment({ actor, garment, scene, quality }));
    } catch (error) {
      console.warn(`[sims] failed to attach garment ${garmentId} to ${actor.id}`, error);
    }
  }
  return runtimes;
}
