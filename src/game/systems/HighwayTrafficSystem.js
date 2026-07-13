/**
 * HighwayTrafficSystem (M0–M6) — deterministic tiled traffic window + cruise.
 *
 * Owns: manifest slot selection, per-archetype pool leases, window recycle/recover,
 * and highwayCruise setup on live traffic (lane hold + FLOW_SPEED + dSpeed).
 * Must not: raw scene disposal, a second vehicle registry, player input.
 *
 * VehicleSystem remains the sole registry/lifecycle owner for every BaseVehicle.
 * Live traffic free-cruises (recover + wake + highwayCruise); idle returns use
 * recover + park off-ribbon. Steady-state never spawns.
 */

import * as THREE from 'three';
import { BaseVehicle } from '../vehicles/BaseVehicle.js';
import {
  DEFAULT_HIGHWAY_SEED,
  FLOW_SPEED,
  HIGHWAY_Y,
  ROAD_HALF_WIDTH,
  RUN_LENGTH,
  TRAFFIC_ARCHETYPES,
  TRAFFIC_BODY_SIZE,
  TRAFFIC_COLORS,
  WINDOW_BACK,
  WINDOW_FRONT,
  createHighwayRng,
  cruiseSpeedForDSpeed,
  cruiseWorldVelocity,
  isInsideRoad,
  laneWorldX,
  makeSlotId,
  physicalRoadBounds,
  poolSizeForArchetype,
  resolveWindowSlots,
  runPlatforms,
  sToWorldZ,
  tileSeed,
  worldZToS,
} from '../config/highwayRunManifest.js';
import {
  VEHICLE_ACTIVITY_ACTIVE,
  VEHICLE_ACTIVITY_DORMANT,
} from './VehicleSystem.js';
import {
  HighwayCarVisuals,
  createHighwayProxyModel,
} from './HighwayCarVisuals.js';
import {
  SEMI_CAB_SIZE,
  createSemiRig,
  activateSemiRig,
  deactivateSemiRig,
  disposeSemiRig,
  syncSemiRig,
  stepSemiRig,
} from '../vehicles/HighwaySemiRig.js';

/** Lease states. idle + traffic + reserved/player ownership seams. */
export const LEASE_IDLE = 'idle';
export const LEASE_TRAFFIC = 'traffic';
export const LEASE_RESERVED = 'reserved';
export const LEASE_PLAYER = 'player';

/** Hysteresis beyond the authored window before a cruising car is recycled. */
const RECYCLE_SLACK_M = 24;

/** Skip acquire when another live car already occupies this s-band. */
const NEAR_SLOT_MATCH_M = 10;

/** O3: max rate for window maintenance during steady drive (Hz). */
const WINDOW_MAINT_HZ = 10;

/** O3: force maintenance when focus moves this far along s (m). */
const WINDOW_FOCUS_DELTA_S = 12;

/**
 * When the player outruns FLOW_SPEED, pack extra desired slots ahead so cars are
 * placed with enough lead time to enter the view frustum before being overtaken.
 * Metres of front window per (m/s) of closing speed.
 */
const FAST_FRONT_LOOKAHEAD_S = 5;

/**
 * Cap on front-window boost from high player speed (metres).
 * Kept modest so peak desired slots still fit the base pool (18 + 4 spare).
 * Larger boosts need a matching poolSizeForArchetype increase.
 */
const FAST_FRONT_BOOST_MAX_M = 120;

/**
 * Max amount traffic cruise may speed up above authored FLOW+dSpeed so a fast
 * player still has relative motion without cars vanishing instantly behind them.
 */
const FAST_CRUISE_CATCHUP_MAX = 48;

/** Keep at least this much closing speed (m/s) when boosting traffic cruise. */
const FAST_CRUISE_RELATIVE_MIN = 8;

/** Semis stay readable as moving platforms instead of matching a racing player. */
const SEMI_CRUISE_BASE_SPEED = 18;
const SEMI_CRUISE_MAX_SPEED = 20;

/**
 * Idle pool cars must sit OUTSIDE the road XZ footprint.
 * Parking at (0, -500, 0) is still "on the ribbon" for getGroundHeightAt, so
 * VehicleSystem.snapToGround lifts every idle body onto the deck at the origin
 * and they stack behind the spawn ("infinite cars at the start").
 */
const IDLE_PARK_X = ROAD_HALF_WIDTH + 80;
const IDLE_PARK_Y = -500;
const IDLE_PARK_Z_BASE = 0;
const IDLE_PARK_Z_STRIDE = 6;

/**
 * @typedef {object} TrafficLease
 * @property {string} state
 * @property {string|null} slotId
 * @property {string} archetype
 * @property {import('../vehicles/BaseVehicle.js').BaseVehicle} vehicle
 * @property {number} colorIndex
 * @property {number} poolIndex
 */

