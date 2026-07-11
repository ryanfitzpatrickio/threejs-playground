import * as THREE from 'three';

const DEFAULT_CAPACITY = 48;
const _normal = new THREE.Vector3();
const _inward = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();

export const SURFACE_IMPACT_PRESETS = Object.freeze({
  metal: { flash: 0xffdb86, dust: 0x8b9298, chip: 0xffc65a, size: 0.052, debris: 4 },
  concrete: { flash: 0xd8d0c4, dust: 0xa9a39a, chip: 0x9b958e, size: 0.09, debris: 3 },
  marble: { flash: 0xfff0d5, dust: 0xd9d0c2, chip: 0xf0e1cc, size: 0.08, debris: 3 },
  wood: { flash: 0xe4a56a, dust: 0xaa7448, chip: 0xc98950, size: 0.075, debris: 3 },
  glass: { flash: 0xd8f7ff, dust: 0x8dd5e7, chip: 0xaeeeff, size: 0.07, debris: 4 },
  soil: { flash: 0x98704a, dust: 0x765035, chip: 0x8a603d, size: 0.11, debris: 3 },
  flesh: { flash: 0xff5c55, dust: 0x8d2424, chip: 0xbd3c36, size: 0.075, debris: 2 },
  generic: { flash: 0xffcf92, dust: 0x9ca0a0, chip: 0xa3a7aa, size: 0.07, debris: 2 },
});

/** Fixed-pool visual response for resolved impacts; no physics bodies. */
export function createWeaponImpactRenderer(scene, { capacity = DEFAULT_CAPACITY } = {}) {
  const disc = new THREE.CircleGeometry(0.5, 9);
  const chipGeometry = new THREE.IcosahedronGeometry(0.012, 0);
  const slots = [];

  for (let i = 0; i < capacity; i += 1) {
    const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const dustMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.5, side: THREE.DoubleSide });
    const chipMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    const flash = new THREE.Mesh(disc, flashMaterial);
    const dust = new THREE.Mesh(disc, dustMaterial);
    const chips = Array.from({ length: 4 }, () => new THREE.Mesh(chipGeometry, chipMaterial));
    for (const mesh of [flash, dust, ...chips]) {
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 44;
      scene.add(mesh);
    }
    slots.push({ flash, dust, chips, flashMaterial, dustMaterial, chipMaterial, life: 0, duration: 0.22, normal: new THREE.Vector3(), velocities: chips.map(() => new THREE.Vector3()) });
  }

  function spawn({ point, normal, incomingDirection, surfaceClass = 'generic', intensity = 1 } = {}) {
    if (!point) return;
    const slot = slots.find((entry) => entry.life <= 0) ?? slots[0];
    if (!slot) return;
    const preset = SURFACE_IMPACT_PRESETS[surfaceClass] ?? SURFACE_IMPACT_PRESETS.generic;
    _normal.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_normal.lengthSq() < 1e-6) _normal.set(0, 1, 0);
    _normal.normalize();
    const size = preset.size * Math.max(0.55, Math.min(1.8, Number(intensity) || 1));
    slot.normal.copy(_normal);
    slot.flashMaterial.color.set(preset.flash).multiplyScalar(3.2);
    slot.dustMaterial.color.set(preset.dust);
    slot.chipMaterial.color.set(preset.chip);
    slot.flashMaterial.opacity = 1;
    slot.dustMaterial.opacity = 0.55;
    for (const mesh of [slot.flash, slot.dust]) {
      mesh.position.set(point.x, point.y, point.z).addScaledVector(_normal, 0.006);
      mesh.quaternion.setFromUnitVectors(_inward.set(0, 0, 1), _normal);
      mesh.visible = true;
    }
    slot.flash.scale.setScalar(size * 0.8);
    slot.dust.scale.setScalar(size * 1.1);
    _inward.set(-(incomingDirection?.x ?? 0), -(incomingDirection?.y ?? 0), -(incomingDirection?.z ?? 1));
    if (_inward.lengthSq() < 1e-6) _inward.copy(_normal);
    _inward.normalize();
    _tangent.crossVectors(_normal, Math.abs(_normal.y) < 0.9 ? _inward.set(0, 1, 0) : _inward.set(1, 0, 0)).normalize();
    _bitangent.crossVectors(_normal, _tangent).normalize();
    for (let i = 0; i < slot.chips.length; i += 1) {
      const chip = slot.chips[i];
      const visible = i < preset.debris;
      chip.visible = visible;
      if (!visible) continue;
      chip.position.set(point.x, point.y, point.z).addScaledVector(_normal, 0.012);
      const lateralA = (Math.random() * 2 - 1) * 0.8;
      const lateralB = (Math.random() * 2 - 1) * 0.8;
      slot.velocities[i]
        .copy(_normal).multiplyScalar(1.2 + Math.random() * 1.8)
        .addScaledVector(_tangent, lateralA)
        .addScaledVector(_bitangent, lateralB);
      chip.scale.setScalar(0.55 + Math.random() * 0.75);
      chip.rotation.set(Math.random() * 5, Math.random() * 5, Math.random() * 5);
    }
    slot.duration = surfaceClass === 'soil' ? 0.3 : 0.22;
    slot.life = slot.duration;
  }

  function update(dt) {
    const step = Math.max(0, Number(dt) || 0);
    for (const slot of slots) {
      if (slot.life <= 0) continue;
      slot.life -= step;
      const t = Math.max(0, slot.life / slot.duration);
      slot.flashMaterial.opacity = t * t;
      slot.dustMaterial.opacity = t * 0.5;
      slot.dust.scale.multiplyScalar(1 + step * 4.5);
      for (let i = 0; i < slot.chips.length; i += 1) {
        const chip = slot.chips[i];
        if (!chip.visible) continue;
        const velocity = slot.velocities[i];
        velocity.y -= 7.5 * step;
        velocity.multiplyScalar(Math.max(0, 1 - step * 2.3));
        chip.position.addScaledVector(velocity, step);
        chip.rotation.x += step * 11;
        chip.rotation.z += step * 8;
      }
      if (slot.life <= 0) {
        slot.flash.visible = false;
        slot.dust.visible = false;
        for (const chip of slot.chips) chip.visible = false;
      }
    }
  }

  function dispose() {
    for (const slot of slots) {
      for (const mesh of [slot.flash, slot.dust, ...slot.chips]) mesh.parent?.remove(mesh);
      slot.flashMaterial.dispose();
      slot.dustMaterial.dispose();
      slot.chipMaterial.dispose();
    }
    disc.dispose();
    chipGeometry.dispose();
  }

  return { spawn, update, dispose, slots };
}
