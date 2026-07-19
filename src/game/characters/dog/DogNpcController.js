import * as THREE from 'three';
import { DogMudContactHelper } from './DogMudContactHelper.js';
import { DogClipPlayer, animalUsesDogClipLibrary } from './DogClipPlayer.js';
import { plantDogFeet } from './dogFootPlant.js';

const desired = new THREE.Vector3();
const bodyForward = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const candidate = new THREE.Vector3();

const SURFACE_SPEED = Object.freeze({
  grass: 1,
  dirt: 1,
  sand: 0.82,
  mud: 0.64,
  water: 0.55,
  wood: 0.9,
});

export const NPC_STATE_SIT = 'sit';
export const NPC_STATE_WANDER = 'wander';
export const NPC_STATE_MUD = 'mud';

const STATE_WEIGHTS = { [NPC_STATE_SIT]: 0.34, [NPC_STATE_WANDER]: 0.44, [NPC_STATE_MUD]: 0.22 };

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function pickWeightedState(exclude, hasMudPatches) {
  const keys = Object.keys(STATE_WEIGHTS).filter((key) => (
    key !== exclude && (key !== NPC_STATE_MUD || hasMudPatches)
  ));
  const total = keys.reduce((sum, key) => sum + STATE_WEIGHTS[key], 0);
  let roll = Math.random() * total;
  for (const key of keys) {
    roll -= STATE_WEIGHTS[key];
    if (roll <= 0) return key;
  }
  return keys[keys.length - 1];
}

/**
 * Simple wander/sit/mud-play AI for park NPC dogs. Reuses the same kinematic
 * ground-follow + collision approach as DogPlayerController, but steers
 * toward chosen AI targets instead of camera-relative input.
 */
export class DogNpcController {
  constructor({ dog, levelSystem, mudField, bounds, mudPatches = [], onFlop = null, onPawStamp = null }) {
    this.dog = dog;
    this.levelSystem = levelSystem;
    this.bounds = bounds;
    this.mudPatches = mudPatches;
    this.onFlop = onFlop;
    this.radius = THREE.MathUtils.clamp(0.34 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.22, 0.52);
    this.height = THREE.MathUtils.clamp(0.92 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.62, 1.35);
    this.surfaceClass = 'grass';
    this.state = NPC_STATE_SIT;
    this.stateTimer = 0;
    this.target = null;
    this.sprint = false;
    this.hasFlopped = false;

    this.pawHelper = mudField
      ? new DogMudContactHelper({ dog, levelSystem, mudField, onPawStamp })
      : null;

    // Same retargeted mocap clips the player dog uses (Walk/Run/Sit/Idle Alert)
    // — the library is fetched once and cached, so this is just another cheap
    // AnimationMixer over already-loaded clips, not extra network/parse cost.
    // Applies to felines/procyonids on the shared dog skeleton as well.
    this.clipPlayer = null;
    if (animalUsesDogClipLibrary(dog)) {
      this.clipPlayer = new DogClipPlayer(dog);
      void this.clipPlayer.initialize();
    }

    dog.animation.setAutopilot(false);
    dog.animation.setExternalRootMotion(true);
    // Stagger starting states/timers so 25 dogs don't all sync-flip together.
    this._enterState(pickWeightedState(null, this.mudPatches.length > 0));
    this.stateTimer = randRange(0, this.stateTimer);
  }

  _enterState(state) {
    this.state = state;
    this.hasFlopped = false;
    if (state === NPC_STATE_SIT) {
      this.stateTimer = randRange(4, 9);
      this.target = null;
    } else if (state === NPC_STATE_WANDER) {
      this.stateTimer = randRange(6, 13);
      this.sprint = Math.random() < 0.45;
      this._pickWanderTarget();
    } else {
      this.stateTimer = randRange(7, 12);
      this.sprint = false;
      this._pickMudTarget();
    }
  }

