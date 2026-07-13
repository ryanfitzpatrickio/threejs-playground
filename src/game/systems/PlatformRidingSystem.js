/**
 * PlatformRidingSystem (M1) — moving-platform support for on-foot actors.
 *
 * Fixed-step carry: capture platform transforms before each Rapier tick, accumulate
 * rigid deltas after the tick, apply to supported characters before movement.
 * On jump/detach, inherit contact-point velocity (linvel + angvel × offset).
 *
 * M1 is player-only. Enemy integration lands later; the registry is shared so
 * both paths do not drift.
 *
 * Does not own vehicle spawning or traffic layout.
 */

import * as THREE from 'three';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _prevQuatInv = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _world = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _pointVel = new THREE.Vector3();
const _euler = new THREE.Euler();
const _carryDelta = new THREE.Vector3();

/** Default vertical tolerance when snapping feet to a platform surface (m). */
export const PLATFORM_VERTICAL_TOLERANCE = 0.55;

/** Block re-snap for this long after a platform jump (s). */
export const PLATFORM_RESNAP_BLOCK = 0.18;

/**
 * @typedef {object} PlatformDescriptor
 * @property {object|null} owner
 * @property {{ x: number, y: number, z: number }} localCenter  body-local surface centre
 * @property {{ x: number, y: number, z: number }} halfExtents  body-local half size of footprint
 * @property {number} surfaceY  body-local surface height (usually halfExtents.y)
 * @property {string} [kind]
 * @property {boolean} [hijackable]
 */

/**
 * @typedef {object} PlatformHit
 * @property {number} bodyHandle
 * @property {object|null} owner
 * @property {THREE.Vector3} worldSurfacePoint
 * @property {THREE.Vector3} pointVelocity
 * @property {{ position: THREE.Vector3, rotation: THREE.Quaternion }} transform
 * @property {string} [kind]
 * @property {boolean} [hijackable]
 */

export class PlatformRidingSystem {
  constructor() {
    this.physics = null;
    this.scene = null;
    /**
     * @type {Map<number, object>}
     * Per-platform preallocated transform/carry/cache state (O4).
     */
    this.platforms = new Map();
    /** Scripted kinematic test platforms updated each tick. */
    this.scripted = [];
    this.status = 'idle';
    this._scratchHit = createHitScratch();
    /** Monotonic generation for carry windows (increments once per physics tick that produced delta). */
    this._carryGeneration = 0;
    /** Generation at the start of the current render-frame carry window. */
    this._windowStartGeneration = 0;
    /** Whether a capture has opened a carry window this render frame. */
    this._windowOpen = false;
    /**
     * Set when any actor consumes carry. Next capture auto-opens a fresh window
     * even if endCarryWindow was not called (test harnesses / zero-step frames).
     */
    this._carryConsumedSinceOpen = false;
    this._queryCount = 0;
  }

  /**
   * @param {{ physics: object, scene?: object|null }} opts
   */
  initialize({ physics, scene = null } = {}) {
    this.physics = physics ?? null;
    this.scene = scene ?? null;
    this.status = 'ready';
    return this;
  }

  /**
   * Register a Rapier body handle as a rideable platform surface.
   * Stores the handle only — always re-fetch bodies via PhysicsSystem.getFreshBody.
   *
   * @param {number} bodyHandle
   * @param {PlatformDescriptor} desc
   */
  register(bodyHandle, desc = {}) {
    if (!Number.isFinite(bodyHandle)) return false;
    const localCenter = desc.localCenter ?? { x: 0, y: 0, z: 0 };
    const halfExtents = desc.halfExtents ?? { x: 1, y: 0.2, z: 1 };
    this.platforms.set(bodyHandle, {
      owner: desc.owner ?? null,
      localCenter: { x: localCenter.x, y: localCenter.y, z: localCenter.z },
      halfExtents: {
        x: Math.max(0.05, halfExtents.x),
        y: Math.max(0.02, halfExtents.y),
        z: Math.max(0.05, halfExtents.z),
      },
      surfaceY: Number.isFinite(desc.surfaceY) ? desc.surfaceY : (halfExtents.y ?? 0.2),
      kind: desc.kind ?? 'platform',
      hijackable: desc.hijackable === true,
      // Preallocated transform / carry (O4 — no per-tick clone allocations).
      prev: {
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        valid: false,
      },
      /** Start of the current render-frame carry window (fixed across multi-step). */
      windowStart: {
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        valid: false,
      },
      pendingCarry: {
        active: false,
        generation: 0,
        position: new THREE.Vector3(),
        yaw: 0,
        prevPosition: new THREE.Vector3(),
        prevRotation: new THREE.Quaternion(),
        currPosition: new THREE.Vector3(),
        currRotation: new THREE.Quaternion(),
      },
      /** Cached body state refreshed in fixed-step hooks. */
      cache: {
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        invRotation: new THREE.Quaternion(),
        linvel: new THREE.Vector3(),
        angvel: new THREE.Vector3(),
        valid: false,
      },
    });
    return true;
  }

