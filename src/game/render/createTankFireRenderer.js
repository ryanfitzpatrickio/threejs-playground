/** Procedural propane flame jets, tank engulf shells, fake bounce glow, and shimmer. */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mix,
  mx_fractal_noise_float,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';

const _up = new THREE.Vector3(0, 1, 0);
const _direction = new THREE.Vector3();

function flameMaterial(timeUniform, intensityUniform) {
  const radial = uv().sub(0.5).length();
  const body = float(1).sub(smoothstep(0.12, 0.54, radial));
  const noise = mx_fractal_noise_float(
    positionWorld.mul(4.3).add(vec3(0, timeUniform.mul(2.4), 0)),
    3,
  ).mul(0.5).add(0.5);
  const hot = smoothstep(0.32, 0.88, noise);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(color(0xff4b0b), color(0xfff3ad), hot)
    .mul(float(2.5).add(intensityUniform.mul(1.1)));
  material.opacityNode = body.mul(smoothstep(0.22, 0.58, noise)).mul(0.88);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

function shimmerMaterial(timeUniform) {
  const radial = uv().sub(0.5).length();
  const noise = mx_fractal_noise_float(
    positionWorld.mul(7).add(vec3(timeUniform.mul(0.2), timeUniform.mul(1.8), 0)),
    2,
  ).mul(0.5).add(0.5);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = color(0xffd0a0).mul(noise.mul(0.35).add(0.2));
  material.opacityNode = float(1).sub(smoothstep(0.18, 0.52, radial))
    .mul(noise)
    .mul(0.11);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

export function createTankFireRenderer(scene, {
  capacity = 8,
  heatShimmer = true,
} = {}) {
  const shellGeometry = new THREE.ConeGeometry(0.5, 1.2, 14, 4, true);
  const jetGeometry = new THREE.ConeGeometry(0.5, 1, 10, 3, true);
  const glowGeometry = new THREE.CircleGeometry(1, 24);
  const heatGeometry = new THREE.PlaneGeometry(1, 1.5);
  const timeUniform = uniform(0);
  const slots = [];

  for (let i = 0; i < capacity; i += 1) {
    const intensityUniform = uniform(1);
    const material = flameMaterial(timeUniform, intensityUniform);
    const shell = new THREE.Mesh(shellGeometry, material);
    const jet = new THREE.Mesh(jetGeometry, material);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.8, 0.65, 0.08),
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.rotation.x = -Math.PI * 0.5;
    const heatMaterial = heatShimmer ? shimmerMaterial(timeUniform) : null;
    const heat = heatMaterial ? new THREE.Mesh(heatGeometry, heatMaterial) : null;
    for (const mesh of [shell, jet, glow, heat]) {
      if (!mesh) continue;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = mesh === glow ? 40 : 45;
      scene.add(mesh);
    }
    slots.push({
      shell,
      jet,
      glow,
      heat,
      material,
      glowMaterial,
      heatMaterial,
      intensityUniform,
    });
  }

  let clock = 0;
  function update(delta, sources = [], camera = null) {
    const dt = Math.max(0, Number(delta) || 0);
    clock += dt;
    timeUniform.value = clock;
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      const source = sources[i];
      const visible = Boolean(source?.position);
      slot.shell.visible = visible;
      slot.jet.visible = visible;
      slot.glow.visible = visible;
      if (slot.heat) slot.heat.visible = visible;
      if (!visible) continue;

      const intensity = THREE.MathUtils.clamp(Number(source.intensity) || 1, 0.45, 2.2);
      const flicker = 0.9 + Math.sin(clock * 19 + i * 2.1) * 0.08 + Math.sin(clock * 31) * 0.04;
      slot.intensityUniform.value = intensity;
      slot.shell.position.copy(source.position);
      slot.shell.position.y += 0.2;
      slot.shell.scale.set(0.38 * intensity, 0.9 * intensity * flicker, 0.38 * intensity);
      slot.shell.rotation.y = clock * 0.6 + i;

      _direction.set(
        source.direction?.x ?? 0,
        source.direction?.y ?? 0.2,
        source.direction?.z ?? 1,
      );
      if (_direction.lengthSq() < 1e-5) _direction.set(0, 0.2, 1);
      _direction.normalize();
      slot.jet.position.copy(source.holePosition ?? source.position)
        .addScaledVector(_direction, 0.32 * intensity);
      slot.jet.quaternion.setFromUnitVectors(_up, _direction);
      slot.jet.scale.set(0.16 * intensity, 0.75 * intensity * flicker, 0.16 * intensity);

      slot.glow.position.copy(source.position);
      slot.glow.position.y = source.floorY ?? (source.position.y - 0.42);
      slot.glow.scale.setScalar(1.4 + intensity * 0.7);
      slot.glowMaterial.opacity = 0.18 + flicker * 0.12;

      if (slot.heat) {
        slot.heat.position.copy(source.position);
        slot.heat.position.y += 1.25 * intensity;
        if (camera) slot.heat.quaternion.copy(camera.quaternion);
        slot.heat.scale.set(0.8 * intensity, 1.15 * intensity, 1);
      }
    }
  }

  function dispose() {
    for (const slot of slots) {
      for (const mesh of [slot.shell, slot.jet, slot.glow, slot.heat]) mesh?.removeFromParent();
      slot.material.dispose();
      slot.glowMaterial.dispose();
      slot.heatMaterial?.dispose();
    }
    shellGeometry.dispose();
    jetGeometry.dispose();
    glowGeometry.dispose();
    heatGeometry.dispose();
  }

  return { update, dispose, slots };
}
