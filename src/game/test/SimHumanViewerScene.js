// Isolated WebGPU viewer for the vendored vibe-human character.
// M1 visual gate: confirm the TSL skin/eye materials render under our r185
// WebGPU build and that MODELING_CONTROLS morphs deform the mesh, before the
// creator UI (M3) and sim scene (M5) consume the factory.
//
// Boot: ?view=simhuman
// Optional prepared body: ?view=simhuman&simBody=humanoid
//   (aliases: human5 | humanoid | humanoid-base | or /assets/simhuman/….glb)
//
// Exposes window.__SIMHUMAN_DEBUG__ for scripts/verify-simhuman-model.mjs:
//   { status, morphMeshes, morphCount, bones, verts, bboxHeight,
//     setControl(controlId, value), getBBoxHeight() }

import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createVibeHumanModel } from '../characters/simhuman/createVibeHumanModel.js';
import {
  createDefaultSimAppearance,
  sanitizeSimAppearance,
} from '../characters/simhuman/simAppearanceSchema.js';
import { loadRigifyAnimationClips } from '../characters/simhuman/rigifySourceSkeleton.js';
import {
  applyArmSpaceModifier,
  UBC_DEFAULT_ARM_ROLLS_DEG,
} from '../characters/simhuman/armSpaceModifier.js';
import { MaraAnimationController } from '../characters/mara/MaraAnimationController.js';
import { attachSimGarment } from '../characters/simhuman/attachSimGarment.js';
import { attachSimOutfit } from '../characters/simhuman/attachSimOutfit.js';
import { attachSimHair } from '../characters/simhuman/attachSimHair.js';
import { applyArmRaisePose } from '../characters/simhuman/armRaisePose.js';
import { resolveSimOutfitAsset } from '../characters/simhuman/simOutfitCatalog.js';
import {
  createOutfitLoopCut,
  createOutfitLoopFrame,
  sanitizeOutfitLoopCuts,
} from '../characters/simhuman/outfitLoopCuts.js';
import {
  applyPoseProcedure,
  capturePoseWorldDeltas,
  captureRestQuaternions,
  captureRestWorldMatrices,
  findBone,
  listBoneNames,
  resetBonesToRest,
} from '../characters/simhuman/outfitImportPose.js';
import { toRuntimeRigifyBoneName } from '../characters/simhuman/rigifySkeleton.js';
import { MODELING_CONTROLS } from '../../vendor/vibe-human/characterModeling.ts';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

function parseArmRollParam(raw) {
  // upper_arm.L:0,0,-90;upper_arm.R:0,0,90  OR  DEF-upper_arm.L:0,0,-90
  const out = {};
  for (const part of String(raw).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, vals] = trimmed.split(':');
    if (!name || !vals) continue;
    const [x, y, z] = vals.split(',').map((v) => Number(v));
    const bone = name.startsWith('DEF-') ? name : `DEF-${name}`;
    out[bone] = {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      z: Number.isFinite(z) ? z : 0,
    };
  }
  return out;
}

function bindPointFromIntersection(hit) {
  const mesh = hit?.object;
  const face = hit?.face;
  const position = mesh?.geometry?.getAttribute?.('position');
  if (!mesh?.isSkinnedMesh || !face || !position) return null;
  const indices = [face.a, face.b, face.c];
  const worldVertices = indices.map((index) => (
    mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
  ));
  const barycentric = THREE.Triangle.getBarycoord(
    hit.point,
    worldVertices[0],
    worldVertices[1],
    worldVertices[2],
    new THREE.Vector3(),
  );
  if (!barycentric) return null;
  const bindVertices = indices.map((index) => new THREE.Vector3().fromBufferAttribute(position, index));
  return bindVertices[0].multiplyScalar(barycentric.x)
    .addScaledVector(bindVertices[1], barycentric.y)
    .addScaledVector(bindVertices[2], barycentric.z);
}

function loopAngularCoverage(frame, points) {
  const angles = points.map((point) => {
    const dx = point[0] - frame.origin[0];
    const dy = point[1] - frame.origin[1];
    const dz = point[2] - frame.origin[2];
    const u = dx * frame.u[0] + dy * frame.u[1] + dz * frame.u[2];
    const v = dx * frame.v[0] + dy * frame.v[1] + dz * frame.v[2];
    const angle = Math.atan2(v, u);
    return angle < 0 ? angle + Math.PI * 2 : angle;
  }).sort((a, b) => a - b);
  let maxGap = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const next = index === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[index + 1];
    maxGap = Math.max(maxGap, next - angles[index]);
  }
  return { maxGap };
}

