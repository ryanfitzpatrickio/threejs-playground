import * as THREE from 'three';

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const bodyForward = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const candidate = new THREE.Vector3();
const prevPos = new THREE.Vector3();

const SURFACE_SPEED = Object.freeze({
  grass: 1,
  dirt: 1,
  sand: 0.82,
  mud: 0.68,
  water: 0.58,
  wood: 0.92,
});

// Jump timing mirrors the retargeted horse Jump clip: it crouches ~0.42s,
// launches, peaks ~0.55s later, and touches down around t=1.5s. The clip is
// rotation-only (rootTranslationLocked), so the controller owns the arc —
// gravity is picked for the clip's timing, not for earth physics.
const JUMP_CROUCH_SECONDS = 0.42;
const JUMP_APEX_METERS = 0.55;
const JUMP_RISE_SECONDS = 0.55;

/** Kinematic dog controller. The actor group owns world position; dogAnimation owns pose/yaw. */
export class DogPlayerController {
  constructor({ dog, levelSystem, camera }) {
    this.dog = dog;
    this.levelSystem = levelSystem;
    this.camera = camera;
    this.enabled = true;
    this.surfaceClass = 'grass';
    this.lastInput = null;
    this.lookRemaining = 0;
    this.radius = THREE.MathUtils.clamp(0.34 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.22, 0.52);
    this.height = THREE.MathUtils.clamp(0.92 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.62, 1.35);
    this.jumpPhase = 'none';
    this.jumpTimer = 0;
    this.jumpGravity = 0;
    this.verticalVelocity = 0;
    this.jumpStartedThisFrame = false;
    /** Measured horizontal speed (m/s) for chase-cam framing. */
    this.horizontalSpeed = 0;
    /** Stick magnitude projected onto dog facing (−1..1). */
    this.forwardIntent = 0;
    this._hadPrevPos = false;
    this.dog.animation.setAutopilot(false);
    this.dog.animation.setExternalRootMotion(true);
  }

  setDog(dog) {
    this.dog = dog;
    this.radius = THREE.MathUtils.clamp(0.34 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.22, 0.52);
    this.height = THREE.MathUtils.clamp(0.92 * (dog?.phenotype?.skeleton?.scale ?? 1), 0.62, 1.35);
    this.jumpPhase = 'none';
    this.jumpTimer = 0;
    this.verticalVelocity = 0;
    this.jumpStartedThisFrame = false;
    this.horizontalSpeed = 0;
    this.forwardIntent = 0;
    this._hadPrevPos = false;
    dog.animation.setAutopilot(false);
    dog.animation.setExternalRootMotion(true);
  }

