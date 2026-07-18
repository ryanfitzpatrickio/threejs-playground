/**
 * Client-local aquarium breach FX for levels that expose `level.aquarium`.
 *
 * - onWorldHit: map hitscan world hits onto tank AABBs → breach model holes
 * - update: step Torricelli drain, scale water meshes, drive jets/puddles/cracks,
 *   fish waterline uniforms, spatial spray audio
 *
 * Inert when the current level has no aquarium (COUNT-0 dormant path).
 * Breach state is not networked — cosmetic only (see plan).
 */

import * as THREE from 'three';
import { createBreachModel } from '../world/aquariumBreachModel.js';
import { createWaterJetRenderer } from '../render/createWaterJetRenderer.js';
import { createGlassPaneShatter } from '../render/createGlassPaneShatter.js';

/**
 * Looping procedural spray/hiss near active jets (no sample asset required).
 * Spatialized via PannerNode; gain tracks jet pressure sum near the player.
 */
class AquariumSprayAudio {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.filter = null;
    this.gain = null;
    this.panner = null;
    this.started = false;
    this.targetGain = 0;
    this._listenerPos = new THREE.Vector3();
  }

  _ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, sr * 2, sr);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      // Brown-ish noise with a wet hiss edge.
      last = last * 0.88 + white * 0.12;
      data[i] = last * 0.65 + white * 0.18;
    }
    this.source = this.ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 1400;
    this.filter.Q.value = 0.55;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.panner = this.ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 4;
    this.panner.maxDistance = 40;
    this.panner.rolloffFactor = 1.2;
    this.source.connect(this.filter).connect(this.gain).connect(this.panner).connect(this.ctx.destination);
    this.source.start();
    this.started = true;
  }

  resume() {
    this._ensure();
    this.ctx?.resume?.().catch?.(() => {});
  }

  /**
   * @param {{ intensity: number, x: number, y: number, z: number, listener?: THREE.Camera | null }} opts
   */
  update({ intensity = 0, x = 0, y = 0, z = 0, listener = null } = {}) {
    if (intensity > 0.02) this.resume();
    if (!this.ctx || !this.gain || !this.panner) return;

    const target = THREE.MathUtils.clamp(intensity, 0, 1) * 0.22;
    this.targetGain = target;
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, target > 0.01 ? 0.12 : 0.25);
    if (this.filter) {
      this.filter.frequency.setTargetAtTime(900 + intensity * 1100, this.ctx.currentTime, 0.15);
    }

    if (typeof this.panner.positionX !== 'undefined') {
      this.panner.positionX.setTargetAtTime(x, this.ctx.currentTime, 0.05);
      this.panner.positionY.setTargetAtTime(y, this.ctx.currentTime, 0.05);
      this.panner.positionZ.setTargetAtTime(z, this.ctx.currentTime, 0.05);
    } else {
      this.panner.setPosition?.(x, y, z);
    }

    if (listener?.isCamera || listener?.position) {
      listener.getWorldPosition?.(this._listenerPos)
        || this._listenerPos.copy(listener.position);
      const l = this.ctx.listener;
      if (l.positionX) {
        l.positionX.setTargetAtTime(this._listenerPos.x, this.ctx.currentTime, 0.05);
        l.positionY.setTargetAtTime(this._listenerPos.y, this.ctx.currentTime, 0.05);
        l.positionZ.setTargetAtTime(this._listenerPos.z, this.ctx.currentTime, 0.05);
      } else {
        l.setPosition?.(this._listenerPos.x, this._listenerPos.y, this._listenerPos.z);
      }
    }
  }

  dispose() {
    try { this.source?.stop(); } catch { /* already stopped */ }
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.panner = null;
    this.started = false;
  }
}

