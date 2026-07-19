import * as THREE from 'three';
import { createProceduralDog } from '../../../characters/dog/createProceduralDog.js';
import { AUTHORED_DOG_BREED_IDS } from '../../../characters/dog/dogCatalog.js';
import { DogNpcController } from '../../../characters/dog/DogNpcController.js';

// Crowd budget: each NPC is body + N fur shells (+ face meshes when near).
// Spawning one full dog per authored breed (~29) × 8 shells was ~260+ skinned
// draws before face features. Cap the pack and LOD aggressively.
// Trace-driven budget: pack of full shell dogs was the main draw-call killer.
export const MAX_NPC_DOGS = 8;
/** Fur shells per NPC at near LOD (hero player uses a separate budget). */
export const NPC_SHELL_COUNT = 2;
const LOD_NEAR = 14;
const LOD_MID = 28;
const _camPos = new THREE.Vector3();
const _dogPos = new THREE.Vector3();

function hashSeed(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/** Pick up to `max` breed ids evenly from the authored catalog. */
export function pickNpcBreedIds(allIds = AUTHORED_DOG_BREED_IDS, max = MAX_NPC_DOGS) {
  const list = [...allIds];
  if (list.length <= max) return list;
  const picked = [];
  for (let i = 0; i < max; i += 1) {
    const t = max === 1 ? 0 : i / (max - 1);
    const index = Math.min(list.length - 1, Math.round(t * (list.length - 1)));
    picked.push(list[index]);
  }
  // Dedupe while preserving order (round can collide on small catalogs).
  return [...new Set(picked)];
}

/**
 * Spawns a capped pack of NPC dogs (not one-per-breed) and distance-LODs
 * shell/face draw cost relative to the active camera.
 */
export class DogParkNpcSystem {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   levelSystem: object,
   *   mudField?: object,
   *   mudPatches?: object[],
   *   bounds?: object,
   *   spawnPoint?: { x: number, y?: number, z: number },
   *   getCamera?: () => THREE.Camera | null | undefined,
   *   maxDogs?: number,
   *   shellCount?: number,
   * }} opts
   */
  constructor({
    scene,
    levelSystem,
    mudField,
    mudPatches = [],
    bounds,
    spawnPoint,
    getCamera = null,
    maxDogs = MAX_NPC_DOGS,
    shellCount = NPC_SHELL_COUNT,
  }) {
    this.scene = scene;
    this.getCamera = typeof getCamera === 'function' ? getCamera : null;
    this.npcs = [];
    this._lodFrame = 0;

    const breedIds = pickNpcBreedIds(AUTHORED_DOG_BREED_IDS, maxDogs);
    const spanX = ((bounds?.maxX ?? 20) - (bounds?.minX ?? -20)) * 0.5;
    const spanZ = ((bounds?.maxZ ?? 15) - (bounds?.minZ ?? -15)) * 0.5;
    const originX = spawnPoint?.x ?? 0;
    const originZ = spawnPoint?.z ?? 0;

    breedIds.forEach((breedId, index) => {
      const dog = createProceduralDog({
        breedId,
        seed: hashSeed(breedId),
        shellCount,
        budget: 'npc',
      });
      dog.setShowFur(true);
      dog.setDetailLevel(1);

      // Deterministic scatter: golden-angle ring so breeds spread evenly
      // without clumping, biased toward the middle of the park.
      const angle = index * 2.399963;
      const ringT = 0.3 + 0.65 * ((index % 5) / 4);
      const x = THREE.MathUtils.clamp(
        originX + Math.cos(angle) * spanX * ringT,
        (bounds?.minX ?? -20) + 2,
        (bounds?.maxX ?? 20) - 2,
      );
      const z = THREE.MathUtils.clamp(
        originZ + Math.sin(angle) * spanZ * ringT,
        (bounds?.minZ ?? -15) + 2,
        (bounds?.maxZ ?? 15) - 2,
      );
      const groundY = levelSystem.getGroundHeightAt({ x, y: 0, z }, 0.3, { maxStepUp: 2, maxSnapDown: 4 });
      dog.root.position.set(x, Number.isFinite(groundY) ? groundY : 0, z);
      dog.animation.setRootYaw(angle);
      scene.add(dog.root);

      const controller = new DogNpcController({
        dog,
        levelSystem,
        mudField,
        bounds,
        mudPatches,
        // No per-NPC mud-coat controller (kept off NPCs for perf); the shared
        // ground splash/paw-trail systems still sell the moment. trackImpact:
        // false keeps this out of the player-facing flopImpactCount metric.
        onFlop: (impact) => levelSystem.level?.applyDogFlopImpact?.({ ...impact, trackImpact: false }),
        onPawStamp: (stamp) => levelSystem.level?.addDogPawVisual?.(stamp),
      });

      this.npcs.push({ dog, controller, detailLevel: 1 });
    });
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    this._lodFrame = (this._lodFrame + 1) % 3;
    const camera = this.getCamera?.() ?? null;
    if (camera) camera.getWorldPosition(_camPos);

    for (let i = 0; i < this.npcs.length; i += 1) {
      const npc = this.npcs[i];
      // Stagger LOD checks across frames — AI still updates every frame.
      if (camera && (i % 3) === this._lodFrame) {
        npc.dog.root.getWorldPosition(_dogPos);
        const dist = _dogPos.distanceTo(_camPos);
        const level = dist < LOD_NEAR ? 2 : dist < LOD_MID ? 1 : 0;
        if (level !== npc.detailLevel) {
          npc.detailLevel = level;
          npc.dog.setDetailLevel?.(level);
        }
      }

      // Far LODs skip expensive fur dynamics; clips still advance pose when near/mid.
      const far = npc.detailLevel <= 0;
      npc.controller.update(delta, { skipFurDynamics: far, skipClips: far });
    }
  }

  snapshot() {
    return {
      count: this.npcs.length,
      max: MAX_NPC_DOGS,
      shells: NPC_SHELL_COUNT,
      dogs: this.npcs.map((npc) => ({
        ...npc.controller.snapshot(),
        detailLevel: npc.detailLevel,
      })),
    };
  }

  dispose() {
    for (const npc of this.npcs) {
      npc.controller.dispose();
      npc.dog.dispose();
    }
    this.npcs = [];
  }
}
