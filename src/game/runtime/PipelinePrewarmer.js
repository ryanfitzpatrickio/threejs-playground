import * as THREE from 'three';
import { sanitizeWebGPUVertexBuffers } from '../geometry/prepareWebGPUGeometry.js';
import { rainWind } from '../systems/weatherUniforms.js';
import { INITIAL_PIPELINE_COMPILE_TIMEOUT_MS } from './runtimeConstants.js';
import { settleWithin, hideUnsafeAsyncCompileObjects } from './runtimeHelpers.js';
import { bindRuntimeHost } from './bindRuntimeHost.js';

/** Initial + streaming pipeline warmup / compileAsync. */
export class PipelinePrewarmer {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  async _runPrewarm(generation) {
    try {
      await this._prewarmShaders(generation);
    } catch {
      // Non-fatal — first real frames may still compile anything missed.
    }
    if (this._aborted(generation)) return;
    this._prewarmFinished = true;
    this._setLoadProgress({
      phase: 'pipelines',
      label: 'Shaders ready',
      sub: { pipelines: 1 },
      detail: { prewarm: this._cityPrewarmProgress },
    });
    this._tryEnterRunning();
  }

  async _prewarmShaders(generation) {
    const renderer = this.rendererSystem.renderer;
    const scene = this.sceneSystem.scene;
    const camera = this.cameraSystem.camera;
    const warmup = this.levelSystem.level?.createPipelineWarmupGroup?.() ?? null;

    try {
      this._setLoadProgress({
        phase: 'pipelines',
        label: 'Warming shaders…',
        sub: { pipelines: 0.05 },
      });
      // compileAsync turns small instance/skeleton arrays into vertex uniform
      // buffers. WebGPU rejects zero-byte bindings, so strip impossible empty
      // render objects before Three builds the asynchronous render list.
      sanitizeWebGPUVertexBuffers(scene);
      if (renderer && typeof renderer.compileAsync === 'function' && scene && camera) {
        // Three r185's async pipeline descriptor is incomplete for the custom
        // MeshSSSNodeMaterial used by hero foliage (missing depthStencil), which
        // poisons the prewarm command stream. Let those bounded objects compile
        // through their real render context instead of compileAsync(scene).
        const restoreUnsafeMaterials = hideUnsafeAsyncCompileObjects(scene);
        try {
          const compiled = await settleWithin(
            renderer.compileAsync(scene, camera),
            INITIAL_PIPELINE_COMPILE_TIMEOUT_MS,
          );
          if (!compiled) {
            console.warn('[GameRuntime] initial shader compile timed out; entering play fail-open');
          }
        } finally {
          restoreUnsafeMaterials();
        }
      }
      if (this._aborted(generation)) return;

      // Compile one material's Mesh + InstancedMesh pair at a time. A single
      // scene containing every city TSL material monopolized Chromium for
      // minutes; small batches keep the loading loop responsive while still
      // presenting each variant to the real lights, shadows, and SSAO pass.
      const children = warmup ? [...warmup.children] : [];
      const totalBatches = Math.max(1, Math.ceil(children.length / 2));
      this._cityPrewarmProgress = { completed: 0, total: totalBatches };
      if (children.length === 0) {
        this._setLoadProgress({
          phase: 'pipelines',
          label: 'Warming shaders…',
          sub: { pipelines: 0.85 },
          detail: { prewarm: this._cityPrewarmProgress },
        });
      }
      for (let index = 0; index < children.length; index += 2) {
        if (this._aborted(generation)) return;
        const batch = new THREE.Group();
        batch.name = `City Pipeline Warmup Batch ${index / 2}`;
        batch.add(...children.slice(index, index + 2));
        scene.add(batch);
        try {
          // Do not call compileAsync(scene) for every pair: that repeatedly
          // re-analyzes the entire live scene and made the warmup take minutes.
          // The active animation loop renders this small batch through the real
          // color/shadow/prepass pipeline on the next two frames.
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        } finally {
          batch.removeFromParent();
        }
        this._cityPrewarmProgress.completed += 1;
        const pipelineFrac = this._cityPrewarmProgress.completed / totalBatches;
        this._setLoadProgress({
          phase: 'pipelines',
          label: 'Warming shaders…',
          sub: { pipelines: 0.1 + pipelineFrac * 0.85 },
          detail: { prewarm: { ...this._cityPrewarmProgress } },
        });
      }

    } catch (e) {
      // Non-fatal
    } finally {
      // compileAsync can reject before covering every real RenderPipeline
      // context. Keep a few full render frames so shadow/SSAO caches populate.
      for (let frame = 0; frame < 4; frame += 1) {
        if (this._aborted(generation)) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      warmup?.removeFromParent();
      warmup?.userData?.disposeWarmup?.();
      if (!this._aborted(generation) && this._cityPrewarmProgress) {
        this._cityPrewarmProgress = {
          completed: this._cityPrewarmProgress.total,
          total: this._cityPrewarmProgress.total,
        };
      } else {
        this._cityPrewarmProgress = null;
      }
    }
  }

  _updatePrewarmingFrame(timeMs, delta, frameMs) {
    const character = this.characterSystem.character;
    if (!character) {
      this.emitSnapshot();
      return;
    }

    this.rendererSystem.resizeIfNeeded((viewport) => {
      this.cameraSystem.resize(viewport);
    });

    let streamingMs = 0;
    let streamingActive = false;
    const streamStart = performance.now();
    const streamingFocus = character.group.position;
    const viewPos = this.cameraSystem?.camera?.position ?? streamingFocus;
    const streamingChanges = this.levelSystem.updateStreaming(streamingFocus, {
      viewPosition: viewPos,
    });
    const builtColliders = this.physicsSystem.applyStreamingChanges?.(streamingChanges) ?? 0;
    streamingMs = performance.now() - streamStart;
    streamingActive =
      builtColliders > 0 ||
      (streamingChanges?.addedChunks?.length ?? 0) > 0 ||
      (streamingChanges?.removedChunkKeys?.length ?? 0) > 0 ||
      (streamingChanges?.terrainVisualChanges ?? 0) > 0;

    if ((streamingChanges?.addedChunks?.length ?? 0) > 0) {
      this.queueStreamingCompile(streamingChanges.addedChunks.map((chunk) => chunk.group));
    }

    this.sceneSystem.updateShadowFollow?.(streamingFocus);
    this.sceneSystem.updateStreetLights?.(streamingFocus);
    this.frameStats.recordSystem('streaming', streamingMs);

    this.frameStats.start('bvh');
    this.levelSystem.warmupGeometryRaycasts({
      maxMs: streamingActive ? 1 : 2,
      maxCount: streamingActive ? 2 : 8,
    });
    this.frameStats.endSection();

    this.levelSystem.level?.updateForestEnvironment?.({
      sunDirection: this.sceneSystem.skySystem?.sunDirection,
      windVector: rainWind.value,
    });

    // Hold camera on spawn so prewarm batches and shadows compile from a stable view.
    this.cameraSystem.update({
      delta,
      target: character.group.position,
      viewport: this.rendererSystem.getViewport(),
      input: { lookX: 0, lookY: 0, rearViewHeld: false },
      rootMotionActive: false,
      character,
      vehicle: null,
    });

    if (this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
      this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
    }
    this._syncTerrainEnvironment(delta);

    const renderStart = performance.now();
    this.rendererSystem.render({
      scene: this.sceneSystem.scene,
      camera: this.cameraSystem.camera,
      deferExpensivePasses: streamingActive || this._streamingCompileActive,
    });
    const renderMs = performance.now() - renderStart;
    this.frameStats.recordSystem('render', renderMs);
    this.frameStats.record(frameMs, streamingMs, renderMs, streamingActive);
    this.emitSnapshot(timeMs);
  }

  queueStreamingCompile(roots = []) {
    const renderer = this.rendererSystem.renderer;
    const camera = this.cameraSystem.camera;

    for (const root of roots) {
      if (!root) continue;
      sanitizeWebGPUVertexBuffers(root);
      if (renderer?.compileAsync && camera) {
        // Hide the chunk group until its render pipelines/materials are pre-warmed.
        // This prevents the next renderer.render() from stalling on first-seen
        // pipeline compilation (which shows up as main-thread jank).
        root.visible = false;
        this._streamingCompileQueue.push(root);
      } else {
        root.visible = true;
      }
    }

    if (!renderer?.compileAsync || !camera) {
      return;
    }

    if (this._streamingCompileActive) {
      return;
    }

    this._streamingCompileActive = true;
    const drain = async () => {
      while (!this.disposed && this._streamingCompileQueue.length > 0) {
        const root = this._streamingCompileQueue.shift();
        try {
          await renderer.compileAsync(root, camera);
        } catch (_) {
          // Non-fatal; first visible render can compile anything this missed.
        }
        // Reveal only after compile attempt completes (success or fail-open).
        if (root) root.visible = true;
      }
      this._streamingCompileActive = false;
    };

    drain();
  }

  // Teleport the character AND shift the chase camera by the same delta, so the
  // framing stays continuous across a large (pocket) teleport instead of the
  // camera flying across the world to catch up.

}
