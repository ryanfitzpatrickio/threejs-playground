/**
 * Flat-ground free-roam controller for Dog Studio.
 *
 * Reuses the same camera-relative WASD feel as DogPlayerController / dog park,
 * but plants on y=0 (studio floor) and works for any animal handle:
 * dogs (setMoveIntent + outer root), birds / goose (setRootPosition world).
 */

import * as THREE from 'three';

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const bodyForward = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const prevPos = new THREE.Vector3();

function isBirdLike(animal) {
  return Boolean(
    animal?.isBird
    || animal?.phenotype?.rigKind === 'bird'
    || animal?.phenotype?.rigKind === 'goose'
    || animal?.rigKind === 'goose',
  );
}

/** Facades that rewrite outer actor TRS from rootPos (goose/cat/horse/insect). */
function ownsWorldRoot(animal) {
  if (isBirdLike(animal)) return true;
  const kind = animal?.rigKind ?? animal?.phenotype?.rigKind ?? null;
  return kind === 'cat' || kind === 'horse' || kind === 'insect';
}

/**
 * @param {{
 *   animal: object,
 *   camera: THREE.Camera,
 *   boundsRadius?: number,
 * }} opts
 */
export class StudioFreeRoamController {
  constructor({ animal, camera, boundsRadius = 6.2 }) {
    this.animal = animal;
    this.camera = camera;
    this.boundsRadius = boundsRadius;
    this.enabled = true;
    this.horizontalSpeed = 0;
    this.forwardIntent = 0;
    this.yawRate = 0;
    this._prevYaw = 0;
    this._hadPrevPos = false;
    this._hadPrevYaw = false;
    this._bindAnimal(animal);
  }

  setAnimal(animal) {
    this.animal = animal;
    this._hadPrevPos = false;
    this._hadPrevYaw = false;
    this.horizontalSpeed = 0;
    this.forwardIntent = 0;
    this.yawRate = 0;
    this._bindAnimal(animal);
  }

  _bindAnimal(animal) {
    if (!animal?.animation) return;
    animal.animation.setAutopilot?.(false);
    animal.animation.setExternalRootMotion?.(true);
  }

  /**
   * Scale-aware walk/sprint (m/s) from phenotype or bird presentation.
   * @returns {{ walk: number, sprint: number }}
   */
  _speeds() {
    const scale = this.animal?.phenotype?.skeleton?.scale
      ?? this.animal?.presentation?.scale
      ?? 1;
    const motion = this.animal?.phenotype?.motion?.speed ?? 1;
    const bird = isBirdLike(this.animal);
    const base = bird ? 0.85 : 1.85;
    const sprintMul = bird ? 1.55 : 2.1;
    const s = Math.max(0.35, scale) * motion;
    return { walk: base * s, sprint: base * sprintMul * s };
  }

  /**
   * @param {number} delta
   * @param {{
   *   moveX?: number,
   *   moveZ?: number,
   *   brace?: boolean,
   *   crouchHeld?: boolean,
   *   crouchPressed?: boolean,
   * }} [input]
   */
  update(delta, input = {}) {
    if (!this.enabled || !this.animal?.root || !this.camera) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    const anim = this.animal.animation;
    const birdLike = isBirdLike(this.animal);

    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    else forward.normalize();
    right.crossVectors(forward, this.camera.up).normalize();

    // Same basis as DogPlayerController / InputSystem:
    // moveZ = backward - forward (W → -1), so -moveZ points along camera look.
    desired.set(0, 0, 0)
      .addScaledVector(right, input.moveX ?? 0)
      .addScaledVector(forward, -(input.moveZ ?? 0));

    const inputMagnitude = Math.min(1, desired.length());
    const moving = inputMagnitude > 0.05;
    if (moving) desired.normalize();

    const sit = Boolean(input.crouchHeld || input.crouchPressed) && !moving;
    const sprint = Boolean(input.brace) && moving;

    if (typeof anim.setMoveIntent === 'function') {
      anim.setMoveIntent({
        x: moving ? desired.x : 0,
        z: moving ? desired.z : 0,
        moving,
        sprint,
        sit,
        look: false,
      });
    } else {
      if (sit) anim.setBehavior?.('sit');
      else if (moving) anim.setBehavior?.(sprint ? 'trot' : 'walk');
      else anim.setBehavior?.('idle');
      if (moving) {
        const targetYaw = Math.atan2(desired.x, desired.z);
        let yaw = anim.getRootYaw?.() ?? 0;
        let dyaw = targetYaw - yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        yaw += THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-3.2 * dt)), -2.2 * dt, 2.2 * dt);
        anim.setRootYaw?.(yaw);
      }
    }

    const position = this.animal.root.position;
    if (this._hadPrevPos) {
      const dx = position.x - prevPos.x;
      const dz = position.z - prevPos.z;
      const measured = Math.hypot(dx, dz) / Math.max(dt, 1e-5);
      this.horizontalSpeed = THREE.MathUtils.lerp(
        this.horizontalSpeed,
        measured,
        1 - Math.exp(-10 * dt),
      );
    } else {
      this._hadPrevPos = true;
    }
    prevPos.copy(position);

    const yaw = anim.getRootYaw?.() ?? 0;
    if (this._hadPrevYaw) {
      let dy = yaw - this._prevYaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yawRate = THREE.MathUtils.lerp(this.yawRate, dy / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
    } else {
      this._hadPrevYaw = true;
    }
    this._prevYaw = yaw;

    bodyForward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.forwardIntent = moving ? bodyForward.dot(desired) : 0;

    if (moving) {
      const { walk, sprint: sprintSpeed } = this._speeds();
      const baseSpeed = sprint ? sprintSpeed : walk;
      const align = THREE.MathUtils.clamp(this.forwardIntent, -1, 1);
      const turnSlow = THREE.MathUtils.lerp(
        0.62,
        1,
        THREE.MathUtils.smoothstep(align, -0.2, 0.85),
      );
      moveDir
        .copy(bodyForward)
        .multiplyScalar(0.78)
        .addScaledVector(desired, 0.22);
      if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
      else moveDir.copy(bodyForward);

      const distance = baseSpeed * inputMagnitude * turnSlow * dt;
      position.x += moveDir.x * distance;
      position.z += moveDir.z * distance;

      // Soft clamp to studio floor disc.
      const r = Math.hypot(position.x, position.z);
      if (r > this.boundsRadius) {
        const s = this.boundsRadius / r;
        position.x *= s;
        position.z *= s;
      }
    }

    position.y = 0;

    // Facades that own outer root TRS need setRootPosition after controller moves,
    // unless externalRootMotion is on (then animation samples the outer group).
    if (ownsWorldRoot(this.animal) && !anim.getExternalRootMotion?.()) {
      anim.setRootPosition?.(position.x, position.y, position.z);
    }

    // Advance pose. Dogs plant on flat y=0; birds plant inside their update.
    if (birdLike) {
      this.animal.update?.(dt);
    } else {
      this.animal.update?.(dt, {
        plantFeet: !ownsWorldRoot(this.animal),
        getGroundHeight: () => 0,
      });
    }
  }

  snapshot() {
    const position = this.animal?.root?.position;
    return {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      behavior: this.animal?.animation?.getBehavior?.() ?? 'idle',
      speed: this.horizontalSpeed,
      forwardIntent: this.forwardIntent,
      yawRate: this.yawRate,
    };
  }
}
