/** CPU-updated propane vapor + smoke billboard pools (WebGPU-safe instance uploads). */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mx_fractal_noise_float,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';

const _matrix = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _collapsed = new THREE.Matrix4().makeScale(0, 0, 0);

function createVaporMaterial({ tint, opacity, timeUniform }) {
  const radial = uv().sub(0.5).length();
  const soft = float(1).sub(smoothstep(0.08, 0.52, radial));
  const noise = mx_fractal_noise_float(
    positionWorld.mul(3.7).add(vec3(0, timeUniform.mul(0.7), 0)),
    3,
  ).mul(0.5).add(0.5);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = color(tint).mul(noise.mul(0.28).add(0.72));
  material.opacityNode = soft.mul(noise.mul(0.45).add(0.55)).mul(opacity);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  return material;
}

function createPool(scene, {
  capacity,
  tint,
  opacity,
  name,
  timeUniform,
}) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = createVaporMaterial({ tint, opacity, timeUniform });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 44;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < capacity; i += 1) mesh.setMatrixAt(i, _collapsed);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  const particles = Array.from({ length: capacity }, () => ({
    active: false,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    life: 0,
    duration: 1,
    startSize: 0.05,
    endSize: 0.3,
    spin: 0,
  }));
  let cursor = 0;

  function spawn({ position, velocity, duration, startSize, endSize } = {}) {
    if (!position) return;
    const particle = particles[cursor];
    cursor = (cursor + 1) % particles.length;
    particle.active = true;
    particle.position.copy(position);
    particle.velocity.copy(velocity ?? _scale.set(0, 1, 0));
    particle.life = Math.max(0.05, Number(duration) || 1);
    particle.duration = particle.life;
    particle.startSize = Math.max(0.01, Number(startSize) || 0.05);
    particle.endSize = Math.max(particle.startSize, Number(endSize) || 0.3);
    particle.spin = Math.random() * Math.PI * 2;
  }

  function update(dt, camera, { buoyancy = 0.6, drag = 2.2 } = {}) {
    const damping = Math.exp(-Math.max(0, drag) * dt);
    for (let i = 0; i < particles.length; i += 1) {
      const particle = particles[i];
      if (!particle.active) {
        mesh.setMatrixAt(i, _collapsed);
        continue;
      }
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.active = false;
        mesh.setMatrixAt(i, _collapsed);
        continue;
      }
      particle.velocity.multiplyScalar(damping);
      particle.velocity.y += buoyancy * dt;
      particle.position.addScaledVector(particle.velocity, dt);
      particle.spin += dt * 0.7;
      const age = 1 - particle.life / particle.duration;
      const size = THREE.MathUtils.lerp(particle.startSize, particle.endSize, age);
      _scale.set(size, size, size);
      _matrix.compose(
        particle.position,
        camera?.quaternion ?? new THREE.Quaternion(),
        _scale,
      );
      mesh.setMatrixAt(i, _matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    mesh.removeFromParent();
    geometry.dispose();
    material.dispose();
  }

  return { spawn, update, dispose, mesh, particles };
}

export function createGasVentRenderer(scene, {
  gasCapacity = 128,
  smokeCapacity = 72,
} = {}) {
  const timeUniform = uniform(0);
  const gas = createPool(scene, {
    capacity: gasCapacity,
    tint: 0xe5ece9,
    opacity: 0.5,
    name: 'Propane Gas Vent Pool',
    timeUniform,
  });
  const smoke = createPool(scene, {
    capacity: smokeCapacity,
    tint: 0x24272b,
    opacity: 0.68,
    name: 'Propane Explosion Smoke Pool',
    timeUniform,
  });
  const normal = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let clock = 0;

  function emitGas({ position, direction, pressure = 1 } = {}) {
    if (!position) return;
    normal.set(direction?.x ?? 0, direction?.y ?? 0.2, direction?.z ?? 1);
    if (normal.lengthSq() < 1e-5) normal.set(0, 0.2, 1);
    normal.normalize();
    const p = THREE.MathUtils.clamp(Number(pressure) || 0, 0.08, 1);
    velocity.copy(normal).multiplyScalar((2.0 + Math.random() * 0.8) * p);
    velocity.x += (Math.random() - 0.5) * 0.24;
    velocity.y += 0.14 + Math.random() * 0.2;
    velocity.z += (Math.random() - 0.5) * 0.24;
    gas.spawn({
      position,
      velocity,
      duration: 0.55 + Math.random() * 0.3,
      startSize: 0.045 + p * 0.02,
      endSize: 0.24 + p * 0.14,
    });
  }

  function burstSmoke({ position, count = 12, radius = 1 } = {}) {
    if (!position) return;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.4 + Math.random() * 1.4) * radius;
      velocity.set(
        Math.cos(angle) * speed,
        1.1 + Math.random() * 2.0,
        Math.sin(angle) * speed,
      );
      smoke.spawn({
        position,
        velocity,
        duration: 3.8 + Math.random() * 2.2,
        startSize: 0.35 + Math.random() * 0.35,
        endSize: 1.6 + Math.random() * 1.4,
      });
    }
  }

  function update(delta, camera) {
    const dt = Math.max(0, Number(delta) || 0);
    clock += dt;
    timeUniform.value = clock;
    gas.update(dt, camera, { buoyancy: 0.55, drag: 2.8 });
    smoke.update(dt, camera, { buoyancy: 0.34, drag: 0.38 });
  }

  function dispose() {
    gas.dispose();
    smoke.dispose();
  }

  return { emitGas, burstSmoke, update, dispose, gas, smoke };
}
