import * as THREE from 'three';

const forward = new THREE.Vector3();
const right = new THREE.Vector3();

export class SimCameraSystem {
  constructor() {
    this.camera = null;
    this.target = new THREE.Vector3(0, 0, 0);
    this.yaw = 0.72;
    this.pitch = 0.82;
    this.distance = 19;
    this.active = false;
  }

  initialize(camera) {
    this.camera = camera;
    this.active = true;
    this.applyPose();
  }

  update(delta, input) {
    input ??= {};
    const orbiting = input.mouseSecondaryHeld || input.mouseMiddleHeld;
    if (orbiting) {
      this.yaw -= (input.lookX ?? 0) * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (input.lookY ?? 0) * 0.005, 0.38, 1.25);
    }
    this.distance = THREE.MathUtils.clamp(this.distance + (input.zoomDelta ?? 0) * 1.25, 6, 32);

    forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // Pan only via explicit move axes (WASD). No screen-edge scroll — it fights
    // UI/catalog cursor use in household/sims mode.
    const panSpeed = this.distance * 0.55 * delta;
    this.target.addScaledVector(right, (input.moveX ?? 0) * panSpeed);
    this.target.addScaledVector(forward, -(input.moveZ ?? 0) * panSpeed);

    this.target.x = THREE.MathUtils.clamp(this.target.x, -18, 18);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -13, 13);
    this.applyPose();
  }

  applyPose() {
    if (!this.camera) return;
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }

  snapshot() {
    return {
      active: this.active,
      target: { x: this.target.x, y: this.target.y, z: this.target.z },
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      position: this.camera
        ? { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }
        : null,
    };
  }

  dispose() {
    this.active = false;
    this.camera = null;
  }
}
