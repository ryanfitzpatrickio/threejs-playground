import * as THREE from 'three';

const DEFAULT_CAPACITY = 6;
const BOUNCE_DURATION = 0.06;
/** Beyond this the flash would not meaningfully light a surface — skip it. */
const MAX_BOUNCE_DISTANCE = 6;
const _normal = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, 1);

/** Shared soft radial falloff so the additive quad reads as a glow, not a disc. */
function createRadialTexture() {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * Fake muzzle-flash bounce: a brief warm additive glow projected onto the
 * nearest surface the shot pointed at. This replaces the environment
 * illumination a dynamic muzzle light used to provide, for the cost of one
 * transparent quad per shot and zero lighting recompute.
 */
export function createMuzzleBounceRenderer(scene, { capacity = DEFAULT_CAPACITY } = {}) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const texture = createRadialTexture();
  const slots = [];

  for (let i = 0; i < capacity; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffb15a,
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 46;
    scene.add(mesh);
    slots.push({ mesh, material, life: 0, duration: BOUNCE_DURATION, peak: 0 });
  }

  function spawn({ point, normal, distance = 0, color = '#ffb15a', scale = 1 } = {}) {
    if (!point || distance > MAX_BOUNCE_DISTANCE) return;
    const slot = slots.find((entry) => entry.life <= 0)
      ?? slots.reduce((oldest, entry) => (entry.life < oldest.life ? entry : oldest), slots[0]);
    if (!slot) return;

    _normal.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_normal.lengthSq() < 1e-6) _normal.set(0, 1, 0);
    _normal.normalize();
    // Lift off the surface a hair to beat z-fighting with the wall/floor.
    slot.mesh.position.set(point.x, point.y, point.z).addScaledVector(_normal, 0.02);
    slot.mesh.quaternion.setFromUnitVectors(_forward, _normal);
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);

    // Nearer surfaces catch a brighter, tighter pool of light.
    const near = 1 - Math.min(1, distance / MAX_BOUNCE_DISTANCE);
    const radius = (1.1 + distance * 0.28) * Math.max(0.4, Number(scale) || 1);
    slot.mesh.scale.setScalar(radius);
    slot.material.color.set(color);
    slot.peak = 0.5 + near * 0.6;
    slot.material.opacity = slot.peak;
    slot.mesh.visible = true;
    slot.duration = BOUNCE_DURATION;
    slot.life = BOUNCE_DURATION;
  }

  function update(dt) {
    const step = Math.max(0, Number(dt) || 0);
    for (const slot of slots) {
      if (slot.life <= 0) continue;
      slot.life -= step;
      const t = Math.max(0, slot.life / slot.duration);
      slot.material.opacity = slot.peak * t * t;
      if (slot.life <= 0) slot.mesh.visible = false;
    }
  }

  function dispose() {
    for (const slot of slots) {
      slot.mesh.parent?.remove(slot.mesh);
      slot.material.dispose();
    }
    geometry.dispose();
    texture?.dispose();
  }

  return { spawn, update, dispose, slots };
}