export class SimHumanViewerScene {
  constructor({ canvas, onSnapshot, onOutfitLoopCutsChange } = {}) {
    this.canvas = canvas;
    this.onSnapshot = onSnapshot;
    this.onOutfitLoopCutsChange = onOutfitLoopCutsChange;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.animationFrame = 0;
    this.resizeObserver = null;

    this.model = null;
    this.animationController = null;
    this.garmentRuntime = null;
    this.pendingGarment = null;
    this.outfitRuntime = null;
    this.outfitLoopEditor = null;
    this.outfitLoopHelper = null;
    this.outfitLoopPointerHandler = null;
    this.pendingOutfitId = null;
    this.hairRuntime = null;
    this._hairLoadGen = 0;
    /** Bumped on every outfit request / body reload so stale attaches are dropped. */
    this._outfitLoadGen = 0;
    /** Bumped on every body switch so a slower male/female load cannot clobber the latest. */
    this._bodyLoadGen = 0;
    /**
     * Serializes body + outfit mutations. Concurrent setBody/setOutfit was the
     * intermittent gender mix source: male clothes could bind to a female mesh
     * (or the reverse) when loads overlapped.
     */
    this._opQueue = Promise.resolve();
    this.appearance = createDefaultSimAppearance({ name: 'Viewer Sim' });
    this.status = 'booting';
    this.error = null;
    this.materialMode = 'skin';
    this.modelUrl = null;
    /** Body alias the current `this.model` was built for (null until first load). */
    this.loadedBodyUrl = null;
    /** Outfit Import Studio state */
    this.importMode = false;
    this.importCloth = null;
    /** Last pose deltas (local euler deg) captured for Blender bake */
    this.importPose = {};
    this.importRestQuats = null;
    this.importRestWorldMatrices = null;
    this.importPoseConfig = { procedure: 'rest', macros: {} };
    this.importPoseStatus = '';
    this.transformControls = null;
    this._importAnimPaused = false;
    this._importMixerTimeScale = 1;
    /** 'auto' | 'on' | 'off' — arm-space bind-axis clip rewrite */
    this.armSpaceMode = 'auto';
    /** Optional manual local rolls { boneName: {x,y,z} degrees } */
    this.armRollsDeg = null;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      this.modelUrl = params.get('simBody') || params.get('simModel') || null;
      const mat = params.get('simMaterials');
      if (mat === 'solid' || mat === 'skin' || mat === 'source' || mat === 'auto') {
        this.materialMode = mat;
      } else if (this.modelUrl) {
        // Custom bodies (UBC etc.) default to source/auto so pack textures show.
        this.materialMode = 'auto';
      }
      const armSpace = params.get('armSpace');
      if (armSpace === '1' || armSpace === 'on') this.armSpaceMode = 'on';
      if (armSpace === '0' || armSpace === 'off') this.armSpaceMode = 'off';
      // ?armRoll=upper_arm.L:0,0,-90;upper_arm.R:0,0,90
      const armRoll = params.get('armRoll');
      if (armRoll) this.armRollsDeg = parseArmRollParam(armRoll);
    }

