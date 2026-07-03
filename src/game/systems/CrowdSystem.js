import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { prepareBakedCrowdPoses } from '../geometry/prepareBakedCrowdPoses.js';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';

/**
 * CrowdSystem — dedicated first-class peer to EnemySystem (milestones 1+2 only).
 *
 * Provides cheap ambient visual density using pre-baked posed InstancedMesh.
 * Scope strictly limited to Foundation/Analysis + Visual Foundation + Basic Instancing:
 *   - Soldier archetype only (standardize on majority visual for v1 ambient).
 *   - Load + bake 1+ posed geoms from clip at load time.
 *   - Hard-coded/ring static instances (~80) around player start using first pose.
 *   - One InstancedMesh, frustumCulled=true, ground snap + soldier offsets.
 *   - No chunk seeds, no promotion, no dynamic phase updates, no per-chunk, no physics/cuts.
 *
 * Bake/ring uses soldier "Idle Alert". Howl/aggressive equiv is "Bite" (see enemy fallbacks).
 *
 * Visual match: identical soldier targetHeight=1.85 / groundOffset=-0.05 + orientation fix
 * + material clone (skinning=false) + bake path. Matches full enemies as closely as possible.
 *
 * Patterns followed exactly: EnemySystem load (GLTF+DRACO+meshopt), bakeSkinned reuse,
 * disposeObject3D, flatten, Group ownership, frustumCulled on instanced (unlike full enemies),
 * GAME_CONFIG, WebGPU-friendly static geom.
 */

const CROWD_DEFAULT_CAPACITY = 256;

// Jitter factors hoisted from populate (addressing residual magic after ring hoisting).
// These provide natural visual variation for standing crowd on sidewalks (not deterministic).
const CROWD_JITTER_MAX = 2.8;       // max horizontal jitter in units
const CROWD_JITTER_Z_FACTOR = 0.6;  // scale jitter for depth to keep on sidewalk
const CROWD_YAW_JITTER = 1.2;       // max yaw deviation radians for varied facing