export class AquariumBreachSystem {
  constructor() {
    this.enabled = false;
    /**
     * True when the bound (or pending) level has aquarium tanks. Used by
     * WeaponSystem to opt into world physics rays before/while enabled.
     */
    this.wantsWorldRay = false;
    /** @type {ReturnType<typeof createBreachModel> | null} */
    this.model = null;
    /** @type {ReturnType<typeof createWaterJetRenderer> | null} */
    this.jets = null;
    /** @type {Array<object> | null} */
    this.tanks = null;
    /** @type {import('three').Mesh | null} */
    this.fishMesh = null;
    /** @type {{ value: THREE.Vector4 } | null} */
    this.tankWaterLevels = null;
    this._sprayAudio = new AquariumSprayAudio();
    this._boundLevel = null;
    this._scene = null;
    this._physicsSystem = null;
    this._hitsAccepted = 0;
    this._leaksCreated = 0;
    this._shatteredFaces = 0;
    this._knownLeakKeys = new Set();
    /** @type {ReturnType<typeof createGlassPaneShatter> | null} */
    this.glassShatter = null;
  }

  /**
   * Bind (or rebind) to the current level's aquarium payload.
   * @param {{ scene?: import('three').Scene, level?: object | null }} opts
   */
  bindLevel({ scene = null, level = null } = {}) {
    this.unbind();
    this._scene = scene;
    this._boundLevel = level ?? null;
    const aquarium = level?.aquarium;
    this.wantsWorldRay = Boolean(aquarium?.tanks?.length);
    if (!aquarium?.tanks?.length) {
      this.enabled = false;
      return;
    }

    this.tanks = aquarium.tanks.map((t) => ({
      id: t.id,
      waterMesh: t.waterMesh ?? null,
      faceMeshes: t.faceMeshes ?? null,
      waterBottomY: t.waterBottomY,
      waterH: t.waterH ?? Math.max(0.01, (t.waterTopY ?? 0) - (t.waterBottomY ?? 0)),
      cx: t.cx,
      cz: t.cz,
      halfSize: t.halfSize,
      waterTopY: t.waterTopY,
      glassBottomY: t.glassBottomY ?? 0.58,
      glassTopY: t.glassTopY ?? t.waterTopY ?? 7.2,
      innerArea: t.innerArea,
    }));

    this.fishMesh = aquarium.fishMesh ?? null;
    this.tankWaterLevels = aquarium.tankWaterLevels
      ?? this.fishMesh?.material?.userData?.tankWaterLevels
      ?? null;

    this.model = createBreachModel({
      tanks: this.tanks.map((t) => ({
        id: t.id,
        cx: t.cx,
        cz: t.cz,
        halfSize: t.halfSize,
        waterBottomY: t.waterBottomY,
        waterTopY: t.waterTopY,
        waterH: t.waterH,
        innerArea: t.innerArea,
      })),
    });

    // Seed fish waterline uniform to full tanks.
    if (this.tankWaterLevels?.value?.set) {
      this.tankWaterLevels.value.set(
        this.tanks[0]?.waterTopY ?? 6.86,
        this.tanks[1]?.waterTopY ?? 6.86,
        this.tanks[2]?.waterTopY ?? 6.86,
        this.tanks[3]?.waterTopY ?? 6.86,
      );
    }

    if (scene) {
      this.jets = createWaterJetRenderer({
        parent: scene,
        floorY: aquarium.floorY ?? 0,
        name: 'Aquarium Water Jets',
        tanks: this.tanks,
      });
      this.glassShatter = createGlassPaneShatter({
        parent: scene,
        floorY: aquarium.floorY ?? 0,
      });
    }

    this.enabled = true;
    this._hitsAccepted = 0;
    this._leaksCreated = 0;
    this._shatteredFaces = 0;
    this._knownLeakKeys.clear();
  }

  unbind() {
    this.jets?.dispose?.();
    this.jets = null;
    this.glassShatter?.dispose?.();
    this.glassShatter = null;
    this.model = null;
    this.tanks = null;
    this.fishMesh = null;
    this.tankWaterLevels = null;
    this._sprayAudio.dispose();
    this._sprayAudio = new AquariumSprayAudio();
    this.enabled = false;
    this.wantsWorldRay = false;
    this._boundLevel = null;
    this._scene = null;
    this._knownLeakKeys.clear();
  }

