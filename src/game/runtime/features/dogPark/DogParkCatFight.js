import * as THREE from 'three';
import { createProceduralDog } from '../../../characters/dog/createProceduralDog.js';
import { DogClipPlayer, animalUsesDogClipLibrary } from '../../../characters/dog/DogClipPlayer.js';
import { plantDogFeet } from '../../../characters/dog/dogFootPlant.js';
import { gaitFromSpeed } from '../../../characters/dog/animalLocalAvoidance.js';

export const CAT_FIGHT_COUNT = 2;
/** Low shell count — close cinematic subject, still NPC budget. */
export const CAT_FIGHT_SHELL_COUNT = 4;

/**
 * First two feline catalog entries (not the cat-rig procedural third).
 * @see dogCatalog.js — tortoiseshell, khao-manee, then tortoiseshell-procedural.
 */
export const CAT_FIGHT_BREEDS = Object.freeze([
  'tortoiseshell',
  'khao-manee',
]);

const ARENA_RADIUS = 1.55;
/** Dog-skeleton behaviors that sell a scuffle (no cat-only FSM). */
const BEHAVIORS = Object.freeze(['trot', 'look', 'walk', 'trot', 'look', 'idle']);

const groundProbe = new THREE.Vector3();

/**
 * Two dog-pipeline felines sparring in a small park arena.
 * Cast is the first two catalog felines — tortoiseshell + Khao Manee —
 * not the bespoke `tortoiseshell-procedural` cat-rig.
 */
