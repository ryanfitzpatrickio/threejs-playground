import * as THREE from 'three';
import { BaseVehicle, makeNeutralControls, makeParkedControls } from '../vehicles/BaseVehicle.js';
import { VEHICLE_DOMAINS } from '../config/vehicleConfig.js';

// ---------------------------------------------------------------------------
// VehicleSystem
//
// Owns the registry of BaseVehicle instances and the player's relationship to
// them: enter/exit (reusing the existing mount key), control routing, and the
// per-frame drive update. It is deliberately the only place that knows about
// player input — vehicles themselves take a normalized control struct.
//
// Ordering contract (see GameRuntime.update): this system runs BEFORE
// MountSystem and MovementSystem so that
//   (a) it can consume the mount key before the horse does when a vehicle is in
//       range / the player is driving, and
//   (b) vehicle forces are applied before the per-frame world.step().
//
// While driving, locomotion/combat input is stripped from the returned input so
// downstream systems stay quiet (MovementSystem also early-outs on
// character.vehicle.active).
// ---------------------------------------------------------------------------

/** Vehicle activity tiers (O1). Hot loops skip `dormantPool`. */
export const VEHICLE_ACTIVITY_ACTIVE = 'active';
export const VEHICLE_ACTIVITY_SLEEPING = 'sleeping';
export const VEHICLE_ACTIVITY_DORMANT = 'dormantPool';

const ENTER_DISTANCE = 4.5;
const HEADLIGHT_COLOR = 0xc9e9ff;
const HEADLIGHT_INTENSITY = 14000;
const HEADLIGHT_DISTANCE = 240;
const HEADLIGHT_ANGLE = 0.48;
const HEADLIGHT_PENUMBRA = 0.72;
const HEADLIGHT_TARGET_DROP = 2.4;
const HEADLIGHT_TARGET_FORWARD = 140;

// Mixamo hip bone used to hip-anchor the rider in the seat (same convention as
// the horse saddle socket).
const HIPS_BONE = 'mixamorigHips';

const _seatPos = new THREE.Vector3();
const _seatQuat = new THREE.Quaternion();
const _exitPos = new THREE.Vector3();
const _anchorOffset = new THREE.Vector3();
const _anchorWorld = new THREE.Vector3();
const _recoveryPosition = new THREE.Vector3();
const _recoveryBest = new THREE.Vector3();
const _recoveryForward = new THREE.Vector3();
const _lookaheadPosition = new THREE.Vector3();
// How far ahead (in seconds of travel) the driven vehicle prefetches physics
// heightfields. Must comfortably beat the per-frame maxBuilds:1 drip — at 60fps
// a full radius-1 ring (9 chunks) fills in ~0.15s, well inside the window.
const GROUND_PREFETCH_SECONDS = 1.25;
const GROUND_PREFETCH_MIN_SPEED = 8; // m/s; below this the occupied chunk suffices
const RECOVERY_RADII = [0, 4, 8, 14, 22, 32];
const RECOVERY_DIRECTIONS = 12;
const RECOVERY_CLEARANCE = 0.15;
const RECOVERY_ROAD_SEARCH_MAX = 180;
// Extra lift on spawn so the chassis clears road decks, heightfield seams, and any
// analytic-vs-physics mismatch (the character rides analytic ground; a rigid body
// needs real collider clearance).
const SPAWN_EXTRA_CLEARANCE = 0.15;
const CONTROL_RECORDING_LIMIT = 72_000;
/** Cabin ↔ roof seat-swap blend (s). Steering is locked during the swap. */
const ROOF_SWAP_DURATION = 0.38;
/** Stability stress accumulates while roof-surfing under harsh inputs. */
const ROOF_STABILITY_HARD_STEER = 0.85;
const ROOF_STABILITY_HARD_BRAKE = 0.7;
const ROOF_STABILITY_MIN_SPEED = 10; // m/s before harsh inputs matter
const ROOF_STABILITY_BUILD = 1.15; // stress / second under load
const ROOF_STABILITY_RECOVER = 0.9;
const ROOF_STABILITY_THROW = 1; // dump back to seat at this stress
const ROOF_STABILITY_EJECT = 1.55; // full exit if extreme (impact + high stress)

export class VehicleSystem {
  constructor() {
    this.vehicles = [];
    /**
     * Vehicles that receive frame + fixed-step work (not dormantPool).
     * Ownership still lives in `vehicles`; this is an iteration filter.
     * @type {import('../vehicles/BaseVehicle.js').BaseVehicle[]}
     */
    this.simulatedVehicles = [];
    this.activeVehicle = null;
    this.cinematicDemoActive = false;
    this.physics = null;
    this.scene = null;
    this.level = null;
    this.weatherSystem = null;
    this.vehicleDamageSystem = null;
    this.cameraSystem = null;
    this.status = 'idle';
    this.headlightsEnabled = false;
    this.controlRecording = [];
    /** @type {{ fromIndex: number, toIndex: number, elapsed: number, duration: number }|null} */
    this._seatSwap = null;
    this._roofStability = 0;
    this._cameraModeBeforeRoof = null;
  }

  initialize({
    physics,
    scene,
    level = null,
    weatherSystem = null,
    vehicleDamageSystem = null,
    cameraSystem = null,
  }) {
    this.physics = physics;
    this.scene = scene;
    this.level = level;
    this.weatherSystem = weatherSystem;
    this.vehicleDamageSystem = vehicleDamageSystem;
    this.cameraSystem = cameraSystem ?? null;
    this.status = 'ready';
  }

  // Register an already-spawned vehicle.
  registerVehicle(vehicle) {
    if (!this.vehicles.includes(vehicle)) {
      this.vehicles.push(vehicle);
      if (!vehicle.activity) vehicle.activity = VEHICLE_ACTIVITY_ACTIVE;
      this._syncSimulatedList();
      installHeadlights(vehicle, this.headlightsEnabled);
    }
    return vehicle;
  }

  /**
   * Set activity tier for a registered vehicle (O1 highway dormant pool).
   * @param {object} vehicle
   * @param {'active'|'sleeping'|'dormantPool'} activity
   * @param {{ physics?: object|null }} [opts]
   */
  setVehicleActivity(vehicle, activity, { physics = this.physics } = {}) {
    if (!vehicle) return false;
    const next = activity === VEHICLE_ACTIVITY_DORMANT
      || activity === VEHICLE_ACTIVITY_SLEEPING
      || activity === VEHICLE_ACTIVITY_ACTIVE
      ? activity
      : VEHICLE_ACTIVITY_ACTIVE;
    const prev = vehicle.activity ?? VEHICLE_ACTIVITY_ACTIVE;
    if (prev === next && vehicle._activityApplied === next) {
      return true;
    }
    vehicle.activity = next;
    vehicle._activityApplied = next;

    const body = physics?.getFreshBody?.(vehicle.bodyHandle);
    if (next === VEHICLE_ACTIVITY_DORMANT) {
      if (vehicle.group) vehicle.group.visible = false;
      vehicle.tireEffects?.mute?.(true);
      vehicle.engineAudio?.mute?.(true);
      vehicle.crashAudio?.mute?.(true);
      try {
        body?.setEnabled?.(false);
      } catch {
        // Older body wrappers may lack setEnabled — leave sleeping.
        body?.sleep?.();
      }
    } else {
      try {
        body?.setEnabled?.(true);
      } catch {
        // ignore
      }
      body?.wakeUp?.();
      if (vehicle.group && next === VEHICLE_ACTIVITY_ACTIVE) {
        vehicle.group.visible = true;
      }
      vehicle.tireEffects?.mute?.(false);
      // Engine audio stays muted until a driver enters / traffic unmutes as needed.
    }
    this._syncSimulatedList();
    return true;
  }