    this._disposed = false;
  }

  async start() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a2e33);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    this.camera.position.set(1.2, 1.5, 2.2);

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
    this.controls.target.set(0, 0.95, 0);
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 8;

    this.setupEnvironment();
    this.installResizeObserver();
    this.resize();

    this.status = 'loading';
    this.emitSnapshot();

    try {
      // Queue so an early setBody/setOutfit from the creator UI cannot interleave
      // with the boot load and bind the wrong-gender outfit mesh.
      await this.enqueueOp(async () => {
        const bodyGen = this._bodyLoadGen;
        const applied = await this.loadModel(bodyGen);
        if (applied && bodyGen === this._bodyLoadGen) this.status = 'ready';
      });
    } catch (err) {
      console.error('[SimHumanViewer] start failed', err);
      this.status = 'failed';
      this.error = err?.message ?? String(err);
    }

    this.installDebugHook();
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
    this.endOutfitImport();
    this.cancelOutfitLoopCut();
    this.controls?.dispose();
    this.controls = null;
    this.animationController?.dispose();
    this.animationController = null;
    this.garmentRuntime?.dispose();
    this.garmentRuntime = null;
    this._outfitLoadGen += 1;
    this._bodyLoadGen += 1;
    this.pendingOutfitId = null;
    this.outfitRuntime?.dispose();
    this.outfitRuntime = null;
    this.hairRuntime?.dispose();
    this.hairRuntime = null;
    this._hairLoadGen += 1;
    this.model?.dispose();
    this.model = null;
    this.loadedBodyUrl = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    if (globalThis.__SIMHUMAN_DEBUG__?.owner === this) {
      delete globalThis.__SIMHUMAN_DEBUG__;
    }
  }

  setupEnvironment() {
    const hemi = new THREE.HemisphereLight(0xf0f4f2, 0x44505a, 1.0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff2e2, 2.1);
    key.position.set(2.2, 3.2, 2.0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 10;
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -1;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbcd0ea, 0.5);
    fill.position.set(-2.4, 1.6, -1.4);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xd8e8ff, 0.8);
    rim.position.set(0.4, 2.2, -2.6);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 48),
      new THREE.MeshStandardMaterial({ color: 0x3c444c, roughness: 0.85, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  /** Body alias the live skeleton corresponds to (for outfit gender resolution). */
  activeBodyAlias() {
    return this.loadedBodyUrl || this.modelUrl || this.appearance?.body || 'human5';
  }

  /** True when the on-screen skeleton matches `body` and is safe to dress. */
  isBodyReady(body = null) {
    if (!this.model || !this.loadedBodyUrl || this.status === 'loading') return false;
    if (body == null) return true;
    return this.loadedBodyUrl === body;
  }

  /**
   * Run body/outfit work one-at-a-time. Nested calls must use *Impl methods
   * directly to avoid deadlocking the queue.
   * @template T
   * @param {() => (T|Promise<T>)} fn
   * @returns {Promise<T>}
   */
  enqueueOp(fn) {
    const run = this._opQueue.then(() => fn());
    // Keep the chain alive after failures so later ops still schedule.
    this._opQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async loadModel(bodyGen = this._bodyLoadGen) {
    const wasImport = this.importMode;
    if (wasImport) this.endOutfitImport({ keepFlag: false });
    this.garmentRuntime?.dispose();
    this.garmentRuntime = null;
    // Invalidate any in-flight outfit attach bound to the outgoing body.
    this._outfitLoadGen += 1;
    this.outfitRuntime?.dispose();
    this.outfitRuntime = null;
    this._hairLoadGen += 1;
    this.hairRuntime?.dispose();
    this.hairRuntime = null;
    this.animationController?.dispose();
    this.animationController = null;
    this.model?.dispose();
    this.model = null;
    this.loadedBodyUrl = null;

    // Capture the requested body for this generation — later switches change
    // this.modelUrl, and a slow male/female GLB must not land on the wrong slot.
    const intendedBody = this.modelUrl || 'human5';
    const materialMode = this.materialMode;
    const appearanceSnapshot = this.appearance;

    const [model, clips] = await Promise.all([
      createVibeHumanModel({
        appearance: appearanceSnapshot,
        materials: materialMode,
        modelUrl: intendedBody,
      }),
      loadRigifyAnimationClips({ bodyAlias: intendedBody }),
    ]);

    if (bodyGen !== this._bodyLoadGen || this._disposed) {
      model?.dispose?.();
      return false;
    }

    let finalClips = clips;
    // Body-specific packs (retarget:rigify:ubc-*) already match that skeleton's
    // bind axes. Arm-space only runs when forced, or when we fell back to the
    // human5 pack on a non-human5 body.
    const forceArmSpace = this.armSpaceMode === 'on';
    const skipArmSpace = this.armSpaceMode === 'off';
    const needsArmSpace = !skipArmSpace && (
      forceArmSpace
      || Boolean(clips.usedFallback && intendedBody)
    );
    if (needsArmSpace) {
      finalClips = await this.applyArmSpaceToClips(clips, model);
    }

    if (bodyGen !== this._bodyLoadGen || this._disposed) {
      model?.dispose?.();
      return false;
    }

    this.model = model;
    this.loadedBodyUrl = intendedBody;
    this.scene.add(this.model.group);
    this.animationController = new MaraAnimationController({
      mixer: new THREE.AnimationMixer(this.model.object),
      clips: finalClips,
      modelRoot: this.model.object,
      skeletonSource: 'rigify',
    });
    this.animationController.start();
    await this.syncHair(appearanceSnapshot);
    if (bodyGen !== this._bodyLoadGen || this._disposed) {
      return false;
    }
    if (this.pendingGarment) this.installGarment(this.pendingGarment);
    // Drop outfits that only exist for the other gender (e.g. athleisure on female).
    if (this.pendingOutfitId) {
      const variant = this.appearance?.outfitVariant ?? 'morph';
      if (!resolveSimOutfitAsset(this.pendingOutfitId, intendedBody, { variant })) {
        this.pendingOutfitId = null;
      }
    }
    // Re-attach the latest requested outfit for THIS body only.
    if (this.pendingOutfitId) {
      await this.installOutfit(this.pendingOutfitId, this._outfitLoadGen, intendedBody);
    }
    return true;
  }

  async setBody(bodyAlias = 'human5') {
    return this.enqueueOp(() => this._setBodyImpl(bodyAlias));
  }

  async _setBodyImpl(bodyAlias = 'human5') {
    const nextBody = bodyAlias || 'human5';
    if ((this.modelUrl || 'human5') === nextBody && this.model && this.loadedBodyUrl === nextBody) {
      return;
    }
    this.modelUrl = nextBody;
    this.materialMode = nextBody === 'human5' ? 'skin' : 'auto';
    // Keep appearance.body aligned with the mesh we are about to show so outfit
    // resolution and UI draft stay gender-consistent.
    if (this.appearance) {
      this.appearance = {
        ...this.appearance,
        body: nextBody,
      };
    }
    const bodyGen = ++this._bodyLoadGen;
    this.status = 'loading';
    this.error = null;
    this.emitSnapshot();
    try {
      const applied = await this.loadModel(bodyGen);
      if (bodyGen !== this._bodyLoadGen) return;
      if (applied) this.status = 'ready';
    } catch (error) {
      if (bodyGen !== this._bodyLoadGen) return;
      this.status = 'failed';
      this.error = error?.message ?? String(error);
      throw error;
    } finally {
      if (bodyGen === this._bodyLoadGen) {
        this.installDebugHook();
        this.emitSnapshot();
      }
    }
  }

  /**
   * Arm-space modifier: rewrite Rigify clip quaternions into this body's bind axes.
   * Uses human5 as the reference bind when available; always applies UBC default rolls
   * for known UE-style bodies (overridable via ?armRoll=).
   */
  async applyArmSpaceToClips(clips, model) {
    let referenceRoot = null;
    let refModel = null;
    try {
      // Lightweight solid ref — only need skeleton bind locals.
      refModel = await createVibeHumanModel({
        materials: 'solid',
        modelUrl: 'human5',
        targetHeight: model.rawHeight * model.scale,
      });
      referenceRoot = refModel.object;
      // Pose both to bind for offset extraction
      model.object.traverse((n) => { if (n.isSkinnedMesh) n.skeleton?.pose?.(); });
      referenceRoot.traverse((n) => { if (n.isSkinnedMesh) n.skeleton?.pose?.(); });
      model.object.updateMatrixWorld(true);
      referenceRoot.updateMatrixWorld(true);
    } catch (err) {
      console.warn('[simhuman] arm-space: could not load human5 reference', err);
    }

    const isUbc = /male|female|ubc|superhero/i.test(String(this.modelUrl ?? ''));
    const manualRollsDeg = this.armRollsDeg
      ?? (isUbc ? { ...UBC_DEFAULT_ARM_ROLLS_DEG } : null);

    const result = applyArmSpaceModifier({
      clips,
      targetRoot: model.object,
      referenceRoot,
      includeLegs: true,
      manualRollsDeg,
    });
    console.info(
      `[simhuman] arm-space modifier: adapted ${result.adaptedCount} bones`
      + (manualRollsDeg ? ' (+manual rolls)' : ''),
    );
    refModel?.dispose?.();
    return result.clips;
  }

  setAnimation(state) {
    this.animationController?.play(state);
    this.emitSnapshot();
  }

  setControl(controlId, value) {
    this.appearance.morphs[controlId] = value;
    this.model?.applyAppearance(this.appearance);
    this.outfitRuntime?.applyAppearance(this.appearance);
    this.emitSnapshot();
  }

  setAppearance(appearance) {
    this.appearance = sanitizeSimAppearance(appearance);
    this.model?.applyAppearance(this.appearance);
    this.outfitRuntime?.applyAppearance(this.appearance);
    void this.syncHair(this.appearance);
    this.emitSnapshot();
  }

  /**
   * Load / retint / refit the hair cap from appearance.
   * Style changes reload the GLB; color + socket fit update live.
   */
  async syncHair(appearance = this.appearance) {
    if (!this.model || this._disposed) return null;
    const styleId = appearance?.hairStyleId ?? null;
    const color = appearance?.hairColor;
    const fit = appearance?.hairFit;
    if (!styleId) {
      this._hairLoadGen += 1;
      this.hairRuntime?.dispose();
      this.hairRuntime = null;
      return null;
    }
    if (this.hairRuntime?.id === styleId) {
      if (color) this.hairRuntime.setColor(color);
      if (fit) this.hairRuntime.applyFit?.(fit);
      return this.hairRuntime;
    }
    const gen = ++this._hairLoadGen;
    this.hairRuntime?.dispose();
    this.hairRuntime = null;
    try {
      const runtime = await attachSimHair({
        actor: {
          id: appearance?.id ?? 'viewer',
          group: this.model.group,
          model: this.model,
          preset: appearance,
        },
        scene: this.scene,
        hairStyleId: styleId,
        hairColor: color,
        hairFit: fit,
        targetHeight: this.model.rawHeight * this.model.scale,
      });
      if (gen !== this._hairLoadGen || this._disposed) {
        runtime?.dispose?.();
        return null;
      }
      this.hairRuntime = runtime;
      return runtime;
    } catch (error) {
      if (gen === this._hairLoadGen) {
        console.warn('[SimHumanViewer] hair attach failed', error);
      }
      return null;
    }
  }

  setGarment(garment) {
    this.pendingGarment = garment ? structuredClone(garment) : null;
    this.garmentRuntime?.dispose();
    this.garmentRuntime = null;
    if (this.pendingGarment && this.model && this.scene) this.installGarment(this.pendingGarment);
    this.emitSnapshot();
  }

  async setOutfit(outfitId) {
    return this.enqueueOp(() => this._setOutfitImpl(outfitId));
  }

  async _setOutfitImpl(outfitId) {
    this.cancelOutfitLoopCut();
    const gen = ++this._outfitLoadGen;
    this.pendingOutfitId = outfitId || null;
    this.outfitRuntime?.dispose();
    this.outfitRuntime = null;

    // Only dress a fully applied skeleton. modelUrl/appearance.body can already
    // point at the other gender while the previous mesh is still on screen —
    // installing then is the intermittent male/female swap. Body loads reattach
    // pendingOutfitId once loadedBodyUrl is committed.
    let runtime = null;
    if (
      this.pendingOutfitId
      && this.model
      && this.scene
      && this.loadedBodyUrl
      && this.status !== 'loading'
    ) {
      runtime = await this.installOutfit(this.pendingOutfitId, gen, this.loadedBodyUrl);
    }
    if (gen === this._outfitLoadGen) this.emitSnapshot();
    return runtime;
  }

  beginOutfitLoopCut({ target = 'torso', interpolation = 'smooth', hideSide = 'positive', radialReach } = {}) {
    this.cancelOutfitLoopCut();
    const mesh = this.outfitRuntime?.meshes?.find((entry) => entry?.isSkinnedMesh);
    if (!mesh || !this.scene || !this.camera || !this.canvas) return false;
    const frame = createOutfitLoopFrame(target, mesh.skeleton);
    this.outfitLoopEditor = {
      target,
      interpolation: interpolation === 'sharp' ? 'sharp' : 'smooth',
      hideSide: hideSide === 'negative' ? 'negative' : 'positive',
      radialReach: Number.isFinite(Number(radialReach)) ? Number(radialReach) : undefined,
      frame,
      points: [],
      worldPoints: [],
      status: 'Shift-click around the garment. Orbit normally between points.',
      previousPaused: this._importAnimPaused,
    };
    this._importAnimPaused = true;
    this.outfitLoopHelper = new THREE.Group();
    this.outfitLoopHelper.name = 'Outfit loop cut editor';
    this.scene.add(this.outfitLoopHelper);
    this.canvas.dataset.outfitLoopCut = '1';

    this.outfitLoopPointerHandler = (event) => {
      if (!event.shiftKey || event.button !== 0 || !this.outfitLoopEditor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.pickOutfitLoopPoint(event);
    };
    this.canvas.addEventListener('pointerdown', this.outfitLoopPointerHandler, true);
    this.emitSnapshot();
    return true;
  }

  pickOutfitLoopPoint(event) {
    const editor = this.outfitLoopEditor;
    if (!editor || !this.camera || !this.canvas || !this.outfitRuntime) return false;
    const rect = this.canvas.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      y: -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    }, this.camera);
    this.scene?.updateMatrixWorld?.(true);
    const hit = raycaster.intersectObjects(this.outfitRuntime.meshes, false)[0];
    if (!hit?.face || !hit.object?.isSkinnedMesh) {
      editor.status = 'No outfit surface under that point.';
      this.emitSnapshot();
      return false;
    }
    const point = bindPointFromIntersection(hit);
    if (!point) return false;
    editor.points.push(point.toArray());
    editor.worldPoints.push(hit.point.toArray());
    editor.status = `${editor.points.length} point${editor.points.length === 1 ? '' : 's'} · orbit and continue around the loop.`;
    this.rebuildOutfitLoopHelper();
    this.emitSnapshot();
    return true;
  }

  undoOutfitLoopPoint() {
    if (!this.outfitLoopEditor?.points.length) return false;
    this.outfitLoopEditor.points.pop();
    this.outfitLoopEditor.worldPoints.pop();
    this.outfitLoopEditor.status = `${this.outfitLoopEditor.points.length} points.`;
    this.rebuildOutfitLoopHelper();
    this.emitSnapshot();
    return true;
  }

  finishOutfitLoopCut() {
    const editor = this.outfitLoopEditor;
    if (!editor) return null;
    if (editor.points.length < 3) {
      editor.status = 'Add at least three points before closing the loop.';
      this.emitSnapshot();
      return null;
    }
    const coverage = loopAngularCoverage(editor.frame, editor.points);
    if (coverage.maxGap > Math.PI * 1.15) {
      editor.status = 'The loop is still open on one side. Orbit around and add points there.';
      this.emitSnapshot();
      return null;
    }
    const cut = createOutfitLoopCut(editor);
    if (!cut) return null;
    const nextCuts = sanitizeOutfitLoopCuts([
      ...(this.appearance?.outfitLoopCuts ?? []),
      cut,
    ]);
    this.appearance = { ...this.appearance, outfitLoopCuts: nextCuts };
    this.outfitRuntime?.applyAppearance(this.appearance);
    this.onOutfitLoopCutsChange?.(nextCuts);
    this.cleanupOutfitLoopEditor();
    this.emitSnapshot();
    return cut;
  }

  cancelOutfitLoopCut() {
    if (!this.outfitLoopEditor && !this.outfitLoopPointerHandler && !this.outfitLoopHelper) return;
    this.cleanupOutfitLoopEditor();
    this.emitSnapshot();
  }

  cleanupOutfitLoopEditor() {
    if (this.outfitLoopPointerHandler) {
      this.canvas?.removeEventListener('pointerdown', this.outfitLoopPointerHandler, true);
    }
    this.outfitLoopPointerHandler = null;
    if (this.outfitLoopEditor) this._importAnimPaused = this.outfitLoopEditor.previousPaused;
    this.outfitLoopEditor = null;
    if (this.outfitLoopHelper) {
      this.outfitLoopHelper.traverse((node) => {
        node.geometry?.dispose?.();
        node.material?.dispose?.();
      });
      this.outfitLoopHelper.removeFromParent();
    }
    this.outfitLoopHelper = null;
    if (this.canvas) delete this.canvas.dataset.outfitLoopCut;
  }

  rebuildOutfitLoopHelper() {
    const editor = this.outfitLoopEditor;
    const helper = this.outfitLoopHelper;
    if (!editor || !helper) return;
    for (const child of [...helper.children]) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
      child.removeFromParent();
    }
    const markerGeometry = new THREE.SphereGeometry(0.012, 10, 7);
    for (const coords of editor.worldPoints) {
      const marker = new THREE.Mesh(
        markerGeometry,
        new THREE.MeshBasicMaterial({ color: 0x35e7ff, depthTest: false }),
      );
      marker.position.fromArray(coords);
      marker.renderOrder = 100;
      helper.add(marker);
    }
    if (editor.worldPoints.length >= 2) {
      const controlPoints = editor.worldPoints.map((point) => new THREE.Vector3().fromArray(point));
      let guidePoints = controlPoints;
      if (controlPoints.length >= 3) {
        guidePoints = editor.interpolation === 'smooth'
          ? new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal')
            .getPoints(Math.max(24, controlPoints.length * 10))
          : [...controlPoints, controlPoints[0]];
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(
        guidePoints,
      );
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }),
      );
      line.renderOrder = 99;
      helper.add(line);
    }
  }

  installGarment(garment) {
    this.garmentRuntime = attachSimGarment({
      actor: {
        id: 'creator-preview',
        group: this.model.group,
        model: this.model,
        preset: this.appearance,
      },
      garment,
      scene: this.scene,
      quality: 'low',
    });
  }

  /**
   * @param {string} outfitId
   * @param {number} [gen] Load generation; stale completions are disposed.
   * @param {string} [bodyAlias] Skeleton gender/body to resolve the GLB for.
   *   Must be the body the `model` was built for — never a raced draft body.
   */
  async installOutfit(outfitId, gen = this._outfitLoadGen, bodyAlias = null) {
    const model = this.model;
    const scene = this.scene;
    // Strict: only the committed on-screen body. No modelUrl/appearance fallback
    // (those race ahead during gender switches).
    const bodyForAsset = bodyAlias || this.loadedBodyUrl;
    if (!outfitId || !model || !scene || !bodyForAsset) return null;
    if (this.loadedBodyUrl && this.loadedBodyUrl !== bodyForAsset) return null;

    const variant = this.appearance?.outfitVariant ?? 'morph';
    if (!resolveSimOutfitAsset(outfitId, bodyForAsset, { variant })) {
      // e.g. male-only outfit while a female body is showing
      if (gen === this._outfitLoadGen && this.pendingOutfitId === outfitId) {
        this.pendingOutfitId = null;
      }
      return null;
    }

    const presetForAttach = {
      ...this.appearance,
      body: bodyForAsset,
    };

    let runtime = null;
    try {
      runtime = await attachSimOutfit({
        actor: {
          id: 'creator-preview',
          group: model.group,
          model,
          preset: presetForAttach,
        },
        outfitId,
        body: bodyForAsset,
        variant,
        scene,
      });
    } catch (error) {
      // Only surface errors for the still-current request.
      if (gen === this._outfitLoadGen) throw error;
      return null;
    }

    // Superseded by a newer setOutfit / body reload / dispose.
    if (
      gen !== this._outfitLoadGen
      || this.model !== model
      || this.loadedBodyUrl !== bodyForAsset
      || runtime?.body !== bodyForAsset
      || this._disposed
      || this.pendingOutfitId !== outfitId
    ) {
      runtime?.dispose();
      return null;
    }

    this.outfitRuntime = runtime;
    // Re-apply current morphs so bulk fit matches the slider state at attach time.
    this.outfitRuntime.applyAppearance(this.appearance);
    return runtime;
  }

  /** Switch Standard (no morphs) vs Morph-Enabled without changing outfit id. */
  async setOutfitVariant(variant) {
    return this.enqueueOp(() => this._setOutfitVariantImpl(variant));
  }

  async _setOutfitVariantImpl(variant) {
    if (!this.appearance) return;
    this.appearance.outfitVariant = variant === 'standard' ? 'standard' : 'morph';
    const id = this.pendingOutfitId ?? this.outfitRuntime?.id ?? null;
    if (!id) {
      this.emitSnapshot();
      return;
    }
    // Call impl directly — we are already inside the op queue.
    this.pendingOutfitId = id;
    await this._setOutfitImpl(id);
  }

  resetControls() {
    this.appearance.morphs = {};
    this.appearance.facs = {};
    this.model?.applyAppearance(this.appearance);
    this.emitSnapshot();
  }

  getBBoxHeight() {
    if (!this.model) return 0;
    // Force skinned bounds: compute from world-space skinned mesh bboxes.
    const box = new THREE.Box3().setFromObject(this.model.group);
    return box.max.y - box.min.y;
  }

  installDebugHook() {
    const morphCount = this.model
      ? this.model.morphMeshes.reduce(
        (sum, mesh) => sum + Object.keys(mesh.morphTargetDictionary).length,
        0,
      )
      : 0;
    let verts = 0;
    this.model?.group.traverse((child) => {
      if (child.isMesh && child.geometry?.attributes?.position) {
        verts += child.geometry.attributes.position.count;
      }
    });

    const scene = this;
    globalThis.__SIMHUMAN_DEBUG__ = {
      owner: this,
      get status() { return scene.status; },
      get error() { return scene.error; },
      morphMeshes: this.model?.morphMeshes.length ?? 0,
      morphCount,
      bones: Object.keys(this.model?.bones ?? {}).length,
      verts,
      controls: MODELING_CONTROLS.length,
      setControl: (id, value) => this.setControl(id, value),
      resetControls: () => this.resetControls(),
      getBBoxHeight: () => this.getBBoxHeight(),
      setAnimation: (state) => this.setAnimation(state),
      getAnimationState: () => this.animationController?.currentState ?? null,
      getAnimationTime: () => this.animationController?.currentAction?.time ?? 0,
      getGarmentSnapshot: () => this.garmentRuntime?.snapshot() ?? null,
      getOutfitSnapshot: () => this.outfitRuntime?.snapshot() ?? null,
      getHairSnapshot: () => this.hairRuntime?.snapshot() ?? null,
      getMorphInfluenceSum: () => (this.model?.morphMeshes ?? []).reduce(
        (sum, mesh) => sum + mesh.morphTargetInfluences.reduce((a, b) => a + Math.abs(b), 0),
        0,
      ),
      /** Neutral appearance + optional outfit for reference captures. */
      setAppearance: (appearance) => this.setAppearance(appearance),
      setBody: async (body) => this.setBody(body),
      setOutfit: async (outfitId) => this.setOutfit(outfitId),
      setOutfitVariant: async (variant) => this.setOutfitVariant(variant),
      beginOutfitLoopCut: (options) => this.beginOutfitLoopCut(options),
      undoOutfitLoopPoint: () => this.undoOutfitLoopPoint(),
      finishOutfitLoopCut: () => this.finishOutfitLoopCut(),
      cancelOutfitLoopCut: () => this.cancelOutfitLoopCut(),
      /** Outfit Import pose probe: apply arms-down and report status. */
      testImportPose: (procedure = 'arms-down') => {
        scene.beginOutfitImport();
        return scene.applyImportPoseConfig({ procedure, macros: {} });
      },
      getImportBoneNames: () => scene.getImportBoneNames?.() ?? [],
      getImportPoseStatus: () => scene.getImportPoseStatus?.() ?? '',
      /**
       * Frame the character for reference shots.
       * @param {'front'|'threequarter'|'side'|'back'|'threequarter-back'} angle
       * @param {{ distance?: number, height?: number, lookAtY?: number }} [opts]
       */
      setCameraAngle: (angle = 'front', opts = {}) => {
        if (!scene.camera || !scene.controls) return false;
        const dist = Number(opts.distance) || 2.6;
        const height = Number(opts.height) || 1.05;
        const lookY = Number(opts.lookAtY) || 0.95;
        const yaw = {
          front: 0,
          threequarter: Math.PI * 0.28,
          side: Math.PI * 0.5,
          back: Math.PI,
          'threequarter-back': Math.PI * 0.72,
        }[angle] ?? 0;
        scene.camera.position.set(
          Math.sin(yaw) * dist,
          height,
          Math.cos(yaw) * dist,
        );
        scene.controls.target.set(0, lookY, 0);
        scene.controls.update();
        scene.camera.lookAt(0, lookY, 0);
        return true;
      },
      /** Hide body skin meshes (keep eyes/brows); outfit stays visible. */
      setBodyVisible: (visible) => {
        const show = visible !== false;
        scene.model?.skinnedMeshes?.forEach((mesh) => {
          const n = String(mesh.name || '');
          if (/eye|eyebrow|brow/i.test(n)) {
            mesh.visible = true;
            return;
          }
          // Full body shell — hide for pure outfit orthographics.
          mesh.visible = show;
        });
        return true;
      },
      snapshot: () => scene.snapshot(),
    };
  }

  installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    // Observe the canvas itself too: garment mode narrows the canvas with CSS
    // while its parent keeps full size, which left the buffer wide (squeezed).
    this.resizeObserver.observe(this.canvas);
    if (this.canvas.parentElement) this.resizeObserver.observe(this.canvas.parentElement);
  }

  resize() {
    if (!this.renderer || !this.camera || !this.canvas) return;
    const parent = this.canvas.parentElement;
    const width = Math.max(1, this.canvas.clientWidth || parent?.clientWidth || 1);
    const height = Math.max(1, this.canvas.clientHeight || parent?.clientHeight || 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  // ── Outfit Import Studio ──────────────────────────────────────────

  /**
   * Enter import posing mode. Safe to call repeatedly.
   * @returns {boolean} true when ready
   */
  beginOutfitImport() {
    if (!this.model || !this.scene || !this.camera || !this.canvas) {
      return false;
    }
    this.importMode = true;
    this._importAnimPaused = true;
    this._freezeAnimationForImport();

    // Bind-pose the shared skeleton, then snapshot local quats as "rest".
    this._resetSkeletonToBind();
    const bones = this._collectImportBones();
    this.importRestQuats = captureRestQuaternions(bones);
    this.importRestWorldMatrices = captureRestWorldMatrices(bones, this.model.object);
    // Re-apply current procedure (default rest).
    this._applyImportPoseConfigInternal(this.importPoseConfig);
    this.emitSnapshot();
    return true;
  }

  endOutfitImport({ keepFlag = false } = {}) {
    this._disposeTransformControls();
    if (this.importCloth) {
      this.importCloth.removeFromParent();
      this.importCloth = null;
    }
    // Restore rest pose
    if (this.importRestQuats) {
      resetBonesToRest(this._collectImportBones(), this.importRestQuats);
      this._refreshSkinnedSkeletons();
    }
    this.importRestQuats = null;
    this.importRestWorldMatrices = null;
    this.importPose = {};
    this.importPoseConfig = { procedure: 'rest', macros: {} };
    this.importPoseStatus = '';
    this._importAnimPaused = false;
    if (!keepFlag) this.importMode = false;
    this._unfreezeAnimationAfterImport();
    this.emitSnapshot();
  }

  _freezeAnimationForImport() {
    try {
      const mixer = this.animationController?.mixer;
      if (mixer) {
        this._importMixerTimeScale = mixer.timeScale ?? 1;
        mixer.timeScale = 0;
        mixer.stopAllAction?.();
      }
      if (this.animationController) {
        this.animationController.currentAction = null;
      }
    } catch {
      /* ignore */
    }
  }

  _unfreezeAnimationAfterImport() {
    try {
      const mixer = this.animationController?.mixer;
      if (mixer) {
        mixer.timeScale = this._importMixerTimeScale ?? 1;
      }
      this.animationController?.play?.('idle', 0);
    } catch {
      /* ignore */
    }
  }

  /**
   * Live bone map from the scene graph (DEF names + sanitized mixer names).
   * Prefer this over model.bones for posing — always current after reparent.
   */
  _collectImportBones() {
    const bones = {};
    const root = this.model?.object ?? this.model?.group;
    root?.traverse((node) => {
      if (!node?.isBone) return;
      bones[node.name] = node;
      const runtime = toRuntimeRigifyBoneName(node.name);
      if (runtime && runtime !== node.name) bones[runtime] = node;
      if (!node.name.startsWith('DEF-')) bones[`DEF-${node.name}`] = node;
    });
    // Also index skeleton.bones arrays (same refs, ensures we don't miss any).
    this.model?.skinnedMeshes?.forEach((mesh) => {
      for (const bone of mesh.skeleton?.bones ?? []) {
        if (!bone?.isBone) continue;
        bones[bone.name] = bone;
        const runtime = toRuntimeRigifyBoneName(bone.name);
        if (runtime) bones[runtime] = bone;
      }
    });
    for (const [name, bone] of Object.entries(this.model?.bones ?? {})) {
      if (bone?.isBone) bones[name] = bone;
    }
    return bones;
  }

  _resetSkeletonToBind() {
    const seen = new Set();
    const poseSk = (sk) => {
      if (!sk || seen.has(sk)) return;
      seen.add(sk);
      sk.pose?.();
    };
    this.model?.skinnedMeshes?.forEach((mesh) => poseSk(mesh.skeleton));
    this.model?.object?.traverse((n) => {
      if (n.isSkinnedMesh) poseSk(n.skeleton);
    });
    this.model?.object?.updateMatrixWorld(true);
  }

  _refreshSkinnedSkeletons() {
    this.model?.object?.updateMatrixWorld(true);
    const seen = new Set();
    const touch = (mesh) => {
      if (!mesh?.isSkinnedMesh || !mesh.skeleton || seen.has(mesh.skeleton)) return;
      seen.add(mesh.skeleton);
      mesh.skeleton.update?.();
      if (mesh.skeleton.boneTexture) mesh.skeleton.boneTexture.needsUpdate = true;
    };
    this.model?.skinnedMeshes?.forEach(touch);
    this.model?.object?.traverse(touch);
  }

  /**
   * @param {{ procedure?: string, macros?: Record<string, number> }} config
   * @returns {{ applied: number, details: string[], pose: object, boneCount: number }}
   */
  _applyImportPoseConfigInternal(config = {}) {
    const procedure = config.procedure || 'rest';
    const macros = config.macros || {};
    this.importPoseConfig = { procedure, macros: { ...macros } };

    if (!this.importRestQuats?.size) {
      this._resetSkeletonToBind();
      const restBones = this._collectImportBones();
      this.importRestQuats = captureRestQuaternions(restBones);
      this.importRestWorldMatrices = captureRestWorldMatrices(restBones, this.model.object);
    }

    const bones = this._collectImportBones();
    const boneCount = listBoneNames(bones).length;
    const result = applyPoseProcedure(bones, this.importRestQuats, { procedure, macros });
    this._refreshSkinnedSkeletons();

    // Capture model-space world deltas. Local bone axes/rolls differ after
    // Blender imports the glTF, so local Euler deltas cannot reproduce this pose.
    this.importPose = capturePoseWorldDeltas(
      bones,
      this.importRestWorldMatrices,
      this.model.object,
    );
    this.importPoseStatus = [
      procedure,
      `bones:${boneCount}`,
      `applied:${result.applied}`,
      ...result.details.slice(0, 6),
    ].join(' · ');

    return {
      applied: result.applied,
      details: result.details,
      pose: this.importPose,
      boneCount,
      status: this.importPoseStatus,
    };
  }

  /**
   * @param {THREE.Object3D} clothRoot
   */
  setImportCloth(clothRoot) {
    if (!this.importMode) this.beginOutfitImport();
    if (this.importCloth && this.importCloth !== clothRoot) {
      this.importCloth.removeFromParent();
    }
    this.importCloth = clothRoot;
    // Parent under body group so shared scale/space matches the character.
    this.model.group.add(clothRoot);
    this._ensureTransformControls();
    if (this.transformControls) {
      this.transformControls.attach(clothRoot);
      this.transformControls.setMode('translate');
    }
    this.emitSnapshot();
  }

  clearImportCloth() {
    this._disposeTransformControls();
    if (this.importCloth) {
      this.importCloth.removeFromParent();
      this.importCloth = null;
    }
    this.emitSnapshot();
  }

  setImportGizmoMode(mode) {
    const m = mode === 'rotate' || mode === 'scale' ? mode : 'translate';
    if (this.transformControls) this.transformControls.setMode(m);
  }

  setImportEditTarget(target) {
    if (target === 'pose') {
      // Hide cloth gizmo while adjusting pose macros
      if (this.transformControls) this.transformControls.detach();
    } else if (this.importCloth) {
      this._ensureTransformControls();
      this.transformControls?.attach(this.importCloth);
    }
  }

  /**
   * Apply a named procedure + macros (world-space arms-down, etc.).
   * @param {{ procedure?: string, macros?: Record<string, number> }} config
   */
  applyImportPoseConfig(config = {}) {
    if (!this.model) {
      return { applied: 0, details: ['no model'], pose: {}, boneCount: 0, status: 'no model' };
    }
    if (!this.importMode || !this.importRestQuats?.size) {
      if (!this.beginOutfitImport()) {
        return { applied: 0, details: ['viewer not ready'], pose: {}, boneCount: 0, status: 'not ready' };
      }
    }
    // Keep animation frozen every apply (in case something restarted it).
    this._freezeAnimationForImport();
    // Always re-bind then procedure so repeated clicks are deterministic.
    this._resetSkeletonToBind();
    // Rest quats must match bind — re-capture after pose() in case of drift.
    this.importRestQuats = captureRestQuaternions(this._collectImportBones());
    this.importRestWorldMatrices = captureRestWorldMatrices(
      this._collectImportBones(),
      this.model.object,
    );
    const result = this._applyImportPoseConfigInternal(config);
    this.emitSnapshot();
    return result;
  }

  /**
   * Legacy: apply raw local euler map (used rarely). Prefer applyImportPoseConfig.
   * @param {Record<string, {x?:number,y?:number,z?:number}>} pose
   */
  applyImportPose(pose = {}) {
    // If caller passes a full euler dict (bake replay), store and use rest+local path
    // via procedure rest + empty macros, then overlay is not available — config path only.
    if (pose && typeof pose === 'object' && !pose.procedure) {
      // Treat as "keep current procedure but force bake pose from deltas" — not used by UI.
      this.importPose = pose;
    }
    return this.applyImportPoseConfig(this.importPoseConfig).applied;
  }

  getImportPoseDeltas() {
    return { ...(this.importPose || {}) };
  }

  getImportPoseStatus() {
    return this.importPoseStatus || '';
  }

  getImportBone(name) {
    return findBone(this._collectImportBones(), name);
  }

  getBodyObjectForFit() {
    return this.model?.object ?? this.model?.group ?? null;
  }

  /** Debug: bone names currently in the scene graph. */
  getImportBoneNames() {
    return listBoneNames(this._collectImportBones());
  }

  _ensureTransformControls() {
    if (this.transformControls || !this.camera || !this.canvas || !this.scene) return;
    const tc = new TransformControls(this.camera, this.canvas);
    tc.setSize(0.85);
    tc.addEventListener('dragging-changed', (event) => {
      if (this.controls) this.controls.enabled = !event.value;
    });
    // TransformControls is an Object3D helper graph in recent three.
    if (typeof tc.getHelper === 'function') {
      this.scene.add(tc.getHelper());
    } else {
      this.scene.add(tc);
    }
    this.transformControls = tc;
  }

  _disposeTransformControls() {
    if (!this.transformControls) return;
    this.transformControls.detach();
    const helper = typeof this.transformControls.getHelper === 'function'
      ? this.transformControls.getHelper()
      : this.transformControls;
    helper.removeFromParent();
    this.transformControls.dispose?.();
    this.transformControls = null;
    if (this.controls) this.controls.enabled = true;
  }

  renderFrame = () => {
    this.animationFrame = requestAnimationFrame(this.renderFrame);
    if (!this.renderer || !this.scene || !this.camera) return;
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (!this._importAnimPaused) {
      this.animationController?.update(delta);
      // After mixer: lateral arm raise so hands clear thighs (appearance.armSpace).
      if (this.model && this.appearance) {
        applyArmRaisePose(this.model, this.appearance.armSpace);
      }
      this.garmentRuntime?.step(delta);
    }
    // Import mode: do NOT run the mixer. Pose is set imperatively on bones
    // and held until the next applyImportPoseConfig / endOutfitImport.
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
      morphMeshes: this.model?.morphMeshes.length ?? 0,
      bones: Object.keys(this.model?.bones ?? {}).length,
      rawHeight: this.model ? Number(this.model.rawHeight.toFixed(3)) : 0,
      // Prefer the skeleton that is actually on screen (avoids mid-switch mismatch).
      body: this.loadedBodyUrl || this.modelUrl || 'human5',
      requestedBody: this.modelUrl || 'human5',
      animationState: this.animationController?.currentState ?? null,
      appearance: this.appearance,
      garment: this.garmentRuntime?.snapshot() ?? null,
      outfit: this.outfitRuntime?.snapshot() ?? null,
      outfitLoopEditor: this.outfitLoopEditor ? {
        active: true,
        target: this.outfitLoopEditor.target,
        interpolation: this.outfitLoopEditor.interpolation,
        hideSide: this.outfitLoopEditor.hideSide,
        pointCount: this.outfitLoopEditor.points.length,
        status: this.outfitLoopEditor.status,
      } : { active: false, pointCount: 0, status: '' },
      hair: this.hairRuntime?.snapshot() ?? null,
      importMode: this.importMode,
      importCloth: Boolean(this.importCloth),
    };
  }
}