export class HighwayTrafficSystem {
  /**
   * @param {{
   *   physics: object,
   *   vehicleSystem: object,
   *   seed?: number,
   *   windowFront?: number,
   *   windowBack?: number,
   * }} opts
   */
  constructor({
    physics = null,
    vehicleSystem = null,
    platformRiding = null,
    scene = null,
    enemySystem = null,
    seed = DEFAULT_HIGHWAY_SEED,
    windowFront = WINDOW_FRONT,
    windowBack = WINDOW_BACK,
    /** Spawn highwayGangMember on semi trailer decks when assets are ready. */
    spawnSemiGuards = false,
  } = {}) {
    this.physics = physics;
    this.vehicleSystem = vehicleSystem;
    this.platformRiding = platformRiding;
    this.scene = scene;
    this.enemySystem = enemySystem;
    this.spawnSemiGuards = Boolean(spawnSemiGuards);
    this.seed = (seed >>> 0) || DEFAULT_HIGHWAY_SEED;
    this.windowFront = windowFront;
    this.windowBack = windowBack;
    /** City-style TSL instanced car fleet (replaces full BaseVehicle meshes). */
    this.carVisuals = new HighwayCarVisuals({ scene });
    /** @type {Map<string, TrafficLease[]>} archetype → pool */
    this.pools = new Map();
    /** @type {Map<string, TrafficLease>} slotId → live lease */
    this.liveBySlot = new Map();
    this.status = 'idle';
    this._lastFocusS = 0;
    this._lastTileRange = { first: 0, last: 0 };
    this._idleParkScratch = new THREE.Vector3();
    /** @type {Map<number, object[]>} tileIndex → frozen slot descriptors */
    this._tileCache = new Map();
    /** Reused protected set across maintenance ticks. */
    this._protectedSet = new Set();
    /** Reused desired map. */
    this._desiredById = new Map();
    /** Incremental counters for snapshot / benchmark. */
    this._counts = {
      idle: 0,
      live: 0,
      reserved: 0,
      poolSize: 0,
      maintenanceRuns: 0,
      slotResolves: 0,
      acquisitions: 0,
      releases: 0,
      poolMisses: 0,
      skippedMaintenance: 0,
    };
    this._lastMaintFocusS = null;
    this._lastMaintTime = -Infinity;
    this._maintInterval = 1 / WINDOW_MAINT_HZ;
    /** Estimated |ds/dt| of focus from maintenance samples (m/s along +s). */
    this._focusSpeedS = FLOW_SPEED;
    /** Effective front window last used (base + fast boost). */
    this._effectiveWindowFront = windowFront;
    /** Force next updateWindow to run (ownership events). */
    this._forceMaint = true;
  }

  /**
   * World position for an idle pool member. Always outside the road footprint.
   * @param {number} poolIndex
   */
  idleParkPosition(poolIndex = 0) {
    const i = Math.max(0, poolIndex | 0);
    return this._idleParkScratch.set(
      IDLE_PARK_X,
      IDLE_PARK_Y,
      IDLE_PARK_Z_BASE + i * IDLE_PARK_Z_STRIDE,
    );
  }

