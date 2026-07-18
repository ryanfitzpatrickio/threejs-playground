import * as THREE from 'three';
import { createAaaMudParticleRenderer } from '../../../render/createAaaMudParticleRenderer.js';

export const DOG_MUD_WET_SECONDS = 6;
export const DOG_MUD_DRYING_SECONDS = 10;
export const DOG_MUD_SHED_SECONDS = 4;
export const DOG_MUD_TOTAL_SECONDS = DOG_MUD_WET_SECONDS
  + DOG_MUD_DRYING_SECONDS
  + DOG_MUD_SHED_SECONDS;
export const DOG_MUD_SPLASH_POOL_SIZE = 128;
export const DOG_MUD_FLOP_DROPLETS = 36;

const GRAVITY = 9.81;
const DRAG = 1.8;
const DECAL_LIFE = 2.5;

function clamp01(value) {
  return THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
}

function random01(seed) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x100000000;
}

function phaseAt(age, hasCoverage) {
  if (!hasCoverage || age >= DOG_MUD_TOTAL_SECONDS) return 'clean';
  if (age < DOG_MUD_WET_SECONDS) return 'wet';
  if (age < DOG_MUD_WET_SECONDS + DOG_MUD_DRYING_SECONDS) return 'drying';
  return 'shedding';
}

/**
 * Dog-park-local coat lifecycle and deterministic 128-slot splash pool.
 * The controller owns no deformation state: landed droplets are visual only.
 */
export class DogMudCoatController {
  constructor({
    uniforms,
    parent = null,
    camera = null,
    groundHeightAt = null,
    seed = 1,
  } = {}) {
    this.uniforms = uniforms ?? null;
    this.camera = camera;
    this.groundHeightAt = groundHeightAt;
    this.seed = Number(seed) || 1;
    this.lowerBase = 0;
    this.bodyBase = 0;
    this.age = DOG_MUD_TOTAL_SECONDS;
    this.elapsed = 0;
    this.cursor = 0;
    this.sequence = 0;
    this.pawDepositCount = 0;
    this.flopDepositCount = 0;
    this.burstEventCount = 0;
    this.particleEmissionCount = 0;
    this.decalDepositCount = 0;
    this.pawCoverage = new THREE.Vector4();
    this.particles = Array.from({ length: DOG_MUD_SPLASH_POOL_SIZE }, () => ({
      alive: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      lifetime: 0,
      scale: 0,
      seed: 0,
    }));
    this.decalExpiries = [];
    this.renderer = typeof document !== 'undefined' && parent
      ? createAaaMudParticleRenderer({
        poolSize: DOG_MUD_SPLASH_POOL_SIZE,
        decalCount: 96,
        decalLife: DECAL_LIFE,
        parent,
        name: 'Dog Park Mud Splashes',
      })
      : null;
    this._syncUniforms();
  }

  _coverageFactor() {
    const shedStart = DOG_MUD_WET_SECONDS + DOG_MUD_DRYING_SECONDS;
    if (this.age < shedStart) return 1;
    return clamp01(1 - (this.age - shedStart) / DOG_MUD_SHED_SECONDS);
  }

  _currentCoverage() {
    const factor = this._coverageFactor();
    return {
      lower: this.lowerBase * factor,
      body: this.bodyBase * factor,
      factor,
    };
  }

  _prepareDeposit() {
    const current = this._currentCoverage();
    this.lowerBase = current.lower;
    this.bodyBase = current.body;
    if (current.factor < 1) this.pawCoverage.multiplyScalar(current.factor);
    this.age = 0;
  }

