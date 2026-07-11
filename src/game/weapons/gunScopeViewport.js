/**
 * Authored picture-in-picture optic viewport shared by Gunsmith and runtime.
 * CylinderGeometry is rotated so its axis follows weapon Z (muzzle is -Z).
 */

import * as THREE from 'three';

export const DEFAULT_SCOPE_VIEWPORT = Object.freeze({
  enabled: true,
  position: Object.freeze([0, 0.12, -0.08]),
  quaternion: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
  radius: 0.025,
  depth: 0.004,
  magnification: 8,
  resolution: 384,
  eyeRelief: 0.16,
  // CylinderGeometry cap UVs are quarter-turned after its axis is moved Y → Z.
  viewRotationDeg: 90,
});

function vec3(value, fallback) {
  return Array.isArray(value) && value.length >= 3
    ? value.slice(0, 3).map((item, index) => Number.isFinite(Number(item)) ? Number(item) : fallback[index])
    : [...fallback];
}

function quat(value, fallback) {
  return Array.isArray(value) && value.length >= 4
    ? value.slice(0, 4).map((item, index) => Number.isFinite(Number(item)) ? Number(item) : fallback[index])
    : [...fallback];
}

export function normalizeScopeViewport(raw) {
  if (!raw || raw.enabled === false) return null;
  return {
    enabled: true,
    position: vec3(raw.position, DEFAULT_SCOPE_VIEWPORT.position),
    quaternion: quat(raw.quaternion, DEFAULT_SCOPE_VIEWPORT.quaternion),
    scale: vec3(raw.scale, DEFAULT_SCOPE_VIEWPORT.scale).map((item) => Math.max(0.05, Math.abs(item))),
    radius: THREE.MathUtils.clamp(Number(raw.radius) || DEFAULT_SCOPE_VIEWPORT.radius, 0.005, 0.12),
    depth: THREE.MathUtils.clamp(Number(raw.depth) || DEFAULT_SCOPE_VIEWPORT.depth, 0.001, 0.04),
    magnification: THREE.MathUtils.clamp(Number(raw.magnification) || DEFAULT_SCOPE_VIEWPORT.magnification, 1, 24),
    resolution: THREE.MathUtils.clamp(Math.round(Number(raw.resolution) || DEFAULT_SCOPE_VIEWPORT.resolution), 128, 1024),
    eyeRelief: THREE.MathUtils.clamp(Number(raw.eyeRelief) || DEFAULT_SCOPE_VIEWPORT.eyeRelief, 0.05, 0.4),
    viewRotationDeg: THREE.MathUtils.clamp(
      Number.isFinite(Number(raw.viewRotationDeg))
        ? Number(raw.viewRotationDeg)
        : DEFAULT_SCOPE_VIEWPORT.viewRotationDeg,
      -180,
      180,
    ),
  };
}

export function createDefaultScopeViewport(adsAnchor = null) {
  const position = [...DEFAULT_SCOPE_VIEWPORT.position];
  if (adsAnchor?.position) {
    position[0] = Number(adsAnchor.position[0]) || 0;
    position[1] = Number(adsAnchor.position[1]) || 0;
    position[2] = (Number(adsAnchor.position[2]) || 0) - 0.1;
  }
  return normalizeScopeViewport({ ...DEFAULT_SCOPE_VIEWPORT, position });
}

function createGeometry(config) {
  const geometry = new THREE.CylinderGeometry(
    config.radius,
    config.radius,
    config.depth,
    48,
    1,
    false,
  );
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function applyTransform(mesh, config) {
  mesh.position.fromArray(config.position);
  mesh.quaternion.fromArray(config.quaternion);
  mesh.scale.fromArray(config.scale);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
}

export function createScopeViewportPreview(config) {
  const normalized = normalizeScopeViewport(config);
  if (!normalized) return null;
  const material = new THREE.MeshBasicMaterial({
    color: 0x39c8ff,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(createGeometry(normalized), material);
  mesh.name = 'GunsmithScopeViewport';
  mesh.userData._scopeViewport = true;
  mesh.userData._gunsmithMesh = false;
  applyTransform(mesh, normalized);
  return mesh;
}

export function createRuntimeScopeViewport(config, adsAnchor, gunRoot) {
  const normalized = normalizeScopeViewport(config);
  if (!normalized || !adsAnchor || !gunRoot) return null;

  const renderTarget = new THREE.RenderTarget(normalized.resolution, normalized.resolution, {
    depthBuffer: true,
  });
  renderTarget.texture.name = 'GunScopeViewport';
  renderTarget.texture.generateMipmaps = false;
  renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  renderTarget.texture.center.set(0.5, 0.5);
  // Cylinder cap UV V runs opposite screen-space Y after the Y → Z geometry
  // rotation. Flip around the texture center so the magnified view stays upright.
  renderTarget.texture.repeat.y = -1;
  renderTarget.texture.rotation = THREE.MathUtils.degToRad(normalized.viewRotationDeg);
  renderTarget.texture.updateMatrix();

  const shellMaterial = new THREE.MeshBasicMaterial({ color: 0x101317, toneMapped: false });
  const viewMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: renderTarget.texture,
    toneMapped: false,
  });
  const darkCapMaterial = new THREE.MeshBasicMaterial({ color: 0x071015, toneMapped: false });
  // Cylinder groups: wall, +axis cap (rear/eye-facing after rotateX), -axis cap.
  const mesh = new THREE.Mesh(
    createGeometry(normalized),
    [shellMaterial, darkCapMaterial, darkCapMaterial],
  );
  mesh.name = 'RuntimeScopeViewport';
  mesh.userData._scopeViewport = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  applyTransform(mesh, normalized);
  gunRoot.add(mesh);

  const camera = new THREE.PerspectiveCamera(18, 1, 0.05, 2000);
  camera.name = 'RuntimeScopeCamera';
  let adsBlend = 0;

  return {
    config: normalized,
    mesh,
    camera,
    renderTarget,
    gunRoot,
    get active() { return adsBlend > 0.05 && mesh.visible; },
    setAds(blend = 0) {
      adsBlend = THREE.MathUtils.clamp(Number(blend) || 0, 0, 1);
      mesh.material[1] = adsBlend > 0.05 ? viewMaterial : darkCapMaterial;
    },
    updateCamera(mainCamera) {
      // Optical aim follows the gameplay/hitscan camera exactly. The authored
      // viewport controls where the screen sits on the gun, not where bullets aim.
      mainCamera.updateWorldMatrix(true, false);
      mainCamera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
      camera.scale.set(1, 1, 1);
      const mainFov = Number(mainCamera?.fov) || 74;
      camera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(mainFov) / 2) / normalized.magnification),
      );
      camera.near = Math.max(0.02, Number(mainCamera?.near) || 0.05);
      camera.far = Number(mainCamera?.far) || 2000;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    },
    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      shellMaterial.dispose();
      viewMaterial.dispose();
      darkCapMaterial.dispose();
      renderTarget.dispose();
    },
  };
}