  /**
   * Pre-create the bounded pool, then fill the initial window.
   * Call only after PhysicsSystem + VehicleSystem are ready.
   *
   * @param {{
   *   focusPosition: { x?: number, y?: number, z?: number },
   *   protectedVehicles?: Iterable<object>|null,
   * }} opts
   */
  async initialize({ focusPosition, protectedVehicles = null } = {}) {
    if (!this.vehicleSystem || !this.physics?.world) {
      throw new Error('HighwayTrafficSystem.initialize: physics and vehicleSystem required');
    }
    this.status = 'loading';

    // Per-archetype pool sizes (mixed fleet must not over-create sedan×total).
    const poolByType = new Map();
    let totalCapacity = 0;
    for (const archetype of TRAFFIC_ARCHETYPES) {
      const size = poolSizeForArchetype({
        windowFront: this.windowFront,
        windowBack: this.windowBack,
        type: archetype,
      });
      poolByType.set(archetype, size);
      totalCapacity += size;
    }
    this._poolSizePerArchetype = poolByType;
    // TSL instanced fleet — capacity covers the largest archetype pool.
    const visualCap = Math.max(1, ...poolByType.values(), totalCapacity);
    this.carVisuals.initialize({
      scene: this.scene ?? this.vehicleSystem?.scene,
      capacity: visualCap,
      types: [...TRAFFIC_ARCHETYPES],
    });

    let globalPoolIndex = 0;
    for (const archetype of TRAFFIC_ARCHETYPES) {
      const size = poolByType.get(archetype) ?? 0;
      const bodySize = archetype === 'semi'
        ? SEMI_CAB_SIZE
        : (TRAFFIC_BODY_SIZE[archetype] ?? TRAFFIC_BODY_SIZE.sedan);
      const members = [];
      for (let i = 0; i < size; i += 1) {
        const colorIndex = (globalPoolIndex + i) % TRAFFIC_COLORS.length;
        const parkPos = this.idleParkPosition(globalPoolIndex + i).clone();
        // Guard: idle park must never be treated as on-road by analytic ground.
        if (isInsideRoad(parkPos, 1)) {
          throw new Error(`HighwayTrafficSystem: idle park ${globalPoolIndex + i} is inside the road footprint`);
        }
        // Physics-only chassis: empty providedModel skips BaseVehicle.buildMesh()
        // (the multi-thousand geometry bomb). Drawing is HighwayCarVisuals/TSL.
        const vehicle = await this.vehicleSystem.spawnVehicle({
          vehicle: new BaseVehicle({
            name: `Highway Traffic ${archetype} ${i}`,
            position: parkPos,
            rotationY: 0,
            model: createHighwayProxyModel(),
            chassisOverlay: false,
            config: {
              body: { size: [...bodySize] },
            },
          }),
          // Never ground-snap idle cars — on-ribbon XZ + snap stacks the pool
          // on the deck at the origin (visible pile behind spawn).
          snapToGround: false,
        });
        // Stash paint + archetype for TSL shell selection.
        vehicle.userData = {
          ...(vehicle.userData ?? {}),
          highwayColor: TRAFFIC_COLORS[colorIndex],
          highwayProxyVisual: true,
          highwayArchetype: archetype,
          highwayBodyType: archetype === 'semi' ? 'semiCab' : archetype,
        };
        // Drop audio/tyre systems that still attach on spawn for empty groups.
        // Trace: TireEffects.update + EngineAudio were top main-thread samples.
        vehicle.tireEffects?.dispose?.();
        vehicle.tireEffects = null;
        vehicle.exteriorIdleAudio?.dispose?.();
        vehicle.exteriorIdleAudio = null;
        vehicle.crashAudio?.dispose?.();
        vehicle.crashAudio = null;
        vehicle.engineAudio?.dispose?.();
        vehicle.engineAudio = null;
        if (vehicle.group) {
          vehicle.group.visible = false;
          vehicle.group.matrixAutoUpdate = false;
          vehicle.group.matrixWorldAutoUpdate = false;
        }
        // Force off-ribbon pose after spawn/settleParked — recover is authoritative.
        vehicle.recover?.({
          position: { x: parkPos.x, y: parkPos.y, z: parkPos.z },
          rotationY: 0,
          physics: this.physics,
        });
        vehicle.park?.(this.physics);
        this._setIdleVisual(vehicle, true);
        // O1: dormant pool — no frame/fixed-step work until leased.
        this.vehicleSystem.setVehicleActivity?.(vehicle, VEHICLE_ACTIVITY_DORMANT, {
          physics: this.physics,
        });

        let semiRig = null;
        if (archetype === 'semi' && this.physics?.RAPIER) {
          semiRig = createSemiRig({
            physics: this.physics,
            cabVehicle: vehicle,
            scene: this.scene,
            poolIndex: globalPoolIndex + i,
          });
        }

        members.push({
          state: LEASE_IDLE,
          slotId: null,
          archetype,
          vehicle,
          colorIndex,
          poolIndex: globalPoolIndex + i,
          semiRig,
        });
      }
      globalPoolIndex += size;
      this.pools.set(archetype, members);
    }

    this._recountPools();
    this.status = 'ready';
    this._forceMaint = true;
    this.updateWindow({ focusPosition, protectedVehicles, force: true });
    return this;
  }

