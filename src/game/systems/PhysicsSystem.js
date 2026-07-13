import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ensureRapier } from '../physics/rapierInit.js';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { buildTerrainTrimeshData, hasTerrainHoles } from '../../world/terrain/TerrainChunk.js';

const GRAVITY = { x: 0, y: -GAME_CONFIG.character.gravity, z: 0 };
const ROPE_SEGMENTS = 10;
const ROPE_BODY_RADIUS = 0.045;
const ROPE_BODY_DENSITY = 4.5;
const ROPE_DRIVER_STRENGTH = 0.018;
const ROPE_DRIVER_VELOCITY_STRENGTH = 0.012;
const ROPE_DRIVER_MAX_IMPULSE = 0.028;

// Per-frame time budget for registering streamed chunk colliders (the actual Rapier
// trimesh shape construction from data prepared in the cityChunkWorker).
// The heavy trimesh *data* creation (vertex transform + filtering) is now done in
// the worker via buildTrimeshColliderData. We still spread the final Rapier
// creation here so attaching many buildings doesn't spike one frame.
// Drain always does at least one (progress), then respects budget for the rest;
// colliders are sorted by rough cost (small first) on add.
const STREAMING_COLLIDER_BUDGET_MS = 4;

// Fixed physics timestep. The world always integrates in slices of exactly this
// much sim time; how many slices run per rendered frame comes from the real
// frame delta via the accumulator in beginFrame(). This is what makes sim speed
// independent of the display refresh rate (previously one 16 ms step ran per
// rAF frame, so a 120 Hz monitor simulated ~2x real time).
export const PHYSICS_FIXED_STEP = 1 / 60;
export const VEHICLE_PHYSICS_FIXED_STEP = 1 / 120;
// Catch-up cap after a long stall: at most this many fixed steps per frame, and
// any time beyond one extra step is dropped (no death spiral).
const MAX_CATCHUP_STEPS = 4;
const MAX_INTERPOLATED_BODIES = 256;

export class PhysicsSystem {
  constructor() {
    this.RAPIER = null;
    this.world = null;
    this.characterController = null;
    this.characterBody = null;
    this.characterCollider = null;
    this.characterColliderHalfHeight = null;
    this.characterBodyPosition = null;
    this.staticBodies = [];
    this.staticBodyOwners = new Map();
    this.staticBodiesByOwner = new Map();
    this.enemyBodies = [];
    this.ropeChains = new Map();
    this.pendingColliders = [];
    this.steppedThisFrame = false;
    // Fixed-step frame plan (see beginFrame/stepPlanned). When fixedStepPlanning
    // is false, stepPlanned falls back to the legacy one-step-per-call behavior
    // that the headless probe/verify harnesses drive directly.
    this.fixedStepPlanning = false;
    this.stepAccumulator = 0;
    this.plannedSteps = 0;
    this.stepDt = PHYSICS_FIXED_STEP;
    this.tickCount = 0;
    this.simTime = 0;
    this.stepsLastFrame = 0;
    this.poseRegistry = new Map();
    // Optional per-step callbacks wired by GameRuntime:
    //   beforeTick()  — once per fixed step, before integration (pose capture)
    //   integrate(dt, tick) — before each world.step (vehicle forces/impulses)
    //   afterTick()   — once per fixed step, after world.step (platform carry)
    this.stepHooks = null;
    this.status = 'idle';
  }

  async initialize({ level, character, enemies = [] }) {
    if (this.world) {
      this.dispose();
    }

    this.status = 'loading';
    await ensureRapier();
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World(GRAVITY);
    this.world.numSolverIterations = 8;
    this.world.numInternalPgsIterations = 2;
    this.createStaticLevelColliders(level);
    this.createRopeChains(level);
    this.createCharacterController(character);
    this.createEnemyColliders(enemies);
    // Heightfields need one world step before Rapier's query pipeline reliably sees them.
    // The first character-controller movement happens before the normal end-of-frame step.
    this.world.step();
    this.status = 'ready';
  }

  // Plan this frame's fixed-step schedule. Called once per rendered frame with
  // the REAL frame delta and the current timeScale. Step cadence comes from real
  // time (sim speed is independent of display refresh). timeScale scales time
  // entering the accumulator, while the integration step stays fixed so solver
  // and suspension tuning do not change in slow motion.
  // Calling with no arguments keeps the legacy behavior (stepPlanned == one
  // world.step at whatever timestep the caller set), for the headless harnesses.
  beginFrame(frame = null) {
    this.steppedThisFrame = false;
    if (!frame || !this.world) {
      this.fixedStepPlanning = false;
      return;
    }
    const delta = Math.max(frame.delta ?? 0, 0);
    const timeScale = Math.max(frame.timeScale ?? 1, 0);
    const fixedStep = Number.isFinite(frame.fixedStep) && frame.fixedStep > 0
      ? frame.fixedStep
      : PHYSICS_FIXED_STEP;
    this.fixedStepPlanning = true;
    this.stepDt = fixedStep;
    this.stepAccumulator += delta * timeScale;
    // Epsilon so an exact-60Hz delta (accumulator lands on the boundary) isn't
    // lost to float noise just below it.
    let steps = Math.floor(this.stepAccumulator / fixedStep + 1e-9);
    if (steps > MAX_CATCHUP_STEPS) steps = MAX_CATCHUP_STEPS;
    this.stepAccumulator -= steps * fixedStep;
    // When the catch-up cap truncated a long stall, drop the excess instead of
    // letting it snowball into ever-longer frames.
    if (this.stepAccumulator > fixedStep) {
      this.stepAccumulator = fixedStep;
    }
    this.plannedSteps = steps;
    this.stepsLastFrame = 0;
  }