  /** Rebuild simulatedVehicles from activity flags. */
  _syncSimulatedList() {
    this.simulatedVehicles = this.vehicles.filter(
      (v) => (v.activity ?? VEHICLE_ACTIVITY_ACTIVE) !== VEHICLE_ACTIVITY_DORMANT,
    );
  }

  /** Whether a vehicle participates in frame/fixed-step work. */
  isSimulated(vehicle) {
    if (!vehicle) return false;
    return (vehicle.activity ?? VEHICLE_ACTIVITY_ACTIVE) !== VEHICLE_ACTIVITY_DORMANT;
  }

  setHeadlightsEnabled(enabled) {
    this.headlightsEnabled = Boolean(enabled);
    for (const vehicle of this.vehicles) {
      installHeadlights(vehicle, this.headlightsEnabled);
      if (vehicle.headlightRig) vehicle.headlightRig.visible = this.headlightsEnabled;
    }
    return this.snapshot();
  }

  // Convenience: construct + spawn + register in one call.
  async spawnVehicle(options = {}) {
    if (!this.physics?.world) {
      throw new Error('VehicleSystem.spawnVehicle: physics not initialized');
    }
    const vehicle = options.vehicle instanceof BaseVehicle
      ? options.vehicle
      : new BaseVehicle(options);
    if (
      vehicle.domain === VEHICLE_DOMAINS.GROUND &&
      options.snapToGround !== false &&
      this.level?.getGroundHeightAt
    ) {
      // Make sure the terrain under the spawn actually has a physics heightfield.
      // Streaming only builds heightfields for chunks as they become live around
      // the CHARACTER, and a chunk can be visually live without a heightfield (the
      // character rides analytic ground). A vehicle is a real rigid body, so
      // without this it would spawn over terrain that has no collider and fall
      // straight through. Builds the chunk block under the spawn if missing.
      const builtCollider = this.level.ensureGroundCollider?.(vehicle.spawnPosition, this.physics);
      if (builtCollider) {
        // Rapier's query pipeline needs one step to see a heightfield we just built.
        this.physics.world.step();
      }
      // Sample the surface DIRECTLY under the spawn center (radius 0), not the
      // footprint MAX. getGroundHeightAt multi-samples around the radius and
      // returns the HIGHEST point (right for keeping a character from sinking),
      // but on steep terrain — e.g. the ~80° faces in wilds/alpine zones — the
      // tallest point within the chassis footprint can be many metres above the
      // ground under the car's center. Snapping to that floats the chassis high
      // in the air, so it free-falls and tumbles down the slope on spawn ("falls
      // through the ground"). The point sample puts the wheels on the surface
      // they actually sit on; the suspension/contact resolves the per-wheel slope.
      const clearance = vehicle.getGroundSpawnClearance();
      const analytic = this.level.getGroundHeightAt(vehicle.spawnPosition, 0, {
        preferRoadSurface: true,
      });
      const physicsY = raycastPhysicsSurfaceY(
        this.physics,
        vehicle.spawnPosition.x,
        vehicle.spawnPosition.z,
      );
      let surfaceY = Math.max(
        Number.isFinite(analytic) ? analytic : -Infinity,
        Number.isFinite(physicsY) ? physicsY : -Infinity,
      );

      // Also sample a bit ahead of the vehicle (in its facing direction) when
      // choosing spawn height. Otherwise the rigid chassis collider (or front
      // suspension) can spawn already intersecting a rise / seam / deck edge
      // immediately in front of the center point. This is the "invisible bump
      // right in front of the car" that appears once the full world (detailed
      // heightfields + road decks) has loaded after spawn. Using max( center, front )
      // lifts just enough to clear the front without the old "use max over whole
      // footprint" problem on side slopes.
      if (Number.isFinite(vehicle.spawnRotationY)) {
        const yaw = vehicle.spawnRotationY;
        const fwdX = -Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        const frontSampleX = vehicle.spawnPosition.x + fwdX * 1.8;
        const frontSampleZ = vehicle.spawnPosition.z + fwdZ * 1.8;
        const frontAnalytic = this.level.getGroundHeightAt(
          { x: frontSampleX, y: 0, z: frontSampleZ },
          0,
          { preferRoadSurface: true },
        );
        const frontPhysicsY = raycastPhysicsSurfaceY(this.physics, frontSampleX, frontSampleZ);
        const frontS = Math.max(
          Number.isFinite(frontAnalytic) ? frontAnalytic : -Infinity,
          Number.isFinite(frontPhysicsY) ? frontPhysicsY : -Infinity,
        );
        if (Number.isFinite(frontS)) {
          surfaceY = Math.max(surfaceY, frontS);
        }
      }

      if (Number.isFinite(surfaceY)) {
        vehicle.spawnPosition.y = surfaceY + clearance + SPAWN_EXTRA_CLEARANCE;
      }
    }
    await vehicle.spawn({ scene: this.scene, physics: this.physics });
    if (vehicle.domain === VEHICLE_DOMAINS.GROUND) {
      vehicle.settleParked(this.physics);
    }
    return this.registerVehicle(vehicle);
  }

  // Remove and dispose a vehicle. If the player is currently driving it, the
  // rider is ejected first (via the normal exit path) so `character.vehicle`
  // never points at a disposed body — otherwise MovementSystem would early-out
  // against a dead vehicle forever.
  removeVehicle(vehicle, { character = null, level = null } = {}) {
    if (this.activeVehicle === vehicle) {
      if (character) {
        this._exit({ character, level });
      } else {
        // No character to eject (e.g. teardown); just drop the active ref.
        this.activeVehicle = null;
      }
    }
    const idx = this.vehicles.indexOf(vehicle);
    if (idx >= 0) {
      this.vehicles.splice(idx, 1);
      this._syncSimulatedList();
    }
    vehicle.dispose({ scene: this.scene, physics: this.physics });
  }

