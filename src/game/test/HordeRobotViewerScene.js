// Isolated WebGPU viewer for the three Horde robot GLBs.
// Human gate for M0: inspect idle / run / attack / arm-missing / one-leg / crawl
// deformation on cyclop, tessy, and faceless before M2 consumes the assets.
//
// Boot: ?view=horde-robots  (or switch via console: set viewMode to 'hordeRobots')

import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ENEMY_ARCHETYPES } from '../config/enemyArchetypes.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';

export const HORDE_BOTS = ['cyclop', 'tessy', 'faceless'];

// All 13 clips the asset contract requires (rifle-pack + disability-pack).
export const ALL_CLIPS = [
  'Idle',
  'Walk',
  'Run',
  'Idle Alert',
  'Bite',
  'Head Missing',
  'Head Missing 2',
  'Left Arm Missing Walk',
  'Right Arm Missing Walk',
  'Left Leg Missing',
  'Right Leg Missing',
  'Crawl Forward',
  'Crawl Back',
];

// Six gate states the plan calls out for human deformation inspection.
// id is stable for UI; clip is the exact GLB animation name.
export const GATE_CLIPS = [
  { id: 'idle', label: 'Idle', clip: 'Idle' },
  { id: 'run', label: 'Run', clip: 'Run' },
  { id: 'attack', label: 'Attack', clip: 'Bite' },
  { id: 'arm-missing', label: 'Arm missing', clip: 'Left Arm Missing Walk' },
  { id: 'one-leg', label: 'One leg', clip: 'Left Leg Missing' },
  { id: 'crawl', label: 'Crawl', clip: 'Crawl Forward' },
];

const GATE_CLIP_NAMES = new Set(GATE_CLIPS.map((g) => g.clip));

export class HordeRobotViewerScene {
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

    this.botId = HORDE_BOTS[0];
    this.clipName = GATE_CLIPS[0].clip;
    this.status = 'booting';
    this.error = null;
    this.autoCycle = false;
    this.autoCycleElapsed = 0;
    this.autoCycleSeconds = 3.5;
    this.orientationFlip = false;