  // Fraction of a fixed step accumulated but not yet simulated — where "now"
  // sits between the last two physics states. Rendering blends dynamic-body
  // visuals with this. 1 (render the live body pose) outside fixed-step mode.
  get interpolationAlpha() {
    if (!this.fixedStepPlanning) return 1;
    const alpha = this.stepAccumulator / this.stepDt;
    return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  }

  // Execute this frame's planned fixed steps. Runs from whichever call site
  // reaches it first — moveCharacter mid-frame on foot, or the end-of-frame
  // physics section while driving — so the step's position within the frame is
  // unchanged from the old single-step design. A frame may legitimately run 0
  // steps (e.g. 120 Hz display: a step every other frame).
  stepPlanned() {
    if (!this.world || this.steppedThisFrame) {
      return;
    }
    if (!this.fixedStepPlanning) {
      this.stepWorld();
      return;
    }
    this.steppedThisFrame = true;
    const hooks = this.stepHooks;
    for (let s = 0; s < this.plannedSteps; s += 1) {
      this.captureRegisteredPoses();
      hooks?.beforeTick?.();
      this.world.timestep = this.stepDt;
      hooks?.integrate?.(this.stepDt, this.tickCount);
      this.world.step();
      hooks?.afterTick?.();
      this.tickCount += 1;
      this.simTime += this.stepDt;
      this.stepsLastFrame += 1;
    }
  }

  registerInterpolatedBody(bodyOrHandle) {
    const handle = typeof bodyOrHandle === 'number' ? bodyOrHandle : bodyOrHandle?.handle;
    if (!Number.isFinite(handle)) return null;
    let pose = this.poseRegistry.get(handle);
    if (!pose && this.poseRegistry.size < MAX_INTERPOLATED_BODIES) {
      pose = { previousPosition: new THREE.Vector3(), previousRotation: new THREE.Quaternion(), valid: false };
      this.poseRegistry.set(handle, pose);
    }
    return pose ?? null;
  }

  captureRegisteredPoses() {
    for (const [handle, pose] of this.poseRegistry) {
      const body = this.getFreshBody(handle);
      if (!body) {
        this.poseRegistry.delete(handle);
        continue;
      }
      if (body.isSleeping?.()) continue;
      try {
        const t = body.translation();
        const r = body.rotation();
        pose.previousPosition.set(t.x, t.y, t.z);
        pose.previousRotation.set(r.x, r.y, r.z, r.w);
        pose.valid = true;
      } catch {
        // Transient Rapier wrapper aliasing: preserve the previous sample.
      }
    }
  }

  sampleInterpolatedPose(bodyOrHandle, alpha = this.interpolationAlpha, outPosition = new THREE.Vector3(), outRotation = new THREE.Quaternion()) {
    const body = this.getFreshBody(bodyOrHandle);
    if (!body) return null;
    const pose = this.registerInterpolatedBody(bodyOrHandle);
    try {
      const t = body.translation();
      const r = body.rotation();
      outPosition.set(t.x, t.y, t.z);
      outRotation.set(r.x, r.y, r.z, r.w);
    } catch {
      return null;
    }
    if (pose?.valid && alpha < 1) {
      outPosition.lerpVectors(pose.previousPosition, outPosition, Math.max(0, alpha));
      outRotation.slerpQuaternions(pose.previousRotation, outRotation, Math.max(0, alpha));
    }
    return { position: outPosition, rotation: outRotation };
  }

  moveCharacter({ character, movement, controllerOptions = null }) {
    if (!this.characterController || !this.characterCollider || !this.characterBody) {
      return {
        movement,
        grounded: character.grounded !== false,
      };
    }

    this.syncCharacterBody(character);
    this.configureCharacterController(controllerOptions);
    this.characterController.computeColliderMovement(this.characterCollider, movement);
    const correctedMovement = this.characterController.computedMovement();
    const currentTranslation = this.characterBodyPosition;
    const nextTranslation = {
      x: currentTranslation.x + correctedMovement.x,
      y: currentTranslation.y + correctedMovement.y,
      z: currentTranslation.z + correctedMovement.z,
    };

    this.safeSetNextKinematicTranslation(this.characterBody, nextTranslation);
    this.stepPlanned();
    this.characterBodyPosition = nextTranslation;

    return {
      movement: correctedMovement,
      grounded: this.characterController.computedGrounded(),
    };
  }

  stepIfNeeded() {
    if (!this.world || this.steppedThisFrame) {
      return;
    }

    this.stepWorld();
  }