  depositPawMud({
    pawName = 'PawL',
    intensity = 0.5,
    x = 0,
    y = 0.08,
    z = 0,
    headingX = 0,
    headingZ = 1,
    side = 0,
    scale = 1,
  } = {}) {
    const strength = clamp01(intensity);
    this._prepareDeposit();
    this.lowerBase = Math.min(1, this.lowerBase + 0.035 + strength * 0.045);
    // Sparse belly flecks accumulate during running, but cannot become a full-body coat.
    const bellyFlecks = 0.003 + strength * 0.008;
    this.bodyBase = this.bodyBase <= 0.38
      ? Math.min(0.38, this.bodyBase + bellyFlecks)
      : Math.min(1, this.bodyBase + bellyFlecks);
    const pawIndex = Math.max(0, ['PawL', 'PawR', 'HindPawL', 'HindPawR'].indexOf(pawName));
    this.pawCoverage.setComponent(
      pawIndex,
      Math.min(1, this.pawCoverage.getComponent(pawIndex) + 0.18 + strength * 0.22),
    );
    this.pawDepositCount += 1;
    for (let index = 0; index < 2; index += 1) {
      const salt = this._nextSalt(index);
      const lateral = (random01(salt + 13) - 0.5) * (0.65 + strength * 0.5);
      this._spawnParticle({
        x: x + side * 0.025 * scale,
        y: y + 0.025 * scale,
        z,
        vx: headingX * (0.35 + strength * 0.65) + lateral,
        vy: 0.65 + strength * 0.9 + random01(salt + 29) * 0.35,
        vz: headingZ * (0.35 + strength * 0.65) - lateral * 0.35,
        lifetime: 0.35 + random01(salt + 47) * 0.3,
        scale: (0.035 + random01(salt + 61) * 0.035) * scale,
        seed: random01(salt + 79),
      });
    }
    this._syncUniforms();
    return true;
  }

  depositFlopMud({ position = null, headingX = 0, headingZ = 1, scale = 1 } = {}) {
    this._prepareDeposit();
    this.lowerBase = Math.max(this.lowerBase, 0.92);
    this.bodyBase = Math.max(this.bodyBase, 0.85);
    this.pawCoverage.set(1, 1, 1, 1);
    this.flopDepositCount += 1;
    this.burstEventCount += 1;
    const x = position?.x ?? 0;
    const y = (position?.y ?? 0) + 0.2 * scale;
    const z = position?.z ?? 0;
    const headingLength = Math.hypot(headingX, headingZ) || 1;
    const hx = headingX / headingLength;
    const hz = headingZ / headingLength;
    for (let index = 0; index < DOG_MUD_FLOP_DROPLETS; index += 1) {
      const salt = this._nextSalt(index);
      const angle = index * 2.399963229728653 + random01(salt + 11) * 0.32;
      const radial = 0.65 + random01(salt + 23) * 2.1;
      const directional = (random01(salt + 31) - 0.25) * 0.8;
      this._spawnParticle({
        x: x + Math.cos(angle) * 0.08 * scale,
        y: y + random01(salt + 41) * 0.18 * scale,
        z: z + Math.sin(angle) * 0.08 * scale,
        vx: (Math.cos(angle) * radial + hx * directional) * scale,
        vy: (1.15 + random01(salt + 53) * 2.25) * scale,
        vz: (Math.sin(angle) * radial + hz * directional) * scale,
        lifetime: 0.5 + random01(salt + 67) * 0.3,
        scale: (0.045 + random01(salt + 83) * 0.075) * scale,
        seed: random01(salt + 97),
      });
    }
    this._syncUniforms();
    return true;
  }

  _nextSalt(index) {
    const salt = (this.seed * 2654435761 + this.sequence * 2246822519 + index * 3266489917) >>> 0;
    this.sequence += 1;
    return salt;
  }

  _spawnParticle(values) {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % DOG_MUD_SPLASH_POOL_SIZE;
    Object.assign(this.particles[slot], values, { alive: true, age: 0 });
    this.particleEmissionCount += 1;
  }