    /** @type {Map<string, { scene: THREE.Object3D, clips: THREE.AnimationClip[] }>} */
    this._assets = new Map();
    this.root = null;
    this.inner = null;
    this.mixer = null;
    this.action = null;
    this.clipNames = [];
    this.clipDuration = 0;
    this.skinnedMeshes = 0;
    this.boneCount = 0;
    this.vertexCount = 0;
  }

  async start() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd7e2dc);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(3.4, 2.0, 4.2);

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
    this.controls.target.set(0, 1.0, 0);
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 12;

    this.setupEnvironment();
    this.installResizeObserver();
    this.resize();

    this.loader = createGltfLoader();
    this.status = 'loading';
    this.emitSnapshot();

    try {
      await this.preloadAll();
      await this.showBot(this.botId);
      this.status = 'ready';
    } catch (err) {
      console.error('[HordeRobotViewer] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.emitSnapshot();
    this.renderFrame();
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
    this.clearModel();
    this._assets.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
  }

  setupEnvironment() {
    const hemi = new THREE.HemisphereLight(0xf0f4f2, 0x5a6660, 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff6e8, 1.65);
    key.position.set(3.2, 6.5, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xc8d8ef, 0.45);
    fill.position.set(-3.5, 2.5, -2.0);
    this.scene.add(fill);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x7f918a,
      roughness: 0.82,
      metalness: 0,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.05, 8), floorMaterial);
    floor.position.y = -0.025;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(8, 16, 0x46635c, 0x9aaca5);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    this.scene.add(grid);
  }

  async preloadAll() {
    for (const bot of HORDE_BOTS) {
      if (this._assets.has(bot)) continue;
      const cfg = ENEMY_ARCHETYPES[bot];
      if (!cfg?.url) throw new Error(`No archetype url for '${bot}'`);
      const gltf = await this.loader.loadAsync(cfg.url);
      this._assets.set(bot, {
        scene: gltf.scene,
        clips: gltf.animations ?? [],
      });
    }
  }

  async showBot(botId) {
    if (!HORDE_BOTS.includes(botId)) {
      throw new Error(`Unknown bot '${botId}'`);
    }
    this.botId = botId;
    this.status = 'loading';
    this.emitSnapshot();

    if (!this._assets.has(botId)) {
      await this.preloadAll();
    }

    this.clearModel();

    const cfg = ENEMY_ARCHETYPES[botId];
    const asset = this._assets.get(botId);
    const clone = cloneSkeleton(asset.scene);
    clone.updateMatrixWorld(true);
    clone.traverse((child) => {
      if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
    });

    flattenObjectForWebGPU(clone);
    prepareViewerMaterials(clone);

    // Match EnemySystem spawn path: optional orientation fix, then height normalize.
    let orientationX = cfg.orientationFixX ?? 0;
    if (this.orientationFlip) {
      orientationX += -Math.PI / 2;
    }
    if (orientationX) {
      clone.rotation.x = orientationX;
    }
    normalizeToHeight(clone, cfg.targetHeight ?? 2.0);

    const root = new THREE.Group();
    root.name = `horde-viewer-${botId}`;
    root.add(clone);
    this.scene.add(root);

    this.root = root;
    this.inner = clone;
    this.mixer = new THREE.AnimationMixer(clone);
    this.clipNames = (asset.clips ?? []).map((c) => c.name).filter(Boolean);

    this.skinnedMeshes = 0;
    this.boneCount = 0;
    this.vertexCount = 0;
    const boneSet = new Set();
    clone.traverse((child) => {
      if (child.isSkinnedMesh) {
        this.skinnedMeshes += 1;
        const pos = child.geometry?.attributes?.position;
        if (pos) this.vertexCount += pos.count;
        for (const bone of child.skeleton?.bones ?? []) {
          boneSet.add(bone.uuid);
        }
      }
    });
    this.boneCount = boneSet.size;

    // Prefer current clip if present on this bot, else first gate clip, else first clip.
    const preferred = this.clipNames.includes(this.clipName)
      ? this.clipName
      : (GATE_CLIPS.find((g) => this.clipNames.includes(g.clip))?.clip
        ?? this.clipNames[0]
        ?? null);

    this.playClip(preferred);
    this.status = 'ready';
    this.emitSnapshot();
  }

  clearModel() {
    if (this.action) {
      this.action.stop();
      this.action = null;
    }
    this.mixer?.stopAllAction();
    this.mixer = null;
    if (this.root) {
      this.scene?.remove(this.root);
      // Dispose clone only (shared asset.scene stays in _assets for re-clone).
      this.root.traverse((child) => {
        child.skeleton?.dispose?.();
      });
      disposeObject3D(this.root);
      this.root = null;
    }
    this.inner = null;
    this.clipDuration = 0;
  }

  playClip(clipName) {
    if (!this.mixer || !clipName) return false;
    const asset = this._assets.get(this.botId);
    const clip = (asset?.clips ?? []).find((c) => c.name === clipName);
    if (!clip) {
      console.warn(`[HordeRobotViewer] clip '${clipName}' missing on ${this.botId}`);
      return false;
    }

    if (this.action) {
      this.action.fadeOut(0.12);
    }
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.fadeIn(0.12);
    next.play();
    this.action = next;
    this.clipName = clipName;
    this.clipDuration = clip.duration ?? 0;
    this.autoCycleElapsed = 0;
    this.emitSnapshot();
    return true;
  }

  setBot(botId) {
    if (botId === this.botId && this.root) return;
    void this.showBot(botId).catch((err) => {
      console.error(err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
      this.emitSnapshot();
    });
  }

  setClip(clipName) {
    this.playClip(clipName);
  }

  nextClip(step = 1) {
    const list = this.clipNames.length ? this.clipNames : ALL_CLIPS;
    const idx = Math.max(0, list.indexOf(this.clipName));
    const next = list[(idx + step + list.length) % list.length];
    this.playClip(next);
  }

  nextGateClip(step = 1) {
    const present = GATE_CLIPS.filter((g) => this.clipNames.includes(g.clip));
    const list = present.length ? present : GATE_CLIPS;
    const idx = Math.max(0, list.findIndex((g) => g.clip === this.clipName));
    const next = list[(idx + step + list.length) % list.length];
    this.playClip(next.clip);
  }

  setAutoCycle(enabled) {
    this.autoCycle = !!enabled;
    this.autoCycleElapsed = 0;
    this.emitSnapshot();
  }

  setOrientationFlip(enabled) {
    this.orientationFlip = !!enabled;
    // Rebuild current bot so orientation applies before height normalize.
    void this.showBot(this.botId);
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

    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.autoCycle && this.status === 'ready') {
      this.autoCycleElapsed += dt;
      if (this.autoCycleElapsed >= this.autoCycleSeconds) {
        this.autoCycleElapsed = 0;
        this.nextGateClip(1);
      }
    }

    this.mixer?.update(dt);
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  };

  emitSnapshot() {
    const snap = this.snapshot();
    this.onSnapshot?.(snap);
    return snap;
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      botId: this.botId,
      clipName: this.clipName,
      clipDuration: Number(this.clipDuration.toFixed(3)),
      clipNames: [...this.clipNames],
      isGateClip: GATE_CLIP_NAMES.has(this.clipName),
      autoCycle: this.autoCycle,
      orientationFlip: this.orientationFlip,
      skinnedMeshes: this.skinnedMeshes,
      bones: this.boneCount,
      verts: this.vertexCount,
      targetHeight: ENEMY_ARCHETYPES[this.botId]?.targetHeight ?? null,
      orientationFixX: ENEMY_ARCHETYPES[this.botId]?.orientationFixX ?? 0,
    };
  }
}

function prepareViewerMaterials(root) {
  root.traverse((child) => {
    if (!(child.isMesh || child.isSkinnedMesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      // Avoid pure-black metallic look under hemisphere-only lighting (no IBL).
      if ('metalness' in material) {
        material.metalness = Math.min(material.metalness ?? 0, 0.35);
      }
      if ('roughness' in material) {
        material.roughness = Math.max(material.roughness ?? 0.6, 0.45);
      }
      if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
      }
      if ((material.opacity ?? 1) >= 1) {
        material.transparent = false;
        material.depthWrite = true;
      }
      material.needsUpdate = true;
    }
  });
}

function normalizeToHeight(root, targetHeight) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.y) || size.y <= 0) return;
  const scale = targetHeight / size.y;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  const normalizedBox = new THREE.Box3().setFromObject(root, true);
  root.position.y -= normalizedBox.min.y;
}
