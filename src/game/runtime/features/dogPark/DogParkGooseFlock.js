import * as THREE from 'three';
import { createProceduralGoose } from '../../../characters/goose/createProceduralGoose.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();

/** Low shell count — flock is a sky silhouette, not a close fur study. */
export const FLOCK_SHELL_COUNT = 3;
/** Classic V: lead + 2 wings (5 total). */
export const FLOCK_COUNT = 5;
/** Spacing along the V arm (metres, bird-local). */
const V_BACK = 1.85;
const V_SIDE = 1.15;
const V_DROP = 0.22;

/**
 * Slot offsets for a Canada-goose V (index 0 = lead).
 * Even indices ride the right wing, odd the left (after lead).
 * @param {number} index
 * @returns {{ side: number, back: number, drop: number }}
 */
export function flockSlotOffset(index) {
  if (index <= 0) return { side: 0, back: 0, drop: 0 };
  const rank = Math.ceil(index / 2);
  const sideSign = index % 2 === 1 ? -1 : 1;
  return {
    side: sideSign * V_SIDE * rank,
    back: -V_BACK * rank,
    drop: -V_DROP * rank,
  };
}

/**
 * Sample an elliptical circuit over the park (XZ) with gentle altitude bob.
 * @param {number} phase radians along the path
 * @param {{
 *   centerX?: number,
 *   centerZ?: number,
 *   radiusX?: number,
 *   radiusZ?: number,
 *   altitude?: number,
 *   bobAmp?: number,
 * }} [path]
 */
export function sampleFlockPath(phase, path = {}) {
  const cx = path.centerX ?? 0;
  const cz = path.centerZ ?? 0;
  const rx = path.radiusX ?? 18;
  const rz = path.radiusZ ?? 13;
  const altitude = path.altitude ?? 14;
  const bobAmp = path.bobAmp ?? 0.55;
  const x = cx + Math.cos(phase) * rx;
  const z = cz + Math.sin(phase) * rz;
  // Tangent heading: d/dθ (cos, sin) = (-sin, cos) → yaw via atan2(x, z).
  const tx = -Math.sin(phase) * rx;
  const tz = Math.cos(phase) * rz;
  const headingYaw = Math.atan2(tx, tz);
  const y = altitude + Math.sin(phase * 2.15) * bobAmp;
  return { x, y, z, headingYaw };
}

/**
 * Canada-goose V-formation that circuits the dog park sky.
 * Always present once spawned — cinematic cam just follows the lead bird.
 */
