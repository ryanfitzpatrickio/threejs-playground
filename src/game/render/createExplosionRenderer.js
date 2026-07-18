/** Pooled propane fireball, shockwave, heat pulse, fragments, and scorch. */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mix,
  mx_worley_noise_float,
  normalView,
  positionWorld,
  screenUV,
  smoothstep,
  uniform,
  viewportSharedTexture,
} from 'three/tsl';

const FIREBALL_DURATION = 0.62;
const SHOCKWAVE_DURATION = 0.38;
const FRAGMENT_DURATION = 2.2;
const SLOT_DURATION = 6;
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _outward = new THREE.Vector3();

function createFireballMaterial(opacityUniform) {
  const cells = mx_worley_noise_float(positionWorld.mul(2.8));
  const hot = smoothstep(0.08, 0.72, cells);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(color(0xff3208), color(0xffef9a), hot).mul(4);
  material.opacityNode = smoothstep(0.04, 0.82, cells).mul(opacityUniform);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

function createDistortionMaterial(opacityUniform) {
  const offsetUv = screenUV.add(normalView.xy.mul(opacityUniform).mul(0.018));
  const backdrop = viewportSharedTexture(offsetUv);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = backdrop.rgb;
  material.opacityNode = opacityUniform.mul(0.34);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  return material;
}

function cloneFragmentMaterial(source) {
  const material = (Array.isArray(source) ? source[0] : source)?.clone?.()
    ?? new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.6, roughness: 0.5 });
  material.transparent = true;
  material.opacity = 1;
  material.depthWrite = true;
  return material;
}