export class DogParkCatFight {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   levelSystem: object,
   *   center?: { x: number, z: number },
   *   shellCount?: number,
   * }} opts
   */
  constructor({
    scene,
    levelSystem,
    center = { x: -12, z: -6 },
    shellCount = CAT_FIGHT_SHELL_COUNT,
  }) {
    this.scene = scene;
    this.levelSystem = levelSystem;
    this.center = { x: center.x, z: center.z };
    this.shellCount = shellCount;
    this.cats = [];
    this._elapsed = 0;
    this._phase = Math.random() * Math.PI * 2;
    this._behaviorTimers = [];
    this._actors = [];

    for (let i = 0; i < CAT_FIGHT_COUNT; i += 1) {
      const breedId = CAT_FIGHT_BREEDS[i] ?? CAT_FIGHT_BREEDS[0];
      const cat = createProceduralDog({
        breedId,
        seed: 40 + i * 19,
        shellCount: this.shellCount,
        budget: 'npc',
      });
      cat.setShowFur?.(true);
      cat.setDetailLevel?.(1);
      cat.animation.setAutopilot?.(false);
      cat.animation.setExternalRootMotion?.(true);
      cat.animation.setBehavior?.(i === 0 ? 'trot' : 'look');

      const clipPlayer = animalUsesDogClipLibrary(cat)
        ? new DogClipPlayer(cat)
        : null;
      if (clipPlayer) void clipPlayer.initialize();

      this.scene.add(cat.root);
      this.cats.push(cat);
      this._actors.push({
        animal: cat,
        clipPlayer,
        radius: THREE.MathUtils.clamp(0.28 * (cat.phenotype?.skeleton?.scale ?? 1), 0.14, 0.4),
      });
      this._behaviorTimers.push(0.6 + i * 0.4);
    }
    this._placeCats(0);
  }

  /**
   * Register orbit preferred velocities so chase/player part around the spar.
   * @param {import('./DogParkCrowd.js').DogParkCrowd} crowd
   */
  registerCrowd(crowd) {
    if (!crowd) return;
    for (let i = 0; i < this.cats.length; i += 1) {
      const cat = this.cats[i];
      const p = cat.root.position;
      const yaw = cat.animation?.getRootYaw?.() ?? 0;
      // Tangential orbit direction (prefer circling the arena).
      const tx = Math.cos(yaw);
      const tz = -Math.sin(yaw);
      const speed = 1.35;
      crowd.register({
        id: `cat-fight-${i}`,
        x: p.x,
        z: p.z,
        dirX: tx,
        dirZ: tz,
        speed,
        radius: this._actors[i]?.radius ?? 0.28,
        maxSpeed: 1.8,
        priority: 0.9,
        group: 'cats',
      });
    }
  }

  /**
   * @param {number} delta
   * @param {{
   *   skipFurDynamics?: boolean,
   *   skipClips?: boolean,
   *   crowd?: import('./DogParkCrowd.js').DogParkCrowd | null,
   * }} [opts]
   */
  update(delta, opts = {}) {
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    this._elapsed += dt;
    // Slow orbit so they circle each other without leaving the arena.
    this._phase += 0.7 * dt;
    this._placeCats(dt, opts.crowd ?? null);

    for (let i = 0; i < this._actors.length; i += 1) {
      const actor = this._actors[i];
      const cat = actor.animal;
      this._behaviorTimers[i] -= dt;
      if (this._behaviorTimers[i] <= 0) {
        const idx = Math.floor(this._elapsed * 1.7 + i * 2.3) % BEHAVIORS.length;
        const next = BEHAVIORS[idx];
        cat.animation.setBehavior?.(next);
        this._behaviorTimers[i] = next === 'trot' ? 1.1 : 1.6 + (i * 0.35);
      }

      // Velocity → gait from crowd motion (or authored behavior fallback).
      const motion = opts.crowd?.getMotion?.(`cat-fight-${i}`, { trotMin: 1.4 });
      const behavior = cat.animation.getBehavior?.() ?? 'idle';
      const look = behavior === 'look' || behavior === 'alert';
      if (motion && motion.speed > 0.08) {
        const gait = gaitFromSpeed(motion.speed, { trotMin: 1.4 });
        cat.animation.setMoveIntent?.({
          x: motion.dirX,
          z: motion.dirZ,
          moving: gait.moving,
          sprint: gait.sprint,
          sit: false,
          look: look && !gait.moving,
        });
      } else {
        const moving = behavior === 'walk' || behavior === 'trot';
        cat.animation.setMoveIntent?.({
          x: moving ? Math.sin(cat.animation.getRootYaw?.() ?? 0) : 0,
          z: moving ? Math.cos(cat.animation.getRootYaw?.() ?? 0) : 0,
          moving,
          sprint: behavior === 'trot',
          sit: false,
          look,
        });
      }

      const useClips = !opts.skipClips && Boolean(actor.clipPlayer?.ready);
      cat.animation?.setClipDriven?.(useClips);
      cat.update?.(dt, {
        fixed: false,
        skipFurDynamics: Boolean(opts.skipFurDynamics),
        plantFeet: Boolean(opts.skipClips) || !useClips,
        getGroundHeight: (x, z) => {
          groundProbe.set(x, cat.root.position.y, z);
          const y = this.levelSystem?.getGroundHeightAt?.(groundProbe, actor.radius * 0.45, {
            maxStepUp: 0.48,
            maxSnapDown: 1.2,
            requiredInset: Math.min(actor.radius * 0.25, 0.1),
          });
          return Number.isFinite(y) ? y : cat.root.position.y;
        },
      });
      if (useClips) {
        actor.clipPlayer.update(dt, cat.animation.getBehavior());
        cat.animation?.applyPostClipOverlays?.();
        plantDogFeet(cat, {
          getGroundHeight: (x, z) => {
            groundProbe.set(x, cat.root.position.y, z);
            const y = this.levelSystem?.getGroundHeightAt?.(groundProbe, actor.radius * 0.45, {
              maxStepUp: 0.48,
              maxSnapDown: 1.2,
            });
            return Number.isFinite(y) ? y : cat.root.position.y;
          },
        });
      }
    }
  }

  /**
   * @param {number} dt
   * @param {import('./DogParkCrowd.js').DogParkCrowd | null} [crowd]
   */
  _placeCats(dt, crowd = null) {
    for (let i = 0; i < this.cats.length; i += 1) {
      const cat = this.cats[i];
      const actor = this._actors[i];
      // Opposite sides of a small ring; slight radial weave so they lunge in/out.
      const angle = this._phase + i * Math.PI;
      const weave = 1 + 0.18 * Math.sin(this._elapsed * 2.4 + i * 1.7);
      const r = ARENA_RADIUS * weave;
      let x = this.center.x + Math.cos(angle) * r;
      let z = this.center.z + Math.sin(angle) * r;
      // Soft crowd nudge so they part around the player / chase without leaving the ring.
      const v = crowd?.get?.(`cat-fight-${i}`);
      if (v && dt > 0) {
        x += v.vx * dt * 0.55;
        z += v.vz * dt * 0.55;
        const dx = x - this.center.x;
        const dz = z - this.center.z;
        const dist = Math.hypot(dx, dz) || 1;
        const maxR = ARENA_RADIUS * 1.35;
        if (dist > maxR) {
          x = this.center.x + (dx / dist) * maxR;
          z = this.center.z + (dz / dist) * maxR;
        }
      }
      const groundY = this.levelSystem?.getGroundHeightAt?.(
        { x, y: 0, z },
        actor?.radius ?? 0.2,
        { maxStepUp: 2, maxSnapDown: 4 },
      );
      const y = Number.isFinite(groundY) ? groundY : 0;
      // Face the arena center (toward the other cat).
      const yaw = Math.atan2(this.center.x - x, this.center.z - z);
      cat.root.position.set(x, y, z);
      cat.animation.setRootYaw?.(yaw);
    }
  }

  /** Orbit focus for cinematic cam (first cat — tortoiseshell). */
  getCameraTarget() {
    const cat = this.cats[0];
    return cat?.rig?.root ?? cat?.root ?? null;
  }

  getCameraMotion() {
    if (!this.cats[0]) return null;
    const yaw = this.cats[0].animation?.getRootYaw?.() ?? 0;
    return {
      headingYaw: yaw,
      yawRate: 0.7,
      moving: true,
      speed: 1.6,
      forwardIntent: 1,
    };
  }

  /** Midpoint between cats for world-framing fallbacks. */
  getMidpoint(out = new THREE.Vector3()) {
    if (this.cats.length < 2) {
      const p = this.cats[0]?.root?.position;
      return out.set(p?.x ?? this.center.x, p?.y ?? 0.3, p?.z ?? this.center.z);
    }
    const a = this.cats[0].root.position;
    const b = this.cats[1].root.position;
    return out.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 0.2, (a.z + b.z) * 0.5);
  }

  snapshot() {
    return {
      count: this.cats.length,
      breeds: this.cats.map((c) => c.breedId ?? null),
      center: { ...this.center },
      behaviors: this.cats.map((c) => c.animation?.getBehavior?.() ?? null),
    };
  }

  dispose() {
    for (const actor of this._actors) {
      actor.clipPlayer?.dispose?.();
      actor.animal?.dispose?.();
    }
    this._actors = [];
    this.cats = [];
  }
}