  _pickWanderTarget() {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const lake = this.levelSystem.level?.lake;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const x = randRange(minX + 2.5, maxX - 2.5);
      const z = randRange(minZ + 2.5, maxZ - 2.5);
      if (lake) {
        const dx = (x - lake.x) / (lake.radiusX + 1.5);
        const dz = (z - lake.z) / (lake.radiusZ + 1.5);
        if (dx * dx + dz * dz < 1) continue;
      }
      this.target = { x, z };
      return;
    }
    this.target = { x: randRange(minX + 2.5, maxX - 2.5), z: randRange(minZ + 2.5, maxZ - 2.5) };
  }

  _pickMudTarget() {
    if (!this.mudPatches.length) {
      this._enterState(NPC_STATE_WANDER);
      return;
    }
    const patch = this.mudPatches[Math.floor(Math.random() * this.mudPatches.length)];
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.45;
    this.target = {
      x: patch.x + Math.cos(angle) * patch.radiusX * r,
      z: patch.z + Math.sin(angle) * patch.radiusZ * r,
    };
  }

  /**
   * @param {number} delta
   * @param {{ skipFurDynamics?: boolean, skipClips?: boolean }} [opts]
   */
  update(delta, opts = {}) {
    if (!this.dog) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);

    this.stateTimer -= dt;
    let moving = false;
    let sit = false;
    let sprint = false;
    const position = this.dog.root.position;

    if (this.state === NPC_STATE_SIT) {
      sit = true;
    } else {
      const dx = this.target.x - position.x;
      const dz = this.target.z - position.z;
      const dist = Math.hypot(dx, dz);
      const arriveRadius = this.state === NPC_STATE_MUD ? 0.35 : 0.65;
      if (dist < arriveRadius) {
        if (this.state === NPC_STATE_WANDER) {
          this._pickWanderTarget();
        } else if (!this.hasFlopped) {
          this.hasFlopped = true;
          const yaw = this.dog.animation.getRootYaw();
          this.onFlop?.({ position, headingX: Math.sin(yaw), headingZ: Math.cos(yaw) });
          sit = true;
        } else {
          sit = true;
        }
      } else {
        moving = true;
        sprint = this.sprint;
        desired.set(dx, 0, dz).normalize();
      }
    }

    this.dog.animation.setMoveIntent({
      x: moving ? desired.x : 0,
      z: moving ? desired.z : 0,
      moving,
      sprint,
      sit,
      look: false,
    });

    const dogYaw = this.dog.animation.getRootYaw();
    bodyForward.set(Math.sin(dogYaw), 0, Math.cos(dogYaw));

    if (moving) {
      const phenotypeSpeed = this.dog.phenotype?.motion?.speed ?? 1;
      const baseSpeed = sprint ? 3.1 : 1.55;
      const surfaceSpeed = SURFACE_SPEED[this.surfaceClass] ?? 1;
      const align = THREE.MathUtils.clamp(bodyForward.dot(desired), -1, 1);
      const turnSlow = THREE.MathUtils.lerp(0.62, 1, THREE.MathUtils.smoothstep(align, -0.2, 0.85));
      moveDir.copy(bodyForward).multiplyScalar(0.78).addScaledVector(desired, 0.22);
      if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
      else moveDir.copy(bodyForward);
      const distance = baseSpeed * phenotypeSpeed * surfaceSpeed * turnSlow * dt;
      candidate.copy(position).addScaledVector(moveDir, distance);
      this._moveWithCollision(position, candidate);
    }

    const sampledGround = this.levelSystem.getGroundHeightAt(position, this.radius, {
      maxStepUp: 0.48,
      maxSnapDown: 1.2,
      requiredInset: Math.min(this.radius * 0.35, 0.12),
    });
    let floorY = Number.isFinite(sampledGround) ? sampledGround : position.y;
    const water = this.levelSystem.level?.getWaterHeightAt?.(position);
    if ((water?.weight ?? 0) > 0) {
      floorY = Math.max(floorY, water.waterY - 0.18 * water.weight);
    }
    position.y = floorY;

    this.surfaceClass = this.levelSystem.level?.getSurfaceAt?.(position.x, position.z) ?? this.surfaceClass;

    const groundProbe = new THREE.Vector3();
    const sampleGround = (x, z) => {
      groundProbe.set(x, position.y, z);
      const y = this.levelSystem.getGroundHeightAt(groundProbe, this.radius * 0.45, {
        maxStepUp: 0.48,
        maxSnapDown: 1.2,
        requiredInset: Math.min(this.radius * 0.25, 0.1),
      });
      if (!Number.isFinite(y)) return floorY;
      if ((water?.weight ?? 0) > 0) return Math.max(y, water.waterY - 0.18 * water.weight);
      return y;
    };
    // Skeleton clips own body pose when loaded; far LODs skip mixer (procedural).
    const useClips = !opts.skipClips && Boolean(this.clipPlayer?.ready);
    this.dog.animation?.setClipDriven?.(useClips);
    // Plant once after clips (or immediately when mixer is skipped).
    this.dog.update(dt, {
      fixed: false,
      skipFurDynamics: Boolean(opts.skipFurDynamics),
      plantFeet: Boolean(opts.skipClips) || !useClips,
      getGroundHeight: sampleGround,
    });
    if (useClips) {
      this.clipPlayer.update(dt, this.dog.animation.getBehavior());
      this.dog.animation?.applyPostClipOverlays?.();
      plantDogFeet(this.dog, { getGroundHeight: sampleGround });
    }

    if (!opts.skipFurDynamics) {
      this.pawHelper?.update(dt, {
        moving,
        airborne: false,
        surfaceClass: this.surfaceClass,
        headingX: bodyForward.x,
        headingZ: bodyForward.z,
        movementIntensity: sprint ? 0.85 : 0.5,
      });
    }

    if (this.stateTimer <= 0) {
      this._enterState(pickWeightedState(this.state, this.mudPatches.length > 0));
    }
  }

  _moveWithCollision(position, target) {
    const targetX = target.x;
    const targetZ = target.z;
    const blocked = (point) => this.levelSystem.getBlockingColliderAt({
      position: point,
      radius: this.radius,
      feetY: position.y,
      height: this.height,
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
    // Both axes blocked: pick a fresh target next tick instead of stalling in place.
    else if (this.state !== NPC_STATE_SIT) this.stateTimer = Math.min(this.stateTimer, 0.4);
  }

  snapshot() {
    return {
      breedId: this.dog?.breedId ?? null,
      state: this.state,
      position: this.dog?.root?.position ? { ...this.dog.root.position } : null,
      clip: this.clipPlayer?.snapshot?.() ?? null,
    };
  }

  dispose() {
    this.clipPlayer?.dispose();
    this.clipPlayer = null;
    this.dog = null;
  }
}