export function createExplosionRenderer(scene, {
  capacity = 4,
  distortion = true,
} = {}) {
  const fireballGeometry = new THREE.IcosahedronGeometry(1, 3);
  const ringGeometry = new THREE.RingGeometry(0.86, 1, 64);
  const distortionGeometry = new THREE.SphereGeometry(1, 24, 16);
  const scorchGeometry = new THREE.CircleGeometry(1, 32);
  const slots = [];

  for (let i = 0; i < capacity; i += 1) {
    const fireOpacity = uniform(0);
    const fireMaterial = createFireballMaterial(fireOpacity);
    const fireball = new THREE.Mesh(fireballGeometry, fireMaterial);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(4.5, 1.5, 0.3),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI * 0.5;
    const distortionOpacity = uniform(0);
    const distortionMaterial = distortion ? createDistortionMaterial(distortionOpacity) : null;
    const heatPulse = distortionMaterial
      ? new THREE.Mesh(distortionGeometry, distortionMaterial)
      : null;
    const scorchMaterial = new THREE.MeshBasicMaterial({
      color: 0x100b08,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
    });
    const scorch = new THREE.Mesh(scorchGeometry, scorchMaterial);
    scorch.rotation.x = -Math.PI * 0.5;
    for (const mesh of [fireball, ring, heatPulse, scorch]) {
      if (!mesh) continue;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = mesh === scorch ? 5 : 47;
      scene.add(mesh);
    }
    slots.push({
      fireball,
      ring,
      heatPulse,
      scorch,
      fireMaterial,
      ringMaterial,
      distortionMaterial,
      scorchMaterial,
      fireOpacity,
      distortionOpacity,
      fragments: [],
      life: 0,
      age: 0,
      radius: 6.5,
      point: new THREE.Vector3(),
    });
  }

  function clearFragments(slot) {
    for (const fragment of slot.fragments) {
      fragment.mesh.removeFromParent();
      fragment.material.dispose();
    }
    slot.fragments.length = 0;
  }

  function spawnFragments(slot, tank, point) {
    clearFragments(slot);
    tank?.group?.updateMatrixWorld?.(true);
    const sourceMeshes = [];
    tank?.group?.traverse?.((child) => {
      if (child.isMesh && sourceMeshes.length < 6) sourceMeshes.push(child);
    });
    for (let i = 0; i < sourceMeshes.length; i += 1) {
      const source = sourceMeshes[i];
      source.matrixWorld.decompose(_position, _quaternion, _scale);
      const material = cloneFragmentMaterial(source.material);
      const mesh = new THREE.Mesh(source.geometry, material);
      mesh.position.copy(_position);
      mesh.quaternion.copy(_quaternion);
      mesh.scale.copy(_scale);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      _outward.copy(_position).sub(point);
      _outward.y = 0;
      if (_outward.lengthSq() < 1e-5) {
        const angle = (i / Math.max(1, sourceMeshes.length)) * Math.PI * 2;
        _outward.set(Math.cos(angle), 0, Math.sin(angle));
      } else {
        _outward.normalize();
      }
      const speed = 2.5 + Math.random() * 4.5;
      const velocity = _outward.clone().multiplyScalar(speed);
      velocity.y = 2.6 + Math.random() * 4.6;
      slot.fragments.push({
        mesh,
        material,
        velocity,
        angular: new THREE.Vector3(
          (Math.random() - 0.5) * 11,
          (Math.random() - 0.5) * 11,
          (Math.random() - 0.5) * 11,
        ),
      });
    }
  }

  function spawn({ point, floorY = null, radius = 6.5, tank = null } = {}) {
    if (!point) return null;
    const slot = slots.find((entry) => entry.life <= 0) ?? slots.reduce(
      (oldest, entry) => (entry.life < oldest.life ? entry : oldest),
      slots[0],
    );
    if (!slot) return null;
    slot.point.copy(point);
    slot.radius = Math.max(1, Number(radius) || 6.5);
    slot.age = 0;
    slot.life = SLOT_DURATION;
    slot.fireball.position.copy(point);
    slot.fireball.scale.setScalar(0.2);
    slot.fireball.visible = true;
    slot.ring.position.set(point.x, floorY ?? point.y - 0.45, point.z);
    slot.ring.scale.setScalar(0.05);
    slot.ring.visible = true;
    if (slot.heatPulse) {
      slot.heatPulse.position.copy(point);
      slot.heatPulse.scale.setScalar(0.25);
      slot.heatPulse.visible = true;
    }
    slot.scorch.position.set(point.x, (floorY ?? point.y - 0.45) + 0.015, point.z);
    slot.scorch.scale.setScalar(Math.min(3.2, slot.radius * 0.46));
    slot.scorchMaterial.opacity = 0.56;
    slot.scorch.visible = true;
    spawnFragments(slot, tank, point);
    return slot;
  }

  function update(delta) {
    const dt = Math.max(0, Number(delta) || 0);
    for (const slot of slots) {
      if (slot.life <= 0) continue;
      slot.life -= dt;
      slot.age += dt;

      const fireT = Math.min(1, slot.age / FIREBALL_DURATION);
      slot.fireball.scale.setScalar(THREE.MathUtils.lerp(0.45, 3.5, Math.sqrt(fireT)));
      slot.fireOpacity.value = Math.max(0, (1 - fireT) * (1 - fireT));
      slot.fireball.visible = fireT < 1;

      const waveT = Math.min(1, slot.age / SHOCKWAVE_DURATION);
      slot.ring.scale.setScalar(Math.max(0.05, slot.radius * waveT));
      slot.ringMaterial.opacity = Math.max(0, 0.82 * (1 - waveT));
      slot.ring.visible = waveT < 1;
      if (slot.heatPulse) {
        slot.heatPulse.scale.setScalar(0.5 + slot.radius * waveT * 0.72);
        slot.distortionOpacity.value = Math.max(0, (1 - waveT) * 0.8);
        slot.heatPulse.visible = waveT < 1;
      }

      const fragmentT = Math.min(1, slot.age / FRAGMENT_DURATION);
      for (const fragment of slot.fragments) {
        fragment.velocity.y -= 9.81 * dt;
        fragment.mesh.position.addScaledVector(fragment.velocity, dt);
        fragment.mesh.rotation.x += fragment.angular.x * dt;
        fragment.mesh.rotation.y += fragment.angular.y * dt;
        fragment.mesh.rotation.z += fragment.angular.z * dt;
        fragment.material.opacity = fragmentT > 0.72 ? (1 - fragmentT) / 0.28 : 1;
        fragment.mesh.visible = fragmentT < 1;
      }
      if (fragmentT >= 1 && slot.fragments.length) clearFragments(slot);

      const scorchFade = Math.max(0, Math.min(1, slot.life / 1.5));
      slot.scorchMaterial.opacity = 0.5 * scorchFade;
      if (slot.life <= 0) {
        slot.fireball.visible = false;
        slot.ring.visible = false;
        if (slot.heatPulse) slot.heatPulse.visible = false;
        slot.scorch.visible = false;
        clearFragments(slot);
      }
    }
  }

  function dispose() {
    for (const slot of slots) {
      clearFragments(slot);
      for (const mesh of [slot.fireball, slot.ring, slot.heatPulse, slot.scorch]) mesh?.removeFromParent();
      slot.fireMaterial.dispose();
      slot.ringMaterial.dispose();
      slot.distortionMaterial?.dispose();
      slot.scorchMaterial.dispose();
    }
    fireballGeometry.dispose();
    ringGeometry.dispose();
    distortionGeometry.dispose();
    scorchGeometry.dispose();
  }

  return { spawn, update, dispose, slots };
}
