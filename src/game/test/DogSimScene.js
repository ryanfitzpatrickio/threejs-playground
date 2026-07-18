/**
 * Isolated WebGPU scene for the procedural dog simulation.
 *
 * Boot: main menu "Dog" card, or ?view=dog-sim (aliases: dog, dogsim)
 * Harness: ?harness (or &harness=1) — deterministic scenarios, frozen blink/breeze,
 * camera/lighting presets, side-by-side photo panel hooks, gallery API.
 *
 * Global scripting API: window.__DOG_SIM_DEBUG__
 */

import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createProceduralDog } from '../characters/dog/createProceduralDog.js';
import {
  AUTHORED_DOG_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  getAuthoredDogBreeds,
  getDogBreed,
  normalizeDogSeed,
  normalizeRenderableDogBreedId,
} from '../characters/dog/index.js';

const FIXED_DT = 1 / 60;

/** Resolve a still under public/assets/dog-ref/. */
export function dogRefUrl(filename, breedId = 'golden-retriever') {
  return breedId === 'golden-retriever'
    ? `/assets/dog-ref/${filename}`
    : `/assets/dog-ref/${breedId}/${filename}`;
}

/**
 * Reference photo slots for the 5-pair gallery.
 * `refImage` is the primary still shown in the side-by-side compare panel.
 * Extra stills for a preset can live as `{id}-*.jpg` in the same folder.
 */
export const DOG_REFERENCE_PRESETS = [
  {
    id: 'three-quarter',
    label: 'Three-quarter',
    camera: { pos: [1.45, 0.85, 1.55], target: [0, 0.42, 0.05] },
    light: { key: [2.8, 5.5, 2.2], keyIntensity: 1.7, hemi: 1.1 },
    behavior: 'idle',
    settleSeconds: 1.2,
    // Placeholder full-body until authored; currently a head three-quarter still.
    refImage: dogRefUrl('three-quarter.jpg'),
    refFile: 'three-quarter.jpg',
  },
  {
    id: 'profile',
    label: 'Profile',
    camera: { pos: [2.1, 0.55, 0.15], target: [0, 0.45, 0.1] },
    light: { key: [1.2, 4.5, 3.5], keyIntensity: 1.55, hemi: 1.05 },
    behavior: 'look',
    settleSeconds: 1.0,
    refImage: dogRefUrl('head-close-profile.jpg'),
    refFile: 'profile.jpg',
  },
  {
    id: 'front-sit',
    label: 'Front sit',
    camera: { pos: [0.15, 0.7, 2.0], target: [0, 0.38, 0.05] },
    light: { key: [2.0, 5.0, 3.0], keyIntensity: 1.65, hemi: 1.15 },
    behavior: 'sit',
    settleSeconds: 1.6,
    refImage: dogRefUrl('head-close-front.jpg'),
    refFile: 'front-sit.jpg',
  },
  {
    id: 'walk-side',
    label: 'Walk side',
    camera: { pos: [2.4, 0.7, 0.4], target: [0, 0.4, 0] },
    light: { key: [3.0, 5.0, 1.0], keyIntensity: 1.6, hemi: 1.0 },
    behavior: 'walk',
    settleSeconds: 2.0,
    refImage: dogRefUrl('head-close-profile.jpg'),
    refFile: 'profile.jpg',
  },
  {
    id: 'head-close',
    label: 'Head close-up',
    // Framed to match ref portrait: slightly three-quarter, eyes center.
    camera: { pos: [0.42, 0.72, 0.78], target: [0, 0.62, 0.42] },
    light: { key: [1.6, 3.6, 2.6], keyIntensity: 1.5, hemi: 1.1 },
    behavior: 'look',
    settleSeconds: 1.0,
    refImage: dogRefUrl('head-close.jpg'),
    refFile: 'head-close.jpg',
    refAlts: [
      dogRefUrl('head-close-front.jpg'),
      dogRefUrl('head-close-profile.jpg'),
    ],
  },
];

function isTruthyParam(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === '';
}