  // Returns { input } — possibly a locked clone while driving, or the original
  // (with the mount key consumed) when an enter/exit was handled this frame.
  update({ delta, input, character, level, camera = null, cameraSystem = null }) {
    if (this.status !== 'ready' || !character) {
      return { input };
    }
    if (cameraSystem) this.cameraSystem = cameraSystem;

    let consumedMount = false;

    // ---- enter / exit on the mount key ----
    if (input.mountPressed && !this.cinematicDemoActive) {
      if (this.activeVehicle) {
        this._exit({ character, level });
        consumedMount = true;
      } else if (this._canEnter(character)) {
        const target = this._nearestEnterable(character.group.position);
        if (target) {
          this._enter({ character, vehicle: target });
          consumedMount = true;
        }
      }
    }

    // ---- roof-surf seat swap (cabin ↔ roof), not a full dismount ----
    if (
      input.roofSurfPressed
      && this.activeVehicle
      && !this.cinematicDemoActive
      && !this._seatSwap
    ) {
      this._toggleRoofSurf(character);
    }

    // ---- drive the active vehicle, idle the rest ----
    let outputInput = input;
    if (this.activeVehicle) {
      if (
        input.shoulderThrowPressed
        && this.activeVehicle.domain === VEHICLE_DOMAINS.GROUND
      ) {
        this._recoverActiveVehicle(level ?? this.level);
      }

      // Self-heal terrain under the car. Streaming only builds heightfields for
      // chunks as they become live around the CHARACTER, and a chunk can be
      // visually live without a heightfield (the character rides analytic ground).
      // Driving onto such a chunk would drop the car through the world, so make
      // sure the chunk under it has a real collider first (idempotent + cheap —
      // a Map lookup once the heightfield exists).
      if (this.level?.ensureGroundCollider && this.activeVehicle.group) {
        // Occupied chunk: must exist NOW (no build cap) or the body falls through.
        this.level.ensureGroundCollider(this.activeVehicle.group.position, this.physics, { radiusChunks: 0 });
        // High-speed lookahead: streaming builds heightfields through a budgeted
        // queue centred on the character, so at speed the car can cross into a
        // chunk whose collider hasn't been built yet. The front wheel rays then
        // find no ground (nose dips, tyre grip vanishes) and when the heightfield
        // finally appears the over-compressed suspension kicks the chassis — the
        // "hit an invisible wall at speed" launch, worst during streaming hitches.
        // Prefetch a ring around where the car will be in ~a second, at most one
        // forced build per frame so the prefetch itself can't hitch.
        const speed = this.activeVehicle.speed ?? 0;
        if (speed > GROUND_PREFETCH_MIN_SPEED) {
          const body = this.physics?.getFreshBody?.(this.activeVehicle.bodyHandle);
          const v = body?.linvel?.();
          if (v) {
            _lookaheadPosition.copy(this.activeVehicle.group.position);
            _lookaheadPosition.x += v.x * GROUND_PREFETCH_SECONDS;
            _lookaheadPosition.z += v.z * GROUND_PREFETCH_SECONDS;
            this.level.ensureGroundCollider(_lookaheadPosition, this.physics, {
              radiusChunks: 1,
              maxBuilds: 1,
            });
          }
        }
      }
      if (this.level?.updateForestDrivingColliders && this.activeVehicle.group) {
        this.level.updateForestDrivingColliders(this.activeVehicle.group.position, this.physics);
      }
      this._updateVehicleSurface(this.activeVehicle);

      // During seat-swap, lock steer/throttle briefly so the pop-up reads cleanly.
      const swapActive = Boolean(this._seatSwap);
      const roofSurfing = Boolean(character.vehicle?.roofSurfing);
      let controls = this.cinematicDemoActive && this.activeVehicle.autopilot?.target
        ? this.activeVehicle.computeAutopilotControls()
        : this._controlsFromInput(this.activeVehicle, input, { roofSurfing });
      if (swapActive) {
        controls = {
          ...controls,
          throttle: controls.throttle * 0.35,
          steer: 0,
          brake: Math.max(controls.brake, 0.15),
        };
      }

      this.activeVehicle.update({
        dt: delta,
        controls,
        physics: this.physics,
        weatherSystem: this.weatherSystem,
        integrate: !this.physics?.fixedStepPlanning,
        camera,
      });

      this._updateSeatSwap(character, delta);
      this._updateRoofStability(character, delta, controls, level);
      this._lockRiderToSeat(character);
      outputInput = lockedInput(input, { roofSurfing });
    }

    const neutral = makeNeutralControls();
    const parked = makeParkedControls();
    for (const vehicle of this.simulatedVehicles) {
      if (vehicle === this.activeVehicle) {
        continue;
      }
      this._updateVehicleSurface(vehicle);
      // M6 highway cruise before generic autopilot/parked idle.
      let controls = parked;
      if (vehicle.highwayCruise) {
        controls = vehicle.computeHighwayCruiseControls?.() ?? parked;
      } else if (vehicle.autopilot?.target) {
        controls = vehicle.computeAutopilotControls();
      }
      vehicle.update({
        dt: delta,
        controls,
        physics: this.physics,
        weatherSystem: this.weatherSystem,
        integrate: !this.physics?.fixedStepPlanning,
        camera,
      });
    }

    // Mud field decay only here — stamping + texture upload run in
    // syncMudFieldAfterPhysics() AFTER integrateStep so wheel contact points
    // are current (fixed-step path previously stamped 1-frame-stale telemetry,
    // and often empty before the first physics step).
    const mudField = this.level?.mudField;
    if (mudField) {
      mudField.decay(delta);
    }

    if (consumedMount && outputInput.mountPressed) {
      outputInput = { ...outputInput, mountPressed: false };
    }

    this._updateExteriorIdleAudio(character);

    return { input: outputInput };
  }

  /**
   * Stamp live tyre ruts + re-seed pre-worn + upload deform texture.
   * Must run AFTER physics integrate (wheel telemetry contact points).
   * Called from GameRuntime after stepPlanned / syncVisualPoses.
   */
  syncMudFieldAfterPhysics(character = null, dt = 1 / 60) {
    const mudField = this.level?.mudField;
    if (!mudField) return;

    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    for (const vehicle of this.simulatedVehicles) {
      // Keep vehicle.mudField pointer fresh (used by grip sampling too).
      vehicle.mudField = mudField;
      vehicle.stampMudRuts?.(mudField, step);
    }

    // Follow the active car (or character / any ground vehicle) so the material
    // fade around centerUniform tracks the driver. Without this, ruts outside
    // ~70 m of the last center are fully faded.
    const focus = this.activeVehicle?.group?.position
      ?? character?.group?.position
      ?? this.simulatedVehicles.find((v) => v.domain === VEHICLE_DOMAINS.GROUND)?.group?.position;
    if (focus) {
      mudField.setCenter(focus.x, focus.z);
      mudField.refreshPreWorn?.(focus.x, focus.z);
    }

    mudField.ensureTexture?.();
    mudField.syncTexture();
  }

