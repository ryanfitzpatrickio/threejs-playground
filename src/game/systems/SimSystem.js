import * as THREE from 'three';
import { createVibeHumanModel, cloneVibeHumanModel } from '../characters/simhuman/createVibeHumanModel.js';
import { getSimSpawnPresets } from '../characters/simhuman/simPresetStore.js';
import { loadRigifyAnimationClips } from '../characters/simhuman/rigifySourceSkeleton.js';
import { MaraAnimationController } from '../characters/mara/MaraAnimationController.js';
import { attachPresetGarments } from '../characters/simhuman/attachSimGarment.js';
import { attachPresetOutfit } from '../characters/simhuman/attachSimOutfit.js';
import { attachPresetHair } from '../characters/simhuman/attachSimHair.js';
import { applyArmRaisePose } from '../characters/simhuman/armRaisePose.js';

const WALK_SPEED = 1.4;
const ARRIVAL_RADIUS = 0.18;
const ACTOR_RADIUS = 0.34;
const ACTOR_HEIGHT = 1.75;
const pointOnRay = new THREE.Vector3();
const pointOnSegment = new THREE.Vector3();

export class SimSystem {
  constructor() {
    this.actors = [];
    this.bodyResources = new Map();
    this.scene = null;
    this.levelSystem = null;
    this.selectedSimId = null;
    this.ready = false;
  }

  async initialize({ scene, levelSystem }) {
    this.scene = scene;
    this.levelSystem = levelSystem;
    const presets = getSimSpawnPresets(2);
    const bodyAliases = [...new Set(presets.map((preset) => preset.body))];
    const resources = await Promise.all(bodyAliases.map(async (body) => {
      const [template, clips] = await Promise.all([
        createVibeHumanModel({ modelUrl: body }),
        loadRigifyAnimationClips({ bodyAlias: body }),
      ]);
      return [body, { template, clips }];
    }));
    this.bodyResources = new Map(resources);
    const spawnPoints = levelSystem.level?.simSpawnPoints ?? [];
    this.actors = presets.map((preset, index) => {
      const resource = this.bodyResources.get(preset.body);
      if (!resource) throw new Error(`Missing Sim body resources: ${preset.body}`);
      const model = cloneVibeHumanModel(resource.template, preset);
      model.group.name = `Sim Actor:${preset.id}`;
      model.group.position.copy(spawnPoints[index] ?? new THREE.Vector3(index * 2, 0, 0));
      scene.add(model.group);
      const animationController = new MaraAnimationController({
        mixer: new THREE.AnimationMixer(model.object),
        clips: resource.clips,
        modelRoot: model.object,
        skeletonSource: 'rigify',
      });
      animationController.start();
      const actor = {
        id: preset.id,
        name: preset.name,
        preset,
        model,
        group: model.group,
        animationController,
        garments: [],
        outfit: null,
        hair: null,
        goal: null,
        moving: false,
      };
      actor.garments = attachPresetGarments({ actor, scene, quality: 'low' });
      return actor;
    });
    await Promise.all(this.actors.map(async (actor) => {
      const [outfit, hair] = await Promise.all([
        attachPresetOutfit({ actor, scene }),
        attachPresetHair({ actor, scene }),
      ]);
      actor.outfit = outfit;
      actor.hair = hair;
    }));
    this.selectedSimId = this.actors[0]?.id ?? null;
    this.ready = true;
  }

  updateGarments(delta) {
    for (const actor of this.actors) {
      for (const garment of actor.garments) garment.step(delta);
    }
  }

  update(delta) {
    for (const actor of this.actors) {
      let moving = false;
      if (actor.goal) {
        const offsetX = actor.goal.x - actor.group.position.x;
        const offsetZ = actor.goal.z - actor.group.position.z;
        const distance = Math.hypot(offsetX, offsetZ);
        if (distance <= ARRIVAL_RADIUS) {
          actor.goal = null;
        } else {
          const step = Math.min(distance, WALK_SPEED * delta);
          const dx = offsetX / distance;
          const dz = offsetZ / distance;
          const next = actor.group.position.clone().add(new THREE.Vector3(dx * step, 0, dz * step));
          const blocking = this.levelSystem.getBlockingColliderAt({
            position: next,
            radius: ACTOR_RADIUS,
            feetY: actor.group.position.y,
            height: ACTOR_HEIGHT,
            stepHeight: 0.28,
          });
          if (!blocking) {
            const ground = this.levelSystem.getGroundHeightAt(next, ACTOR_RADIUS, {
              maxStepUp: 0.35,
              maxSnapDown: 0.7,
            });
            actor.group.position.set(next.x, Number.isFinite(ground) ? ground : 0, next.z);
            actor.group.rotation.y = dampAngle(
              actor.group.rotation.y,
              Math.atan2(dx, dz),
              10,
              delta,
            );
            moving = true;
          } else {
            actor.goal = null;
          }
        }
      }
      if (moving !== actor.moving) {
        actor.moving = moving;
        actor.animationController.play(moving ? 'walk' : 'idle');
      }
      actor.animationController.update(delta);
      // Lateral arm raise from the saved preset (hands clear thighs).
      applyArmRaisePose(actor.model, actor.preset?.armSpace);
    }
  }

  select(id) {
    if (!this.actors.some((actor) => actor.id === id)) return false;
    this.selectedSimId = id;
    return true;
  }

  setGoal(point) {
    const actor = this.actors.find((entry) => entry.id === this.selectedSimId);
    if (!actor) return false;
    actor.goal = point.clone();
    return true;
  }

  pick(ray) {
    let best = null;
    let bestDistance = Infinity;
    for (const actor of this.actors) {
      const bottom = actor.group.position.clone().add(new THREE.Vector3(0, 0.25, 0));
      const top = actor.group.position.clone().add(new THREE.Vector3(0, 1.7, 0));
      const distanceSq = ray.distanceSqToSegment(bottom, top, pointOnRay, pointOnSegment);
      const alongRay = pointOnRay.distanceTo(ray.origin);
      if (distanceSq <= 0.48 ** 2 && alongRay < bestDistance) {
        best = actor;
        bestDistance = alongRay;
      }
    }
    return best;
  }

  get selectedActor() {
    return this.actors.find((actor) => actor.id === this.selectedSimId) ?? null;
  }

  snapshot() {
    return {
      ready: this.ready,
      selectedSimId: this.selectedSimId,
      sims: this.actors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        body: actor.preset.body,
        x: actor.group.position.x,
        y: actor.group.position.y,
        z: actor.group.position.z,
        moving: actor.moving,
        goal: actor.goal ? { x: actor.goal.x, y: actor.goal.y, z: actor.goal.z } : null,
        garments: actor.garments.map((garment) => garment.snapshot()),
        outfit: actor.outfit?.snapshot() ?? null,
        hair: actor.hair?.snapshot() ?? null,
      })),
    };
  }

  dispose() {
    for (const actor of this.actors) {
      for (const garment of actor.garments) garment.dispose();
      actor.outfit?.dispose();
      actor.hair?.dispose();
      actor.animationController.dispose();
      actor.model.dispose();
    }
    this.actors = [];
    for (const { template } of this.bodyResources.values()) template.dispose();
    this.bodyResources.clear();
    this.ready = false;
  }
}

function dampAngle(current, target, smoothing, delta) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-smoothing * delta));
}
