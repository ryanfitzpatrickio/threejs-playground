import {
  solveLocalAvoidance,
  preferredVelocity,
  gaitFromSpeed,
} from '../../../characters/dog/animalLocalAvoidance.js';

/**
 * Per-frame registry of park agents for local avoidance.
 * Controllers register preferred motion; after `solve`, they read safe velocities.
 */
export class DogParkCrowd {
  constructor() {
    /** @type {import('../../../characters/dog/animalLocalAvoidance.js').AvoidanceAgent[]} */
    this._agents = [];
    /** @type {Map<string|number, { vx: number, vz: number, speed: number }>} */
    this.results = new Map();
    this._frame = 0;
  }

  begin() {
    this._agents.length = 0;
    this.results.clear();
    this._frame += 1;
  }

  /**
   * @param {{
   *   id: string|number,
   *   x: number,
   *   z: number,
   *   dirX?: number,
   *   dirZ?: number,
   *   speed?: number,
   *   preferredVx?: number,
   *   preferredVz?: number,
   *   radius?: number,
   *   maxSpeed?: number,
   *   priority?: number,
   *   group?: string|null,
   *   vx?: number,
   *   vz?: number,
   * }} agent
   */
  register(agent) {
    if (!agent || agent.id == null) return;
    let preferredVx = agent.preferredVx;
    let preferredVz = agent.preferredVz;
    if (!Number.isFinite(preferredVx) || !Number.isFinite(preferredVz)) {
      const pref = preferredVelocity(
        agent.dirX ?? 0,
        agent.dirZ ?? 0,
        agent.speed ?? agent.maxSpeed ?? 0,
      );
      preferredVx = pref.vx;
      preferredVz = pref.vz;
    }
    this._agents.push({
      id: agent.id,
      x: agent.x,
      z: agent.z,
      vx: agent.vx ?? preferredVx,
      vz: agent.vz ?? preferredVz,
      preferredVx,
      preferredVz,
      radius: agent.radius ?? 0.34,
      maxSpeed: agent.maxSpeed ?? Math.max(0.5, agent.speed ?? 2),
      priority: agent.priority ?? 1,
      group: agent.group ?? null,
    });
  }

  /**
   * @param {number} dt
   */
  solve(dt) {
    this.results = solveLocalAvoidance(this._agents, dt, {
      timeHorizon: 1.1,
      separationBoost: 1.4,
    });
    return this.results;
  }

  /**
   * @param {string|number} id
   * @returns {{ vx: number, vz: number, speed: number } | null}
   */
  get(id) {
    return this.results.get(id) ?? null;
  }

  /**
   * Safe unit direction + gait for a registered agent.
   * @param {string|number} id
   * @param {{ trotMin?: number }} [gaitOpts]
   */
  getMotion(id, gaitOpts) {
    const v = this.get(id);
    if (!v || v.speed < 1e-4) {
      return {
        dirX: 0,
        dirZ: 0,
        speed: 0,
        ...gaitFromSpeed(0, gaitOpts),
      };
    }
    const inv = 1 / v.speed;
    return {
      dirX: v.vx * inv,
      dirZ: v.vz * inv,
      speed: v.speed,
      ...gaitFromSpeed(v.speed, gaitOpts),
    };
  }

  snapshot() {
    return {
      agents: this._agents.length,
      frame: this._frame,
    };
  }
}

export { gaitFromSpeed, preferredVelocity, solveLocalAvoidance };
