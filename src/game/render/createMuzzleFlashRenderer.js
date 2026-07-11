import * as THREE from 'three';

const DEFAULT_CAPACITY = 8;
const CORE_DURATION = 0.042;
const SMOKE_DURATION = 0.16;
const TONGUES_PER_FLASH = 3;
const _axis = new THREE.Vector3(0, 1, 0);
const _direction = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _tongueDirection = new THREE.Vector3();

/**
 * Fixed-pool, directional muzzle presentation. The core is a bloom-bright
 * volume; three low-poly flame tongues give it a clear forward silhouette even
 * when viewed from the side, unlike a camera-facing sprite.
 *
 * No dynamic light: on WebGPU + TSL node materials a live PointLight is
 * evaluated by every lit fragment in view for the frame it is on (and risks
 * touching cached material lighting variants). The bright HDR core reads through
 * the bloom pass, the weapon self-illumination is faked by a material emissive
 * pulse (WeaponPresentationSystem), and nearby-surface bounce is a projected
 * additive decal (createMuzzleBounceRenderer) — all far cheaper than a light.
 */
export function createMuzzleFlashRenderer(scene, { capacity = DEFAULT_CAPACITY } = {}) {
  const coreGeometry = new THREE.SphereGeometry(0.5, 8, 6);
  const tongueGeometry = new THREE.ConeGeometry(0.5, 1, 5, 1, true);
  const smokeGeometry = new THREE.CircleGeometry(0.5, 10);
  const slots = [];

  for (let i = 0; i < capacity; i += 1) {
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(12, 10, 7), transparent: true, depthWrite: false,
      toneMapped: false, blending: THREE.AdditiveBlending,
    });
    const tongueMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(5, 1.5, 0.15), transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending,
    });
    const smokeMaterial = new THREE.MeshBasicMaterial({
      color: 0x6f7882, transparent: true, depthWrite: false, opacity: 0.18,
      side: THREE.DoubleSide,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    const tongues = Array.from({ length: TONGUES_PER_FLASH }, () => new THREE.Mesh(tongueGeometry, tongueMaterial));
    const smoke = new THREE.Mesh(smokeGeometry, smokeMaterial);
    for (const mesh of [core, ...tongues, smoke]) {
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 45;
      scene.add(mesh);
    }
    slots.push({
      core, tongues, smoke, coreMaterial, tongueMaterial, smokeMaterial,
      life: 0, coreDuration: CORE_DURATION, smokeLife: 0, direction: new THREE.Vector3(),
    });
  }

  function spawn({ position, direction, scale = 1, durationMs = CORE_DURATION * 1000, color = '#ffb15a', smoke = 0.35 } = {}) {
    const slot = slots.find((entry) => entry.life <= 0) ?? slots[0];
    if (!slot || !position) return;
    _direction.set(direction?.x ?? 0, direction?.y ?? 0, direction?.z ?? -1);
    if (_direction.lengthSq() < 1e-6) _direction.set(0, 0, -1);
    _direction.normalize();
    slot.direction.copy(_direction);
    const tint = new THREE.Color(color);
    slot.coreMaterial.color.setRGB(12, 10, 7);
    slot.tongueMaterial.color.copy(tint).multiplyScalar(5.5);
    slot.coreMaterial.opacity = 1;
    slot.tongueMaterial.opacity = 0.92;
    slot.smokeMaterial.opacity = Math.min(0.23, Math.max(0, smoke) * 0.42);
    const size = Math.max(0.018, Number(scale) || 1) * (0.055 + Math.random() * 0.02);
    slot.core.position.copy(position).addScaledVector(_direction, size * 0.13);
    slot.core.scale.setScalar(size * 0.34);

    _tangent.crossVectors(_direction, Math.abs(_direction.y) < 0.92 ? _axis : _bitangent.set(1, 0, 0)).normalize();
    _bitangent.crossVectors(_direction, _tangent).normalize();
    for (let i = 0; i < slot.tongues.length; i += 1) {
      const tongue = slot.tongues[i];
      const length = size * (1.25 + Math.random() * 1.5) * (i === 0 ? 1.12 : 0.86);
      const width = size * (0.28 + Math.random() * 0.16);
      _tongueDirection.copy(_direction)
        .addScaledVector(_tangent, (Math.random() * 2 - 1) * 0.2)
        .addScaledVector(_bitangent, (Math.random() * 2 - 1) * 0.2)
        .normalize();
      tongue.position.copy(position).addScaledVector(_tongueDirection, length * 0.48);
      tongue.quaternion.setFromUnitVectors(_axis, _tongueDirection);
      tongue.rotateY(Math.random() * Math.PI * 2);
      tongue.scale.set(width, length, width);
      tongue.visible = true;
    }

    slot.smoke.position.copy(position).addScaledVector(_direction, size * 0.6);
    slot.smoke.scale.setScalar(size * 1.5);
    slot.coreDuration = THREE.MathUtils.clamp((Number(durationMs) || CORE_DURATION * 1000) / 1000, 0.025, 0.055);
    slot.life = slot.coreDuration;
    slot.smokeLife = Math.max(0, smoke) > 0 ? SMOKE_DURATION : 0;
    slot.core.visible = true;
    slot.smoke.visible = slot.smokeLife > 0;
  }

  function update(dt, camera) {
    const step = Math.max(0, Number(dt) || 0);
    for (const slot of slots) {
      if (slot.life <= 0 && slot.smokeLife <= 0) continue;
      if (slot.life > 0) {
        slot.life -= step;
        const t = Math.max(0, slot.life / slot.coreDuration);
        slot.coreMaterial.opacity = t * t;
        slot.tongueMaterial.opacity = t * (0.65 + t * 0.35);
        slot.core.scale.multiplyScalar(1 + step * 2.6);
        slot.core.visible = slot.life > 0;
        for (const tongue of slot.tongues) {
          tongue.scale.y *= 1 + step * 1.7;
          tongue.visible = slot.life > 0;
        }
      }
      if (slot.smokeLife > 0) {
        slot.smokeLife -= step;
        const t = Math.max(0, slot.smokeLife / SMOKE_DURATION);
        if (camera) slot.smoke.quaternion.copy(camera.quaternion);
        slot.smoke.position.addScaledVector(slot.direction, step * 0.22);
        slot.smoke.scale.multiplyScalar(1 + step * 2.8);
        slot.smokeMaterial.opacity = t * 0.15;
        slot.smoke.visible = slot.smokeLife > 0;
      }
    }
  }

  function dispose() {
    for (const slot of slots) {
      for (const mesh of [slot.core, ...slot.tongues, slot.smoke]) mesh.parent?.remove(mesh);
      slot.coreMaterial.dispose();
      slot.tongueMaterial.dispose();
      slot.smokeMaterial.dispose();
    }
    coreGeometry.dispose();
    tongueGeometry.dispose();
    smokeGeometry.dispose();
  }

  return { spawn, update, dispose, slots };
}
