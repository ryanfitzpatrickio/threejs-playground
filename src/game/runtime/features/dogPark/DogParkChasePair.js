import * as THREE from 'three';
import { createProceduralDog } from '../../../characters/dog/createProceduralDog.js';
import { DogClipPlayer, animalUsesDogClipLibrary } from '../../../characters/dog/DogClipPlayer.js';
import { plantDogFeet } from '../../../characters/dog/dogFootPlant.js';
import { pickFurDetailLevel } from '../../../characters/dog/dogFurLod.js';
import { gaitFromSpeed, preferredVelocity, advanceLocomotionSpeed } from '../../../characters/dog/animalLocalAvoidance.js';

const desired = new THREE.Vector3();
const bodyForward = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const candidate = new THREE.Vector3();
const flee = new THREE.Vector3();
const wander = new THREE.Vector3();
const groundProbe = new THREE.Vector3();

/** Fixed cast: golden always chases grey squirrel, never quite catches. */
export const CHASE_DOG_BREED = 'golden-retriever';
export const CHASE_SQUIRREL_BREED = 'grey-squirrel';
export const CHASE_PAIR_COUNT = 2;

/** Soft band: dog gets close (≈1.4–2.2 m), squirrel always keeps a gap. */
const MIN_GAP = 1.4;
const COMFORT_GAP = 2.15;
const MAX_GAP = 7.5;

const SURFACE_SPEED = Object.freeze({
  grass: 1,
  dirt: 1,
  sand: 0.82,
  mud: 0.64,
  water: 0.55,
  wood: 0.9,
});

