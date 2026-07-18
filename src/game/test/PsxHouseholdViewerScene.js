// Isolated WebGPU catalog viewer for PSX-style household props.
// Loads public/assets/psx-household/catalog.json + category GLBs.
// Boot: ?view=psx-household  (aliases: household-props, psx-props)

import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';

export const CATALOG_URL = '/assets/psx-household/catalog.json';

const TARGET_PROP_SIZE = 1.15;

function prepareViewerMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (mat.map) {
        mat.map.colorSpace = SRGBColorSpace;
        mat.map.needsUpdate = true;
      }
      if ('metalness' in mat) mat.metalness = Math.min(mat.metalness ?? 0, 0.15);
      if ('roughness' in mat) mat.roughness = Math.max(mat.roughness ?? 0.75, 0.55);
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    }
  });
}

function worldBox(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (!Number.isFinite(box.min.x) || box.isEmpty()) {
    return new THREE.Box3(
      new THREE.Vector3(-0.5, 0, -0.5),
      new THREE.Vector3(0.5, 1, 0.5),
    );
  }
  return box;
}

function fitCameraToBox(camera, controls, box, padding = 1.45) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.2);
  const dist = maxDim * padding / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const dir = new THREE.Vector3(0.85, 0.55, 1.0).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.01, dist / 100);
  camera.far = Math.max(50, dist * 20);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = maxDim * 0.35;
  controls.maxDistance = maxDim * 12;
  controls.update();
}

function collectMeshEntries(root) {
  /** @type {Map<string, THREE.Object3D[]>} */
  const byName = new Map();
  root.traverse((child) => {
    if (!child.isMesh) return;
    const key = child.name || child.parent?.name || 'unnamed';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(child);
  });
  return byName;
}

export class PsxHouseholdViewerScene {
  constructor({ canvas, onSnapshot } = {}) {
    this.canvas = canvas;
    this.onSnapshot = onSnapshot;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.loader = null;

    this.catalog = null;
    this.status = 'booting';
    this.error = null;

    /** @type {'packs' | 'characters'} */
    this.mode = 'packs';
    this.packId = null;
    this.meshId = null;
    this.showAllMeshes = false;
    this.filter = '';
    this.normalizeSize = true;
    this.viabilityFilter = 'all'; // all | high | medium | low

    /** @type {Map<string, THREE.Object3D>} */
    this._packScenes = new Map();
    this.root = null;
    this.packRoot = null;
    this.meshNames = [];
    this.visibleMeshCount = 0;
    this.vertexCount = 0;
    this.meshCount = 0;
    this._disposed = false;
  }