  _updateVehicleSurface(vehicle) {
    if (vehicle?.domain !== VEHICLE_DOMAINS.GROUND) return;
    // Highway TSL proxies only need a ride-height sample, not full surface tuning.
    if (vehicle.userData?.highwayProxyVisual && vehicle.highwayCruise && !vehicle.hasDriver?.()) {
      const position = vehicle.group?.position ?? vehicle.spawnPosition;
      if (position && this.level?.getGroundHeightAt) {
        const gy = this.level.getGroundHeightAt(position, 0, { preferRoadSurface: true });
        if (Number.isFinite(gy)) {
          const clearance = vehicle.getGroundSpawnClearance?.() ?? 0.9;
          vehicle._highwayGroundY = gy + clearance * 0.35;
        }
      }
      vehicle.groundSurface = 'asphalt';
      return;
    }
    const position = vehicle.group?.position ?? vehicle.spawnPosition;
    const surface = position
      ? this.level?.getRoadSurfaceAt?.(position.x, position.z)
      : null;
    vehicle.setGroundSurface?.(surface ?? 'offroad');
    vehicle.setGroundSurfaceSampler?.(this.level);
    // Hand the vehicle the rally mud deform field (null everywhere else) so its
    // integrate step can dip the visual tyres into their ruts.
    vehicle.mudField = this.level?.mudField ?? null;
  }

  _updateExteriorIdleAudio(character) {
    const listener = character?.group?.position;
    if (!listener) return;
    const inVehicle = Boolean(this.activeVehicle);
    for (const vehicle of this.simulatedVehicles) {
      vehicle.updateExteriorIdleAudio?.(listener, { inVehicle });
    }
  }

  // ---- fixed-step hooks (wired into PhysicsSystem.stepHooks by GameRuntime) --

  // Once per fixed step, before integration: record every vehicle's current body
  // pose as the interpolation "previous" state.
  capturePrevPoses() {
    for (const vehicle of this.simulatedVehicles) {
      vehicle.capturePosePreStep(this.physics);
    }
  }

  // Before every world-step slice: re-apply each vehicle's drive/suspension
  // model so force application matches the number of steps actually taken this
  // frame (may be 0, may be several during hitch catch-up). Reuses the controls
  // smoothed by this frame's update().
  integrateStep(dt, tick = this.physics?.tickCount ?? 0) {
    for (const vehicle of this.simulatedVehicles) {
      if (vehicle === this.activeVehicle) {
        this.controlRecording.push({ tick, controls: { ...vehicle.controls } });
        if (this.controlRecording.length > CONTROL_RECORDING_LIMIT) this.controlRecording.shift();
      }
      vehicle.substepIntegrate({ dt, physics: this.physics });
    }
  }

  clearControlRecording() {
    this.controlRecording.length = 0;
  }

  exportControlRecording() {
    return {
      version: 1,
      fixedStep: this.physics?.stepDt ?? null,
      samples: this.controlRecording.map(({ tick, controls }) => ({ tick, controls: { ...controls } })),
    };
  }

  // After the frame's steps: move the visual groups to the pose interpolated
  // between the last two physics states, and re-seat the rider so the character
  // (and the camera behind it) tracks the interpolated car, not the raw body.
  syncVisualPoses(alpha, character = null) {
    for (const vehicle of this.simulatedVehicles) {
      vehicle.syncVisualFromBody(this.physics, alpha);
    }
    if (character && this.activeVehicle && character.vehicle?.active) {
      this._lockRiderToSeat(character);
    }
  }

  _recoverActiveVehicle(level) {
    const vehicle = this.activeVehicle;
    if (!vehicle?.group || !level?.getGroundHeightAt) return false;

    const origin = vehicle.group.position;
    let rotationY = vehicle.spawnRotationY;
    let placedOnRoad = false;

    const road = level.findNearestRoadPoint?.(origin.x, origin.z, {
      maxDistance: RECOVERY_ROAD_SEARCH_MAX,
    });
    if (road) {
      _recoveryPosition.set(road.x, 0, road.z);
      rotationY = road.rotationY;
      placedOnRoad = true;
    } else {
      let bestScore = Infinity;
      let found = false;
      for (const radius of RECOVERY_RADII) {
        const samples = radius === 0 ? 1 : RECOVERY_DIRECTIONS;
        for (let index = 0; index < samples; index += 1) {
          const angle = (index / samples) * Math.PI * 2;
          _recoveryPosition.set(
            origin.x + Math.cos(angle) * radius,
            origin.y,
            origin.z + Math.sin(angle) * radius,
          );
          const ground = level.getGroundHeightAt(_recoveryPosition, 0);
          if (!Number.isFinite(ground)) continue;
          const onRoad = level.getRoadSurfaceAt?.(_recoveryPosition.x, _recoveryPosition.z) != null;
          const dist = Math.hypot(_recoveryPosition.x - origin.x, _recoveryPosition.z - origin.z);
          const score = dist + (onRoad ? 0 : 1000);
          if (score < bestScore) {
            bestScore = score;
            _recoveryBest.copy(_recoveryPosition);
            found = true;
            placedOnRoad = onRoad;
          }
        }
        if (found && placedOnRoad) break;
      }
      if (!found) return false;
      if (placedOnRoad) {
        _recoveryPosition.copy(_recoveryBest);
      } else {
        _recoveryPosition.copy(origin);
      }
    }

    const ground = level.getGroundHeightAt(_recoveryPosition, 0, { preferRoadSurface: true });
    if (!Number.isFinite(ground)) return false;
    _recoveryPosition.y = ground + vehicle.getGroundSpawnClearance() + RECOVERY_CLEARANCE;

    level.ensureGroundCollider?.(_recoveryPosition, this.physics, { radiusChunks: 1 });

    if (!placedOnRoad) {
      _recoveryForward.set(0, 0, -1).applyQuaternion(vehicle.group.quaternion);
      _recoveryForward.y = 0;
      if (_recoveryForward.lengthSq() > 0.0001) {
        rotationY = Math.atan2(-_recoveryForward.x, -_recoveryForward.z);
      }
    }

    this.vehicleDamageSystem?.repair?.(vehicle);

    return vehicle.recover({
      position: _recoveryPosition,
      rotationY,
      physics: this.physics,
    });
  }

  // ---- enter / exit --------------------------------------------------------

  /** Place the character in a vehicle (optionally with engine audio primed). */
  async enterVehicle(character, vehicle, { warmup = false } = {}) {
    if (!character || !vehicle || vehicle.status !== 'ready' || vehicle.hasDriver()) {
      return false;
    }
    if (warmup) {
      await vehicle._ensureEngineAudio?.();
    }
    this._enter({ character, vehicle });
    return true;
  }

  _canEnter(character) {
    return (
      character.grounded !== false &&
      !character.mount?.active &&
      !character.hang?.active &&
      !character.wallRun?.active &&
      !character.wallClimb?.active &&
      !character.rope?.active &&
      !character.hookSwing?.active &&
      !character.vault?.active &&
      !character.wingsuit?.active
    );
  }

  _nearestEnterable(position) {
    let best = null;
    let bestDist = ENTER_DISTANCE;
    for (const vehicle of this.vehicles) {
      if (vehicle.status !== 'ready' || vehicle.hasDriver()) {
        continue;
      }
      const dist = vehicle.distanceTo(position);
      if (dist <= bestDist) {
        bestDist = dist;
        best = vehicle;
      }
    }
    return best;
  }

