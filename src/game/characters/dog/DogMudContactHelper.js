import * as THREE from 'three';

const PAWS = Object.freeze([
  { name: 'PawL', side: -1 },
  { name: 'PawR', side: 1 },
  { name: 'HindPawL', side: -1 },
  { name: 'HindPawR', side: 1 },
]);

const pawWorld = new THREE.Vector3();
const groundProbe = new THREE.Vector3();

/**
 * Samples animated paw bones and turns grounded mud contacts into a sparse trail.
 * Call after both procedural animation and any retargeted clip mixer update.
 */
export class DogMudContactHelper {
  constructor({ dog, levelSystem, mudField, onPawStamp = null }) {
    this.levelSystem = levelSystem;
    this.mudField = mudField;
    this.onPawStamp = onPawStamp;
    this.lastStamp = new Map();
    this.elapsed = 0;
    this.setDog(dog);
  }

  setDog(dog) {
    this.dog = dog;
    this.lastStamp.clear();
    this.elapsed = 0;
  }

  update(delta, {
    moving = false,
    airborne = false,
    surfaceClass = null,
    headingX = 0,
    headingZ = 1,
    movementIntensity = 0.5,
  } = {}) {
    const dt = Math.min(Math.max(Number(delta) || 0, 0), 0.05);
    this.elapsed += dt;
    if (!this.dog || !this.mudField || !moving || airborne || surfaceClass !== 'mud') return 0;

    const scale = this.dog.phenotype?.skeleton?.scale ?? 1;
    const minSpacing = THREE.MathUtils.clamp(0.105 * scale, 0.065, 0.16);
    const groundTolerance = THREE.MathUtils.clamp(0.105 * scale, 0.075, 0.16);
    let stamped = 0;
    this.dog.rig?.root?.updateMatrixWorld?.(true);

    for (const paw of PAWS) {
      const bone = this.dog.rig?.bonesByName?.get?.(paw.name);
      if (!bone) continue;
      bone.getWorldPosition(pawWorld);
      const pawSurface = this.levelSystem.level?.getSurfaceAt?.(pawWorld.x, pawWorld.z) ?? surfaceClass;
      if (pawSurface !== 'mud') continue;
      groundProbe.set(pawWorld.x, pawWorld.y, pawWorld.z);
      const groundY = this.levelSystem.getGroundHeightAt?.(groundProbe, 0.035, {
        maxStepUp: 0.25,
        maxSnapDown: 0.5,
      });
      if (!Number.isFinite(groundY) || Math.abs(pawWorld.y - groundY) > groundTolerance) continue;

      const previous = this.lastStamp.get(paw.name);
      if (previous) {
        const distance = Math.hypot(pawWorld.x - previous.x, pawWorld.z - previous.z);
        if (distance < minSpacing || this.elapsed - previous.time < 0.075) continue;
      }

      const id = this.mudField.stampDogPaw(pawWorld.x, pawWorld.z, {
        depth: THREE.MathUtils.clamp(0.07 * scale, 0.04, 0.09),
        wetness: 0.9,
        tread: 0.86,
        directionX: headingX,
        directionZ: headingZ,
        side: paw.side,
      });
      if (!id) continue;
      this.onPawStamp?.({
        pawName: paw.name,
        x: pawWorld.x,
        y: pawWorld.y,
        z: pawWorld.z,
        headingX,
        headingZ,
        side: paw.side,
        scale,
        intensity: THREE.MathUtils.clamp(Number(movementIntensity) || 0, 0, 1),
      });
      this.lastStamp.set(paw.name, { x: pawWorld.x, z: pawWorld.z, time: this.elapsed });
      stamped += 1;
    }
    return stamped;
  }

  resetTrailGate() {
    this.lastStamp.clear();
  }
}

export const DOG_MUD_PAW_NAMES = PAWS.map((paw) => paw.name);
