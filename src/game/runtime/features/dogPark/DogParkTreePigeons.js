import * as THREE from 'three';
import { createProceduralGoose } from '../../../characters/goose/createProceduralGoose.js';

export const TREE_PIGEON_COUNT = 4;
/** Silhouette shells — canopy subjects stay small on screen. */
export const TREE_PIGEON_SHELL_COUNT = 3;

/**
 * Authored perch slots in the north cypress grove (tree-canopy cinematic).
 * Placeholders until real insects/bugs land in the canopy.
 * @type {ReadonlyArray<{ x: number, z: number, y: number, yaw: number }>}
 */
export const TREE_PIGEON_PERCHES = Object.freeze([
  Object.freeze({ x: -8.5, z: 17.2, y: 5.4, yaw: 0.4 }),
  Object.freeze({ x: -2.2, z: 18.1, y: 6.1, yaw: -0.8 }),
  Object.freeze({ x: 4.8, z: 16.6, y: 5.7, yaw: 1.9 }),
  Object.freeze({ x: 11.5, z: 17.8, y: 6.4, yaw: -2.2 }),
  Object.freeze({ x: 0.5, z: 15.8, y: 4.9, yaw: 0.15 }),
]);

/**
 * Rock pigeons in the park canopy — cheap stand-in for future bug life.
 * Mostly perched with occasional flap hop to a neighbor perch.
 */
export class DogParkTreePigeons {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   count?: number,
   *   shellCount?: number,
   * }} opts
   */
  constructor({
    scene,
    count = TREE_PIGEON_COUNT,
    shellCount = TREE_PIGEON_SHELL_COUNT,
  }) {
    this.scene = scene;
    this.count = Math.max(1, Math.min(TREE_PIGEON_PERCHES.length, count | 0));
    this.shellCount = shellCount;
    this.birds = [];
    this.ready = false;
    this._elapsed = 0;
    /** @type {Array<{ perch: number, hopT: number, from: THREE.Vector3, to: THREE.Vector3, hopping: boolean }>} */
    this._slots = [];
  }

  /**
   * @param {ConstructorParameters<typeof DogParkTreePigeons>[0]} opts
   */
  static async create(opts) {
    const group = new DogParkTreePigeons(opts);
    await group.spawn();
    return group;
  }

  async spawn() {
    if (this.ready) return;
    for (let i = 0; i < this.count; i += 1) {
      // Sequential upload keeps park boot smooth.
      // eslint-disable-next-line no-await-in-loop
      const bird = await createProceduralGoose({
        breedId: 'rock-pigeon',
        seed: 1200 + i * 31,
        shellCount: this.shellCount,
      });
      bird.animation.setAutopilot(false);
      bird.animation.setExternalRootMotion(true);
      bird.animation.setFlightAltitudeOverride(0);
      bird.animation.setBehavior('idle');
      bird.setDetailLevel?.(1);
      this.scene.add(bird.root);

      const perch = TREE_PIGEON_PERCHES[i % TREE_PIGEON_PERCHES.length];
      bird.animation.setRootPosition(perch.x, perch.y, perch.z);
      bird.animation.setRootYaw(perch.yaw);
      bird.update?.(1 / 30);

      this.birds.push(bird);
      this._slots.push({
        perch: i % TREE_PIGEON_PERCHES.length,
        hopT: 0,
        from: new THREE.Vector3(perch.x, perch.y, perch.z),
        to: new THREE.Vector3(perch.x, perch.y, perch.z),
        hopping: false,
        nextHop: 2.5 + i * 1.1,
      });
    }
    this.ready = true;
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    if (!this.ready) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    this._elapsed += dt;

    for (let i = 0; i < this.birds.length; i += 1) {
      const bird = this.birds[i];
      const slot = this._slots[i];
      slot.nextHop -= dt;

      if (slot.hopping) {
        slot.hopT += dt / 0.85;
        const t = Math.min(1, slot.hopT);
        const ease = t * t * (3 - 2 * t);
        const x = slot.from.x + (slot.to.x - slot.from.x) * ease;
        const z = slot.from.z + (slot.to.z - slot.from.z) * ease;
        // Arc hop through the branches.
        const y = slot.from.y + (slot.to.y - slot.from.y) * ease + Math.sin(t * Math.PI) * 0.85;
        bird.animation.setRootPosition(x, y, z);
        bird.animation.setBehavior(t < 0.85 ? 'fly_flap' : 'land_feet');
        if (t >= 1) {
          slot.hopping = false;
          slot.hopT = 0;
          bird.animation.setRootPosition(slot.to.x, slot.to.y, slot.to.z);
          bird.animation.setBehavior('idle');
          slot.nextHop = 3.2 + (i % 3) * 1.4;
        }
      } else if (slot.nextHop <= 0) {
        // Hop to a different perch so the canopy feels alive.
        const next = (slot.perch + 1 + (i % 2)) % TREE_PIGEON_PERCHES.length;
        const dest = TREE_PIGEON_PERCHES[next];
        const cur = TREE_PIGEON_PERCHES[slot.perch];
        slot.from.set(cur.x, cur.y, cur.z);
        slot.to.set(dest.x, dest.y, dest.z);
        slot.perch = next;
        slot.hopping = true;
        slot.hopT = 0;
        const yaw = Math.atan2(dest.x - cur.x, dest.z - cur.z);
        bird.animation.setRootYaw(yaw);
      } else {
        // Subtle idle fidget on the branch.
        const perch = TREE_PIGEON_PERCHES[slot.perch];
        const bob = Math.sin(this._elapsed * 1.8 + i) * 0.02;
        bird.animation.setRootPosition(perch.x, perch.y + bob, perch.z);
        if (Math.sin(this._elapsed * 0.7 + i * 2) > 0.92) {
          bird.animation.setBehavior('look');
        } else {
          bird.animation.setBehavior('idle');
        }
      }

      bird.animation.setFlightAltitudeOverride(0);
      bird.update?.(dt);
    }
  }

  getCameraTarget() {
    const bird = this.birds[0];
    return bird?.rig?.root ?? bird?.root ?? null;
  }

  getCameraMotion() {
    if (!this.birds[0]) return null;
    return {
      headingYaw: this.birds[0].animation?.getRootYaw?.() ?? 0,
      yawRate: 0.05,
      moving: false,
      speed: 0.2,
      forwardIntent: 0,
    };
  }

  /** World-space focus for the canopy shot. */
  getFocusPoint(out = new THREE.Vector3()) {
    if (!this.birds.length) {
      const p = TREE_PIGEON_PERCHES[0];
      return out.set(p.x, p.y, p.z);
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (const bird of this.birds) {
      const p = bird.root.position;
      x += p.x;
      y += p.y;
      z += p.z;
    }
    const n = this.birds.length;
    return out.set(x / n, y / n, z / n);
  }

  snapshot() {
    return {
      ready: this.ready,
      count: this.birds.length,
      hopping: this._slots.filter((s) => s.hopping).length,
    };
  }

  dispose() {
    for (const bird of this.birds) bird.dispose?.();
    this.birds = [];
    this._slots = [];
    this.ready = false;
  }
}