  _enter({ character, vehicle }) {
    const seatIndex = vehicle.driverSeatIndex;
    vehicle.wakeForDrive(this.physics);
    vehicle.seatOccupant(seatIndex, character);
    this.activeVehicle = vehicle;
    this._seatSwap = null;
    this._roofStability = 0;
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.vehicle = {
      active: true,
      vehicle,
      seatIndex,
      roofSurfing: false,
      // Reuse the horse's seated riding loop as the driving pose; arm IK pins the
      // hands to the steering wheel. Swap for a dedicated driving clip later.
      animationState: vehicle.driverAnimationState ?? 'ridingHorse',
      // Hips-to-group-origin offset so the rider is hip-anchored in the seat
      // (matches the horse saddle). Computed from the current pose at entry.
      anchorOffset: getRiderHipAnchorOffset(character),
      // Steering-wheel hand targets, refreshed every frame in _lockRiderToSeat.
      handTargets: {
        center: new THREE.Vector3(),
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
        tangent: new THREE.Vector3(),
        normal: new THREE.Vector3(),
      },
      footTargets: vehicle.config.seats[seatIndex]?.footGrip ? {
          left: new THREE.Vector3(),
          right: new THREE.Vector3(),
          tangent: new THREE.Vector3(),
          normal: new THREE.Vector3(),
        } : null,
    };
    vehicle.onEnter(character, seatIndex);
    this._lockRiderToSeat(character);

    // Wake up engine audio (AudioContext requires user gesture)
    if (vehicle.engineAudio) {
      vehicle.engineAudio.resume();
      vehicle.engineAudio.mute(false);
      // Give a little initial rev on entry for feedback (muscle car feel)
      if (vehicle.engineRpm) vehicle.engineRpm = Math.max(vehicle.engineRpm, 1650);
    }
    this.level?.wakeForestAmbience?.();
    vehicle.tireEffects?.resume();
    vehicle.tireEffects?.mute(false);
    vehicle.crashAudio?.resume();
    // AnimationStateSystem drives the seated state from next frame; play it now
    // so there's no one-frame gap to idle.
    character.animationController?.play?.(vehicle.driverAnimationState ?? 'ridingHorse', 0.12);
    if (vehicle.doorRig) vehicle.doorOpenTarget = 1;
  }

  _exit({ character, level }) {
    const vehicle = this.activeVehicle;
    if (!vehicle) {
      return;
    }
    this._restoreCameraAfterRoof();
    this._seatSwap = null;
    this._roofStability = 0;
    if (vehicle.doorRig) vehicle.doorOpenTarget = 0;
    const seatIndex = vehicle.clearOccupant(character);
    vehicle.getExitWorldPosition(_exitPos, level);
    character.group.position.copy(_exitPos);
    character.group.rotation.set(0, vehicle.group?.rotation.y ?? 0, 0);
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.vehicle = null;
    vehicle.onExit(character, seatIndex);
    this.activeVehicle = null;
    if (vehicle.domain === VEHICLE_DOMAINS.GROUND) {
      vehicle.park(this.physics);
    }
    character.animationController?.play?.('idle', 0.12);

    // Mute engine audio when leaving the vehicle
    if (vehicle.engineAudio) {
      vehicle.engineAudio.mute(true);
    }
    vehicle.tireEffects?.mute(true);
  }

  /**
   * Leave the vehicle mid-roof-surf for a car leap without side-exit park.
   * Car keeps its current velocity (coast); rider is freed for ballistic leap.
   */
  detachRiderForLeap(character) {
    const vehicle = this.activeVehicle;
    if (!vehicle || !character?.vehicle?.active) return false;
    this._releaseVehicleKeepCoast(character, vehicle);
    return true;
  }

  /**
   * M4 hijack: transfer player ownership from free platform / current vehicle
   * onto `newVehicle` (default: into the cabin driver seat).
   *
   * @param {object} character
   * @param {import('../vehicles/BaseVehicle.js').BaseVehicle} newVehicle
   * @param {{ fromSeat?: string, toSeat?: string, animate?: boolean }} [opts]
   */
  transferPlayerTo(character, newVehicle, {
    fromSeat = 'roof',
    toSeat = 'driver',
    animate = true,
  } = {}) {
    if (!character || !newVehicle || newVehicle.status !== 'ready') return false;
    if (newVehicle.hasDriver() && this.activeVehicle !== newVehicle) return false;

    const oldVehicle = this.activeVehicle;

    // Free the rider from old vehicle / platform seat-lock.
    if (oldVehicle && character.vehicle?.active) {
      this._releaseVehicleKeepCoast(character, oldVehicle);
    } else {
      character.vehicle = null;
      character.platformSupport = null;
    }

    // Mount new vehicle in cabin driver (or requested seat).
    this._enter({ character, vehicle: newVehicle });

    let seatIndex = newVehicle.driverSeatIndex;
    if (toSeat === 'roof' && newVehicle.roofSeatIndex >= 0) {
      seatIndex = newVehicle.roofSeatIndex;
    } else if (toSeat && toSeat !== 'driver') {
      const named = newVehicle.findSeatIndex?.(toSeat) ?? -1;
      if (named >= 0) seatIndex = named;
    }

    if (seatIndex !== character.vehicle.seatIndex) {
      this.swapSeat(character, seatIndex, { animate });
    }

    // Ensure audio / tires live on the new ride.
    if (newVehicle.engineAudio) {
      newVehicle.engineAudio.resume?.();
      newVehicle.engineAudio.mute?.(false);
    }
    newVehicle.tireEffects?.resume?.();
    newVehicle.tireEffects?.mute?.(false);

    void fromSeat;
    return true;
  }

  /**
   * Candidate for hijack: free on a hijackable vehicle roof platform.
   * @param {object} character
   * @param {object|null} platforms PlatformRidingSystem
   * @returns {import('../vehicles/BaseVehicle.js').BaseVehicle|null}
   */
  getHijackCandidate(character, platforms = null) {
    if (!character || character.vehicle?.active) return null;
    if (character.carLeap?.active) return null;
    const support = character.platformSupport;
    if (!support || !Number.isFinite(support.bodyHandle)) return null;

    const entry = platforms?.platforms?.get?.(support.bodyHandle);
    if (!entry || entry.hijackable !== true) return null;

    const vehicle = entry.owner;
    if (!vehicle || vehicle.status !== 'ready') return null;
    if (vehicle === this.activeVehicle) return null;
    if (vehicle.hasDriver?.()) return null;
    // Must be a real BaseVehicle-ish registry member (or at least have seats).
    if (!vehicle.config?.seats || !Number.isFinite(vehicle.bodyHandle)) return null;
    return vehicle;
  }