export class DogSimScene {
  /**
   * @param {{ canvas: HTMLCanvasElement, onSnapshot?: (s: object) => void }} opts
   */
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
    this._disposed = false;

    this.dog = null;
    this.status = 'booting';
    this.error = null;
    this.liveMotion = true;
    this.harnessMode = false;
    this.activePresetId = DOG_REFERENCE_PRESETS[0].id;
    this.galleryIndex = 0;
    this.compareEnabled = false;
    this.shellCount = 64;
    this.familyId = 'retriever-sporting';
    this.breedId = 'golden-retriever';
    this.seed = 1;
    this._bootNaked = false;

    this.keyLight = null;
    this.hemiLight = null;
    this.fillLight = null;

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      this.harnessMode = isTruthyParam(params.get('harness'));
      const shells = Number(params.get('shells'));
      if (Number.isFinite(shells) && shells >= 4 && shells <= 80) {
        this.shellCount = Math.floor(shells);
      }
      if (params.get('naked') === '1') this._bootNaked = true;
      if (params.get('motion') === '0') this.liveMotion = false;
    }
  }

  async start() {
    this.scene = new THREE.Scene();
    // Overwritten in setupEnvironment to match ref stills.
    this.scene.background = new THREE.Color(0xc5cdc6);
    this.scene.fog = new THREE.Fog(0xc5cdc6, 6, 18);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
    this.camera.position.set(1.45, 0.85, 1.55);

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
    this.controls.target.set(0, 0.42, 0.05);
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 8;

    this.setupEnvironment();
    this.installResizeObserver();
    this.resize();

    try {
      this.dog = createProceduralDog({
        breedId: this.breedId,
        seed: this.seed,
        shellCount: this.shellCount,
      });
      this.scene.add(this.dog.root);
      if (this._bootNaked) this.dog.setNakedBody(true);

      if (this.harnessMode) {
        this.enterHarnessDefaults();
      } else {
        // Default framing matches the primary reference still for side-by-side.
        const headClose = DOG_REFERENCE_PRESETS.find((p) => p.id === 'head-close');
        if (headClose) {
          this.dog.animation.setAutopilot(false);
          this.dog.animation.setBehavior('look');
          this.applyPreset(headClose, { settle: false });
        }
      }

      this.status = 'ready';
      this.installDebugApi();
    } catch (err) {
      console.error('[DogSim] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.emitSnapshot();
    this.renderFrame();
  }

  enterHarnessDefaults() {
    this.liveMotion = false;
    this.dog?.animation.setAutopilot(false);
    this.dog?.animation.setFrozenBlink(true);
    this.dog?.animation.setFrozenBreeze(true);
    this.dog?.animation.setBehavior('idle');
    this.applyPreset(DOG_REFERENCE_PRESETS[0], { settle: true });
  }

  setupEnvironment() {
    // Soft studio palette matching dog-ref stills (sage-gray seamless).
    this.scene.background = new THREE.Color(0xc5cdc6);
    this.scene.fog = new THREE.Fog(0xc5cdc6, 6, 18);

    this.hemiLight = new THREE.HemisphereLight(0xf2f4f0, 0x8a9088, 0.95);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xfff4e8, 1.55);
    this.keyLight.position.set(2.2, 5.0, 3.0);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 20;
    this.keyLight.shadow.camera.left = -3;
    this.keyLight.shadow.camera.right = 3;
    this.keyLight.shadow.camera.top = 3;
    this.keyLight.shadow.camera.bottom = -3;
    this.keyLight.shadow.bias = -0.0003;
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0xd4e0f0, 0.55);
    this.fillLight.position.set(-3.0, 2.4, -1.2);
    this.scene.add(this.fillLight);

    const rim = new THREE.DirectionalLight(0xffe8d0, 0.35);
    rim.position.set(-1.5, 3.5, -3.0);
    this.scene.add(rim);

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xb0b8b2,
      roughness: 0.92,
      metalness: 0,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), floorMat);
    floor.rotation.x = -Math.PI * 0.5;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Subtle grid — keep low so it doesn't fight the portrait look.
    const grid = new THREE.GridHelper(6, 12, 0x7a8880, 0xa8b4ac);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    this.scene.add(grid);
  }

  /**
   * @param {typeof DOG_REFERENCE_PRESETS[0]} preset
   * @param {{ settle?: boolean }} [opts]
   */
  applyPreset(preset, opts = {}) {
    if (!preset || !this.dog) return;
    this.activePresetId = preset.id;

    if (preset.light && this.keyLight && this.hemiLight) {
      this.keyLight.position.fromArray(preset.light.key);
      this.keyLight.intensity = preset.light.keyIntensity ?? 1.6;
      this.hemiLight.intensity = preset.light.hemi ?? 1.1;
    }

    this.dog.animation.setAutopilot(false);
    this.dog.animation.setBehavior(preset.behavior ?? 'idle');
    this.dog.animation.setRootPosition(0, 0, 0);
    this.dog.animation.setRootYaw(0);

    if (opts.settle !== false && this.harnessMode) {
      this.settleSeconds(preset.settleSeconds ?? 1.0);
    }
    this.frameDogForPreset(preset);
    this.emitSnapshot();
  }

  frameDogForPreset(preset) {
    if (!this.dog || !this.camera || !this.controls) return;
    this.dog.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.dog.root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    center.y = bounds.min.y + size.y * 0.5;

    const sourcePos = new THREE.Vector3().fromArray(preset.camera.pos);
    const sourceTarget = new THREE.Vector3().fromArray(preset.camera.target);
    const direction = sourcePos.sub(sourceTarget).normalize();
    let target = center;
    let framingExtent = Math.max(size.x, size.y, size.z, 0.2);
    if (preset.id === 'head-close') {
      const head = this.dog.rig.bonesByName.get('Head');
      if (head) target = head.getWorldPosition(new THREE.Vector3());
      framingExtent = Math.max(
        0.12,
        0.24 * this.dog.phenotype.skeleton.headSize * this.dog.phenotype.skeleton.scale,
      );
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (framingExtent * (preset.id === 'head-close' ? 1.16 : 0.88)) / Math.tan(fov * 0.5);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.controls.target.copy(target);
    this.controls.minDistance = Math.max(0.15, framingExtent * 0.7);
    this.controls.maxDistance = Math.max(4, framingExtent * 12);
    this.controls.update();
  }

  /**
   * Synchronous fixed-timestep settle for deterministic harness frames.
   * @param {number} seconds
   */
  settleSeconds(seconds) {
    if (!this.dog) return;
    const steps = Math.max(1, Math.round(seconds / FIXED_DT));
    for (let i = 0; i < steps; i += 1) {
      this.dog.update(FIXED_DT, { fixed: true, time: this.dog.animation.getTime() });
    }
  }

  /**
   * One-click 5-pair gallery cycle.
   * @param {number} [index]
   */
  showGalleryPair(index) {
    const i = ((index ?? this.galleryIndex) % DOG_REFERENCE_PRESETS.length + DOG_REFERENCE_PRESETS.length)
      % DOG_REFERENCE_PRESETS.length;
    this.galleryIndex = i;
    this.applyPreset(DOG_REFERENCE_PRESETS[i], { settle: true });
    return DOG_REFERENCE_PRESETS[i];
  }

  nextGalleryPair() {
    return this.showGalleryPair(this.galleryIndex + 1);
  }

  setBehavior(id) {
    this.dog?.animation.setAutopilot(false);
    this.dog?.animation.setBehavior(id);
    this.emitSnapshot();
  }

  setMouthState(id) {
    this.dog?.animation.setMouthState(id);
    this.emitSnapshot();
  }

  setLiveMotion(on) {
    this.liveMotion = Boolean(on);
    this.emitSnapshot();
  }

  setNakedBody(on) {
    this.dog?.setNakedBody(on);
    this.emitSnapshot();
  }

  rebuildDog({ breedId = this.breedId, seed = this.seed } = {}) {
    if (!this.scene) return null;
    const normalizedBreedId = normalizeRenderableDogBreedId(breedId);
    const normalizedSeed = normalizeDogSeed(seed);
    const previous = this.dog;
    const state = previous ? {
      behavior: previous.animation.getBehavior(),
      autopilot: previous.animation.getAutopilot(),
      mouthState: previous.animation.getMouthState(),
      time: previous.animation.getTime(),
      rootPosition: previous.animation.getRootPosition(),
      rootYaw: previous.animation.getRootYaw(),
      nakedBody: previous.getNakedBody(),
      showFur: previous.getShowFur(),
    } : null;

    const next = createProceduralDog({
      breedId: normalizedBreedId,
      seed: normalizedSeed,
      shellCount: this.shellCount,
    });
    this.scene.add(next.root);
    if (state) {
      next.animation.setBehavior(state.behavior);
      next.animation.setAutopilot(state.autopilot);
      next.animation.setMouthState(state.mouthState);
      next.animation.setTime(state.time);
      next.animation.setRootPosition(state.rootPosition.x, state.rootPosition.y, state.rootPosition.z);
      next.animation.setRootYaw(state.rootYaw);
      next.setNakedBody(state.nakedBody);
      next.setShowFur(state.showFur);
    }
    if (this.harnessMode) {
      next.animation.setFrozenBlink(true);
      next.animation.setFrozenBreeze(true);
    }
    this.dog = next;
    this.breedId = next.breedId;
    this.familyId = next.familyId;
    this.seed = next.seed;
    previous?.dispose();

    const preset = DOG_REFERENCE_PRESETS.find((item) => item.id === this.activePresetId)
      ?? DOG_REFERENCE_PRESETS[0];
    this.frameDogForPreset(preset);
    this.emitSnapshot();
    return next;
  }

  setBreed(breedId) {
    return this.rebuildDog({ breedId });
  }

  setFamily(familyId) {
    const breeds = getAuthoredDogBreeds(familyId);
    if (!breeds.length) return null;
    if (breeds.some((breed) => breed.id === this.breedId)) {
      this.familyId = familyId;
      this.emitSnapshot();
      return this.dog;
    }
    return this.setBreed(breeds[0].id);
  }

  setSeed(seed) {
    return this.rebuildDog({ seed });
  }

  randomize() {
    let nextSeed;
    if (globalThis.crypto?.getRandomValues) {
      nextSeed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    } else {
      nextSeed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    }
    if (nextSeed === this.seed) nextSeed = (nextSeed + 1) >>> 0;
    return this.setSeed(nextSeed);
  }

  setCompareEnabled(on) {
    this.compareEnabled = Boolean(on);
    this.emitSnapshot();
  }

  petImpulse() {
    this.dog?.furDynamics.addImpulse(new THREE.Vector3(
      (Math.random() - 0.5) * 0.4,
      0.15,
      (Math.random() - 0.5) * 0.3,
    ));
  }

  installDebugApi() {
    if (typeof window === 'undefined') return;
    const api = {
      get status() { return thisRef.status; },
      get harness() { return thisRef.harnessMode; },
      get snapshot() { return thisRef.buildSnapshot(); },
      settle: (s) => thisRef.settleSeconds(s),
      applyPreset: (id) => {
        const p = DOG_REFERENCE_PRESETS.find((x) => x.id === id);
        if (p) thisRef.applyPreset(p, { settle: true });
        return p ?? null;
      },
      gallery: () => DOG_REFERENCE_PRESETS.map((p) => p.id),
      catalog: () => ({
        families: DOG_FAMILIES,
        breeds: DOG_BREEDS,
        authoredBreedIds: AUTHORED_DOG_BREED_IDS,
      }),
      getResolvedTraits: () => thisRef.dog?.resolvedTraits ?? null,
      showGalleryPair: (i) => thisRef.showGalleryPair(i),
      nextGalleryPair: () => thisRef.nextGalleryPair(),
      setBehavior: (b) => thisRef.setBehavior(b),
      setMouthState: (m) => thisRef.setMouthState(m),
      setLiveMotion: (v) => thisRef.setLiveMotion(v),
      setNakedBody: (v) => thisRef.setNakedBody(v),
      setCompareEnabled: (v) => thisRef.setCompareEnabled(v),
      setBreed: (id) => thisRef.setBreed(id)?.breedId ?? null,
      setFamily: (id) => thisRef.setFamily(id)?.familyId ?? null,
      setSeed: (seed) => thisRef.setSeed(seed)?.seed ?? null,
      randomize: () => thisRef.randomize()?.seed ?? null,
      setCamera: (pos, target) => {
        thisRef.camera?.position.fromArray(pos);
        if (target) thisRef.controls?.target.fromArray(target);
        thisRef.controls?.update();
      },
      pet: () => thisRef.petImpulse(),
      renderOnce: async () => {
        thisRef.dog?.update(0, { fixed: true });
        thisRef.controls?.update();
        if (thisRef.renderer && thisRef.scene && thisRef.camera) {
          await thisRef.renderer.renderAsync(thisRef.scene, thisRef.camera);
        }
      },
      getBoneCount: () => thisRef.dog?.boneCount ?? 0,
      getBoneWorldPosition: (name) => {
        const bone = thisRef.dog?.rig.bonesByName.get(name);
        return bone ? bone.getWorldPosition(new THREE.Vector3()).toArray() : null;
      },
      getVertexCount: () => thisRef.dog?.vertexCount ?? 0,
      getShellCount: () => thisRef.dog?.shellCount ?? 0,
    };
    const thisRef = this;
    window.__DOG_SIM_DEBUG__ = api;
  }

  buildSnapshot() {
    const breed = getDogBreed(this.breedId);
    const preset = DOG_REFERENCE_PRESETS.find((item) => item.id === this.activePresetId);
    return {
      status: this.status,
      error: this.error,
      harness: this.harnessMode,
      liveMotion: this.liveMotion,
      nakedBody: this.dog?.getNakedBody() ?? false,
      showFur: this.dog?.getShowFur() ?? true,
      compareEnabled: this.compareEnabled,
      behavior: this.dog?.animation.getBehavior() ?? '—',
      autopilot: this.dog?.animation.getAutopilot() ?? false,
      mouthState: this.dog?.animation.getMouthState() ?? 'closed',
      bones: this.dog?.boneCount ?? 0,
      verts: this.dog?.vertexCount ?? 0,
      shells: this.dog?.shellCount ?? 0,
      familyId: this.familyId,
      breedId: this.breedId,
      breedLabel: breed?.label ?? 'Golden Retriever',
      seed: this.seed,
      breedSummary: breed?.summary ?? null,
      akcRank: breed?.popularity.rank ?? null,
      resolvedTraits: this.dog?.resolvedTraits ?? null,
      referenceImage: preset
        ? dogRefUrl(preset.refFile ?? 'three-quarter.jpg', this.breedId)
        : null,
      preset: this.activePresetId,
      galleryIndex: this.galleryIndex,
      speed: Number((this.dog?.animation.getMoveSpeed() ?? 0).toFixed(2)),
      time: Number((this.dog?.animation.getTime() ?? 0).toFixed(2)),
    };
  }

  emitSnapshot() {
    this.onSnapshot?.(this.buildSnapshot());
  }

  installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  resize() {
    if (!this.canvas || !this.renderer || !this.camera) return;
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  renderFrame = () => {
    if (this._disposed) return;
    this.animationFrame = requestAnimationFrame(this.renderFrame);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.dog && this.status === 'ready') {
      if (this.liveMotion) {
        this.dog.update(dt);
      } else if (!this.harnessMode) {
        // Still advance fur time gently when paused? keep frozen in harness.
        this.dog.furDynamics.update(dt, this.dog.animation.getRootPosition(), {
          time: this.dog.animation.getTime(),
          breeze: this.dog.animation.isFrozenBreeze() ? 0 : 0.2,
        });
      }
    }

    this.controls?.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    // Throttle snapshot UI updates.
    if ((performance.now() * 0.001) % 0.25 < dt) {
      this.emitSnapshot();
    }
  };

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    this.dog?.dispose();
    this.dog = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    if (typeof window !== 'undefined' && window.__DOG_SIM_DEBUG__) {
      delete window.__DOG_SIM_DEBUG__;
    }
  }
}