  /**
   * Diff desired deterministic slots against live leases; recover idle cars into
   * gaps; recycle cars whose *actual* s left the window (cruise-aware).
   * Never spawns vehicles. Throttled to ~10 Hz / focus distance (O3) unless forced.
   *
   * @param {{
   *   focusPosition: { x?: number, y?: number, z?: number },
   *   protectedVehicles?: Iterable<object>|null,
   *   force?: boolean,
   *   now?: number,
   * }} opts
   */
  updateWindow({
    focusPosition,
    protectedVehicles = null,
    force = false,
    now = performance.now() / 1000,
  } = {}) {
    if (this.status !== 'ready') {
      return { desired: 0, live: 0, acquired: 0, released: 0, skipped: true };
    }

    const focusS = worldZToS(focusPosition);
    this._lastFocusS = focusS;

    // Estimate focus speed along +s from the last maintenance sample.
    if (this._lastMaintFocusS != null && Number.isFinite(this._lastMaintTime)) {
      const dtSample = now - this._lastMaintTime;
      if (dtSample > 1e-4 && dtSample < 2) {
        const inst = Math.abs(focusS - this._lastMaintFocusS) / dtSample;
        // Light smooth so a hitch does not explode the front window.
        this._focusSpeedS = this._focusSpeedS * 0.7 + inst * 0.3;
      }
    }
    const focusSpeed = this._focusSpeedS;
    const closing = Math.max(0, focusSpeed - FLOW_SPEED);
    const frontBoost = Math.min(FAST_FRONT_BOOST_MAX_M, closing * FAST_FRONT_LOOKAHEAD_S);
    const windowFront = this.windowFront + frontBoost;
    this._effectiveWindowFront = windowFront;

    // High closing speed: maintain more often so front slots refill before the
    // player overruns the packed band.
    const focusDeltaNeed = closing > 12
      ? Math.max(4, WINDOW_FOCUS_DELTA_S * 0.45)
      : WINDOW_FOCUS_DELTA_S;
    const maintInterval = closing > 12
      ? Math.min(this._maintInterval, 1 / 20)
      : this._maintInterval;

    const forceRun = force || this._forceMaint;
    const focusMoved = this._lastMaintFocusS == null
      || Math.abs(focusS - this._lastMaintFocusS) >= focusDeltaNeed;
    const intervalElapsed = (now - this._lastMaintTime) >= maintInterval;
    if (!forceRun && !focusMoved && !intervalElapsed) {
      this._counts.skippedMaintenance += 1;
      return {
        desired: this._desiredById.size,
        live: this.liveBySlot.size,
        acquired: 0,
        released: 0,
        skipped: true,
      };
    }
    this._forceMaint = false;
    this._lastMaintFocusS = focusS;
    this._lastMaintTime = now;
    this._counts.maintenanceRuns += 1;

    const desired = this._resolveWindowCached(focusS, windowFront, this.windowBack);
    this._counts.slotResolves += 1;

    const firstTile = Math.floor((focusS - this.windowBack) / RUN_LENGTH);
    const lastTile = Math.floor((focusS + windowFront) / RUN_LENGTH);
    this._lastTileRange = { first: firstTile, last: lastTile };

    const desiredById = this._desiredById;
    desiredById.clear();
    for (let i = 0; i < desired.length; i += 1) {
      desiredById.set(desired[i].id, desired[i]);
    }

    const protectedSet = this._fillProtectedSet(protectedVehicles);

    let released = 0;
    let acquired = 0;
    let rebound = 0;

    // M6: recycle by actual vehicle progress so co-moving convoy cars stay live.
    // Only s-window membership retires a car — do NOT park unclaimed in-window
    // leases (they drift off authored slot centres while cruising; yeeting them
    // made traffic vanish under the player at high relative speed).
    const minLiveS = focusS - this.windowBack - RECYCLE_SLACK_M;
    const maxLiveS = focusS + windowFront + RECYCLE_SLACK_M;
    for (const lease of [...this.liveBySlot.values()]) {
      if (this._isProtected(lease, protectedSet)) continue;
      const vs = this._leaseProgressS(lease);
      if (!Number.isFinite(vs) || vs < minLiveS || vs > maxLiveS) {
        this._releaseLease(lease);
        released += 1;
      }
    }

    // Claim leases for the current desired packing. Co-moving cars keep stale
    // tile slot ids after the window slides — rebind onto the new id at the same
    // s-band so acquire can still fill true gaps without pool exhaustion.
    /** @type {Set<object>} */
    const claimed = new Set();
    // Wider rebind radius: slot spacing is ~30–40 m; 12 m left cars unclaimed.
    const rebindRadiusBase = Math.max(NEAR_SLOT_MATCH_M * 2.5, 28);
    for (let i = 0; i < desired.length; i += 1) {
      const slot = desired[i];
      const nearRadius = rebindRadiusBase + (slot.len ?? 4) * 0.5;
      let lease = this.liveBySlot.get(slot.id);
      if (lease) {
        this._applyCruise(lease, slot);
        claimed.add(lease);
        continue;
      }
      const slotMatch = {
        archetype: slot.type ?? 'sedan',
        laneX: slot.worldX,
      };
      const near = this._findLiveNearS(slot.s, nearRadius, claimed, slotMatch);
      if (near && !this._isProtected(near, protectedSet)) {
        if (near.slotId && this.liveBySlot.get(near.slotId) === near) {
          this.liveBySlot.delete(near.slotId);
        }
        near.slotId = slot.id;
        this.liveBySlot.set(slot.id, near);
        this._applyCruise(near, slot);
        claimed.add(near);
        rebound += 1;
        continue;
      }
      // Occupied band already (claimed car) — skip rather than double-stack.
      if (this._findLiveNearS(
        slot.s,
        NEAR_SLOT_MATCH_M + (slot.len ?? 4) * 0.5,
        null,
        slotMatch,
      )) {
        continue;
      }
      lease = this._acquireIdle(slot.type ?? 'sedan', protectedSet);
      if (!lease) {
        this._counts.poolMisses += 1;
        continue;
      }
      this._placeLease(lease, slot);
      claimed.add(lease);
      acquired += 1;
    }

    this._counts.acquisitions += acquired;
    this._counts.releases += released;
    this._counts.rebinds = (this._counts.rebinds ?? 0) + rebound;

    return {
      desired: desired.length,
      live: this.liveBySlot.size,
      acquired,
      released,
      rebound,
      windowFront,
      focusSpeed,
      skipped: false,
    };
  }