  /**
   * Try hijack on ability/F when standing on a hijackable roof.
   * @returns {{ input: object, hijacked: boolean, vehicle: object|null }}
   */
  tryHijack({ character, input, platforms = null, trafficSystem = null }) {
    if (!input?.abilityPressed || !character) {
      return { input, hijacked: false, vehicle: null };
    }
    const candidate = this.getHijackCandidate(character, platforms);
    if (!candidate) {
      return { input, hijacked: false, vehicle: null };
    }

    // O6: transfer first; only claim pool ownership after a successful seat swap.
    const ok = this.transferPlayerTo(character, candidate, {
      fromSeat: 'roof',
      toSeat: 'driver',
      animate: true,
    });
    if (!ok) {
      return { input, hijacked: false, vehicle: null };
    }
    // claimVehicleForPlayer also clears highwayCruise so cabin input takes over.
    trafficSystem?.claimVehicleForPlayer?.(candidate);
    if (candidate.highwayCruise) candidate.highwayCruise = null;

    // Consume ability so AbilitySystem does not also fire swing/wingsuit.
    const nextInput = { ...input, abilityPressed: false, abilityHeld: false };
    return { input: nextInput, hijacked: true, vehicle: candidate };
  }

  /**
   * Drop active vehicle ownership without side-exit teleport; leave residual velocity.
   */
  _releaseVehicleKeepCoast(character, vehicle) {
    this._restoreCameraAfterRoof();
    this._seatSwap = null;
    this._roofStability = 0;
    if (vehicle.doorRig) vehicle.doorOpenTarget = 0;
    vehicle.clearOccupant(character);
    character.vehicle = null;
    if (this.activeVehicle === vehicle) this.activeVehicle = null;
    // Coast: do not park. Light residual damping happens via normal parked idle later.
    if (vehicle.engineAudio) vehicle.engineAudio.mute?.(true);
    vehicle.tireEffects?.mute?.(true);
    // Seat-lock wrote a full chassis quaternion; clear pitch/roll so FP body is upright.
    if (character?.group) {
      const e = new THREE.Euler().setFromQuaternion(
        vehicle.group?.quaternion ?? character.group.quaternion,
        'YXZ',
      );
      // Body facing convention: travel −Z at chassis yaw 0 → body yaw π.
      const bodyYaw = e.y + Math.PI;
      character.group.rotation.order = 'YXZ';
      character.group.rotation.set(0, bodyYaw, 0);
      character.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), bodyYaw);
      character.yaw = bodyYaw;
    }
  }

  /**
   * Toggle cabin driver seat ↔ roof stunt position (H key).
   * Seat swap only — does not dismount.
   */
  _toggleRoofSurf(character) {
    const vehicle = this.activeVehicle;
    if (!vehicle || !character?.vehicle?.active) return false;
    const roofIndex = vehicle.roofSeatIndex;
    if (roofIndex < 0) return false;
    const driverIndex = vehicle.driverSeatIndex;
    const current = character.vehicle.seatIndex ?? driverIndex;
    const onRoof = vehicle.config.seats[current]?.name === 'roof';
    const target = onRoof ? driverIndex : roofIndex;
    return this.swapSeat(character, target, { animate: true });
  }

  /**
   * Move the player between seats on the active vehicle.
   * @param {object} character
   * @param {number} seatIndex
   * @param {{ animate?: boolean }} [opts]
   */
  swapSeat(character, seatIndex, { animate = true } = {}) {
    const vehicle = this.activeVehicle;
    if (!vehicle || !character?.vehicle?.active) return false;
    if (seatIndex < 0 || seatIndex >= vehicle.config.seats.length) return false;
    const fromIndex = character.vehicle.seatIndex ?? vehicle.driverSeatIndex;
    if (fromIndex === seatIndex) return true;

    vehicle.clearOccupant(character);
    vehicle.seatOccupant(seatIndex, character);
    character.vehicle.seatIndex = seatIndex;
    const seat = vehicle.config.seats[seatIndex];
    const onRoof = seat?.name === 'roof';
    character.vehicle.roofSurfing = onRoof;
    character.vehicle.animationState = onRoof
      ? 'idle'
      : (vehicle.driverAnimationState ?? 'ridingHorse');
    character.vehicle.handTargets = seat?.handGrip
      ? {
          center: new THREE.Vector3(),
          left: new THREE.Vector3(),
          right: new THREE.Vector3(),
          tangent: new THREE.Vector3(),
          normal: new THREE.Vector3(),
        }
      : null;
    character.vehicle.footTargets = seat?.footGrip
      ? {
          left: new THREE.Vector3(),
          right: new THREE.Vector3(),
          tangent: new THREE.Vector3(),
          normal: new THREE.Vector3(),
        }
      : null;
    // Recompute hip anchor for standing vs seated.
    character.vehicle.anchorOffset = getRiderHipAnchorOffset(character);

    if (animate) {
      this._seatSwap = {
        fromIndex,
        toIndex: seatIndex,
        elapsed: 0,
        duration: ROOF_SWAP_DURATION,
      };
    } else {
      this._seatSwap = null;
      this._lockRiderToSeat(character);
    }

    character.animationController?.play?.(character.vehicle.animationState, 0.18);
    this._applyRoofCamera(onRoof);
    if (!onRoof) this._roofStability = 0;
    return true;
  }

  _updateSeatSwap(character, delta) {
    if (!this._seatSwap || !character?.vehicle) return;
    const swap = this._seatSwap;
    swap.elapsed += delta;
    const t = Math.min(1, swap.elapsed / Math.max(1e-4, swap.duration));
    // Smoothstep blend between seat world poses.
    const a = t * t * (3 - 2 * t);
    const vehicle = this.activeVehicle;
    if (!vehicle) {
      this._seatSwap = null;
      return;
    }
    const fromPos = new THREE.Vector3();
    const toPos = new THREE.Vector3();
    const fromQuat = new THREE.Quaternion();
    const toQuat = new THREE.Quaternion();
    vehicle.getSeatWorldTransform(swap.fromIndex, fromPos, fromQuat);
    vehicle.getSeatWorldTransform(swap.toIndex, toPos, toQuat);
    _seatPos.lerpVectors(fromPos, toPos, a);
    _seatQuat.slerpQuaternions(fromQuat, toQuat, a);
    if (character.vehicle.anchorOffset) {
      _anchorOffset.copy(character.vehicle.anchorOffset).applyQuaternion(_seatQuat);
      character.group.position.copy(_seatPos).sub(_anchorOffset);
    } else {
      character.group.position.copy(_seatPos);
    }
    character.group.quaternion.copy(_seatQuat);
    if (t >= 1) {
      this._seatSwap = null;
      character.vehicle.seatIndex = swap.toIndex;
      this._lockRiderToSeat(character);
    }
  }

  /**
   * Roof-surf stability: hard steer/brake or body tip builds stress and dumps
   * the player back to the seat (or ejects on extreme load).
   */
  _updateRoofStability(character, delta, controls, level) {
    if (!character?.vehicle?.roofSurfing || this._seatSwap) return;
    const vehicle = this.activeVehicle;
    if (!vehicle) return;

    const speed = vehicle.speed ?? 0;
    let load = 0;
    if (speed >= ROOF_STABILITY_MIN_SPEED) {
      if (Math.abs(controls?.steer ?? 0) >= ROOF_STABILITY_HARD_STEER) load += 1;
      if ((controls?.brake ?? 0) >= ROOF_STABILITY_HARD_BRAKE) load += 0.85;
      if (controls?.handbrake) load += 0.5;
    }
    const body = this.physics?.getFreshBody?.(vehicle.bodyHandle);
    if (body) {
      try {
        const av = body.angvel();
        const tip = Math.hypot(av.x, av.z);
        if (tip > 1.1) load += Math.min(1.2, tip * 0.55);
      } catch { /* ignore */ }
    }
    if ((vehicle.pendingDamageImpacts?.length ?? 0) > 0) load += 1.2;

    if (load > 0.05) {
      this._roofStability += load * ROOF_STABILITY_BUILD * delta;
    } else {
      this._roofStability = Math.max(0, this._roofStability - ROOF_STABILITY_RECOVER * delta);
    }

    if (this._roofStability >= ROOF_STABILITY_EJECT && load >= 1.5) {
      // Extreme: throw off the side onto the road.
      this._exit({ character, level: level ?? this.level });
      character.pendingImpulse = character.pendingImpulse ?? new THREE.Vector3();
      const yaw = vehicle.group?.rotation.y ?? 0;
      character.pendingImpulse.x += Math.cos(yaw) * 6;
      character.pendingImpulse.z += Math.sin(yaw) * 6;
      character.verticalVelocity = Math.max(character.verticalVelocity, 3);
      this._roofStability = 0;
      return;
    }
    if (this._roofStability >= ROOF_STABILITY_THROW) {
      // Mild failure: drop back into the cabin seat.
      this.swapSeat(character, vehicle.driverSeatIndex, { animate: true });
      this._roofStability = 0;
    }
  }

  _applyRoofCamera(onRoof) {
    const cam = this.cameraSystem;
    if (!cam?.setVehicleCameraMode) return;
    if (onRoof) {
      if (this._cameraModeBeforeRoof == null) {
        this._cameraModeBeforeRoof = cam.vehicleCameraMode ?? 'close';
      }
      cam.setVehicleCameraMode('roof');
    } else {
      this._restoreCameraAfterRoof();
    }
  }

  _restoreCameraAfterRoof() {
    const cam = this.cameraSystem;
    if (!cam?.setVehicleCameraMode) {
      this._cameraModeBeforeRoof = null;
      return;
    }
    if (cam.vehicleCameraMode === 'roof') {
      const restore = this._cameraModeBeforeRoof ?? 'close';
      // Prefer a chase mode; firstPerson is awkward right after roof-surf.
      cam.setVehicleCameraMode(restore === 'roof' ? 'close' : restore);
    }
    this._cameraModeBeforeRoof = null;
  }

  _lockRiderToSeat(character) {
    const vehicle = this.activeVehicle;
    const state = character.vehicle;
    if (!vehicle || !state) {
      return;
    }
    // Mid seat-swap owns the pose.
    if (this._seatSwap) return;

    if (vehicle.getSeatWorldTransform(state.seatIndex, _seatPos, _seatQuat)) {
      // Hip-anchor: place the group so the rider's hips (not the group origin)
      // land on the seat, the same way the horse saddle does.
      if (state.anchorOffset) {
        _anchorOffset.copy(state.anchorOffset).applyQuaternion(_seatQuat);
        character.group.position.copy(_seatPos).sub(_anchorOffset);
      } else {
        character.group.position.copy(_seatPos);
      }
      character.group.quaternion.copy(_seatQuat);
    }
    // Refresh steering-wheel hand targets for arm IK (no-op for seats w/o a grip).
    if (state.handTargets) {
      vehicle.getSeatHandTargets?.(state.seatIndex, state.handTargets);
    }
    if (state.footTargets) {
      vehicle.getSeatFootTargets?.(state.seatIndex, state.footTargets);
    }
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
  }

  // ---- control routing -----------------------------------------------------

  _controlsFromInput(vehicle, input, { roofSurfing = false } = {}) {
    const c = makeNeutralControls();
    const throttle = clamp(-input.moveZ, -1, 1); // W (forward) => moveZ = -1
    const steer = applyVehicleSteer(clamp(input.moveX, -1, 1)); // D (right) => +1

    switch (vehicle.domain) {
      case VEHICLE_DOMAINS.AIR:
        c.throttle = input.brace ? 1 : 0; // Shift = throttle up; cruise otherwise
        c.pitch = throttle; // W nose-down, S nose-up
        c.roll = steer; // A/D bank
        c.yaw = 0;
        c.boost = input.brace === true;
        break;
      case VEHICLE_DOMAINS.WATER:
        c.throttle = throttle;
        c.steer = steer;
        c.boost = input.brace === true;
        break;
      case VEHICLE_DOMAINS.GROUND:
      default:
        c.throttle = throttle;
        c.steer = steer;
        // Space = brake in cabin; on roof-surf Space is car-leap (hold/release).
        c.brake = (!roofSurfing && input.jump) ? 1 : 0;
        c.handbrake = input.brace === true; // Shift = handbrake / drift entry
        break;
    }
    return c;
  }

  // ---- debug ---------------------------------------------------------------

  snapshot(character = null, platforms = null) {
    const hijack = character
      ? this.getHijackCandidate(character, platforms)
      : null;
    return {
      status: this.status,
      count: this.vehicles.length,
      activeId: this.activeVehicle?.id ?? null,
      roofSurfing: Boolean(this.activeVehicle && this._isRoofSeatActive()),
      roofStability: this._roofStability,
      seatSwapActive: Boolean(this._seatSwap),
      hijackPrompt: Boolean(hijack),
      hijackVehicleId: hijack?.id ?? null,
      headlightsEnabled: this.headlightsEnabled,
      headlightCount: this.vehicles.reduce((count, vehicle) => count + (vehicle.headlights?.length ?? 0), 0),
      recordedControlTicks: this.controlRecording.length,
      vehicleCounts: this.activityCounts(),
      vehicles: this.vehicles.map((v) => v.snapshot()),
    };
  }

  /**
   * Compact activity summary for highway benchmarks (no full per-vehicle dump).
   */
  activityCounts() {
    let active = 0;
    let sleeping = 0;
    let dormantPool = 0;
    let occupied = 0;
    for (const v of this.vehicles) {
      const a = v.activity ?? VEHICLE_ACTIVITY_ACTIVE;
      if (a === VEHICLE_ACTIVITY_DORMANT) dormantPool += 1;
      else if (a === VEHICLE_ACTIVITY_SLEEPING) sleeping += 1;
      else active += 1;
      if (v.hasDriver?.()) occupied += 1;
    }
    return {
      total: this.vehicles.length,
      simulated: this.simulatedVehicles.length,
      active,
      sleeping,
      dormantPool,
      occupied,
      protectedActive: this.activeVehicle ? 1 : 0,
    };
  }

  _isRoofSeatActive() {
    const v = this.activeVehicle;
    if (!v) return false;
    // Occupant on a seat named roof.
    const roofIndex = v.roofSeatIndex;
    if (roofIndex < 0) return false;
    return v.occupants[roofIndex] != null;
  }

  dispose() {
    for (const vehicle of this.vehicles) {
      vehicle.dispose({ scene: this.scene, physics: this.physics });
    }
    this.vehicles = [];
    this.simulatedVehicles = [];
    this.activeVehicle = null;
    this.physics = null;
    this.scene = null;
    this.level = null;
    this.cameraSystem = null;
    this._seatSwap = null;
    this._roofStability = 0;
    this.controlRecording = [];
    this.status = 'idle';
  }
}