  /**
   * @param {number} bodyHandle
   */
  unregister(bodyHandle) {
    this.platforms.delete(bodyHandle);
  }

  /**
   * Fixed-step: capture every registered platform transform before world.step.
   * Opens a render-frame carry window on the first step; multi-step frames keep
   * the original start transform (O4).
   * @param {number} [dt]
   */
  captureBeforeTick(dt = 1 / 60) {
    if (!this.physics?.world) return;
    this._advanceScripted(dt);

    // Fresh window when: not open yet, OR actors already consumed the last window
    // (auto-heal harnesses that skip endCarryWindow). Multi-step frames keep the
    // same window because consume happens after all steps.
    if (!this._windowOpen || this._carryConsumedSinceOpen) {
      this._windowOpen = true;
      this._carryConsumedSinceOpen = false;
      this._windowStartGeneration = this._carryGeneration;
      for (const entry of this.platforms.values()) {
        entry.pendingCarry.active = false;
        entry.pendingCarry.yaw = 0;
        entry.pendingCarry.position.set(0, 0, 0);
        entry.windowStart.valid = false;
      }
    }

    for (const [handle, entry] of this.platforms) {
      const body = this.physics.getFreshBody(handle);
      if (!body) continue;
      try {
        const t = body.translation();
        const r = body.rotation();
        entry.prev.position.set(t.x, t.y, t.z);
        entry.prev.rotation.set(r.x, r.y, r.z, r.w);
        entry.prev.valid = true;
        if (!entry.windowStart.valid) {
          entry.windowStart.position.set(t.x, t.y, t.z);
          entry.windowStart.rotation.set(r.x, r.y, r.z, r.w);
          entry.windowStart.valid = true;
        }
        this._refreshCache(entry, body, t, r);
      } catch {
        // Transient aliasing — keep previous sample.
      }
    }
  }