// Ring fallbacks (config in GAME_CONFIG.crowd is authoritative; these are resilience-only
// duplicates of the documented values in config to avoid import/undefined issues if config absent).
export class CrowdSystem {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Crowd Group';
    this.status = 'idle';
    this.error = null;
    this.aliveCrowd = null;
    this.bakedPoses = [];
    this.count = 0;
    this._capacity = CROWD_DEFAULT_CAPACITY;
  }

  async load(scene, { level, playerPosition = new THREE.Vector3() } = {}) {
    this.status = 'loading';
    this.error = null;
    if (!scene) {
      this.status = 'error';
      this.error = new Error('no scene provided');
      return;
    }
    scene.add(this.group);

    const crowdConfig = GAME_CONFIG.crowd || {};
    const ringCount = crowdConfig.ringCount ?? 80;
    if (ringCount <= 0) {
      this.status = 'ready';
      return;
    }

    try {
      const loader = createGltfLoader();

      // Load soldier.glb (standardize on soldier for v1 ambient — majority of interactive enemies).
      // Duplicate load is acceptable for phase 1/2 (browser caches GLB; shared asset later).
      const gltf = await loader.loadAsync('/assets/models/soldier.glb');

      const rawClips = gltf.animations || [];

      let targetHeight = crowdConfig.targetHeight ?? 1.85;
      if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
        console.warn('[CrowdSystem] invalid targetHeight, falling back');
        targetHeight = 1.85;
      }
      let groundOffset = crowdConfig.groundOffset ?? -0.05;
      if (!Number.isFinite(groundOffset)) groundOffset = -0.05;

      // Bake posed geometry using helper (samples clip, poses temp root + mixer, reuses bakeSkinned).
      const posedGeoms = prepareBakedCrowdPoses(gltf.scene, rawClips, {
        clipName: 'Idle Alert',
        sampleTimes: [0], // single static pose for phase 2 foundation (expand samples in phase 3+)
        targetHeight,
        orientationFixX: -Math.PI / 2,
      });
      this.bakedPoses = posedGeoms;

      if (posedGeoms.length === 0 || !posedGeoms[0]?.geometry) {
        throw new Error('Failed to bake any crowd poses');
      }

      // Material: clone from source (skinning=false) then apply exact soldier dielectric/opaque fixes
      // from EnemySystem prepareEnemyMaterials for visual parity on Tripo soldier (metalness=0 etc.).
      let baseMaterial = null;
      gltf.scene.traverse((child) => {
        if (!baseMaterial && (child.isSkinnedMesh || child.isMesh) && child.material) {
          const m = Array.isArray(child.material) ? child.material.find(Boolean) : child.material;
          if (m) baseMaterial = m;
        }
      });
      let crowdMaterial = baseMaterial ? baseMaterial.clone() : null;
      if (crowdMaterial) {
        crowdMaterial.skinning = false;
        // Inline of prepareEnemyMaterials (soldier path only; robot would skip).
        const mats = Array.isArray(crowdMaterial) ? crowdMaterial : [crowdMaterial];
        for (const material of mats) {
          if (!material) continue;
          material.metalness = 0;
          if (material.metalnessMap) material.metalnessMap = null;
          material.roughness = Math.max(material.roughness ?? 0.6, 0.68);
          if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
          if ((material.opacity ?? 1) >= 1) {
            material.transparent = false;
            material.depthWrite = true;
          }
          material.needsUpdate = true;
        }
      }

      const poseGeom = posedGeoms[0].geometry;
      // Note: bakeSkinned produces fresh clean Float32 attrs; no flatten needed for crowd posed statics.
      // M2 uses first baked pose only (plan allows "one or more"; multi-pose for phase 3+ phase attrs).

      this._capacity = crowdConfig.maxCapacity ?? CROWD_DEFAULT_CAPACITY;
      this.aliveCrowd = new THREE.InstancedMesh(poseGeom, crowdMaterial, this._capacity);
      this.aliveCrowd.name = 'Alive Crowd';
      // frustumCulled=true (unlike full EnemySystem soldiers which force false) per m2 + plan: cheap crowd relies on frustum + fog + distance.
      this.aliveCrowd.frustumCulled = true;
      this.aliveCrowd.castShadow = true;
      this.aliveCrowd.receiveShadow = true;

      // Phase 2: static ring of ~80 instances around player start (hardcoded; no chunks yet).
      this.populateStaticRing(playerPosition, level, groundOffset);

      this.group.add(this.aliveCrowd);
      this._m1RobotEnumerated = this._m1RobotEnumerated || false;
      this.status = 'ready';
    } catch (error) {
      this.status = 'error';
      this.error = error;
      console.warn('CrowdSystem model failed to load.', error);
      // Clean stray group on error (prevent leak if add happened before failure).
      try { this.group.removeFromParent(); } catch {}
    }
  }

  populateStaticRing(playerPosition, level, groundOffset) {
    if (!this.aliveCrowd) return;

    const center = playerPosition ? playerPosition.clone() : new THREE.Vector3(0, 0, 0);
    center.y = 0;

    const cfg = GAME_CONFIG.crowd || {};
    // Use config values (see crowd section); ?? here are documented resilience duplicates of config defaults.
    const num = Math.min(cfg.ringCount ?? 80, this._capacity);
    const radius = cfg.ringRadius ?? 28;
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    let writeIdx = 0;

    for (let i = 0; i < num; i += 1) {
      const angle = (i / num) * Math.PI * 2;
      const jitter = (Math.random() - 0.5) * CROWD_JITTER_MAX;
      // Fresh pos (x,0,z) each iter to avoid stale .y carrying into getGroundHeightAt (which inspects y).
      pos.set(
        center.x + Math.cos(angle) * radius + jitter,
        0,
        center.z + Math.sin(angle) * radius + jitter * CROWD_JITTER_Z_FACTOR
      );
      // Ground snap using level API (available via chunked city + getGroundHeightAt). Radius matches enemy spawn.
      const ground = level?.getGroundHeightAt?.(pos, 0.5) ?? 0;
      pos.y = ground + groundOffset;

      // Varied yaw for natural standing look (not all facing one way).
      const yaw = angle + (Math.random() - 0.5) * CROWD_YAW_JITTER;
      matrix.makeRotationY(yaw);
      matrix.setPosition(pos.x, pos.y, pos.z);

      this.aliveCrowd.setMatrixAt(writeIdx, matrix);
      writeIdx += 1;
    }

    this.aliveCrowd.count = writeIdx;
    this.count = writeIdx;
    this.aliveCrowd.instanceMatrix.needsUpdate = true;
    this.aliveCrowd.computeBoundingSphere();
  }

  update({ delta = 0, playerPosition, level } = {}) {
    if (this.status !== 'ready' || !this.aliveCrowd) {
      return;
    }
    // Phase 2 stub: instances are static baked poses. No phase advance / rebuild yet.
    // (Future phases: cheap per-member phase, LOD, distance cull, matrix updates here.)
    // Basic frustum + distance handled by three (frustumCulled=true) + fog. Matches Enemy precedent comment.
    void delta;
    void playerPosition;
    void level;
  }

  snapshot() {
    // Snapshot contract for existing debugBridge / smoke harness observability (m1+2 foundation only).
    // All fields are always present (solid types). Use via runtime.snapshot().crowd in the project's
    // current Playwright + evaluate pattern. No new test scripts or modifications required.
    // Key fields for M1 analysis + M2 visual ring: status, count, bakedClip*, m1RobotEnumerated, error, ready, hasInstances.
    return {
      status: this.status,
      count: this.count,
      capacity: this._capacity,
      drawCalls: this.aliveCrowd ? 1 : 0,
      bakedPoses: this.bakedPoses.length,
      // Solid bakedClip from soldier (Idle Alert t=0 after lockRoot + flatten + normalize + bakeSkinned + strip).
      bakedClip: this.bakedPoses[0] ? {
        name: this.bakedPoses[0].name,
        duration: this.bakedPoses[0].duration,
        sampleTime: this.bakedPoses[0].sampleTime
      } : null,
      bakedClipName: this.bakedPoses[0]?.name || null,
      m1RobotEnumerated: !!this._m1RobotEnumerated,
      ready: this.status === 'ready',
      hasInstances: this.count > 0,
      // Ring config (from GAME_CONFIG.crowd or internal defaults) for observability of m2 placement.
      ring: { count: this.count, capacity: this._capacity },
      error: this.error ? String(this.error.message || this.error) : null,
    };
  }

  dispose() {
    // Remove child first to avoid double traversal in disposeObject3D.
    let liveGeom = null;
    if (this.aliveCrowd) {
      liveGeom = this.aliveCrowd.geometry;
      this.group.remove(this.aliveCrowd);
      // Geometry + material cleanup (InstancedMesh owns its buffers).
      liveGeom?.dispose?.();
      const mat = this.aliveCrowd.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => m?.dispose?.());
      } else {
        mat?.dispose?.();
      }
      this.aliveCrowd = null;
    }

    // Explicitly dispose baked geoms (defensive for error paths/extra samples).
    // Guard to skip the primary one (== liveGeom) on success path to avoid double-dispose of the
    // geom assigned to InstancedMesh (baked[0] == alive geometry in normal flow).
    for (const p of this.bakedPoses) {
      if (p?.geometry && p.geometry !== liveGeom) {
        p.geometry.dispose?.();
      }
    }
    this.bakedPoses = [];

    disposeObject3D(this.group);
    this.group.removeFromParent();
    this.count = 0;
    this.status = 'disposed';
  }
}