  update(delta, input = {}) {
    if (!this.enabled || !this.dog) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    this.lastInput = input;
    // One-shots (puddle splash, etc.) own the body — no walk/jump until done.
    const locked = Boolean(input.actionLocked);

    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    else forward.normalize();
    right.crossVectors(forward, this.camera.up).normalize();
    desired.set(0, 0, 0)
      .addScaledVector(right, input.moveX ?? 0)
      .addScaledVector(forward, -(input.moveZ ?? 0));

    const inputMagnitude = locked ? 0 : Math.min(1, desired.length());
    const moving = inputMagnitude > 0.05;
    if (moving) desired.normalize();

    if (!locked && input.cutModePressed) this.lookRemaining = 1.25;
    this.lookRemaining = Math.max(0, this.lookRemaining - dt);
    const sit = !locked && Boolean(input.crouchHeld || input.crouchPressed) && !moving;
    const look = !locked && this.lookRemaining > 0 && !moving && !sit;
    const sprint = !locked && Boolean(input.brace);
    // Stick aims the dog; gait steers gently toward that heading.
    this.dog.animation.setMoveIntent({
      x: locked ? 0 : desired.x,
      z: locked ? 0 : desired.z,
      moving,
      sprint,
      sit,
      look,
    });

    const position = this.dog.root.position;
    if (this._hadPrevPos) {
      const dx = position.x - prevPos.x;
      const dz = position.z - prevPos.z;
      const measured = Math.hypot(dx, dz) / Math.max(dt, 1e-5);
      this.horizontalSpeed = THREE.MathUtils.lerp(this.horizontalSpeed, measured, 1 - Math.exp(-10 * dt));
    } else {
      this._hadPrevPos = true;
    }
    prevPos.copy(position);

    this.surfaceClass = this.levelSystem.level?.getSurfaceAt?.(position.x, position.z) ?? 'grass';
    const dogYaw = this.dog.animation.getRootYaw();
    bodyForward.set(Math.sin(dogYaw), 0, Math.cos(dogYaw));
    this.forwardIntent = moving ? bodyForward.dot(desired) : 0;

    if (moving) {
      const phenotypeSpeed = this.dog.phenotype?.motion?.speed ?? 1;
      const baseSpeed = sprint ? 3.9 : 1.85;
      const surfaceSpeed = SURFACE_SPEED[this.surfaceClass] ?? 1;
      // Car-like drive: mostly along the body, with a little side-slip so the
      // stick still feels responsive while the dog is mid-turn.
      const align = THREE.MathUtils.clamp(this.forwardIntent, -1, 1);
      // Slow slightly while carving a sharp turn (less scrubbing).
      const turnSlow = THREE.MathUtils.lerp(0.62, 1, THREE.MathUtils.smoothstep(align, -0.2, 0.85));
      moveDir
        .copy(bodyForward)
        .multiplyScalar(0.78)
        .addScaledVector(desired, 0.22);
      if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
      else moveDir.copy(bodyForward);

      const distance = baseSpeed * phenotypeSpeed * surfaceSpeed * inputMagnitude * turnSlow * dt;
      candidate.copy(position).addScaledVector(moveDir, distance);
      this.moveWithCollision(position, candidate);
    }

    // Jump: crouch anticipation (matches the clip), then a launched arc. The
    // Jump clip is rotation-only, so without this arc the dog never leaves
    // the ground. Re-jump is locked out until touchdown.
    this.jumpStartedThisFrame = false;
    if (!locked && input.jumpPressed && this.jumpPhase === 'none') {
      this.jumpPhase = 'crouch';
      this.jumpTimer = JUMP_CROUCH_SECONDS;
      this.jumpStartedThisFrame = true;
    }

    const sampledGround = this.levelSystem.getGroundHeightAt(position, this.radius, {
      maxStepUp: 0.48,
      maxSnapDown: 1.2,
      requiredInset: Math.min(this.radius * 0.35, 0.12),
    });
    let floorY = Number.isFinite(sampledGround) ? sampledGround : position.y;
    const water = this.levelSystem.level?.getWaterHeightAt?.(position);
    if ((water?.weight ?? 0) > 0) {
      // MVP is shoreline wading rather than swimming: keep the chest above the
      // water even though the authored basin continues deeper underneath.
      floorY = Math.max(floorY, water.waterY - 0.18 * water.weight);
    }

    const grounded = this.jumpPhase === 'none' || this.jumpPhase === 'crouch';
    if (this.jumpPhase === 'crouch') {
      this.jumpTimer -= dt;
      position.y = floorY;
      if (this.jumpTimer <= 0) {
        const scale = this.dog?.phenotype?.skeleton?.scale ?? 1;
        this.verticalVelocity = (2 * JUMP_APEX_METERS * scale) / JUMP_RISE_SECONDS;
        this.jumpGravity = this.verticalVelocity / JUMP_RISE_SECONDS;
        this.jumpPhase = 'air';
      }
    }
    if (this.jumpPhase === 'air') {
      this.verticalVelocity -= this.jumpGravity * dt;
      position.y += this.verticalVelocity * dt;
      if (this.verticalVelocity <= 0 && position.y <= floorY) {
        position.y = floorY;
        this.jumpPhase = 'none';
        this.verticalVelocity = 0;
      }
    } else {
      // Approximate support before pose; plantDogFeet corrects with pad raycasts.
      position.y = floorY;
    }
    this.surfaceClass = this.levelSystem.level?.getSurfaceAt?.(position.x, position.z) ?? this.surfaceClass;

    const groundProbe = new THREE.Vector3();
    this.dog.update(dt, {
      fixed: false,
      // When a retargeted clip follows this update, its final pose owns the
      // single foot-plant pass (see DogParkRuntimeFeature). Planting this
      // procedural pose too makes the actor height seesaw twice per frame.
      plantFeet: grounded && !locked && !input.deferFootPlant,
      getGroundHeight: (x, z) => {
        groundProbe.set(x, position.y, z);
        const y = this.levelSystem.getGroundHeightAt(groundProbe, this.radius * 0.45, {
          maxStepUp: 0.48,
          maxSnapDown: 1.2,
          requiredInset: Math.min(this.radius * 0.25, 0.1),
        });
        if (!Number.isFinite(y)) return floorY;
        if ((water?.weight ?? 0) > 0) return Math.max(y, water.waterY - 0.18 * water.weight);
        return y;
      },
    });
  }

  moveWithCollision(position, target) {
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
  }

  snapshot() {
    const position = this.dog?.root?.position;
    return {
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      behavior: this.dog?.animation?.getBehavior?.() ?? 'idle',
      speed: this.horizontalSpeed,
      forwardIntent: this.forwardIntent,
      surfaceClass: this.surfaceClass,
      radius: this.radius,
      jump: this.jumpPhase,
    };
  }
}