  /**
   * Resolve desired slots using per-tile cache (O3).
   * @param {number} focusS
   * @param {number} [windowFront]
   * @param {number} [windowBack]
   */
  _resolveWindowCached(focusS, windowFront = this.windowFront, windowBack = this.windowBack) {
    const minS = focusS - windowBack;
    const maxS = focusS + windowFront;
    const firstTile = Math.floor(minS / RUN_LENGTH);
    const lastTile = Math.floor(maxS / RUN_LENGTH);
    const slots = [];
    for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
      const tileSlots = this._getTileSlots(tileIndex);
      for (let i = 0; i < tileSlots.length; i += 1) {
        const slot = tileSlots[i];
        if (slot.s < minS || slot.s > maxS) continue;
        slots.push(slot);
      }
    }
    slots.sort((a, b) => (a.s - b.s) || (a.lane - b.lane) || a.id.localeCompare(b.id));
    return slots;
  }

  /**
   * Cached deterministic slots for one tile (seed + tileIndex).
   * @param {number} tileIndex
   */
  _getTileSlots(tileIndex) {
    let cached = this._tileCache.get(tileIndex);
    if (cached) return cached;
    const rng = createHighwayRng(tileSeed(this.seed, tileIndex));
    const platforms = runPlatforms;
    const list = [];
    for (let entryIndex = 0; entryIndex < platforms.length; entryIndex += 1) {
      const entry = platforms[entryIndex];
      const colorRoll = rng();
      const s = tileIndex * RUN_LENGTH + entry.s;
      const colorIndex = Math.floor(colorRoll * TRAFFIC_COLORS.length) % TRAFFIC_COLORS.length;
      list.push(Object.freeze({
        id: makeSlotId(tileIndex, entryIndex),
        tileIndex,
        entryIndex,
        s,
        lane: entry.lane,
        type: entry.type,
        len: entry.len,
        dSpeed: entry.dSpeed ?? 0,
        colorIndex,
        worldX: laneWorldX(entry.lane),
        worldZ: sToWorldZ(s),
        worldY: HIGHWAY_Y,
      }));
    }
    // Cap tile cache growth for long sessions (keep a sliding band).
    if (this._tileCache.size > 48) {
      const keys = [...this._tileCache.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length - 32; i += 1) {
        this._tileCache.delete(keys[i]);
      }
    }
    this._tileCache.set(tileIndex, list);
    return list;
  }

  _fillProtectedSet(protectedVehicles) {
    const set = this._protectedSet;
    set.clear();
    if (!protectedVehicles) return set;
    if (protectedVehicles instanceof Set) {
      for (const v of protectedVehicles) if (v) set.add(v);
      return set;
    }
    if (Symbol.iterator in Object(protectedVehicles)) {
      for (const v of protectedVehicles) if (v) set.add(v);
    }
    return set;
  }

  _recountPools() {
    let idle = 0;
    let live = 0;
    let reserved = 0;
    let poolSize = 0;
    for (const members of this.pools.values()) {
      poolSize += members.length;
      for (const lease of members) {
        if (lease.state === LEASE_IDLE) idle += 1;
        else if (lease.state === LEASE_TRAFFIC) live += 1;
        else reserved += 1;
      }
    }
    this._counts.idle = idle;
    this._counts.live = live;
    this._counts.reserved = reserved;
    this._counts.poolSize = poolSize;
  }

  /**
   * M4: player hijacked this traffic car — remove from pool/leases permanently
   * for this session so recycle never teleports their ride.
   * @param {object} vehicle
   */
  claimVehicleForPlayer(vehicle) {
    if (!vehicle) return false;
    // Drop any live lease pointing at this vehicle.
    for (const [slotId, lease] of this.liveBySlot.entries()) {
      if (lease.vehicle === vehicle) {
        this.liveBySlot.delete(slotId);
        lease.slotId = null;
        lease.state = LEASE_PLAYER;
        this._counts.live = Math.max(0, this._counts.live - 1);
        // Leave the body where it is — do not park off-world.
        break;
      }
    }
    // Player takes input; stop scripted cruise so cabin controls own the chassis.
    this.clearCruise(vehicle);
    if (vehicle.parkedMode) vehicle.parkedMode = false;
    this.vehicleSystem?.setVehicleActivity?.(vehicle, VEHICLE_ACTIVITY_ACTIVE, {
      physics: this.physics,
    });
    // Promote TSL instance → owned shell on the chassis so the player can see it.
    this.carVisuals?.promoteToOwned?.(vehicle);
    // Remove from idle/traffic pool arrays so we never recover/reuse it.
    for (const [archetype, members] of this.pools.entries()) {
      const next = members.filter((lease) => lease.vehicle !== vehicle);
      if (next.length !== members.length) {
        this.pools.set(archetype, next);
        this._counts.poolSize = Math.max(0, this._counts.poolSize - 1);
      }
    }
    this._forceMaint = true;
    // Keep roof registered for possible roof-surf later.
    return true;
  }

  /**
   * Clear highway cruise bookkeeping on a vehicle (hijack / release).
   * @param {object|null} vehicle
   */
  clearCruise(vehicle) {
    if (!vehicle) return;
    vehicle.highwayCruise = null;
  }

  /**
   * Whether a vehicle is currently a traffic lease (never true for player car).
   * @param {object} vehicle
   */
  isTrafficLease(vehicle) {
    if (!vehicle) return false;
    for (const lease of this.liveBySlot.values()) {
      if (lease.vehicle === vehicle) return true;
    }
    for (const members of this.pools.values()) {
      for (const lease of members) {
        if (lease.vehicle === vehicle && lease.state === LEASE_TRAFFIC) return true;
      }
    }
    return false;
  }

  /**
   * Whether a vehicle belongs to the traffic pool at all (idle or live).
   * @param {object} vehicle
   */
  isPoolMember(vehicle) {
    if (!vehicle) return false;
    for (const members of this.pools.values()) {
      for (const lease of members) {
        if (lease.vehicle === vehicle) return true;
      }
    }
    return false;
  }

  snapshot() {
    let cruising = 0;
    for (const lease of this.liveBySlot.values()) {
      if (lease.vehicle?.highwayCruise) cruising += 1;
    }
    return {
      status: this.status,
      seed: this.seed,
      focusS: this._lastFocusS,
      focusTile: Math.floor(this._lastFocusS / RUN_LENGTH),
      tileRange: { ...this._lastTileRange },
      windowFront: this.windowFront,
      windowBack: this.windowBack,
      physicalRoad: physicalRoadBounds(),
      poolSize: this._counts.poolSize,
      liveLeases: this.liveBySlot.size,
      idleLeases: this._counts.idle,
      reservedLeases: this._counts.reserved,
      cruisingLeases: cruising,
      maintenanceRuns: this._counts.maintenanceRuns,
      slotResolves: this._counts.slotResolves,
      acquisitions: this._counts.acquisitions,
      releases: this._counts.releases,
      poolMisses: this._counts.poolMisses,
      skippedMaintenance: this._counts.skippedMaintenance,
      tileCacheSize: this._tileCache.size,
      carVisuals: this.carVisuals?.snapshot?.() ?? null,
      liveSlotIds: [...this.liveBySlot.keys()].sort(),
    };
  }

  /**
   * Fixed-step: pose kinematic trailers from cab hitch (before world.step).
   * Wired from physicsSystem.stepHooks.beforeTick.
   */
  stepTrailers(dt = 1 / 60) {
    if (this.status !== 'ready') return;
    const seen = new Set();
    for (const members of this.pools.values()) {
      for (const lease of members) {
        if (lease.semiRig?.active) {
          stepSemiRig(lease.semiRig, this.physics, dt);
          seen.add(lease.semiRig);
        }
      }
    }
    for (const vehicle of this.vehicleSystem?.vehicles ?? []) {
      const rig = vehicle.userData?.semiRig;
      if (rig?.active && !seen.has(rig)) stepSemiRig(rig, this.physics, dt);
    }
  }

  /**
   * Sync articulated trailer visuals + TSL fleet (once per render frame).
   * Includes hijacked semis (removed from pool but still hitch-followed).
   */
  syncVisuals() {
    if (this.status !== 'ready') return;
    const seen = new Set();
    for (const members of this.pools.values()) {
      for (const lease of members) {
        if (lease.semiRig?.active) {
          syncSemiRig(lease.semiRig, this.physics);
          seen.add(lease.semiRig);
        }
      }
    }
    for (const vehicle of this.vehicleSystem?.vehicles ?? []) {
      const rig = vehicle.userData?.semiRig;
      if (rig?.active && !seen.has(rig)) syncSemiRig(rig, this.physics);
    }
    this.carVisuals?.syncAll?.();
  }

  /**
   * Drop lease bookkeeping only. VehicleSystem.dispose() owns cab body teardown.
   */
  dispose() {
    for (const members of this.pools.values()) {
      for (const lease of members) {
        if (lease.semiRig) {
          disposeSemiRig(lease.semiRig, {
            physics: this.physics,
            platformRiding: this.platformRiding,
            carVisuals: this.carVisuals,
            enemySystem: this.enemySystem,
            scene: this.scene,
          });
          lease.semiRig = null;
        }
      }
    }
    this.liveBySlot.clear();
    this.pools.clear();
    this._tileCache.clear();
    this._desiredById.clear();
    this._protectedSet.clear();
    this.carVisuals?.dispose?.();
    this.carVisuals = null;
    this.physics = null;
    this.vehicleSystem = null;
    this.scene = null;
    this.enemySystem = null;
    this.status = 'idle';
  }

  // ── internals ────────────────────────────────────────────────────────────

  _isProtected(lease, protectedSet) {
    if (!lease?.vehicle) return true;
    if (protectedSet.has(lease.vehicle)) return true;
    if (lease.state === LEASE_PLAYER || lease.state === LEASE_RESERVED) return true;
    if (lease.vehicle.hasDriver?.()) return true;
    if (this.vehicleSystem?.activeVehicle === lease.vehicle) return true;
    return false;
  }

  _acquireIdle(archetype, protectedSet) {
    const key = TRAFFIC_ARCHETYPES.includes(archetype) ? archetype : 'sedan';
    const members = this.pools.get(key) ?? this.pools.get('sedan');
    if (!members) return null;
    for (const lease of members) {
      if (lease.state !== LEASE_IDLE) continue;
      if (protectedSet.has(lease.vehicle)) continue;
      return lease;
    }
    return null;
  }

  _placeLease(lease, slot) {
    const vehicle = lease.vehicle;
    const position = {
      x: slot.worldX,
      y: HIGHWAY_Y + 0.9,
      z: slot.worldZ,
    };
    // Prefer level ground height when the vehicle system has a level facade.
    const level = this.vehicleSystem?.level;
    if (level?.getGroundHeightAt) {
      const gy = level.getGroundHeightAt(position, 0, { preferRoadSurface: true });
      if (Number.isFinite(gy)) {
        const clearance = vehicle.getGroundSpawnClearance?.() ?? 0.9;
        position.y = gy + clearance + 0.15;
      }
    }

    // O1: re-enable body before recover so physics accepts the teleport.
    this.vehicleSystem?.setVehicleActivity?.(vehicle, VEHICLE_ACTIVITY_ACTIVE, {
      physics: this.physics,
    });
    this._setIdleVisual(vehicle, false);
    vehicle.recover?.({
      position,
      rotationY: 0, // facing −Z (highway forward)
      physics: this.physics,
    });
    // M6: cruise, do not park — seed flow velocity so relative motion is immediate.
    this._applyCruise(lease, slot);
    this._seedCruiseVelocity(vehicle, slot.dSpeed ?? 0, lease.archetype);

    const color = TRAFFIC_COLORS[slot.colorIndex ?? lease.colorIndex ?? 0] ?? 0x3a4a5c;
    const archetype = lease.archetype
      ?? slot.type
      ?? vehicle.userData?.highwayArchetype
      ?? 'sedan';
    vehicle.userData = {
      ...(vehicle.userData ?? {}),
      highwayColor: color,
      highwayArchetype: archetype,
      highwayBodyType: archetype === 'semi' ? 'semiCab' : archetype,
    };

    if (archetype === 'semi' && lease.semiRig) {
      // Articulated cab + trailer: joint, trailer bed platform, dual TSL shells.
      const cabBody = this.physics?.getFreshBody?.(vehicle.bodyHandle);
      const vel = cabBody?.linvel?.() ?? null;
      activateSemiRig(lease.semiRig, {
        physics: this.physics,
        platformRiding: this.platformRiding,
        carVisuals: this.carVisuals,
        enemySystem: this.enemySystem,
        color,
        velocity: vel,
        spawnGuards: this.spawnSemiGuards,
      });
      // Cab roof (sleeper) remains a small leap pad; trailer bed is the fight deck.
      this.platformRiding?.registerVehicleRoof?.(vehicle, { hijackable: true });
    } else if (archetype === 'semi') {
      // No RAPIER in harness — fall back to cab shell only.
      this.platformRiding?.registerVehicleRoof?.(vehicle, { hijackable: true });
      this.carVisuals?.attach?.(vehicle, color, 'semiCab');
    } else {
      this.platformRiding?.registerVehicleRoof?.(vehicle, { hijackable: true });
      this.carVisuals?.attach?.(vehicle, color, archetype);
    }

    if (lease.state === LEASE_IDLE) {
      this._counts.idle = Math.max(0, this._counts.idle - 1);
      this._counts.live += 1;
    }
    lease.state = LEASE_TRAFFIC;
    lease.slotId = slot.id;
    lease.dSpeed = slot.dSpeed ?? 0;
    lease.colorIndex = slot.colorIndex ?? lease.colorIndex;
    this.liveBySlot.set(slot.id, lease);
  }

  /**
   * Cruise target speed for a slot, boosted when the player is much faster so
   * traffic remains in view long enough to read instead of vanishing instantly.
   * Semis deliberately do not receive the fast-player catch-up boost: they are
   * long gameplay platforms, and the boost made them race at up to 173 km/h.
   * @param {number} dSpeed
   * @param {string} archetype
   */
  _cruiseTargetSpeed(dSpeed = 0, archetype = 'sedan') {
    if (archetype === 'semi') {
      const variation = Number.isFinite(dSpeed) ? dSpeed : 0;
      return THREE.MathUtils.clamp(
        SEMI_CRUISE_BASE_SPEED + variation,
        0,
        SEMI_CRUISE_MAX_SPEED,
      );
    }
    const authored = cruiseSpeedForDSpeed(dSpeed);
    const focusSpeed = this._focusSpeedS;
    if (!(focusSpeed > authored + FAST_CRUISE_RELATIVE_MIN)) return authored;
    const catchUp = Math.min(FAST_CRUISE_CATCHUP_MAX, focusSpeed - FAST_CRUISE_RELATIVE_MIN);
    return Math.max(authored, catchUp);
  }

  /**
   * Longitudinal progress of a lease (prefer chassis group; fall back to body).
   * @param {TrafficLease} lease
   */
  _leaseProgressS(lease) {
    const groupPos = lease?.vehicle?.group?.position;
    if (groupPos && Number.isFinite(groupPos.z)) return worldZToS(groupPos);
    const body = this.physics?.getFreshBody?.(lease?.vehicle?.bodyHandle);
    const t = body?.translation?.();
    if (t && Number.isFinite(t.z)) return worldZToS(t);
    const spawn = lease?.vehicle?.spawnPosition;
    if (spawn && Number.isFinite(spawn.z)) return worldZToS(spawn);
    return NaN;
  }

  /**
   * Attach / refresh highwayCruise only when speed, lane, or role changed (O3).
   * @param {TrafficLease} lease
   * @param {object} slot
   */
  _applyCruise(lease, slot) {
    if (!lease?.vehicle || !slot) return;
    const dSpeed = slot.dSpeed ?? 0;
    const targetSpeed = this._cruiseTargetSpeed(dSpeed, lease.archetype);
    const laneX = slot.worldX;
    const prev = lease.vehicle.highwayCruise;
    if (
      prev
      && Math.abs((prev.targetSpeed ?? 0) - targetSpeed) < 0.25
      && prev.laneX === laneX
      && prev.dSpeed === dSpeed
      && prev.slotId === slot.id
    ) {
      lease.dSpeed = dSpeed;
      return;
    }
    lease.vehicle.highwayCruise = {
      targetSpeed,
      laneX,
      dSpeed,
      slotId: slot.id,
    };
    lease.dSpeed = dSpeed;
    // Ensure park hold cannot pin the chassis while cruising.
    if (lease.vehicle.parkedMode) {
      lease.vehicle.parkedMode = false;
      lease.vehicle._parkedPose = null;
    }
  }

  /**
   * Seed chassis linvel to convoy speed after recover (which zeros velocity).
   * @param {object} vehicle
   * @param {number} dSpeed
   * @param {string} archetype
   */
  _seedCruiseVelocity(vehicle, dSpeed = 0, archetype = vehicle?.userData?.highwayArchetype) {
    if (!vehicle) return;
    const speed = this._cruiseTargetSpeed(dSpeed, archetype);
    const vel = { x: 0, y: 0, z: -speed };
    vehicle.parkedMode = false;
    vehicle._parkedPose = null;
    vehicle.speed = speed;
    if (vehicle.linearVelocity?.set) {
      vehicle.linearVelocity.set(vel.x, vel.y, vel.z);
    }
    const body = this.physics?.getFreshBody?.(vehicle.bodyHandle);
    if (body) {
      body.setLinvel(vel, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.wakeUp?.();
    }
  }

  /** Whether any live traffic car sits near longitudinal s. */
  _hasLiveNearS(s, radius = NEAR_SLOT_MATCH_M) {
    return this._findLiveNearS(s, radius) != null;
  }

  /**
   * Nearest live lease within longitudinal radius of s, or null.
   * @param {number} s
   * @param {number} [radius]
   * @param {Set<object>|null} [exclude]
   * @param {{ archetype?: string, laneX?: number }|null} [match]
   */
  _findLiveNearS(s, radius = NEAR_SLOT_MATCH_M, exclude = null, match = null) {
    const r = Math.max(0, radius);
    let best = null;
    let bestDist = Infinity;
    for (const lease of this.liveBySlot.values()) {
      if (exclude?.has(lease)) continue;
      if (match?.archetype && lease.archetype !== match.archetype) continue;
      if (Number.isFinite(match?.laneX)) {
        const leaseLaneX = lease.vehicle?.highwayCruise?.laneX;
        if (!Number.isFinite(leaseLaneX) || Math.abs(leaseLaneX - match.laneX) > 0.1) continue;
      }
      const vs = this._leaseProgressS(lease);
      if (!Number.isFinite(vs)) continue;
      const dist = Math.abs(vs - s);
      if (dist <= r && dist < bestDist) {
        best = lease;
        bestDist = dist;
      }
    }
    return best;
  }

  _releaseLease(lease) {
    if (!lease) return;
    if (lease.slotId) this.liveBySlot.delete(lease.slotId);
    if (lease.state === LEASE_TRAFFIC) {
      this._counts.live = Math.max(0, this._counts.live - 1);
      this._counts.idle += 1;
    }
    lease.slotId = null;
    lease.state = LEASE_IDLE;
    lease.dSpeed = 0;
    this.platformRiding?.unregisterVehicleRoof?.(lease.vehicle);
    this.clearCruise(lease.vehicle);

    const parkPos = this.idleParkPosition(lease.poolIndex ?? 0);
    if (lease.semiRig) {
      deactivateSemiRig(lease.semiRig, {
        physics: this.physics,
        platformRiding: this.platformRiding,
        carVisuals: this.carVisuals,
        enemySystem: this.enemySystem,
        parkPosition: {
          x: parkPos.x + 6,
          y: parkPos.y,
          z: parkPos.z,
        },
      });
    } else {
      this.carVisuals?.detach?.(lease.vehicle);
    }

    // Park outside the road footprint so analytic ground never re-snaps them
    // onto the deck, and hide the mesh so recycle never flashes a stack.
    this.vehicleSystem?.setVehicleActivity?.(lease.vehicle, VEHICLE_ACTIVITY_ACTIVE, {
      physics: this.physics,
    });
    lease.vehicle.recover?.({
      position: { x: parkPos.x, y: parkPos.y, z: parkPos.z },
      rotationY: 0,
      physics: this.physics,
    });
    lease.vehicle.park?.(this.physics);
    this._setIdleVisual(lease.vehicle, true);
    this.vehicleSystem?.setVehicleActivity?.(lease.vehicle, VEHICLE_ACTIVITY_DORMANT, {
      physics: this.physics,
    });
  }

  /** Hide idle pool cars so a mis-park never stacks a visible pile on the ribbon. */
  _setIdleVisual(vehicle, idle) {
    if (!vehicle) return;
    if (vehicle.group) vehicle.group.visible = !idle;
  }
}