  /**
   * Apply a structural face collapse: hide pane, CSG+Rapier glass shards, wake audio.
   * @param {{ tankId: string, face: string }} event
   * @param {object} [physicsSystem]
   */
  _applyShatter(event, physicsSystem = null) {
    if (!event?.tankId || !event?.face) return;
    const tank = this.tanks?.find((t) => t.id === event.tankId);
    if (!tank) return;
    const pane = tank.faceMeshes?.[event.face];
    if (pane) {
      pane.visible = false;
      // Stop contributing to glass hitscan silhouette if any mesh raycast exists.
      pane.userData.skipLevelRaycast = true;
    }
    this.glassShatter?.shatterFace?.({
      face: event.face,
      cx: tank.cx,
      cz: tank.cz,
      halfSize: tank.halfSize,
      bottomY: tank.glassBottomY ?? 0.58,
      topY: tank.glassTopY ?? tank.waterTopY,
      // Final bullet impact — radial spider fracture originates here.
      impactPoint: event.point ?? null,
      faceMesh: pane ?? null,
      physicsSystem: physicsSystem ?? this._physicsSystem,
    });

    this._shatteredFaces += 1;
    this._sprayAudio.resume();
  }

  /**
   * Hitscan world-hit notification (WeaponSystem kind === 'world' branch).
   * @param {{ point?: { x: number, y: number, z: number }, normal?: { x?: number, y?: number, z?: number }, surfaceClass?: string }} result
   */
  onWorldHit(result) {
    if (!this.enabled || !this.model || !result?.point) return false;
    const tank = this.model.resolveTankAt(result.point);
    if (!tank) return false;

    const added = this.model.addHole(tank.id, {
      point: result.point,
      normal: result.normal,
    });
    if (added.accepted) {
      this._hitsAccepted += 1;
      if (added.isLeak && added.hole) {
        this._leaksCreated += 1;
        this.jets?.addCrackMark?.({ tankId: tank.id, hole: added.hole });
        this._sprayAudio.resume();
      }
      // Structural collapse may fire from this hit.
      if (added.shattered && added.face) {
        this._applyShatter({
          tankId: tank.id,
          face: added.face,
          point: added.impactPoint ?? result.point,
          normal: result.normal,
        }, this._physicsSystem);
      }
    }
    // Drain any queued shatter events (force-shatter / multi).
    for (const ev of this.model.drainShatterEvents()) {
      // Already applied if it matched added.shattered, but force-shatter only.
      if (added.shattered && ev.tankId === tank.id && ev.face === added.face) continue;
      this._applyShatter(ev, this._physicsSystem);
    }
    return added.accepted;
  }