export class DogParkGooseFlock {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   bounds?: { minX: number, maxX: number, minZ: number, maxZ: number },
   *   center?: { x: number, z: number },
   *   shellCount?: number,
   *   count?: number,
   * }} opts
   */
  constructor({
    scene,
    bounds,
    center,
    shellCount = FLOCK_SHELL_COUNT,
    count = FLOCK_COUNT,
  }) {
    this.scene = scene;
    this.bounds = bounds ?? { minX: -28, maxX: 28, minZ: -20, maxZ: 20 };
    this.shellCount = shellCount;
    this.count = Math.max(1, Math.min(9, count | 0));
    this.birds = [];
    this.ready = false;
    this._elapsed = 0;
    this._phase = Math.random() * Math.PI * 2;
    /** rad/s around the park ellipse. */
    this.angularSpeed = 0.11;
    this.path = {
      centerX: center?.x ?? ((this.bounds.minX + this.bounds.maxX) * 0.5),
      centerZ: center?.z ?? ((this.bounds.minZ + this.bounds.maxZ) * 0.5),
      radiusX: Math.min(20, (this.bounds.maxX - this.bounds.minX) * 0.38),
      radiusZ: Math.min(15, (this.bounds.maxZ - this.bounds.minZ) * 0.38),
      altitude: 13.5,
      bobAmp: 0.6,
    };
    /** Stagger wingbeat so the V doesn't flap in lockstep. */
    this._flapTimers = [];
  }

  /**
   * @param {ConstructorParameters<typeof DogParkGooseFlock>[0]} opts
   */
  static async create(opts) {
    const flock = new DogParkGooseFlock(opts);
    await flock.spawn();
    return flock;
  }

  async spawn() {
    if (this.ready) return;
    const birds = [];
    for (let i = 0; i < this.count; i += 1) {
      // Sequential await keeps GPU mesh upload bursts small at park boot.
      // eslint-disable-next-line no-await-in-loop
      const goose = await createProceduralGoose({
        breedId: 'canada-goose',
        seed: 900 + i * 17,
        shellCount: this.shellCount,
      });
      goose.animation.setAutopilot(false);
      goose.animation.setExternalRootMotion(true);
      goose.animation.setFlightAltitudeOverride(0);
      goose.animation.setBehavior(i === 0 ? 'fly_flap' : 'fly_glide');
      goose.setDetailLevel?.(1);
      this.scene.add(goose.root);
      birds.push(goose);
      this._flapTimers.push(i * 0.35);
    }
    this.birds = birds;
    this.ready = true;
    this._placeBirds(0);
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    if (!this.ready || !this.birds.length) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    this._elapsed += dt;
    this._phase += this.angularSpeed * dt;
    this._placeBirds(dt);
  }

  _placeBirds(dt) {
    const lead = sampleFlockPath(this._phase, this.path);
    _fwd.set(Math.sin(lead.headingYaw), 0, Math.cos(lead.headingYaw));
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    else _right.normalize();

    for (let i = 0; i < this.birds.length; i += 1) {
      const goose = this.birds[i];
      const slot = flockSlotOffset(i);
      _pos.set(lead.x, lead.y, lead.z)
        .addScaledVector(_right, slot.side)
        .addScaledVector(_fwd, slot.back);
      _pos.y += slot.drop;

      // Subtle wingbeat cycle: lead flaps more often; wingmen mostly glide.
      if (dt > 0) {
        this._flapTimers[i] = (this._flapTimers[i] ?? 0) - dt;
        if (this._flapTimers[i] <= 0) {
          const isLead = i === 0;
          const flap = isLead || Math.sin(this._elapsed * 1.7 + i) > 0.55;
          goose.animation.setBehavior(flap ? 'fly_flap' : 'fly_glide');
          this._flapTimers[i] = flap
            ? (isLead ? 0.55 : 0.85)
            : (1.4 + (i % 3) * 0.25);
        }
      }

      goose.animation.setRootPosition(_pos.x, _pos.y, _pos.z);
      goose.animation.setRootYaw(lead.headingYaw);
      goose.animation.setFlightAltitudeOverride(0);
      goose.update?.(dt > 0 ? dt : 1 / 60);
    }
  }

  /** Camera focus for the lead bird. */
  getLeadCameraTarget() {
    const lead = this.birds[0];
    return lead?.rig?.root ?? lead?.root ?? null;
  }

  /**
   * Motion hints for DogCameraSystem aerial follow.
   * @returns {{
   *   headingYaw: number,
   *   yawRate: number,
   *   moving: boolean,
   *   speed: number,
   *   forwardIntent: number,
   * } | null}
   */
  getLeadCameraMotion() {
    if (!this.ready || !this.birds[0]) return null;
    const sample = sampleFlockPath(this._phase, this.path);
    // Arc speed ≈ angular * radius (use average ellipse radius).
    const r = (this.path.radiusX + this.path.radiusZ) * 0.5;
    const speed = Math.abs(this.angularSpeed) * r;
    return {
      headingYaw: sample.headingYaw,
      yawRate: this.angularSpeed,
      moving: true,
      speed: Math.max(2.5, speed),
      forwardIntent: 1,
    };
  }

  snapshot() {
    const lead = this.birds[0]?.root?.position;
    return {
      ready: this.ready,
      count: this.birds.length,
      phase: this._phase,
      altitude: this.path.altitude,
      lead: lead
        ? { x: lead.x, y: lead.y, z: lead.z }
        : null,
    };
  }

  dispose() {
    for (const bird of this.birds) {
      bird.dispose?.();
    }
    this.birds = [];
    this.ready = false;
  }
}