  stepWorld() {
    this.world.step();
    this.steppedThisFrame = true;
  }

  // Always fetch a fresh Rapier body wrapper by handle to avoid holding stale
  // references that trigger "unsafe aliasing" when many dynamic bodies (e.g. telekinesis
  // chunks) have contacts with kinematics or each other.
  getFreshBody(bodyOrHandle) {
    if (!this.world) return null;
    let handle = null;
    if (bodyOrHandle != null) {
      if (typeof bodyOrHandle === 'number') {
        handle = bodyOrHandle;
      } else if (typeof bodyOrHandle.handle === 'number') {
        handle = bodyOrHandle.handle;
      }
    }
    if (handle == null) return null;
    try {
      return this.world.bodies.get(handle);
    } catch {
      return null;
    }
  }

  safeSetNextKinematicTranslation(bodyOrHandle, translation) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return false;
    try {
      fresh.setNextKinematicTranslation(translation);
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes('aliasing')) throw e;
      return false;
    }
  }

  safeSetLinvel(bodyOrHandle, linvel, wake = true) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return false;
    try {
      fresh.setLinvel(linvel, wake);
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes('aliasing')) throw e;
      return false;
    }
  }

  safeSetAngvel(bodyOrHandle, angvel, wake = true) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return false;
    try {
      fresh.setAngvel(angvel, wake);
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes('aliasing')) throw e;
      return false;
    }
  }

  safeSetGravityScale(bodyOrHandle, scale, wake = true) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return false;
    try {
      fresh.setGravityScale(scale, wake);
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes('aliasing')) throw e;
      return false;
    }
  }

  safeGetTranslation(bodyOrHandle) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return null;
    try {
      const t = fresh.translation();
      return { x: t.x, y: t.y, z: t.z };
    } catch {
      return null;
    }
  }

  safeGetLinvel(bodyOrHandle) {
    const fresh = this.getFreshBody(bodyOrHandle);
    if (!fresh) return null;
    try {
      const v = fresh.linvel();
      return { x: v.x, y: v.y, z: v.z };
    } catch {
      return null;
    }
  }

  driveRope({ ropeName, angle = 0, angularVelocity = 0, grabDistance = 0 } = {}) {
    const chain = this.ropeChains.get(ropeName);

    if (!chain) {
      return;
    }

    const activeLength = Math.max(1, grabDistance);
    const driveScale = THREE.MathUtils.clamp(activeLength / chain.length, 0.18, 1);
    const impulses = [];

    for (let index = 0; index < chain.segments.length; index += 1) {
      const body = chain.segments[index];
      const t = (index + 1) / chain.segments.length;
      const targetOffset = Math.sin(angle) * chain.length * t * driveScale;
      const translation = body.translation();
      const desiredX = chain.anchor.x + chain.swingTangent.x * targetOffset;
      const desiredZ = chain.anchor.z + chain.swingTangent.z * targetOffset;
      const pullX = THREE.MathUtils.clamp(
        (desiredX - translation.x) * ROPE_DRIVER_STRENGTH + chain.swingTangent.x * angularVelocity * t * ROPE_DRIVER_VELOCITY_STRENGTH,
        -ROPE_DRIVER_MAX_IMPULSE,
        ROPE_DRIVER_MAX_IMPULSE,
      );
      const pullZ = THREE.MathUtils.clamp(
        (desiredZ - translation.z) * ROPE_DRIVER_STRENGTH + chain.swingTangent.z * angularVelocity * t * ROPE_DRIVER_VELOCITY_STRENGTH,
        -ROPE_DRIVER_MAX_IMPULSE,
        ROPE_DRIVER_MAX_IMPULSE,
      );

      impulses.push({ body, impulse: { x: pullX, y: 0, z: pullZ } });
    }

    for (const { body, impulse } of impulses) {
      body.applyImpulse(impulse, true);
    }
  }

  syncEnemyColliders(enemies = []) {
    if (!this.world || this.enemyBodies.length === 0) {
      return;
    }

    for (const enemy of enemies) {
      const body = enemy.physicsBody;
      if (!body) {
        continue;
      }

      const radius = enemy.collisionRadius ?? 0.5;
      const height = enemy.collisionHeight ?? 1.8;
      const translation = {
        x: enemy.model.position.x,
        y: enemy.model.position.y + Math.max(radius, height * 0.5),
        z: enemy.model.position.z,
      };

      // For kinematicPositionBased bodies, setNextKinematicTranslation is the
      // correct/only way to drive position before the step.
      // Use a fresh body reference via handle to avoid aliasing issues with
      // previously used body wrappers (common when many dynamic chunks are active
      // and contacting kinematics during throws).
      const ok = this.safeSetNextKinematicTranslation(body, translation);
      if (!ok) {
        // Transient aliasing when many dynamic chunks (e.g. from telekinesis throws)
        // are contacting this enemy body. Skip sync this frame; will recover next frame.
      }
    }
  }

  removeEnemyCollider(enemy) {
    const body = enemy?.physicsBody;

    if (!this.world || !body) {
      return false;
    }

    this.world.removeRigidBody(body);
    const index = this.enemyBodies.indexOf(body);

    if (index !== -1) {
      this.enemyBodies.splice(index, 1);
    }

    enemy.physicsBody = null;
    enemy.physicsCollider = null;
    return true;
  }

  getRopePoints(ropeName, alpha = null) {
    const chain = this.ropeChains.get(ropeName);

    if (!chain) {
      return null;
    }

    return [
      { ...chain.anchor },
      ...chain.segments.map((body) => {
        if (alpha != null) {
          const sampled = this.sampleInterpolatedPose(body, alpha);
          if (sampled) return { ...sampled.position };
        }
        const translation = body.translation();

        return {
          x: translation.x,
          y: translation.y,
          z: translation.z,
        };
      }),
    ];
  }

  snapshot() {
    return {
      status: this.status,
      tick: this.tickCount,
      simTime: Number(this.simTime.toFixed(6)),
      fixedStep: this.fixedStepPlanning,
      stepDt: this.stepDt,
      plannedSteps: this.plannedSteps,
      stepsLastFrame: this.stepsLastFrame,
      interpolationAlpha: Number(this.interpolationAlpha.toFixed(4)),
      interpolatedBodies: this.poseRegistry.size,
      staticBodies: this.staticBodies.length,
      enemyBodies: this.enemyBodies.length,
      streamingCollidersPending: this.pendingColliders.length,
      ropeChains: this.ropeChains.size,
      ropeBodies: [...this.ropeChains.values()].reduce((sum, chain) => sum + chain.segments.length, 0),
      ropes: [...this.ropeChains.values()].map((chain) => {
        const points = this.getRopePoints(chain.name) ?? [];
        const invalidPoints = points.filter((point) => !isFinitePoint(point)).length;
        const tip = points.at(-1) ?? null;

        return {
          name: chain.name,
          points: points.length,
          invalidPoints,
          tip: tip
            ? {
                x: Number(tip.x.toFixed(3)),
                y: Number(tip.y.toFixed(3)),
                z: Number(tip.z.toFixed(3)),
              }
            : null,
        };
      }),
      characterController: Boolean(this.characterController),
    };
  }

  dispose() {
    this.characterController?.free?.();
    this.world?.free?.();
    this.RAPIER = null;
    this.world = null;
    this.characterController = null;
    this.characterBody = null;
    this.characterCollider = null;
    this.characterColliderHalfHeight = null;
    this.characterBodyPosition = null;
    this.staticBodies = [];
    this.staticBodyOwners.clear();
    this.staticBodiesByOwner.clear();
    this.enemyBodies = [];
    this.ropeChains.clear();
    this.pendingColliders = [];
    this.steppedThisFrame = false;
    this.fixedStepPlanning = false;
    this.stepAccumulator = 0;
    this.plannedSteps = 0;
    this.stepDt = PHYSICS_FIXED_STEP;
    this.tickCount = 0;
    this.simTime = 0;
    this.stepsLastFrame = 0;
    this.poseRegistry.clear();
    this.status = 'idle';
  }

  createStaticLevelColliders(level) {
    // The big safety floor was for the original salt plane.
    // When we have proper terrain, we skip it (heightfields will provide the ground surface).
    const hasTerrain = !!(level && level.terrainChunks && level.terrainChunks.length > 0);
    const fallbackFloorY = hasTerrain ? -24 : -0.05;
    const floorBody = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
    const floorCollider = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(GAME_CONFIG.world.planeSize * 0.5, 0.05, GAME_CONFIG.world.planeSize * 0.5)
        .setTranslation(0, fallbackFloorY, 0),
      floorBody,
    );
    tagColliderSurface(floorCollider, 'soil');
    this.registerStaticBody(floorBody, null);

    for (const collider of level.colliders ?? []) {
      this.createStaticCollider(collider, collider.physicsOwnerKey ?? collider.chunkKey ?? null);
    }

    // Proper per-vertex collision for the map builder's edited terrain.
    // Creates Rapier heightfield colliders that exactly match the sculpted chunk surfaces.
    if (hasTerrain && level.terrainChunks) {
      for (const tc of level.terrainChunks) {
        this.createTerrainHeightfield(tc, tc.chunkKey ?? null);
      }
    }
  }

  applyStreamingChanges(changes) {
    if (!this.world || !changes) {
      return 0;
    }

    for (const chunkKey of changes.removedChunkKeys ?? []) {
      this.removeStaticBodiesForOwner(chunkKey);
      // A budgeted item may still be waiting when its chunk leaves the window.
      // Dropping it here prevents a stale fixed body from appearing after unload.
      this.pendingColliders = this.pendingColliders.filter((item) => item.ownerKey !== chunkKey);
    }

    for (const collider of changes.addedColliders ?? []) {
      this.pendingColliders.push({
        collider,
        ownerKey: collider.physicsOwnerKey ?? collider.chunkKey ?? null,
      });
    }

    // Terrain construction also goes through the shared streaming budget. A
    // heightfield is individually cheap, but a newly exposed row arriving next
    // to city collider work was enough to make the total frame cost lumpy.
    for (const tc of changes.addedTerrainChunks ?? []) {
      const ownerKey = tc.physicsOwnerKey ?? tc.chunkKey ?? null;
      if (ownerKey != null && this.hasStaticOwner?.(ownerKey)) continue;
      this.pendingColliders.push({ terrainChunk: tc, ownerKey });
    }

    // Opportunistic cheapest-first ordering: heightfields and small boxes drain
    // before large trimeshes, all against one timer for this frame.
    if (this.pendingColliders.length > 1) {
      this.pendingColliders.sort((a, b) => {
        const ca = a.terrainChunk ? 0 : estimateColliderCost(a.collider);
        const cb = b.terrainChunk ? 0 : estimateColliderCost(b.collider);
        return ca - cb;
      });
    }

    const built = this.drainPendingColliders();

    return built;
  }

  drainPendingColliders() {
    if (this.pendingColliders.length === 0) {
      return 0;
    }

    const start = performance.now();
    let built = 0;

    // Always allow the first (progress guarantee + skeleton->trimesh swap must happen).
    // For subsequent items, honor the budget. A single very large trimesh may still
    // overrun (10ms+ with FIX_INTERNAL_EDGES), but sorting + prefetch makes it rare.
    while (this.pendingColliders.length > 0) {
      if (built > 0 && performance.now() - start >= STREAMING_COLLIDER_BUDGET_MS) {
        break;
      }
      const { collider, terrainChunk, ownerKey } = this.pendingColliders.shift();
      if (terrainChunk) {
        // An urgent vehicle ensure may have supplied this owner after it entered
        // the queue. Do not create a duplicate fixed body.
        if (ownerKey == null || !this.hasStaticOwner?.(ownerKey)) {
          this.createTerrainHeightfield(terrainChunk, ownerKey);
        }
      }
      else this.createStaticCollider(collider, ownerKey);
      built += 1;
    }

    return built;
  }

  createStaticCollider(collider, ownerKey = null) {
    if (collider.physicsShape === 'trimesh' && collider.physicsMesh) {
      if (this.createTrimeshCollider(collider, ownerKey)) {
        return true;
      }
    }

    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());

    // Oriented box (e.g. bridge deck pitched to the road slope): build directly from
    // the supplied center/half-extents/rotation so dynamic bodies (vehicles) roll
    // over a smooth ramp instead of catching on the risers of axis-aligned steps.
    // The AABB fields (min/max/topY) are still carried for analytic ground snapping.
    if (collider.orientation && collider.halfExtents && collider.center) {
      const he = collider.halfExtents;
      const c = collider.center;
      const desc = this.RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z)
        .setTranslation(c.x, c.y, c.z)
        .setRotation(collider.orientation);
      const rapierCollider = this.world.createCollider(desc, body);
      tagColliderSurface(rapierCollider, collider.surfaceClass ?? inferColliderSurface(collider));
      this.registerStaticBody(body, ownerKey);
      return true;
    }

    const halfX = (collider.maxX - collider.minX) * 0.5;
    const halfY = (collider.topY - collider.bottomY) * 0.5;
    const halfZ = (collider.maxZ - collider.minZ) * 0.5;
    const centerX = collider.minX + halfX;
    const centerY = collider.bottomY + halfY;
    const centerZ = collider.minZ + halfZ;
    const desc = this.RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setTranslation(centerX, centerY, centerZ);

    const rapierCollider = this.world.createCollider(desc, body);
    tagColliderSurface(rapierCollider, collider.surfaceClass ?? inferColliderSurface(collider));
    if (collider.interactive) collider.rapierCollider = rapierCollider;
    this.registerStaticBody(body, ownerKey);
    return true;
  }

  // Whether a static body group (e.g. a streamed terrain heightfield) is already
  // registered under this owner key. Used to avoid building duplicate heightfields
  // when forcing a chunk's collider into existence ahead of streaming.
  hasStaticOwner(ownerKey) {
    return this.staticBodiesByOwner.has(ownerKey);
  }

  /**
   * Move every fixed body under an owner key (highway sliding ribbon).
   * Only components present on `translation` are written; others keep current values.
   * @param {string} ownerKey
   * @param {{ x?: number, y?: number, z?: number }} translation
   */
  setStaticOwnerTranslation(ownerKey, translation = {}) {
    if (!this.world || ownerKey == null) return false;
    const bodies = this.staticBodiesByOwner.get(ownerKey);
    if (!bodies || bodies.size === 0) return false;
    for (const body of bodies) {
      const t = body.translation();
      body.setTranslation({
        x: Number.isFinite(translation.x) ? translation.x : t.x,
        y: Number.isFinite(translation.y) ? translation.y : t.y,
        z: Number.isFinite(translation.z) ? translation.z : t.z,
      }, true);
    }
    return true;
  }

  registerStaticBody(body, ownerKey) {
    this.staticBodies.push(body);

    if (ownerKey != null) {
      this.staticBodyOwners.set(body, ownerKey);
      if (!this.staticBodiesByOwner.has(ownerKey)) {
        this.staticBodiesByOwner.set(ownerKey, new Set());
      }
      this.staticBodiesByOwner.get(ownerKey).add(body);
    }
  }

  removeStaticBodiesForOwner(ownerKey) {
    // Drop any collider builds still queued for this chunk so we never construct (and leak)
    // colliders for a chunk the player has already moved away from. This must run before the
    // early-return below: a chunk can unload before any of its colliders were actually built.
    if (this.pendingColliders.length > 0) {
      this.pendingColliders = this.pendingColliders.filter((entry) => entry.ownerKey !== ownerKey);
    }

    const bodies = this.staticBodiesByOwner.get(ownerKey);

    if (!bodies) {
      return;
    }

    for (const body of bodies) {
      const index = this.staticBodies.indexOf(body);

      this.world.removeRigidBody(body);
      this.staticBodyOwners.delete(body);

      if (index !== -1) {
        this.staticBodies.splice(index, 1);
      }
    }

    this.staticBodiesByOwner.delete(ownerKey);
  }

  createTrimeshCollider(collider, ownerKey = null) {
    const vertices = collider.physicsMesh?.vertices;
    const indices = collider.physicsMesh?.indices;

    if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array) || vertices.length < 9 || indices.length < 3) {
      return false;
    }

    try {
      let flags = 0;
      if (this.RAPIER.TriMeshFlags?.FIX_INTERNAL_EDGES != null) {
        flags = this.RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES;
      }

      const desc = this.RAPIER.ColliderDesc.trimesh(vertices, indices, flags);

      desc.setFriction(0.85);
      desc.setRestitution(0);
      desc.setContactSkin(0.012);

      const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
      const rapierCollider = this.world.createCollider(desc, body);
      tagColliderSurface(rapierCollider, collider.surfaceClass ?? inferColliderSurface(collider));
      this.registerStaticBody(body, ownerKey);
      return true;
    } catch (err) {
      console.warn('Failed to create Rapier trimesh collider, falling back to cuboid.', collider.name, err);
      return false;
    }
  }

  /**
   * Creates an accurate Rapier heightfield collider for one terrain chunk.
   * The heights match the visual mesh exactly (authored edits from the map builder).
   */
  createTerrainHeightfield(chunkData, ownerKey = null) {
    if (!this.RAPIER || !this.world) return;

    const { cx, cz, size, resolution, heights: origHeights } = chunkData;
    if (!origHeights || origHeights.length !== resolution * resolution) {
      // Silently returning here leaves the chunk with ZERO collision and anything
      // on it falls forever with no warning — a latent footgun. Warn loudly so a
      // bad terrain source is caught instead of silently dropping the floor.
      console.warn(
        `createTerrainHeightfield: bad heights for chunk ${cx}:${cz} ` +
        `(len ${origHeights?.length ?? 'none'} != ${resolution * resolution}); chunk has NO collider.`,
      );
      return;
    }

    // A heightfield has exactly one surface height at every X/Z coordinate and
    // therefore cannot represent a tunnel opening. Chunks intersecting a tunnel
    // use the same terrain grid as a trimesh, with the bore cells omitted.
    if (hasTerrainHoles(chunkData)) {
      const { vertices, indices } = buildTerrainTrimeshData(chunkData);
      if (indices.length === 0) return;
      try {
        let flags = 0;
        if (this.RAPIER.TriMeshFlags?.FIX_INTERNAL_EDGES != null) {
          flags = this.RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES;
        }
        const desc = this.RAPIER.ColliderDesc.trimesh(vertices, indices, flags);
        desc.setFriction(0.85);
        desc.setRestitution(0.0);
        desc.setContactSkin(0.012);
        const body = this.world.createRigidBody(
          this.RAPIER.RigidBodyDesc.fixed().setTranslation(cx * size, 0, cz * size),
        );
        this.world.createCollider(desc, body);
        this.registerStaticBody(body, ownerKey);
      } catch (err) {
        // A solid fallback would silently seal the tunnel again, so fail visibly
        // instead of replacing this deliberately open topology with a slab.
        console.warn('Failed to create tunnel-cut terrain trimesh; chunk has no terrain collider.', err);
      }
      return;
    }

    // Rapier expects the heights matrix in column-major order.
    // Our data is row-major: heights[j * res + i] where i=x, j=z.
    const rapierHeights = new Float32Array(resolution * resolution);
    for (let i = 0; i < resolution; i++) { // i = column (x)
      for (let j = 0; j < resolution; j++) { // j = row (z)
        rapierHeights[i * resolution + j] = origHeights[j * resolution + i];
      }
    }

    const centerX = cx * size;
    const centerZ = cz * size;

    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, 0, centerZ)
    );

    const scale = new this.RAPIER.Vector3(size, 1.0, size);

    let flags = 0;
    if (this.RAPIER.HeightFieldFlags && this.RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES != null) {
      flags = this.RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES;
    }

    try {
      const desc = this.RAPIER.ColliderDesc.heightfield(
        resolution - 1,
        resolution - 1,
        rapierHeights,
        scale,
        flags
      );

      // Reasonable terrain friction + small contact skin prevents deep penetration / sticking
      desc.setFriction(0.85);
      desc.setRestitution(0.0);
      desc.setContactSkin(0.012);

      const rapierCollider = this.world.createCollider(desc, body);
      tagColliderSurface(rapierCollider, 'soil');
      this.registerStaticBody(body, ownerKey);
    } catch (err) {
      // If heightfield creation fails for any reason (e.g. bad data from old save,
      // WASM internal validation, etc.), fall back to a simple cuboid using the
      // min/max height so we at least don't completely lose collision for the chunk.
      console.warn('Failed to create Rapier heightfield collider for terrain chunk, falling back to slab.', err);

      // Compute rough min/max for the fallback slab
      let minH = Infinity, maxH = -Infinity;
      for (let k = 0; k < origHeights.length; k++) {
        const h = origHeights[k];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      if (!isFinite(minH)) { minH = 0; maxH = 0; }

      const halfX = size * 0.5;
      const halfY = (maxH - minH) * 0.5 || 0.1;
      const halfZ = size * 0.5;
      const cY = minH + halfY;

      const fbBody = this.world.createRigidBody(
        this.RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, cY, centerZ)
      );
      const fbDesc = this.RAPIER.ColliderDesc.cuboid(halfX, Math.max(0.05, halfY), halfZ);
      fbDesc.setFriction(0.85);
      fbDesc.setContactSkin(0.012);
      const rapierCollider = this.world.createCollider(fbDesc, fbBody);
      tagColliderSurface(rapierCollider, 'soil');
      this.registerStaticBody(fbBody, ownerKey);
    }
  }

  createRopeChains(level) {
    for (const rope of level.ropes ?? []) {
      const anchor = {
        x: rope.anchor.x,
        y: rope.anchor.y,
        z: rope.anchor.z,
      };
      const swingTangent = normalizeHorizontal(rope.swingTangent ?? { x: 1, y: 0, z: 0 });
      const segmentLength = rope.length / ROPE_SEGMENTS;
      const anchorBody = this.world.createRigidBody(
        this.RAPIER.RigidBodyDesc.fixed().setTranslation(anchor.x, anchor.y, anchor.z),
      );
      const segments = [];
      let previousBody = anchorBody;

      for (let index = 0; index < ROPE_SEGMENTS; index += 1) {
        const y = anchor.y - segmentLength * (index + 1);
        const body = this.world.createRigidBody(
          this.RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(anchor.x, y, anchor.z)
            .setLinearDamping(1.35)
            .setAngularDamping(1.4),
        );
        this.world.createCollider(
          this.RAPIER.ColliderDesc.ball(ROPE_BODY_RADIUS)
            .setDensity(ROPE_BODY_DENSITY),
          body,
        );
        const previousAnchor = index === 0
          ? { x: 0, y: 0, z: 0 }
          : { x: 0, y: -segmentLength * 0.5, z: 0 };
        const currentAnchor = { x: 0, y: segmentLength * 0.5, z: 0 };

        this.world.createImpulseJoint(
          this.RAPIER.JointData.spherical(previousAnchor, currentAnchor),
          previousBody,
          body,
          true,
        );
        segments.push(body);
        previousBody = body;
      }

      this.ropeChains.set(rope.name, {
        name: rope.name,
        anchor,
        length: rope.length,
        segmentLength,
        swingTangent,
        anchorBody,
        segments,
      });
    }
  }

  createCharacterController(character) {
    const config = GAME_CONFIG.character;
    const radius = config.footRadius;
    const collisionHeight = character.collisionHeight ?? config.collisionHeight;
    const capsuleHalfHeight = Math.max(0.05, (collisionHeight - radius * 2) * 0.5);
    const colliderOffsetRaw = Number(config.playerColliderOffset);
    const colliderOffset = Number.isFinite(colliderOffsetRaw) ? colliderOffsetRaw : 0;
    const initialBodyPosition = {
      x: character.group.position.x,
      y: character.group.position.y + radius + capsuleHalfHeight + colliderOffset,
      z: character.group.position.z,
    };
    const bodyDesc = this.RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(
        initialBodyPosition.x,
        initialBodyPosition.y,
        initialBodyPosition.z,
      );

    this.characterBody = this.world.createRigidBody(bodyDesc);
    this.characterBodyPosition = initialBodyPosition;
    this.characterCollider = this.world.createCollider(
      this.RAPIER.ColliderDesc.capsule(capsuleHalfHeight, radius),
      this.characterBody,
    );
    this.characterColliderHalfHeight = capsuleHalfHeight;
    this.characterController = this.world.createCharacterController(0.08);
    // Slightly more forgiving autostep for irregular heightfield terrain (sculpted maps)
    // while keeping original values for the blocky arena.
    const autoStepHeight = config.groundSnapHeight * 1.8;
    this.characterController.enableAutostep(autoStepHeight, radius * 2.0, false);
    this.characterController.enableSnapToGround(config.groundSnapDownHeight);

    // Slope limits help prevent getting stuck on steep sculpted terrain features
    this.characterController.setMaxSlopeClimbAngle(Math.PI / 2.8); // ~64 degrees
    this.characterController.setMinSlopeSlideAngle(Math.PI / 3.5);  // ~51 degrees

    if (this.characterCollider) {
      this.characterCollider.setContactSkin(0.015);
    }
    this.characterController.setApplyImpulsesToDynamicBodies(false);
  }

  // Register one enemy's kinematic capsule collider. Idempotent: a no-op (returns
  // true) if the enemy already has a body, so it is safe to call for enemies
  // created post-initialization (horde spawns) as well as from createEnemyColliders.
  // syncEnemyColliders' `enemyBodies.length === 0` early-out is safe because this
  // populates enemyBodies before the next sync call.
  addEnemyCollider(enemy) {
    if (!this.RAPIER || !this.world || !enemy) {
      return false;
    }
    if (enemy.physicsBody) {
      return true;
    }

    const radius = enemy.collisionRadius ?? 0.5;
    const height = enemy.collisionHeight ?? 1.8;
    const halfHeight = Math.max(0.05, (height - radius * 2) * 0.5);
    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(
          enemy.model.position.x,
          enemy.model.position.y + radius + halfHeight,
          enemy.model.position.z,
        ),
    );
    const collider = this.world.createCollider(
      this.RAPIER.ColliderDesc.capsule(halfHeight, radius)
        .setFriction(0.85)
        .setRestitution(0),
      body,
    );

    collider.setContactSkin?.(0.015);
    enemy.physicsBody = body;
    enemy.physicsCollider = collider;
    this.enemyBodies.push(body);
    return true;
  }

  createEnemyColliders(enemies = []) {
    if (!this.RAPIER || !this.world) {
      return;
    }

    for (const enemy of enemies) {
      this.addEnemyCollider(enemy);
    }
  }

  configureCharacterController(options = null) {
    if (!this.characterController) {
      return;
    }

    const config = GAME_CONFIG.character;
    const radius = config.footRadius;

    if (options?.allowAutostep === false) {
      this.characterController.disableAutostep();
    } else {
      this.characterController.enableAutostep(config.groundSnapHeight, radius * 1.5, false);
    }

    if (options?.allowGroundSnap === false) {
      this.characterController.disableSnapToGround();
    } else {
      this.characterController.enableSnapToGround(config.groundSnapDownHeight);
    }
  }

  syncCharacterBody(character) {
    const config = GAME_CONFIG.character;
    const collisionHeight = character.collisionHeight ?? config.collisionHeight;
    const capsuleHalfHeight = Math.max(0.05, (collisionHeight - config.footRadius * 2) * 0.5);
    const colliderOffsetRaw = Number(config.playerColliderOffset);
    const colliderOffset = Number.isFinite(colliderOffsetRaw) ? colliderOffsetRaw : 0;
    const centerY = character.group.position.y + config.footRadius + capsuleHalfHeight + colliderOffset;

    // Avoid resizing or reading Rapier handles during the movement frame.
    // Some Rapier WASM builds throw aliasing errors when a borrowed handle is
    // read and then mutated in the same JS turn.
    const current = this.characterBodyPosition;
    if (
      !current
      || Math.abs(current.x - character.group.position.x) > 0.0001
      || Math.abs(current.y - centerY) > 0.0001
      || Math.abs(current.z - character.group.position.z) > 0.0001
    ) {
      const nextPosition = {
        x: character.group.position.x,
        y: centerY,
        z: character.group.position.z,
      };
      try {
        const fresh = this.world ? this.world.bodies.get(this.characterBody?.handle) : null;
        if (fresh) {
          fresh.setTranslation(nextPosition, true);
        }
      } catch (e) {
        if (!String(e.message || e).includes('aliasing')) throw e;
      }
      this.characterBodyPosition = nextPosition;
    }
  }
}

function normalizeHorizontal(source) {
  const length = Math.hypot(source.x, source.z);

  if (length <= 0.0001) {
    return { x: 1, y: 0, z: 0 };
  }

  return {
    x: source.x / length,
    y: 0,
    z: source.z / length,
  };
}

function isFinitePoint(point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

// Rough cost for drain sorting: vertex count for trimesh (the heavy ones), 1 for boxes.
function estimateColliderCost(collider) {
  if (collider?.physicsShape === 'trimesh' && collider.physicsMesh) {
    const v = collider.physicsMesh.vertices;
    if (v && v.length) return v.length / 3;
  }
  return 1;
}

function tagColliderSurface(collider, surfaceClass) {
  if (!collider) return;
  collider.userData = { ...(collider.userData ?? {}), surfaceClass: surfaceClass || 'generic' };
}

function inferColliderSurface(collider) {
  const name = String(collider?.name ?? '').toLowerCase();
  if (name.includes('glass')) return 'glass';
  if (name.includes('wood')) return 'wood';
  if (name.includes('soil') || name.includes('dirt') || name.includes('terrain')) return 'soil';
  if (name.includes('metal') || name.includes('rail') || name.includes('vehicle')) return 'metal';
  return 'concrete';
}