  /**
   * Fixed-step: after world.step, accumulate rigid transform delta into pending carry.
   * Start of the window stays fixed; end advances every step (O4 multi-step).
   */
  accumulateAfterTick() {
    if (!this.physics?.world) return;
    this._carryGeneration += 1;
    for (const [handle, entry] of this.platforms) {
      if (!entry.prev?.valid) continue;
      const body = this.physics.getFreshBody(handle);
      if (!body) continue;
      try {
        const t = body.translation();
        const r = body.rotation();
        _quat.set(r.x, r.y, r.z, r.w);
        _euler.setFromQuaternion(_quat, 'YXZ');
        const yawNow = _euler.y;
        _euler.setFromQuaternion(entry.prev.rotation, 'YXZ');
        const yawPrev = _euler.y;
        let dYaw = yawNow - yawPrev;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));

        const carry = entry.pendingCarry;
        const start = entry.windowStart.valid ? entry.windowStart : entry.prev;
        if (!carry.active) {
          carry.active = true;
          carry.generation = this._carryGeneration;
          carry.prevPosition.copy(start.position);
          carry.prevRotation.copy(start.rotation);
          carry.currPosition.set(t.x, t.y, t.z);
          carry.currRotation.copy(_quat);
          carry.position.set(
            t.x - start.position.x,
            t.y - start.position.y,
            t.z - start.position.z,
          );
          carry.yaw = dYaw;
        } else {
          // Full start→end rigid map for multi-step frames.
          carry.currPosition.set(t.x, t.y, t.z);
          carry.currRotation.copy(_quat);
          carry.position.set(
            t.x - carry.prevPosition.x,
            t.y - carry.prevPosition.y,
            t.z - carry.prevPosition.z,
          );
          _euler.setFromQuaternion(carry.prevRotation, 'YXZ');
          const yawStart = _euler.y;
          let totalYaw = yawNow - yawStart;
          totalYaw = Math.atan2(Math.sin(totalYaw), Math.cos(totalYaw));
          carry.yaw = totalYaw;
          carry.generation = this._carryGeneration;
        }

        entry.prev.position.set(t.x, t.y, t.z);
        entry.prev.rotation.copy(_quat);
        this._refreshCache(entry, body, t, r);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Close the render-frame carry window after all actors have consumed carry.
   * Call once per frame after player + enemy movement (optional; also auto-opens next tick).
   */
  endCarryWindow() {
    this._windowOpen = false;
    this._carryConsumedSinceOpen = false;
  }

  /**
   * Apply accumulated platform carry to a supported actor.
   * Each actor records the last generation it consumed — re-applying the same
   * generation (zero-step frame double call) is a no-op (O4).
   *
   * @param {object} actor character (group) or enemy ({ model, platformSupport })
   * @returns {boolean}
   */
  applyPendingCarry(actor) {
    if (!actor) return false;
    if (actor.vehicle?.active || actor.mount?.active) return false;
    const support = actor.platformSupport;
    if (!support || !Number.isFinite(support.bodyHandle)) return false;
    if ((actor.platformResnapBlockTimer ?? 0) > 0) return false;

    const root = actor.group ?? actor.model;
    if (!root?.position) return false;

    const entry = this.platforms.get(support.bodyHandle);
    const carry = entry?.pendingCarry;
    if (!carry?.active) return false;

    // Already consumed this carry generation (zero-step double apply).
    if ((support.consumedCarryGeneration ?? -1) >= carry.generation) {
      return false;
    }

    const feet = root.position;

    // Rigid transform: map feet through prev → curr platform frame.
    _local.copy(feet).sub(carry.prevPosition);
    _prevQuatInv.copy(carry.prevRotation).invert();
    _local.applyQuaternion(_prevQuatInv);
    _world.copy(_local).applyQuaternion(carry.currRotation).add(carry.currPosition);
    _carryDelta.copy(_world).sub(feet);

    feet.x += _carryDelta.x;
    feet.y += _carryDelta.y;
    feet.z += _carryDelta.z;
    if (Number.isFinite(carry.yaw) && Math.abs(carry.yaw) > 1e-8) {
      if (root.rotation) root.rotation.y += carry.yaw;
    }

    support.localContact = support.localContact ?? { x: 0, y: entry.surfaceY, z: 0 };
    support.consumedCarryGeneration = carry.generation;
    this._carryConsumedSinceOpen = true;
    return true;
  }

  /**
   * World velocity of the platform under an enemy/player (for ragdoll inherit).
   * @param {object} actor
   * @param {THREE.Vector3} [out]
   */
  getActorPlatformVelocity(actor, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    const support = actor?.platformSupport;
    if (!support || !Number.isFinite(support.bodyHandle)) {
      if (actor?.platformVelocity) {
        out.set(
          actor.platformVelocity.x || 0,
          actor.platformVelocity.y || 0,
          actor.platformVelocity.z || 0,
        );
      }
      return out;
    }
    const root = actor.group ?? actor.model;
    const point = root?.position ?? { x: 0, y: 0, z: 0 };
    this.getPointVelocity(support.bodyHandle, point, out);
    if (out.lengthSq() < 1e-8 && actor.platformVelocity) {
      out.set(
        actor.platformVelocity.x || 0,
        actor.platformVelocity.y || 0,
        actor.platformVelocity.z || 0,
      );
    }
    return out;
  }

  /**
   * Clear pending carry for all platforms (e.g. on dispose / mode exit).
   */
  clearAllPendingCarry() {
    for (const entry of this.platforms.values()) {
      if (entry.pendingCarry) {
        entry.pendingCarry.active = false;
        entry.pendingCarry.yaw = 0;
        entry.pendingCarry.position.set(0, 0, 0);
      }
    }
    this._windowOpen = false;
  }

  /**
   * Query the platform under (x,z) within feetY vertical tolerance.
   * Allocates only when a hit is found (caller-owned outHit optional).
   * @param {{ x: number, y?: number, z: number }} position  feet position
   * @param {number} [feetY]
   * @param {{ verticalTolerance?: number, outHit?: object }} [options]
   * @returns {PlatformHit|null}
   */
  getPlatformAt(position, feetY = position?.y, options = {}) {
    return this.findPlatformAt(position, feetY, options);
  }

  /**
   * Scan all platforms for the best surface under feet (unassigned landing).
   * @param {{ x: number, y?: number, z: number }} position
   * @param {number} [feetY]
   * @param {{ verticalTolerance?: number, outHit?: object }} [options]
   * @returns {PlatformHit|null}
   */
  findPlatformAt(position, feetY = position?.y, options = {}) {
    if (!this.physics?.world || !position) return null;
    this._queryCount += 1;
    const tol = Number.isFinite(options.verticalTolerance)
      ? options.verticalTolerance
      : PLATFORM_VERTICAL_TOLERANCE;
    const y = Number.isFinite(feetY) ? feetY : position.y;

    let bestHandle = null;
    let bestEntry = null;
    let bestAbsDy = Infinity;
    let bestLocalX = 0;
    let bestLocalZ = 0;
    let bestSurfaceY = 0;

    for (const [handle, entry] of this.platforms) {
      if (!this._samplePlatformLocal(handle, entry, position.x, y, position.z)) continue;
      const cx = entry.localCenter.x;
      const cz = entry.localCenter.z;
      if (Math.abs(_local.x - cx) > entry.halfExtents.x) continue;
      if (Math.abs(_local.z - cz) > entry.halfExtents.z) continue;

      const surfaceLocalY = entry.surfaceY;
      _local.y = surfaceLocalY;
      // _world already set by sample as surface candidate after re-apply:
      _world.copy(_local).applyQuaternion(_quat).add(_pos);
      const absDy = Math.abs(y - _world.y);
      if (absDy > tol) continue;
      if (absDy >= bestAbsDy) continue;

      bestAbsDy = absDy;
      bestHandle = handle;
      bestEntry = entry;
      bestLocalX = _local.x;
      bestLocalZ = _local.z;
      bestSurfaceY = surfaceLocalY;
      // Keep best surface point / transform in scratch via recompute at end.
    }

    if (bestHandle == null || !bestEntry) return null;
    return this._buildHit(bestHandle, bestEntry, position.x, y, position.z, bestLocalX, bestSurfaceY, bestLocalZ, options.outHit);
  }

  /**
   * Direct lookup for an assigned platform (enemies) — O(1) body/cache path.
   * @param {number} bodyHandle
   * @param {{ x: number, y?: number, z: number }} position
   * @param {number} [feetY]
   * @param {{ verticalTolerance?: number, outHit?: object }} [options]
   * @returns {PlatformHit|null}
   */
  getPlatformByHandle(bodyHandle, position, feetY = position?.y, options = {}) {
    if (!Number.isFinite(bodyHandle) || !position) return null;
    this._queryCount += 1;
    const entry = this.platforms.get(bodyHandle);
    if (!entry) return null;
    const tol = Number.isFinite(options.verticalTolerance)
      ? options.verticalTolerance
      : PLATFORM_VERTICAL_TOLERANCE;
    const y = Number.isFinite(feetY) ? feetY : position.y;
    if (!this._samplePlatformLocal(bodyHandle, entry, position.x, y, position.z)) return null;
    const cx = entry.localCenter.x;
    const cz = entry.localCenter.z;
    if (Math.abs(_local.x - cx) > entry.halfExtents.x) return null;
    if (Math.abs(_local.z - cz) > entry.halfExtents.z) return null;
    const surfaceLocalY = entry.surfaceY;
    _local.y = surfaceLocalY;
    _world.copy(_local).applyQuaternion(_quat).add(_pos);
    if (Math.abs(y - _world.y) > tol) return null;
    return this._buildHit(bodyHandle, entry, position.x, y, position.z, _local.x, surfaceLocalY, _local.z, options.outHit);
  }

  /**
   * Point velocity at a world point on a platform body.
   * @param {number} bodyHandle
   * @param {{ x: number, y: number, z: number }} worldPoint
   * @param {THREE.Vector3} [out]
   */
  getPointVelocity(bodyHandle, worldPoint, out = new THREE.Vector3()) {
    const body = this.physics?.getFreshBody?.(bodyHandle);
    if (!body) {
      out.set(0, 0, 0);
      return out;
    }
    return this._pointVelocityAt(body, worldPoint, out);
  }

  /**
   * Write support record onto the character from a platform hit.
   * @param {object} character
   * @param {PlatformHit} hit
   */
  attachSupport(character, hit) {
    if (!character || !hit) return;
    const prevGen = character.platformSupport?.consumedCarryGeneration ?? -1;
    character.platformSupport = {
      bodyHandle: hit.bodyHandle,
      localContact: hit.localContact
        ? { ...hit.localContact }
        : { x: 0, y: 0, z: 0 },
      lastPointVelocity: {
        x: hit.pointVelocity.x,
        y: hit.pointVelocity.y,
        z: hit.pointVelocity.z,
      },
      kind: hit.kind,
      owner: hit.owner ?? null,
      // Preserve consumption marker when re-attaching the same platform.
      consumedCarryGeneration:
        character.platformSupport?.bodyHandle === hit.bodyHandle ? prevGen : -1,
    };
  }

  /**
   * Clear platform support (walk-off, jump, mount, etc.).
   * @param {object} character
   */
  clearSupport(character) {
    if (character) character.platformSupport = null;
  }

  /**
   * On jump from a platform: add contact-point velocity once, clear support,
   * block immediate re-snap.
   * @param {object} character
   * @returns {boolean}
   */
  inheritDetachVelocity(character) {
    const support = character?.platformSupport;
    if (!support || !Number.isFinite(support.bodyHandle)) return false;

    const feet = character.group.position;
    const pv = this.getPointVelocity(support.bodyHandle, feet, _pointVel);
    // KinematicPositionBased bodies moved via setNextKinematicTranslation can
    // report zero linvel between steps — fall back to scripted cruise velocity.
    if (pv.lengthSq() < 1e-8) {
      const scripted = this.scripted.find((s) => s.bodyHandle === support.bodyHandle);
      if (scripted?.velocity) {
        pv.set(scripted.velocity.x, scripted.velocity.y, scripted.velocity.z);
      } else if (support.lastPointVelocity) {
        pv.set(
          support.lastPointVelocity.x,
          support.lastPointVelocity.y,
          support.lastPointVelocity.z,
        );
      }
    }
    // Horizontal + vertical inherit; jump impulse is already on verticalVelocity.
    character.velocity.x += pv.x;
    character.velocity.z += pv.z;
    character.verticalVelocity += pv.y;

    character.platformResnapBlockTimer = PLATFORM_RESNAP_BLOCK;
    character.groundSnapBlockTimer = Math.max(
      character.groundSnapBlockTimer ?? 0,
      PLATFORM_RESNAP_BLOCK * 0.5,
    );
    this.clearSupport(character);
    return true;
  }

  /**
   * Register a vehicle roof as a leap / ride surface from body size + roof seat.
   * @param {import('../vehicles/BaseVehicle.js').BaseVehicle} vehicle
   * @param {{ hijackable?: boolean }} [opts]
   */
  registerVehicleRoof(vehicle, opts = {}) {
    if (!Number.isFinite(vehicle?.bodyHandle)) return false;
    const size = vehicle.config?.body?.size ?? [2, 1.2, 4.5];
    const roofSeat = vehicle.config?.seats?.find((s) => s.name === 'roof');
    const halfX = Math.max(0.6, (size[0] ?? 2) * 0.45);
    const halfZ = Math.max(1.0, (size[2] ?? 4.5) * 0.42);
    const surfaceY = roofSeat?.offset?.[1]
      ?? ((size[1] ?? 1.2) * 0.5 + 0.15);
    return this.register(vehicle.bodyHandle, {
      owner: vehicle,
      localCenter: {
        x: roofSeat?.offset?.[0] ?? 0,
        y: 0,
        z: roofSeat?.offset?.[2] ?? 0,
      },
      halfExtents: { x: halfX, y: 0.12, z: halfZ },
      surfaceY,
      kind: 'vehicleRoof',
      hijackable: opts.hijackable === true,
    });
  }

  /**
   * @param {import('../vehicles/BaseVehicle.js').BaseVehicle} vehicle
   */
  unregisterVehicleRoof(vehicle) {
    if (!Number.isFinite(vehicle?.bodyHandle)) return;
    this.unregister(vehicle.bodyHandle);
  }

  /**
   * Spawn a kinematic scripted test platform (M1 greybox). Caller adds mesh to scene.
   *
   * @param {{
   *   position?: THREE.Vector3,
   *   size?: [number, number, number],
   *   velocity?: { x?: number, y?: number, z?: number },
   *   color?: number,
   *   name?: string,
   * }} [opts]
   */
  spawnScriptedTestPlatform(opts = {}) {
    if (!this.physics?.world || !this.physics?.RAPIER) {
      throw new Error('PlatformRidingSystem.spawnScriptedTestPlatform: physics not ready');
    }
    const RAPIER = this.physics.RAPIER;
    const size = opts.size ?? [3.4, 0.45, 7.5];
    const half = { x: size[0] * 0.5, y: size[1] * 0.5, z: size[2] * 0.5 };
    const pos = opts.position?.clone?.() ?? new THREE.Vector3(0, 1, 0);
    const vel = {
      x: opts.velocity?.x ?? 0,
      y: opts.velocity?.y ?? 0,
      z: opts.velocity?.z ?? -10,
    };

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pos.x, pos.y, pos.z),
    );
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setFriction(0.9)
        .setRestitution(0),
      body,
    );

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({
        color: opts.color ?? 0xc45a28,
        roughness: 0.72,
        metalness: 0.15,
      }),
    );
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = opts.name ?? 'Platform Riding Test';
    this.scene?.add?.(mesh);

    const handle = body.handle;
    this.register(handle, {
      owner: { kind: 'scriptedTest', mesh, bodyHandle: handle },
      localCenter: { x: 0, y: 0, z: 0 },
      halfExtents: half,
      surfaceY: half.y,
      kind: 'test',
      hijackable: false,
    });

    const scripted = {
      bodyHandle: handle,
      mesh,
      velocity: vel,
      position: pos.clone(),
      size,
    };
    this.scripted.push(scripted);
    return scripted;
  }

  /**
   * Tick timers on the character (resnap block). Call once per frame.
   * @param {object} character
   * @param {number} delta
   */
  updateCharacterTimers(character, delta) {
    if (!character) return;
    if (character.platformResnapBlockTimer > 0) {
      character.platformResnapBlockTimer = Math.max(0, character.platformResnapBlockTimer - delta);
    }
  }

  snapshot() {
    return {
      status: this.status,
      platformCount: this.platforms.size,
      scriptedCount: this.scripted.length,
      carryGeneration: this._carryGeneration,
      queries: this._queryCount,
      handles: [...this.platforms.keys()],
    };
  }

  /** Reset per-frame query counter (benchmark). */
  resetQueryCount() {
    this._queryCount = 0;
  }

  dispose() {
    for (const s of this.scripted) {
      if (s.mesh) {
        s.mesh.parent?.remove?.(s.mesh);
        s.mesh.geometry?.dispose?.();
        s.mesh.material?.dispose?.();
      }
      // Body teardown: owned by physics world dispose in normal shutdown.
      this.unregister(s.bodyHandle);
    }
    this.scripted.length = 0;
    this.platforms.clear();
    this.physics = null;
    this.scene = null;
    this.status = 'idle';
    this._windowOpen = false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  _refreshCache(entry, body, t, r) {
    const cache = entry.cache;
    cache.position.set(t.x, t.y, t.z);
    cache.rotation.set(r.x, r.y, r.z, r.w);
    cache.invRotation.copy(cache.rotation).invert();
    try {
      const lv = body.linvel?.();
      const av = body.angvel?.();
      if (lv) cache.linvel.set(lv.x, lv.y, lv.z);
      if (av) cache.angvel.set(av.x, av.y, av.z);
    } catch {
      // keep previous
    }
    cache.valid = true;
  }

  /**
   * Fill _pos/_quat/_local for feet at world (x,y,z). Returns false if body missing.
   */
  _samplePlatformLocal(handle, entry, x, y, z) {
    const cache = entry.cache;
    if (cache?.valid) {
      _pos.copy(cache.position);
      _quat.copy(cache.rotation);
      _local.set(x, y, z).sub(_pos);
      _local.applyQuaternion(cache.invRotation);
      return true;
    }
    const body = this.physics?.getFreshBody?.(handle);
    if (!body) return false;
    try {
      const t = body.translation();
      const r = body.rotation();
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      _local.set(x, y, z).sub(_pos);
      _prevQuatInv.copy(_quat).invert();
      _local.applyQuaternion(_prevQuatInv);
      return true;
    } catch {
      return false;
    }
  }

  _buildHit(handle, entry, x, y, z, localX, surfaceY, localZ, outHit = null) {
    // Re-sample so _pos/_quat/_world/_pointVel match the hit.
    this._samplePlatformLocal(handle, entry, x, y, z);
    _local.set(localX, surfaceY, localZ);
    _world.copy(_local).applyQuaternion(_quat).add(_pos);

    const body = this.physics?.getFreshBody?.(handle);
    if (body) {
      this._pointVelocityAt(body, _world, _pointVel);
    } else if (entry.cache?.valid) {
      // linvel + angvel × offset from cache
      _offset.copy(_world).sub(entry.cache.position);
      _pointVel.copy(entry.cache.linvel);
      _pointVel.x += entry.cache.angvel.y * _offset.z - entry.cache.angvel.z * _offset.y;
      _pointVel.y += entry.cache.angvel.z * _offset.x - entry.cache.angvel.x * _offset.z;
      _pointVel.z += entry.cache.angvel.x * _offset.y - entry.cache.angvel.y * _offset.x;
    } else {
      _pointVel.set(0, 0, 0);
    }

    const hit = outHit ?? createHitScratch();
    hit.bodyHandle = handle;
    hit.owner = entry.owner;
    hit.worldSurfacePoint.set(_world.x, _world.y, _world.z);
    hit.pointVelocity.set(_pointVel.x, _pointVel.y, _pointVel.z);
    hit.transform.position.set(_pos.x, _pos.y, _pos.z);
    hit.transform.rotation.set(_quat.x, _quat.y, _quat.z, _quat.w);
    hit.kind = entry.kind;
    hit.hijackable = entry.hijackable;
    hit.localContact = hit.localContact ?? { x: 0, y: 0, z: 0 };
    hit.localContact.x = localX;
    hit.localContact.y = surfaceY;
    hit.localContact.z = localZ;
    // When no outHit was provided, clone vectors so callers can keep the hit.
    if (!outHit) {
      return {
        bodyHandle: handle,
        owner: entry.owner,
        worldSurfacePoint: hit.worldSurfacePoint.clone(),
        pointVelocity: hit.pointVelocity.clone(),
        transform: {
          position: hit.transform.position.clone(),
          rotation: hit.transform.rotation.clone(),
        },
        kind: entry.kind,
        hijackable: entry.hijackable,
        localContact: { x: localX, y: surfaceY, z: localZ },
      };
    }
    return hit;
  }

  _advanceScripted(dt) {
    if (!this.physics?.world || !(dt > 0)) return;
    for (const s of this.scripted) {
      // Semi trailers are posed from the cab hitch by HighwaySemiRig.stepSemiRig;
      // only keep scripted.velocity for jump-inherit, don't free-integrate them.
      if (s._semiRig) continue;
      s.position.x += s.velocity.x * dt;
      s.position.y += s.velocity.y * dt;
      s.position.z += s.velocity.z * dt;
      this.physics.safeSetNextKinematicTranslation?.(s.bodyHandle, {
        x: s.position.x,
        y: s.position.y,
        z: s.position.z,
      });
      // Also set translation if kinematic next is not yet available (pre-step).
      const body = this.physics.getFreshBody(s.bodyHandle);
      if (body && typeof body.setNextKinematicTranslation === 'function') {
        try {
          body.setNextKinematicTranslation({
            x: s.position.x,
            y: s.position.y,
            z: s.position.z,
          });
        } catch {
          // ignore
        }
      }
      if (s.mesh) s.mesh.position.copy(s.position);
    }
  }

  _pointVelocityAt(body, worldPoint, out) {
    try {
      const lv = body.linvel();
      const av = body.angvel();
      const t = body.translation();
      _linvel.set(lv.x, lv.y, lv.z);
      _angvel.set(av.x, av.y, av.z);
      _offset.set(worldPoint.x - t.x, worldPoint.y - t.y, worldPoint.z - t.z);
      // v = linvel + angvel × offset
      out.copy(_linvel);
      out.x += _angvel.y * _offset.z - _angvel.z * _offset.y;
      out.y += _angvel.z * _offset.x - _angvel.x * _offset.z;
      out.z += _angvel.x * _offset.y - _angvel.y * _offset.x;
      return out;
    } catch {
      out.set(0, 0, 0);
      return out;
    }
  }
}

function createHitScratch() {
  return {
    bodyHandle: -1,
    owner: null,
    worldSurfacePoint: new THREE.Vector3(),
    pointVelocity: new THREE.Vector3(),
    transform: {
      position: new THREE.Vector3(),
      rotation: new THREE.Quaternion(),
    },
    kind: 'platform',
    hijackable: false,
    localContact: { x: 0, y: 0, z: 0 },
  };
}
