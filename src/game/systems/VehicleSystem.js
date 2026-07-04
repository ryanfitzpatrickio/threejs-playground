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

export class VehicleSystem {
  constructor() {
    this.vehicles = [];
    this.activeVehicle = null;
    this.physics = null;
    this.scene = null;
    this.level = null;
    this.weatherSystem = null;
    this.vehicleDamageSystem = null;
    this.status = 'idle';
    this.headlightsEnabled = false;
    this.controlRecording = [];
  }

  initialize({ physics, scene, level = null, weatherSystem = null, vehicleDamageSystem = null }) {
    this.physics = physics;
    this.scene = scene;
    this.level = level;
    this.weatherSystem = weatherSystem;
    this.vehicleDamageSystem = vehicleDamageSystem;
    this.status = 'ready';
  }

  // Register an already-spawned vehicle.
  registerVehicle(vehicle) {
    if (!this.vehicles.includes(vehicle)) {
      this.vehicles.push(vehicle);
      installHeadlights(vehicle, this.headlightsEnabled);
    }
    return vehicle;
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
      const surfaceY = Math.max(
        Number.isFinite(analytic) ? analytic : -Infinity,
        Number.isFinite(physicsY) ? physicsY : -Infinity,
      );
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
    }
    vehicle.dispose({ scene: this.scene, physics: this.physics });
  }

  // Returns { input } — possibly a locked clone while driving, or the original
  // (with the mount key consumed) when an enter/exit was handled this frame.
  update({ delta, input, character, level, camera = null }) {
    if (this.status !== 'ready' || !character) {
      return { input };
    }

    let consumedMount = false;

    // ---- enter / exit on the mount key ----
    if (input.mountPressed) {
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
      this._updateVehicleSurface(this.activeVehicle);
      const controls = this._controlsFromInput(this.activeVehicle, input);
      this.activeVehicle.update({
        dt: delta,
        controls,
        physics: this.physics,
        weatherSystem: this.weatherSystem,
        integrate: !this.physics?.fixedStepPlanning,
        camera,
      });
      this._lockRiderToSeat(character);
      outputInput = lockedInput(input);
    }

    const neutral = makeNeutralControls();
    const parked = makeParkedControls();
    for (const vehicle of this.vehicles) {
      if (vehicle === this.activeVehicle) {
        continue;
      }
      this._updateVehicleSurface(vehicle);
      const controls = vehicle.autopilot?.target
        ? vehicle.computeAutopilotControls()
        : parked;
      vehicle.update({
        dt: delta,
        controls,
        physics: this.physics,
        weatherSystem: this.weatherSystem,
        integrate: !this.physics?.fixedStepPlanning,
        camera,
      });
    }

    // Rally mud deform field: decay once per frame, then stamp fresh tyre ruts
    // from each ground vehicle's telemetry. Null (no work) in every other mode.
    const mudField = this.level?.mudField;
    if (mudField) {
      mudField.decay(delta);
      for (const vehicle of this.vehicles) {
        vehicle.stampMudRuts?.(mudField, delta);
      }
      // Follow the active car (or any ground vehicle) so the material can fade the
      // wrapping deform texture to zero beyond the footprint around it.
      const focus = this.activeVehicle?.group?.position
        ?? character?.group?.position
        ?? this.vehicles.find((v) => v.domain === VEHICLE_DOMAINS.GROUND)?.group?.position;
      if (focus) mudField.setCenter(focus.x, focus.z);
      // Re-upload the packed deform texture for the mud road material (no-op until
      // the material has lazily created it). Same texture object every frame.
      mudField.syncTexture();
    }

    if (consumedMount && outputInput.mountPressed) {
      outputInput = { ...outputInput, mountPressed: false };
    }

    this._updateExteriorIdleAudio(character);

    return { input: outputInput };
  }

  _updateVehicleSurface(vehicle) {
    if (vehicle?.domain !== VEHICLE_DOMAINS.GROUND) return;
    const position = vehicle.group?.position ?? vehicle.spawnPosition;
    const surface = position
      ? this.level?.getRoadSurfaceAt?.(position.x, position.z)
      : null;
    vehicle.setGroundSurface?.(surface ?? 'offroad');
    // Hand the vehicle the rally mud deform field (null everywhere else) so its
    // integrate step can dip the visual tyres into their ruts.
    vehicle.mudField = this.level?.mudField ?? null;
  }

  _updateExteriorIdleAudio(character) {
    const listener = character?.group?.position;
    if (!listener) return;
    const inVehicle = Boolean(this.activeVehicle);
    for (const vehicle of this.vehicles) {
      vehicle.updateExteriorIdleAudio?.(listener, { inVehicle });
    }
  }

  // ---- fixed-step hooks (wired into PhysicsSystem.stepHooks by GameRuntime) --

  // Once per fixed step, before integration: record every vehicle's current body
  // pose as the interpolation "previous" state.
  capturePrevPoses() {
    for (const vehicle of this.vehicles) {
      vehicle.capturePosePreStep(this.physics);
    }
  }

  // Before every world-step slice: re-apply each vehicle's drive/suspension
  // model so force application matches the number of steps actually taken this
  // frame (may be 0, may be several during hitch catch-up). Reuses the controls
  // smoothed by this frame's update().
  integrateStep(dt, tick = this.physics?.tickCount ?? 0) {
    for (const vehicle of this.vehicles) {
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
    for (const vehicle of this.vehicles) {
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
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.vehicle = {
      active: true,
      vehicle,
      seatIndex,
      // Reuse the horse's seated riding loop as the driving pose; arm IK pins the
      // hands to the steering wheel. Swap for a dedicated driving clip later.
      animationState: 'ridingHorse',
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
    vehicle.tireEffects?.resume();
    vehicle.tireEffects?.mute(false);
    vehicle.crashAudio?.resume();
    // AnimationStateSystem drives the seated state from next frame; play it now
    // so there's no one-frame gap to idle.
    character.animationController?.play?.('ridingHorse', 0.12);
  }

  _exit({ character, level }) {
    const vehicle = this.activeVehicle;
    if (!vehicle) {
      return;
    }
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

  _lockRiderToSeat(character) {
    const vehicle = this.activeVehicle;
    const state = character.vehicle;
    if (!vehicle || !state) {
      return;
    }
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
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
  }

  // ---- control routing -----------------------------------------------------

  _controlsFromInput(vehicle, input) {
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
        c.brake = input.jump ? 1 : 0; // Space = brake
        c.handbrake = input.brace === true; // Shift = handbrake / drift entry
        break;
    }
    return c;
  }

  // ---- debug ---------------------------------------------------------------

  snapshot() {
    return {
      status: this.status,
      count: this.vehicles.length,
      activeId: this.activeVehicle?.id ?? null,
      headlightsEnabled: this.headlightsEnabled,
      headlightCount: this.vehicles.reduce((count, vehicle) => count + (vehicle.headlights?.length ?? 0), 0),
      recordedControlTicks: this.controlRecording.length,
      vehicles: this.vehicles.map((v) => v.snapshot()),
    };
  }

  dispose() {
    for (const vehicle of this.vehicles) {
      vehicle.dispose({ scene: this.scene, physics: this.physics });
    }
    this.vehicles = [];
    this.activeVehicle = null;
    this.physics = null;
    this.scene = null;
    this.level = null;
    this.controlRecording = [];
    this.status = 'idle';
  }
}

function installHeadlights(vehicle, enabled) {
  if (!vehicle?.group || vehicle.headlightRig || vehicle.domain !== VEHICLE_DOMAINS.GROUND) return;

  const [width, height, length] = vehicle.config.body.size;
  const rig = new THREE.Group();
  rig.name = 'Xenon headlight rig';
  rig.visible = Boolean(enabled);
  vehicle.headlights = [];

  const lensGeometry = new THREE.CylinderGeometry(0.095, 0.095, 0.035, 20);
  lensGeometry.rotateX(Math.PI / 2);
  const lensMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8f2ff,
    emissive: HEADLIGHT_COLOR,
    emissiveIntensity: 5,
    roughness: 0.18,
    metalness: 0.08,
  });

  for (const side of [-1, 1]) {
    const x = side * width * 0.43;
    const y = Math.max(0.02, height * 0.08);
    const z = -length * 0.52;
    const light = new THREE.SpotLight(
      HEADLIGHT_COLOR,
      HEADLIGHT_INTENSITY,
      HEADLIGHT_DISTANCE,
      HEADLIGHT_ANGLE,
      HEADLIGHT_PENUMBRA,
      2,
    );
    light.name = side < 0 ? 'Xenon headlight left' : 'Xenon headlight right';
    light.position.set(x, y, z);
    light.target.position.set(x, y - HEADLIGHT_TARGET_DROP, z - HEADLIGHT_TARGET_FORWARD);
    light.castShadow = false;

    const lens = new THREE.Mesh(lensGeometry, lensMaterial);
    lens.name = `${light.name} lens`;
    lens.position.copy(light.position);
    rig.add(light, light.target, lens);
    vehicle.headlights.push(light);
  }

  vehicle.headlightRig = rig;
  vehicle.group.add(rig);
}

function lockedInput(input) {
  return {
    ...input,
    moveX: 0,
    moveZ: 0,
    jump: false,
    jumpPressed: false,
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
    hookAimHeld: false,
    dodgeDirection: null,
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