const _headlightPos = new THREE.Vector3();
const _headlightTarget = new THREE.Vector3();
const _headlightForward = new THREE.Vector3();

function resolveHeadlightPlacements(vehicle) {
  const lenses = (vehicle.headlightLensMeshes ?? []).filter((mesh) => mesh.visible !== false);
  if (!lenses.length) return null;

  const anchors = lenses.map((mesh) => {
    mesh.getWorldPosition(_headlightPos);
    vehicle.group.worldToLocal(_headlightPos);
    return _headlightPos.clone();
  });
  anchors.sort((a, b) => a.x - b.x);
  if (anchors.length === 1) return [anchors[0], anchors[0]];
  return [anchors[0], anchors[anchors.length - 1]];
}

function resolveHeadlightTarget(vehicle, lensMesh, localPosition) {
  if (lensMesh) {
    lensMesh.getWorldPosition(_headlightPos);
    lensMesh.getWorldDirection(_headlightForward);
    _headlightTarget.copy(_headlightPos).addScaledVector(_headlightForward, HEADLIGHT_TARGET_FORWARD);
    _headlightTarget.y -= HEADLIGHT_TARGET_DROP * 0.15;
    vehicle.group.worldToLocal(_headlightTarget);
    return _headlightTarget.clone();
  }
  return new THREE.Vector3(
    localPosition.x,
    localPosition.y - HEADLIGHT_TARGET_DROP,
    localPosition.z - HEADLIGHT_TARGET_FORWARD,
  );
}