  /**
   * @param {{ delta?: number, level?: object | null, camera?: import('three').Camera, scene?: import('three').Scene, physicsSystem?: object }} opts
   */
  update({ delta = 0, level = null, camera = null, scene = null, physicsSystem = null } = {}) {
    if (physicsSystem) this._physicsSystem = physicsSystem;
    // Lazy bind / rebind if level payload changes (mode switches, reloads).
    if (level !== this._boundLevel) {
      this.bindLevel({ scene: scene ?? this._scene, level });
    }
    if (!this.enabled || !this.model) return;

    this.model.step(delta);

    // Catch shatter events from non-hit paths (tests / debug).
    for (const ev of this.model.drainShatterEvents()) {
      this._applyShatter(ev, this._physicsSystem);
    }

    const tankDrain = [];
    let sprayIntensity = 0;
    let sprayX = 0;
    let sprayY = 1.2;
    let sprayZ = 0;
    let sprayWeight = 0;

    // Apply water column height via scale.y (mesh origin at water bottom).
    if (this.tanks) {
      const levels = [];
      for (let i = 0; i < this.tanks.length; i += 1) {
        const tank = this.tanks[i];
        const levelY = this.model.getWaterLevel(tank.id);
        levels[i] = levelY ?? tank.waterTopY;
        const height = Math.max(0, (levelY ?? tank.waterBottomY) - tank.waterBottomY);
        const drained01 = 1 - Math.max(0, Math.min(1, height / tank.waterH));
        tankDrain.push({ tankId: tank.id, drained01 });

        const mesh = tank.waterMesh;
        if (mesh) {
          if (height <= 0.01) {
            mesh.visible = false;
            mesh.scale.y = 0.01;
          } else {
            mesh.visible = true;
            mesh.scale.y = height;
          }
          if (mesh.matrixAutoUpdate === false) mesh.matrixAutoUpdate = true;
          if (mesh.matrixWorldAutoUpdate === false) mesh.matrixWorldAutoUpdate = true;
          mesh.updateMatrix();
          mesh.updateMatrixWorld?.(true);
        }
      }

      // Drive fish sink / beach via TSL vec4 uniform (tank order matches tankIndex).
      if (this.tankWaterLevels?.value?.set) {
        this.tankWaterLevels.value.set(
          levels[0] ?? 6.86,
          levels[1] ?? levels[0] ?? 6.86,
          levels[2] ?? levels[0] ?? 6.86,
          levels[3] ?? levels[0] ?? 6.86,
        );
      }
    }

    const activeJets = this.model.getActiveJets();
    const activeWaterfalls = this.model.getActiveWaterfalls();

    for (const jet of activeJets) {
      const w = jet.jetSpeed;
      sprayIntensity += w;
      sprayX += jet.hole.x * w;
      sprayY += jet.hole.y * w;
      sprayZ += jet.hole.z * w;
      sprayWeight += w;
      const key = `${jet.tankId}:${jet.hole.x.toFixed(2)},${jet.hole.y.toFixed(2)},${jet.hole.z.toFixed(2)}`;
      if (!this._knownLeakKeys.has(key)) {
        this._knownLeakKeys.add(key);
        this.jets?.addCrackMark?.(jet);
      }
    }
    for (const fall of activeWaterfalls) {
      // Loud dump near the open face.
      const w = fall.jetSpeed * 2.5;
      sprayIntensity += w;
      const px = fall.cx + fall.nx * fall.halfSize;
      const pz = fall.cz + fall.nz * fall.halfSize;
      sprayX += px * w;
      sprayY += fall.waterLevel * w;
      sprayZ += pz * w;
      sprayWeight += w;
    }
    if (sprayWeight > 1e-4) {
      sprayX /= sprayWeight;
      sprayY /= sprayWeight;
      sprayZ /= sprayWeight;
    }
    const intensity01 = THREE.MathUtils.clamp(sprayIntensity / 14, 0, 1);
    this._sprayAudio.update({
      intensity: intensity01,
      x: sprayX,
      y: sprayY,
      z: sprayZ,
      listener: camera,
    });

    // Bullet jets + full-face-width waterfall ribbon on shatter.
    if (this.jets) {
      this.jets.update({
        dt: delta,
        jets: activeJets,
        waterfalls: activeWaterfalls,
        camera,
        tankDrain,
      });
    }

    this.glassShatter?.update?.(delta, this._physicsSystem);
  }

  snapshot() {
    if (!this.enabled || !this.model) {
      return {
        enabled: false,
        hitsAccepted: this._hitsAccepted,
        leaksCreated: this._leaksCreated,
        shatteredFaces: this._shatteredFaces,
        model: null,
        jets: null,
        glass: null,
        sprayAudio: { active: false },
      };
    }
    return {
      enabled: true,
      hitsAccepted: this._hitsAccepted,
      leaksCreated: this._leaksCreated,
      shatteredFaces: this._shatteredFaces,
      model: this.model.snapshot(),
      jets: this.jets?.snapshot?.() ?? null,
      glass: this.glassShatter?.snapshot?.() ?? null,
      sprayAudio: {
        active: this._sprayAudio.started,
        gain: Number((this._sprayAudio.targetGain ?? 0).toFixed(3)),
      },
    };
  }

  dispose() {
    this.unbind();
  }
}