function hashSeed(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Pure helpers (testable without Three) — speed scale so the pursuer closes
 * when far and the lead pulls away when near, never collapsing below minGap
 * under equal time steps when both move toward/away optimally.
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Multipliers on each actor's baseSpeed. The golden is a touch faster overall;
 * the squirrel only outruns it when the gap is tight (panic zip).
 */
export function chaseSpeedScales(distance, {
  minGap = MIN_GAP,
  comfortGap = COMFORT_GAP,
  maxGap = MAX_GAP,
} = {}) {
  const d = Number.isFinite(distance) ? distance : comfortGap;
  if (d <= minGap) {
    // Panic: squirrel pulls hard; dog overshoots / scrambles.
    return { leader: 1.55, pursuer: 0.92 };
  }
  if (d >= maxGap) {
    // Stretch: dog closes the lane.
    return { leader: 0.78, pursuer: 1.16 };
  }
  if (d < comfortGap) {
    const t = (d - minGap) / Math.max(1e-4, comfortGap - minGap);
    return {
      leader: lerp(1.55, 1.06, t),
      pursuer: lerp(0.92, 1.02, t),
    };
  }
  const t = (d - comfortGap) / Math.max(1e-4, maxGap - comfortGap);
  return {
    leader: lerp(1.06, 0.78, t),
    pursuer: lerp(1.02, 1.16, t),
  };
}

/**
 * Golden retriever forever chasing a grey squirrel around the park.
 * The dog closes when the squirrel is far; the squirrel accelerates when
 * the dog gets close. Hard separation keeps a visible near-miss gap.
 */
export class DogParkChasePair {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   levelSystem: object,
   *   bounds?: object,
   *   spawnPoint?: { x: number, y?: number, z: number },
   *   shellCount?: number,
   * }} opts
   */
  constructor({
    scene,
    levelSystem,
    bounds,
    spawnPoint,
    shellCount = 2,
  }) {
    this.scene = scene;
    this.levelSystem = levelSystem;
    this.bounds = bounds ?? {
      minX: -28, maxX: 28, minZ: -20, maxZ: 20,
    };
    this.actors = [];
    this.squirrelTarget = null;
    this.targetTimer = 0;
    this._elapsed = 0;

    const originX = spawnPoint?.x ?? 0;
    const originZ = spawnPoint?.z ?? 0;

    // Squirrel starts ahead toward the lake / open lawn; dog starts a few metres back.
    const squirrel = this._spawnActor({
      breedId: CHASE_SQUIRREL_BREED,
      seed: hashSeed(`${CHASE_SQUIRREL_BREED}:chase`),
      shellCount,
      x: originX + 6.5,
      z: originZ + 3.5,
      yaw: 0.4,
      role: 'leader',
    });
    const dog = this._spawnActor({
      breedId: CHASE_DOG_BREED,
      seed: hashSeed(`${CHASE_DOG_BREED}:chase`),
      shellCount,
      x: originX + 3.2,
      z: originZ + 1.8,
      yaw: 0.55,
      role: 'pursuer',
    });

    this.squirrel = squirrel;
    this.dog = dog;
    this.actors = [squirrel, dog];
    /** @type {import('./DogParkNav.js').DogParkNav | null} */
    this.nav = null;
    this._crowdPrefs = null;
    this._pickSquirrelTarget(true);
  }

  _spawnActor({ breedId, seed, shellCount, x, z, yaw, role }) {
    const animal = createProceduralDog({
      breedId,
      seed,
      shellCount,
      budget: 'npc',
    });
    animal.setShowFur(true);
    animal.setDetailLevel(1);

    const groundY = this.levelSystem.getGroundHeightAt(
      { x, y: 0, z },
      0.3,
      { maxStepUp: 2, maxSnapDown: 4 },
    );
    animal.root.position.set(x, Number.isFinite(groundY) ? groundY : 0, z);
    animal.animation.setRootYaw(yaw);
    animal.animation.setAutopilot(false);
    animal.animation.setExternalRootMotion(true);
    this.scene.add(animal.root);

    const scale = animal.phenotype?.skeleton?.scale ?? 1;
    const clipPlayer = animalUsesDogClipLibrary(animal)
      ? new DogClipPlayer(animal)
      : null;
    if (clipPlayer) void clipPlayer.initialize();

    return {
      animal,
      clipPlayer,
      role,
      breedId,
      radius: THREE.MathUtils.clamp(0.34 * scale, 0.14, 0.52),
      height: THREE.MathUtils.clamp(0.92 * scale, 0.35, 1.35),
      // Dog slightly faster; squirrel wins only via panic scale when close.
      baseSpeed: role === 'leader' ? 3.25 : 3.45,
      surfaceClass: 'grass',
      detailLevel: 1,
      // Accel/decel-ramped speed (m/s) + hysteresis gait latch, see _stepActor.
      currentSpeed: 0,
      lastGait: false,
    };
  }

  /**
   * Optional nav helper (set by NpcSystem) for walkable goals + path steering.
   * @param {import('./DogParkNav.js').DogParkNav | null} nav
   */
  setNav(nav) {
    this.nav = nav ?? null;
  }

  _pickSquirrelTarget(force = false) {
    if (!force && this.targetTimer > 0 && this.squirrelTarget) return;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const lake = this.levelSystem.level?.lake;
    const dogPos = this.dog?.animal?.root?.position;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // Prefer targets roughly away from the dog so the chase keeps circulating.
      const angle = dogPos
        ? Math.atan2(dogPos.x - (this.squirrel?.animal.root.position.x ?? 0), dogPos.z - (this.squirrel?.animal.root.position.z ?? 0))
          + Math.PI
          + randRange(-0.85, 0.85)
        : randRange(0, Math.PI * 2);
      const dist = randRange(7, 16);
      const sx = this.squirrel?.animal.root.position.x ?? 0;
      const sz = this.squirrel?.animal.root.position.z ?? 0;
      let x = THREE.MathUtils.clamp(sx + Math.sin(angle) * dist, minX + 2.5, maxX - 2.5);
      let z = THREE.MathUtils.clamp(sz + Math.cos(angle) * dist, minZ + 2.5, maxZ - 2.5);
      if (lake) {
        const dx = (x - lake.x) / (lake.radiusX + 1.2);
        const dz = (z - lake.z) / (lake.radiusZ + 1.2);
        if (dx * dx + dz * dz < 1) continue;
      }
      // Prefer navmesh-walkable goals when available.
      if (this.nav) {
        if (!this.nav.isWalkable(x, z)) {
          const projected = this.nav.project(x, z);
          if (!projected.ok) continue;
          x = projected.x;
          z = projected.z;
        }
      }
      this.squirrelTarget = { x, z };
      this.targetTimer = randRange(2.4, 4.8);
      return;
    }
    if (this.nav) {
      this.squirrelTarget = this.nav.randomPoint(() => Math.random(), 2.5);
    } else {
      this.squirrelTarget = {
        x: randRange(minX + 2.5, maxX - 2.5),
        z: randRange(minZ + 2.5, maxZ - 2.5),
      };
    }
    this.targetTimer = randRange(2.4, 4.8);
  }

  /**
   * Preferred chase velocities for the park crowd solver (group='chase' so the
   * pair ignores each other — gap logic stays authored).
   * @param {import('./DogParkCrowd.js').DogParkCrowd} crowd
   */
  registerCrowd(crowd) {
    if (!crowd || !this.squirrel || !this.dog) return;
    const prefs = this._computePreferred();
    if (!prefs) return;
    const sPos = this.squirrel.animal.root.position;
    const dPos = this.dog.animal.root.position;
    const sPref = preferredVelocity(prefs.squirrelDir.x, prefs.squirrelDir.z, prefs.squirrelSpeed);
    const dPref = preferredVelocity(prefs.dogDir.x, prefs.dogDir.z, prefs.dogSpeed);
    crowd.register({
      id: 'chase-squirrel',
      x: sPos.x,
      z: sPos.z,
      preferredVx: sPref.vx,
      preferredVz: sPref.vz,
      radius: this.squirrel.radius,
      maxSpeed: prefs.squirrelSpeed,
      priority: 1.1,
      group: 'chase',
    });
    crowd.register({
      id: 'chase-dog',
      x: dPos.x,
      z: dPos.z,
      preferredVx: dPref.vx,
      preferredVz: dPref.vz,
      radius: this.dog.radius,
      maxSpeed: prefs.dogSpeed,
      priority: 1.0,
      group: 'chase',
    });
    this._crowdPrefs = prefs;
  }

  /**
   * @returns {{
   *   squirrelDir: THREE.Vector3,
   *   dogDir: THREE.Vector3,
   *   squirrelSpeed: number,
   *   dogSpeed: number,
   *   dist: number,
   * } | null}
   */
  _computePreferred() {
    if (!this.squirrel || !this.dog) return null;
    const sPos = this.squirrel.animal.root.position;
    const dPos = this.dog.animal.root.position;
    let dist = Math.hypot(sPos.x - dPos.x, sPos.z - dPos.z);

    if (dist < MIN_GAP * 0.92) {
      const nx = dist > 1e-4 ? (sPos.x - dPos.x) / dist : 1;
      const nz = dist > 1e-4 ? (sPos.z - dPos.z) / dist : 0;
      sPos.x = dPos.x + nx * MIN_GAP;
      sPos.z = dPos.z + nz * MIN_GAP;
      this._clampToBounds(sPos);
      dist = MIN_GAP;
      this._pickSquirrelTarget(true);
    }

    const scales = chaseSpeedScales(dist);
    this._pickSquirrelTarget(dist < COMFORT_GAP && this.targetTimer < 0.6);
    const target = this.squirrelTarget ?? { x: sPos.x + 1, z: sPos.z };

    // Path-follow wander when nav is ready; else straight line to target.
    if (this.nav?.ready) {
      const steer = this.nav.steerTo(
        'chase-squirrel',
        { x: sPos.x, z: sPos.z },
        target,
      );
      if (steer.arrived || !steer.ok) this._pickSquirrelTarget(true);
      if (steer.ok && !steer.arrived) wander.set(steer.dirX, 0, steer.dirZ);
      else wander.set(target.x - sPos.x, 0, target.z - sPos.z);
    } else {
      wander.set(target.x - sPos.x, 0, target.z - sPos.z);
    }
    if (wander.lengthSq() < 0.35) this._pickSquirrelTarget(true);
    if (wander.lengthSq() > 1e-6) wander.normalize();
    else wander.set(1, 0, 0);

    flee.set(sPos.x - dPos.x, 0, sPos.z - dPos.z);
    if (flee.lengthSq() > 1e-6) flee.normalize();
    else flee.set(-wander.x, 0, -wander.z);

    const fleeWeight = dist < COMFORT_GAP
      ? THREE.MathUtils.lerp(0.85, 0.45, (dist - MIN_GAP) / Math.max(1e-4, COMFORT_GAP - MIN_GAP))
      : THREE.MathUtils.lerp(0.45, 0.2, Math.min(1, (dist - COMFORT_GAP) / (MAX_GAP - COMFORT_GAP)));
    desired.copy(flee).multiplyScalar(fleeWeight).addScaledVector(wander, 1 - fleeWeight);
    const weave = Math.sin(this._elapsed * 2.1) * 0.22;
    const wx = desired.x;
    const wz = desired.z;
    desired.set(wx - wz * weave, 0, wz + wx * weave);
    if (desired.lengthSq() > 1e-6) desired.normalize();
    else desired.copy(wander);

    const squirrelDir = desired.clone();
    // Pursuer: path around obstacles toward live squirrel position.
    let dogDir = new THREE.Vector3(sPos.x - dPos.x, 0, sPos.z - dPos.z);
    if (this.nav?.ready) {
      const dogSteer = this.nav.steerTo(
        'chase-dog',
        { x: dPos.x, z: dPos.z },
        { x: sPos.x, z: sPos.z },
        { force: true },
      );
      if (dogSteer.ok && !dogSteer.arrived) {
        dogDir.set(dogSteer.dirX, 0, dogSteer.dirZ);
      }
    }
    if (dogDir.lengthSq() > 1e-6) dogDir.normalize();
    else dogDir.set(1, 0, 0);

    return {
      squirrelDir,
      dogDir,
      squirrelSpeed: scales.leader * this.squirrel.baseSpeed,
      dogSpeed: scales.pursuer * this.dog.baseSpeed,
      dist,
    };
  }

  /**
   * @param {number} delta
   * @param {{
   *   camera?: THREE.Camera | null,
   *   lodFrame?: number,
   *   crowd?: import('./DogParkCrowd.js').DogParkCrowd | null,
   *   skipFurDynamics?: boolean,
   *   skipClips?: boolean,
   * }} [opts]
   */
  update(delta, opts = {}) {
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    if (!this.squirrel || !this.dog) return;
    this._elapsed += dt;
    this.targetTimer -= dt;

    const prefs = this._crowdPrefs ?? this._computePreferred();
    this._crowdPrefs = null;
    if (!prefs) return;

    const sPos = this.squirrel.animal.root.position;
    const dPos = this.dog.animal.root.position;

    // Prefer crowd-safe velocity (avoids cats / player); fall back to preferred.
    // Copy into plain components so _stepActor temp vectors don't clobber dirs.
    const sMotion = opts.crowd?.getMotion?.('chase-squirrel', { trotMin: 2.2 });
    const dMotion = opts.crowd?.getMotion?.('chase-dog', { trotMin: 2.4 });
    const sDir = {
      x: sMotion?.speed > 0.05 ? sMotion.dirX : prefs.squirrelDir.x,
      z: sMotion?.speed > 0.05 ? sMotion.dirZ : prefs.squirrelDir.z,
    };
    const dDir = {
      x: dMotion?.speed > 0.05 ? dMotion.dirX : prefs.dogDir.x,
      z: dMotion?.speed > 0.05 ? dMotion.dirZ : prefs.dogDir.z,
    };
    const sSpeed = sMotion?.speed > 0.05 ? sMotion.speed : prefs.squirrelSpeed;
    const dSpeed = dMotion?.speed > 0.05 ? dMotion.speed : prefs.dogSpeed;

    this._stepActor(this.squirrel, sDir, sSpeed, dt, opts);
    this._stepActor(this.dog, dDir, dSpeed, dt, opts);

    // Re-assert gap after both moved (dog cannot land inside the squirrel).
    const distAfter = Math.hypot(sPos.x - dPos.x, sPos.z - dPos.z);
    if (distAfter < MIN_GAP) {
      const nx = distAfter > 1e-4 ? (sPos.x - dPos.x) / distAfter : 1;
      const nz = distAfter > 1e-4 ? (sPos.z - dPos.z) / distAfter : 0;
      dPos.x = sPos.x - nx * MIN_GAP;
      dPos.z = sPos.z - nz * MIN_GAP;
      this._clampToBounds(dPos);
    }
  }

  _stepActor(actor, dir, speed, dt, opts) {
    const animal = actor.animal;
    const position = animal.root.position;
    let dirX = Number(dir?.x) || 0;
    let dirZ = Number(dir?.z) || 0;
    const dirLen = dirX * dirX + dirZ * dirZ;
    const moving = speed > 0.05 && dirLen > 1e-6;
    if (moving && dirLen > 1e-6) {
      const inv = 1 / Math.sqrt(dirLen);
      dirX *= inv;
      dirZ *= inv;
    }
    // Accel-clamped ramp toward the commanded (ORCA/chase-gap) speed — real
    // momentum instead of an instant snap; also what gait/distance read below.
    const targetSpeed = moving ? speed : 0;
    actor.currentSpeed = advanceLocomotionSpeed(actor.currentSpeed, targetSpeed, dt, { accel: 7, decel: 10 });

    // Velocity → gait: trot when fast enough, else walk (not a hard speed
    // flag). Hysteresis (wasTrot) keeps the ORCA-solved speed from chattering
    // walk/trot every tick near the threshold.
    const trotMin = actor.role === 'leader' ? 2.2 : 2.4;
    const gait = gaitFromSpeed(actor.currentSpeed, { trotEnter: trotMin, wasTrot: actor.lastGait });
    actor.lastGait = gait.gait === 'trot';
    const sprint = gait.sprint;

    animal.animation.setMoveIntent({
      x: moving ? dirX : 0,
      z: moving ? dirZ : 0,
      moving: gait.moving,
      sprint,
      sit: false,
      look: false,
      speedMps: actor.currentSpeed,
    });

    const dogYaw = animal.animation.getRootYaw();
    bodyForward.set(Math.sin(dogYaw), 0, Math.cos(dogYaw));

    if (moving) {
      // Intentionally ignore phenotype.speed — chase gap is authored in baseSpeed
      // + chaseSpeedScales so a zippy squirrel catalog entry can't break the near-miss.
      const surfaceSpeed = SURFACE_SPEED[actor.surfaceClass] ?? 1;
      desired.set(dirX, 0, dirZ);
      const align = THREE.MathUtils.clamp(bodyForward.dot(desired), -1, 1);
      const turnSlow = THREE.MathUtils.lerp(0.62, 1, THREE.MathUtils.smoothstep(align, -0.2, 0.85));
      moveDir.copy(bodyForward).multiplyScalar(0.72).addScaledVector(desired, 0.28);
      if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
      else moveDir.copy(bodyForward);
      const distance = actor.currentSpeed * surfaceSpeed * turnSlow * dt;
      candidate.copy(position).addScaledVector(moveDir, distance);
      this._moveWithCollision(actor, position, candidate);
    }

    this._clampToBounds(position);

    const sampledGround = this.levelSystem.getGroundHeightAt(position, actor.radius, {
      maxStepUp: 0.48,
      maxSnapDown: 1.2,
      requiredInset: Math.min(actor.radius * 0.35, 0.12),
    });
    let floorY = Number.isFinite(sampledGround) ? sampledGround : position.y;
    const water = this.levelSystem.level?.getWaterHeightAt?.(position);
    if ((water?.weight ?? 0) > 0) {
      floorY = Math.max(floorY, water.waterY - 0.18 * water.weight);
    }
    position.y = floorY;
    actor.surfaceClass = this.levelSystem.level?.getSurfaceAt?.(position.x, position.z) ?? actor.surfaceClass;

    const sampleGround = (x, z) => {
      groundProbe.set(x, position.y, z);
      const y = this.levelSystem.getGroundHeightAt(groundProbe, actor.radius * 0.45, {
        maxStepUp: 0.48,
        maxSnapDown: 1.2,
        requiredInset: Math.min(actor.radius * 0.25, 0.1),
      });
      if (!Number.isFinite(y)) return floorY;
      if ((water?.weight ?? 0) > 0) return Math.max(y, water.waterY - 0.18 * water.weight);
      return y;
    };

    const useClips = !opts.skipClips && Boolean(actor.clipPlayer?.ready);
    animal.animation?.setClipDriven?.(useClips);
    animal.update(dt, {
      fixed: false,
      skipFurDynamics: Boolean(opts.skipFurDynamics),
      plantFeet: Boolean(opts.skipClips) || !useClips,
      getGroundHeight: sampleGround,
    });
    if (useClips) {
      actor.clipPlayer.update(dt, animal.animation.getBehavior());
      animal.animation?.applyPostClipOverlays?.();
      plantDogFeet(animal, { getGroundHeight: sampleGround });
    }
  }

  _moveWithCollision(actor, position, target) {
    const targetX = target.x;
    const targetZ = target.z;
    const blocked = (point) => this.levelSystem.getBlockingColliderAt({
      position: point,
      radius: actor.radius,
      feetY: position.y,
      height: actor.height,
      stepHeight: 0.32,
    });
    if (!blocked(target)) {
      position.x = target.x;
      position.z = target.z;
      return;
    }
    candidate.set(targetX, position.y, position.z);
    if (!blocked(candidate)) position.x = targetX;
    candidate.set(position.x, position.y, targetZ);
    if (!blocked(candidate)) position.z = targetZ;
    else if (actor.role === 'leader') {
      // Bump into a fence: pick a fresh flee target.
      this.targetTimer = 0;
    }
  }

  _clampToBounds(position) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const pad = 2.2;
    position.x = THREE.MathUtils.clamp(position.x, minX + pad, maxX - pad);
    position.z = THREE.MathUtils.clamp(position.z, minZ + pad, maxZ - pad);
  }

  /**
   * @param {THREE.Camera | null} camera
   * @param {number} lodFrame 0..2 stagger index
   */
  updateLod(camera, lodFrame) {
    if (!camera) return;
    camera.getWorldPosition(groundProbe);
    for (let i = 0; i < this.actors.length; i += 1) {
      if ((i % 3) !== (lodFrame % 3)) continue;
      const actor = this.actors[i];
      actor.animal.root.getWorldPosition(candidate);
      const dist = candidate.distanceTo(groundProbe);
      const level = pickFurDetailLevel(dist, actor.detailLevel);
      if (level !== actor.detailLevel) {
        actor.detailLevel = level;
        actor.animal.setDetailLevel?.(level);
      }
    }
  }

  /** Orbit focus for cinematic squirrel cam (`DogCameraSystem.setTarget`). */
  getSquirrelCameraTarget() {
    return this.squirrel?.animal?.rig?.root
      ?? this.squirrel?.animal?.root
      ?? null;
  }

  /**
   * Motion hints for the cinematic chase camera (heading + approximate speed).
   * @returns {{
   *   headingYaw: number,
   *   yawRate: number,
   *   moving: boolean,
   *   speed: number,
   *   forwardIntent: number,
   * } | null}
   */
  getSquirrelCameraMotion() {
    if (!this.squirrel?.animal) return null;
    const anim = this.squirrel.animal.animation;
    const headingYaw = anim?.getRootYaw?.() ?? 0;
    // Chase pair is always on the move; use a stable cinematic speed band.
    const speed = this.squirrel.baseSpeed * 0.85;
    return {
      headingYaw,
      yawRate: anim?.getYawRate?.() ?? 0,
      moving: true,
      speed,
      forwardIntent: 1,
    };
  }

  snapshot() {
    const sPos = this.squirrel?.animal?.root?.position;
    const dPos = this.dog?.animal?.root?.position;
    const distance = sPos && dPos
      ? Math.hypot(sPos.x - dPos.x, sPos.z - dPos.z)
      : null;
    return {
      active: true,
      dogBreed: CHASE_DOG_BREED,
      squirrelBreed: CHASE_SQUIRREL_BREED,
      distance,
      minGap: MIN_GAP,
      dog: this.dog ? {
        breedId: this.dog.breedId,
        position: dPos ? { x: dPos.x, y: dPos.y, z: dPos.z } : null,
      } : null,
      squirrel: this.squirrel ? {
        breedId: this.squirrel.breedId,
        position: sPos ? { x: sPos.x, y: sPos.y, z: sPos.z } : null,
      } : null,
    };
  }

  dispose() {
    for (const actor of this.actors) {
      actor.clipPlayer?.dispose?.();
      actor.animal?.dispose?.();
    }
    this.actors = [];
    this.squirrel = null;
    this.dog = null;
  }
}