function installHeadlights(vehicle, enabled) {
  if (!vehicle?.group || vehicle.headlightRig || vehicle.domain !== VEHICLE_DOMAINS.GROUND) return;

  const [width, height, length] = vehicle.config.body.size;
  const rig = new THREE.Group();
  rig.name = 'Xenon headlight rig';
  rig.visible = Boolean(enabled);
  vehicle.headlights = [];

  const authoredPlacements = resolveHeadlightPlacements(vehicle);
  const authoredLenses = (vehicle.headlightLensMeshes ?? []).filter((mesh) => mesh.visible !== false);
  const lensGeometry = new THREE.CylinderGeometry(0.095, 0.095, 0.035, 20);
  lensGeometry.rotateX(Math.PI / 2);
  const lensMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8f2ff,
    emissive: HEADLIGHT_COLOR,
    emissiveIntensity: 5,
    roughness: 0.18,
    metalness: 0.08,
  });

  for (let index = 0; index < 2; index += 1) {
    const side = index === 0 ? -1 : 1;
    const fallback = new THREE.Vector3(
      side * width * 0.43,
      Math.max(0.02, height * 0.08),
      -length * 0.52,
    );
    const position = authoredPlacements?.[index]?.clone() ?? fallback;
    const lensMesh = authoredLenses.length
      ? authoredLenses[Math.min(index, authoredLenses.length - 1)]
      : null;
    const light = new THREE.SpotLight(
      HEADLIGHT_COLOR,
      HEADLIGHT_INTENSITY,
      HEADLIGHT_DISTANCE,
      HEADLIGHT_ANGLE,
      HEADLIGHT_PENUMBRA,
      2,
    );
    light.name = side < 0 ? 'Xenon headlight left' : 'Xenon headlight right';
    light.position.copy(position);
    light.target.position.copy(resolveHeadlightTarget(vehicle, lensMesh, position));
    light.castShadow = false;

    if (!authoredLenses.length) {
      const lens = new THREE.Mesh(lensGeometry, lensMaterial);
      lens.name = `${light.name} lens`;
      lens.position.copy(light.position);
      rig.add(lens);
    }
    rig.add(light, light.target);
    vehicle.headlights.push(light);
  }

  vehicle.headlightRig = rig;
  vehicle.group.add(rig);
}

function lockedInput(input, { roofSurfing = false } = {}) {
  return {
    ...input,
    moveX: 0,
    moveZ: 0,
    // On roof-surf, keep Space (jump) for hold-to-leap; cabin strips jump (brake is applied before lock).
    jump: roofSurfing ? Boolean(input.jump) : false,
    jumpPressed: roofSurfing ? Boolean(input.jumpPressed) : false,
    jumpReleased: roofSurfing ? Boolean(input.jumpReleased) : false,
    brace: false,
    bracePressed: false,
    slide: false,
    slidePressed: false,
    lightAttackPressed: false,
    heavyAttackPressed: false,
    drawSheathePressed: false,
    shoulderThrowPressed: false,
    cutModePressed: false,
    telekinesisPressed: false,
    hookFirePressed: false,
    hookFire: false,
    hookFireDoubleTapped: false,
    hookAimHeld: false,
    wingsuitTogglePressed: false,
    abilityPressed: false,
    dodgeDirection: null,
    // Leap aliases (Space preferred; L optional).
    carLeapHeld: roofSurfing
      ? Boolean(input.jump || input.carLeapHeld)
      : Boolean(input.carLeapHeld),
    carLeapPressed: roofSurfing
      ? Boolean(input.jumpPressed || input.carLeapPressed)
      : Boolean(input.carLeapPressed),
    carLeapReleased: roofSurfing
      ? Boolean(input.jumpReleased || input.carLeapReleased)
      : Boolean(input.carLeapReleased),
    roofSurfPressed: input.roofSurfPressed === true,
  };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

const STEER_DEADZONE = 0.08;

function applyVehicleSteer(raw) {
  if (Math.abs(raw) < STEER_DEADZONE) return 0;
  const sign = Math.sign(raw);
  const t = (Math.abs(raw) - STEER_DEADZONE) / (1 - STEER_DEADZONE);
  return sign * t ** 0.85;
}

// Position of the rider's hips in group-local space. Used to hip-anchor the
// occupant so the seat offset describes where the hips sit, not where the group
// origin (feet) lands. Returns null if the rig has no hip bone.
function getRiderHipAnchorOffset(character) {
  const hips = character.group?.getObjectByName?.(HIPS_BONE);
  if (!hips) {
    return null;
  }
  character.group.updateWorldMatrix(true, true);
  hips.getWorldPosition(_anchorWorld);
  _anchorOffset.copy(_anchorWorld);
  character.group.worldToLocal(_anchorOffset);
  return _anchorOffset.clone();
}

function raycastPhysicsSurfaceY(physics, x, z) {
  const world = physics?.world;
  const RAPIER = physics?.RAPIER;
  if (!world || !RAPIER) return null;
  const fromY = 512;
  const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, fromY + 64, true);
  if (!hit) return null;
  return fromY - (hit.timeOfImpact ?? hit.toi);
}