  async start() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a2e33);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    this.camera.position.set(2.4, 1.6, 3.0);

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    await this.renderer.init();

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.5, 0);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 40;

    this.setupEnvironment();
    this.installResizeObserver();
    this.resize();

    this.loader = createGltfLoader();
    this.status = 'loading';
    this.emitSnapshot();

    try {
      const res = await fetch(CATALOG_URL);
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      this.catalog = await res.json();
      const packs = this.listPacks();
      const first = packs.find((p) => p.household === 'high') ?? packs[0];
      if (!first) throw new Error('catalog has no packs');
      this.packId = first.id;
      await this.showPack(this.packId);
      this.status = 'ready';
    } catch (err) {
      console.error('[PsxHouseholdViewer] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.emitSnapshot();
    this.renderFrame();

    if (typeof window !== 'undefined') {
      window.__PSX_HOUSEHOLD_DEBUG__ = {
        snapshot: () => this.snapshot(),
        setPack: (id) => this.setPack(id),
        setMesh: (id) => this.setMesh(id),
        setMode: (mode) => this.setMode(mode),
      };
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    this.clearView();
    for (const scene of this._packScenes.values()) {
      disposeObject3D(scene);
    }
    this._packScenes.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    if (typeof window !== 'undefined' && window.__PSX_HOUSEHOLD_DEBUG__) {
      delete window.__PSX_HOUSEHOLD_DEBUG__;
    }
  }

  setupEnvironment() {
    const hemi = new THREE.HemisphereLight(0xf0f4f8, 0x3a3e44, 1.1);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff4e6, 1.55);
    key.position.set(3.2, 6.5, 2.8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xc8d8ef, 0.4);
    fill.position.set(-3.5, 2.2, -2.0);
    this.scene.add(fill);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a3f46,
      roughness: 0.9,
      metalness: 0,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.04, 12), floorMaterial);
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(12, 24, 0x5a6570, 0x3a424a);
    grid.position.y = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    this.scene.add(grid);
  }

  listPacks() {
    const packs = this.catalog?.packs ?? [];
    if (this.viabilityFilter === 'all') return packs;
    return packs.filter((p) => p.household === this.viabilityFilter);
  }

  listCharacters() {
    return this.catalog?.characters ?? [];
  }

  getActivePackMeta() {
    if (this.mode === 'characters') {
      return this.listCharacters().find((c) => c.id === this.packId) ?? null;
    }
    return (this.catalog?.packs ?? []).find((p) => p.id === this.packId) ?? null;
  }

  filteredMeshNames() {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.meshNames;
    return this.meshNames.filter((n) => n.toLowerCase().includes(q));
  }

  async loadAsset(url) {
    if (this._packScenes.has(url)) return this._packScenes.get(url);
    const gltf = await this.loader.loadAsync(url);
    const scene = gltf.scene;
    flattenObjectForWebGPU(scene);
    prepareViewerMaterials(scene);
    scene.updateMatrixWorld(true);
    this._packScenes.set(url, scene);
    return scene;
  }

  clearView() {
    if (this.root) {
      this.scene?.remove(this.root);
      // Clones share geometries/materials with the pack cache — do not dispose here.
      this.root = null;
    }
    this.packRoot = null;
    this.meshNames = [];
    this.visibleMeshCount = 0;
    this.vertexCount = 0;
    this.meshCount = 0;
  }

  async showPack(packId) {
    this.packId = packId;
    this.status = 'loading';
    this.error = null;
    this.emitSnapshot();

    const meta = this.getActivePackMeta();
    if (!meta?.url) throw new Error(`Unknown pack '${packId}'`);

    const asset = await this.loadAsset(meta.url);
    this.clearView();

    const clone = asset.clone(true);
    clone.updateMatrixWorld(true);
    prepareViewerMaterials(clone);

    const byName = collectMeshEntries(clone);
    this.meshNames = [...byName.keys()].sort((a, b) => a.localeCompare(b));
    this.meshCount = this.meshNames.length;

    // Catalog may list meshes; prefer live scene names when available.
    if (this.meshId && !byName.has(this.meshId)) {
      this.meshId = null;
    }
    if (!this.showAllMeshes && !this.meshId && this.meshNames.length) {
      this.meshId = this.meshNames[0];
    }

    const root = new THREE.Group();
    root.name = `psx-household-${packId}`;
    root.add(clone);
    this.scene.add(root);
    this.root = root;
    this.packRoot = clone;

    this.applyMeshVisibility();
    this.frameSelection();
    this.status = 'ready';
    this.emitSnapshot();
  }

  applyMeshVisibility() {
    if (!this.packRoot) return;
    const byName = collectMeshEntries(this.packRoot);
    let verts = 0;
    let visible = 0;

    for (const [name, meshes] of byName) {
      const on = this.showAllMeshes || name === this.meshId;
      for (const mesh of meshes) {
        mesh.visible = on;
        if (on) {
          visible += 1;
          const pos = mesh.geometry?.attributes?.position;
          if (pos) verts += pos.count;
        }
      }
    }

    this.visibleMeshCount = visible;
    this.vertexCount = verts;

    if (this.normalizeSize && this.root) {
      // Reset scale, then normalize visible subset.
      this.packRoot.scale.set(1, 1, 1);
      this.packRoot.position.set(0, 0, 0);
      this.packRoot.updateMatrixWorld(true);

      // Build a temporary group of visible meshes for bounding box.
      const box = new THREE.Box3();
      let any = false;
      this.packRoot.traverse((child) => {
        if (child.isMesh && child.visible) {
          box.expandByObject(child);
          any = true;
        }
      });
      if (any && !box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
        const scale = TARGET_PROP_SIZE / maxDim;
        this.packRoot.scale.setScalar(scale);
        this.packRoot.updateMatrixWorld(true);
        const scaled = new THREE.Box3();
        this.packRoot.traverse((child) => {
          if (child.isMesh && child.visible) scaled.expandByObject(child);
        });
        const center = scaled.getCenter(new THREE.Vector3());
        this.packRoot.position.x -= center.x;
        this.packRoot.position.z -= center.z;
        this.packRoot.position.y -= scaled.min.y;
        this.packRoot.updateMatrixWorld(true);
      }
    }
  }

  frameSelection() {
    if (!this.root || !this.camera || !this.controls) return;
    const box = new THREE.Box3();
    let any = false;
    this.root.traverse((child) => {
      if (child.isMesh && child.visible) {
        box.expandByObject(child);
        any = true;
      }
    });
    if (!any) {
      fitCameraToBox(this.camera, this.controls, worldBox(this.root));
      return;
    }
    fitCameraToBox(this.camera, this.controls, box);
  }

  setMode(mode) {
    if (mode !== 'packs' && mode !== 'characters') return;
    if (mode === this.mode) return;
    this.mode = mode;
    this.meshId = null;
    this.showAllMeshes = mode === 'characters';
    const list = mode === 'characters' ? this.listCharacters() : this.listPacks();
    const next = list[0];
    if (!next) {
      this.clearView();
      this.emitSnapshot();
      return;
    }
    void this.showPack(next.id).catch((err) => {
      this.status = 'failed';
      this.error = err?.message ?? String(err);
      this.emitSnapshot();
    });
  }

  setPack(packId) {
    if (packId === this.packId && this.root) return;
    this.meshId = null;
    void this.showPack(packId).catch((err) => {
      console.error(err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
      this.emitSnapshot();
    });
  }

  setMesh(meshId) {
    this.meshId = meshId;
    this.showAllMeshes = false;
    this.applyMeshVisibility();
    this.frameSelection();
    this.emitSnapshot();
  }

  setShowAllMeshes(enabled) {
    this.showAllMeshes = !!enabled;
    if (this.showAllMeshes) this.meshId = null;
    else if (!this.meshId && this.meshNames.length) this.meshId = this.meshNames[0];
    this.applyMeshVisibility();
    this.frameSelection();
    this.emitSnapshot();
  }

  setFilter(text) {
    this.filter = String(text ?? '');
    this.emitSnapshot();
  }

  setViabilityFilter(value) {
    this.viabilityFilter = value || 'all';
    // If current pack is filtered out, jump to first remaining.
    if (this.mode === 'packs') {
      const packs = this.listPacks();
      if (packs.length && !packs.some((p) => p.id === this.packId)) {
        this.setPack(packs[0].id);
        return;
      }
    }
    this.emitSnapshot();
  }

  setNormalizeSize(enabled) {
    this.normalizeSize = !!enabled;
    this.applyMeshVisibility();
    this.frameSelection();
    this.emitSnapshot();
  }

  nextMesh(step = 1) {
    const list = this.filteredMeshNames();
    if (!list.length) return;
    const idx = Math.max(0, list.indexOf(this.meshId));
    const next = list[(idx + step + list.length) % list.length];
    this.setMesh(next);
  }

  nextPack(step = 1) {
    const list = this.mode === 'characters' ? this.listCharacters() : this.listPacks();
    if (!list.length) return;
    const idx = Math.max(0, list.findIndex((p) => p.id === this.packId));
    const next = list[(idx + step + list.length) % list.length];
    this.setPack(next.id);
  }

  installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
  }

  resize() {
    if (!this.renderer || !this.camera || !this.canvas) return;
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth ?? 1);
    const height = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight ?? 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  renderFrame = () => {
    this.animationFrame = requestAnimationFrame(this.renderFrame);
    if (!this.renderer || !this.scene || !this.camera) return;
    this.clock.getDelta();
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  };

  snapshot() {
    const meta = this.getActivePackMeta();
    return {
      status: this.status,
      error: this.error,
      mode: this.mode,
      packId: this.packId,
      packLabel: meta?.label ?? this.packId,
      household: meta?.household ?? null,
      notes: meta?.notes ?? null,
      meshId: this.meshId,
      showAllMeshes: this.showAllMeshes,
      filter: this.filter,
      viabilityFilter: this.viabilityFilter,
      normalizeSize: this.normalizeSize,
      meshNames: this.meshNames,
      filteredMeshNames: this.filteredMeshNames(),
      meshCount: this.meshCount,
      visibleMeshCount: this.visibleMeshCount,
      verts: this.vertexCount,
      bytesLabel: meta?.bytesLabel ?? null,
      packs: this.listPacks().map((p) => ({
        id: p.id,
        label: p.label,
        household: p.household,
        meshCount: p.meshCount,
        bytesLabel: p.bytesLabel,
        previewUrl: p.previewUrl,
        notes: p.notes,
      })),
      characters: this.listCharacters().map((c) => ({
        id: c.id,
        label: c.label,
        household: c.household,
        bytesLabel: c.bytesLabel,
      })),
      viability: this.catalog?.viability ?? null,
      totals: this.catalog?.totals ?? null,
      runtimeNotes: this.catalog?.runtimeNotes ?? [],
    };
  }

  emitSnapshot() {
    this.onSnapshot?.(this.snapshot());
  }
}