  update(delta, { camera = this.camera } = {}) {
    const dt = Math.max(0, Number(delta) || 0);
    this.elapsed += dt;
    if (this.lowerBase > 0 || this.bodyBase > 0) {
      this.age = Math.min(DOG_MUD_TOTAL_SECONDS, this.age + dt);
      if (this.age >= DOG_MUD_TOTAL_SECONDS) {
        this.lowerBase = 0;
        this.bodyBase = 0;
        this.pawCoverage.set(0, 0, 0, 0);
      }
    }
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(remaining, 1 / 30);
      this._updateParticles(step);
      remaining -= step;
    }
    this.decalExpiries = this.decalExpiries.filter((expiry) => expiry > this.elapsed);
    this._syncUniforms();
    this.renderer?.update?.({ camera, elapsedTime: this.elapsed });
  }

  _updateParticles(dt) {
    const drag = Math.exp(-DRAG * dt);
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index];
      if (!particle.alive) continue;
      particle.age += dt;
      particle.vy -= GRAVITY * dt;
      particle.vx *= drag;
      particle.vy *= drag;
      particle.vz *= drag;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const floorY = this.groundHeightAt?.(particle.x, particle.z, particle.y) ?? 0.055;
      if (particle.y <= floorY && particle.vy < 0) {
        if (((particle.seed * 65535) | 0) % 3 !== 0) {
          const rotation = particle.seed * Math.PI * 2;
          this.renderer?.spawnDecal?.(particle.x, floorY + 0.006, particle.z, this.elapsed, {
            scale: particle.scale * (1.5 + particle.seed),
            rotation,
            seed: particle.seed,
          });
          this.decalExpiries.push(this.elapsed + DECAL_LIFE);
          this.decalDepositCount += 1;
        }
        this._hideParticle(index);
        continue;
      }
      if (particle.age >= particle.lifetime) {
        this._hideParticle(index);
        continue;
      }
      this.renderer?.writeParticle?.(index, {
        x: particle.x,
        y: particle.y,
        z: particle.z,
        vx: particle.vx,
        vy: particle.vy,
        vz: particle.vz,
        life01: clamp01(particle.age / particle.lifetime),
        scale: particle.scale,
        seed: particle.seed,
      });
    }
  }

  _hideParticle(index) {
    this.particles[index].alive = false;
    this.renderer?.hideParticle?.(index);
  }

  _syncUniforms() {
    if (!this.uniforms) return;
    const snapshot = this.snapshot();
    if (this.uniforms.mudLowerCoverage) this.uniforms.mudLowerCoverage.value = snapshot.lowerCoverage;
    if (this.uniforms.mudBodyCoverage) this.uniforms.mudBodyCoverage.value = snapshot.bodyCoverage;
    if (this.uniforms.mudWetness) this.uniforms.mudWetness.value = snapshot.wetness;
    if (this.uniforms.mudDryness) this.uniforms.mudDryness.value = snapshot.dryness;
    this.uniforms.mudPawCoverage?.value?.copy?.(this.pawCoverage)?.multiplyScalar?.(this._coverageFactor());
  }

  snapshot() {
    const coverage = this._currentCoverage();
    const hasCoverage = coverage.lower > 1e-5 || coverage.body > 1e-5;
    const phase = phaseAt(this.age, hasCoverage);
    let wetness = 0;
    let dryness = 0;
    if (phase === 'wet') wetness = 1;
    else if (phase === 'drying') {
      dryness = clamp01((this.age - DOG_MUD_WET_SECONDS) / DOG_MUD_DRYING_SECONDS);
      wetness = 1 - dryness;
    } else if (phase === 'shedding') dryness = 1;
    return {
      lowerCoverage: coverage.lower,
      bodyCoverage: coverage.body,
      wetness,
      dryness,
      phase,
      age: hasCoverage ? this.age : 0,
      particleCount: this.particles.reduce((count, particle) => count + (particle.alive ? 1 : 0), 0),
      decalCount: this.decalExpiries.length,
      pawDepositCount: this.pawDepositCount,
      flopDepositCount: this.flopDepositCount,
      burstEventCount: this.burstEventCount,
      particleEmissionCount: this.particleEmissionCount,
    };
  }

  reset() {
    this.lowerBase = 0;
    this.bodyBase = 0;
    this.age = DOG_MUD_TOTAL_SECONDS;
    this.pawCoverage.set(0, 0, 0, 0);
    this.decalExpiries.length = 0;
    this.pawDepositCount = 0;
    this.flopDepositCount = 0;
    this.burstEventCount = 0;
    this.particleEmissionCount = 0;
    this.decalDepositCount = 0;
    this.cursor = 0;
    this.sequence = 0;
    for (let index = 0; index < this.particles.length; index += 1) this._hideParticle(index);
    this._syncUniforms();
  }

  dispose() {
    this.reset();
    this.renderer?.dispose?.();
    this.renderer = null;
  }
}
