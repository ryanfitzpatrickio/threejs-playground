import * as THREE from 'three';
import { SURFACE_IMPACT_PRESETS } from './createWeaponImpactRenderer.js';

const DEFAULT_CAPACITY = 96;
// Versioned URLs make newly keyed atlas pixels visible immediately after a
// live reload instead of reusing an old browser-cached chroma image.
const ATLAS_URL = '/assets/textures/fx/bullet-hole-atlas-7x7.png?v=2';
const CATALOG_URL = '/assets/textures/fx/bullet-hole-atlas-7x7.catalog.json?v=2';
const _normal = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, 1);

/** Bounded world-space decal pool, selecting an authored atlas frame per surface. */
export function createBulletDecalRenderer(scene, { capacity = DEFAULT_CAPACITY } = {}) {
  const slots = [];
  let atlasTexture = null;
  let atlasReady = false;
  let grid = { columns: 7, rows: 7, insetUv: 0.012 };
  let framesById = new Map();
  let surfaceFrames = {};

  for (let i = 0; i < capacity; i += 1) {
    // Each slot owns only a four-vertex plane so its UVs can point at a unique
    // atlas cell while every material shares the single loaded texture.
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0x302d28,
      transparent: true,
      opacity: 0.96,
      alphaTest: 0.01,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 43;
    scene.add(mesh);
    slots.push({
      mesh, geometry, material,
      baseUvs: Float32Array.from(geometry.attributes.uv.array),
      life: 0, maxLife: 32, frameId: null,
    });
  }

  loadAtlas();

  function loadAtlas() {
    // Unit checks run in Node without DOM image support; retain the plain fallback there.
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const loader = new THREE.TextureLoader();
    loader.load(ATLAS_URL, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      atlasTexture = texture;
      enableAtlasWhenReady();
    }, undefined, () => {
      // Keep the fallback rather than dropping visible hit feedback.
    });
    fetch(CATALOG_URL)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((catalog) => {
        grid = { ...grid, ...(catalog.grid ?? {}) };
        framesById = new Map((catalog.frames ?? []).map((frame) => [frame.id, frame]));
        surfaceFrames = catalog.surfaceFrames ?? {};
        enableAtlasWhenReady();
      })
      .catch(() => {
        // Asset/catalog failures must not prevent firing or decal cleanup.
      });
  }

  function enableAtlasWhenReady() {
    if (!atlasTexture || framesById.size === 0) return;
    atlasReady = true;
    for (const slot of slots) {
      slot.material.map = atlasTexture;
      slot.material.color.set(0xffffff);
      slot.material.needsUpdate = true;
      if (!slot.frameId) applyFrame(slot, selectFrame('generic'));
    }
  }

  function selectFrame(surfaceClass) {
    const ids = surfaceFrames[surfaceClass] ?? surfaceFrames.generic ?? [];
    if (!ids.length) return null;
    return framesById.get(ids[Math.floor(Math.random() * ids.length)]) ?? null;
  }

  function applyFrame(slot, frame) {
    slot.frameId = frame?.id ?? null;
    if (!frame) return;
    const [column, row] = frame.cell;
    const columns = Number(grid.columns) || 7;
    const rows = Number(grid.rows) || 7;
    const inset = THREE.MathUtils.clamp(Number(grid.insetUv) || 0, 0, 0.1);
    const u0 = (column + inset) / columns;
    const u1 = (column + 1 - inset) / columns;
    // Catalog rows are top-left, while texture UV row zero is at the bottom.
    const v0 = (rows - row - 1 + inset) / rows;
    const v1 = (rows - row - inset) / rows;
    const uv = slot.geometry.attributes.uv;
    // Preserve the plane's vertex orientation; only remap its 0/1 coordinates.
    for (let i = 0; i < uv.count; i += 1) {
      const u = slot.baseUvs[i * 2];
      const v = slot.baseUvs[i * 2 + 1];
      uv.setXY(i, u < 0.5 ? u0 : u1, v < 0.5 ? v0 : v1);
    }
    uv.needsUpdate = true;
  }

  function spawn({ point, normal, surfaceClass = 'generic', intensity = 1 } = {}) {
    if (!point || surfaceClass === 'flesh' || surfaceClass === 'soil') return;
    const slot = slots.find((entry) => entry.life <= 0)
      ?? slots.reduce((oldest, entry) => entry.life < oldest.life ? entry : oldest, slots[0]);
    if (!slot) return;
    _normal.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_normal.lengthSq() < 1e-6) _normal.set(0, 1, 0);
    _normal.normalize();
    const preset = SURFACE_IMPACT_PRESETS[surfaceClass] ?? SURFACE_IMPACT_PRESETS.generic;
    slot.mesh.position.set(point.x, point.y, point.z).addScaledVector(_normal, 0.008);
    slot.mesh.quaternion.setFromUnitVectors(_forward, _normal);
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);
    const size = preset.size * (0.65 + Math.random() * 0.44) * Math.max(0.7, Number(intensity) || 1);
    slot.mesh.scale.setScalar(size);
    slot.material.color.set(surfaceClass === 'glass' ? 0x9bc7ce : surfaceClass === 'wood' ? 0x4e2b19 : surfaceClass === 'metal' ? 0x22262a : 0x302d28);
    if (atlasReady) slot.material.color.set(0xffffff);
    slot.material.opacity = 0.96;
    applyFrame(slot, selectFrame(surfaceClass));
    slot.mesh.visible = true;
    slot.maxLife = 32;
    slot.life = slot.maxLife;
  }

  function update(dt) {
    const step = Math.max(0, Number(dt) || 0);
    for (const slot of slots) {
      if (slot.life <= 0) continue;
      slot.life -= step;
      slot.material.opacity = 0.96 * Math.min(1, slot.life / 4);
      if (slot.life <= 0) slot.mesh.visible = false;
    }
  }

  function dispose() {
    for (const slot of slots) {
      slot.mesh.parent?.remove(slot.mesh);
      slot.geometry.dispose();
      slot.material.dispose();
    }
    atlasTexture?.dispose();
  }

  return { spawn, update, dispose, slots, get atlasReady() { return atlasReady; } };
}
