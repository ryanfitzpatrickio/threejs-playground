import * as THREE from 'three';
import {
  applyLooseSurfaceTraction,
  createVehicleConfig,
  isLooseGroundSurface,
  VEHICLE_DOMAINS,
} from '../config/vehicleConfig.js';
import { prepareVehicleOverlayGeometry } from '../geometry/prepareVehicleOverlayGeometry.js';
import {
  classifyVehicleOverlayMesh,
  resolveVehicleOverlayMaterial,
  resolveChassisSurfaceMode,
  isVehicleTailLightMesh,
  updateVehicleTailLightEmissive,
  VEHICLE_OVERLAY_PART,
} from '../materials/createVehicleOverlayMaterials.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { EngineAudio } from './EngineAudio.js';
import { resolveEngineSounds } from './engineProfiles.js';
import { ExteriorIdleAudio } from './ExteriorIdleAudio.js';
import { VehicleCrashAudio } from './VehicleCrashAudio.js';
import { TireEffects } from './TireEffects.js';
import {
  computeMudGripScales,
  computeMudWheelIntensity,
  resolveMudWheelDynamics,
} from './mudWheelDynamics.js';
import { rainWetness } from '../systems/weatherUniforms.js';

// ---------------------------------------------------------------------------
// BaseVehicle
//
// One drivable vehicle instance backed by a dynamic Rapier rigid body. This is
// the robust, opinionated foundation that Car / Motorcycle / Truck / Tank /
// Aircraft / Boat subclasses extend. It is also directly instantiable (it builds
// a placeholder chassis mesh) so the base can be exercised before any concrete
// type exists.
//
// Lifecycle (driven by VehicleSystem):
//   spawn({ scene, physics })  -> build mesh + dynamic body + collider
//   update({ dt, controls, physics })  -> sync mesh from last step, then apply
//                                          domain forces for the upcoming step
//   dispose({ scene, physics })
//
// Forces are applied via addForce/addTorque (which Rapier integrates over the
// next world.step() and then clears), so update() must run before the per-frame
// step. The VehicleSystem is ordered ahead of MovementSystem to guarantee that.
//
// Extension points (override in a subclass):
//   buildMesh()                -> return a THREE.Object3D for the chassis
//   _integrateGround/Air/Water -> replace or augment a domain drive model
//   onEnter(character)/onExit  -> hook seat transitions
// ---------------------------------------------------------------------------

const FORWARD = new THREE.Vector3(0, 0, -1);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

// Module-scoped scratch to avoid per-frame allocations on the hot path.
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _wheelLocal = new THREE.Vector3();
const _wheelWorld = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _wheelVel = new THREE.Vector3();
const _r = new THREE.Vector3();
const _force = new THREE.Vector3();
const _seatPos = new THREE.Vector3();
const _seatForward = new THREE.Vector3();
const _seatRight = new THREE.Vector3();
const _seatBasis = new THREE.Matrix4();
const _seatFacingQuat = new THREE.Quaternion();
const _gripPos = new THREE.Vector3();
const _gripRight = new THREE.Vector3();
const _gripForward = new THREE.Vector3();
const _gripAxis = new THREE.Vector3();
const _spinQuat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _vibEuler = new THREE.Euler();
const _vibQuat = new THREE.Quaternion();
const _wheelGrounded = [];
const _wheelWorldPts = [];
const _damageDelta = new THREE.Vector3();
const _glassBox = new THREE.Box3();
const _glassLocal = new THREE.Vector3();
const _damageDirection = new THREE.Vector3();
const _damageLocalDirection = new THREE.Vector3();
const _damageBodyQuat = new THREE.Quaternion();

// Scratch + helper for the IK-solved wheel axle struts (orient a unit-height
// cylinder so it spans points a -> b: midpoint, length via scale.y, axis via
// the up->direction rotation).
const _frmPt = new THREE.Vector3();
const _tirePt = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
function orientStrutBetween(mesh, a, b) {
  _ikDir.subVectors(b, a);
  const len = _ikDir.length();
  if (len < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(a).addScaledVector(_ikDir, 0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(UP, _ikDir.multiplyScalar(1 / len));
}

// How fast the visual wheel travel chases its target (1/s). High enough to track
// terrain, low enough to not jitter on contact noise.
const WHEEL_SUSP_SMOOTH = 18;

// Generated ladder-frame rail height in buildMesh(); used to pivot frameHeight scaling.
const GENERATED_FRAME_RAIL_Y = 0.08;

// Exterior idle heard on foot — full volume inside inner radius, silent beyond outer.
const EXTERIOR_IDLE_FULL_DIST = 3;
const EXTERIOR_IDLE_MAX_DIST = 18;

const DEFAULT_CHASSIS_OVERLAY = Object.freeze({
  url: '/assets/models/muscle-chasis-2.glb',
  position: Object.freeze([0, -0.1, 0.05]),
  rotationDegrees: Object.freeze([0, 180, 0]),
  scale: Object.freeze([6.3, 6.3, 6.3]),
});

const DEFAULT_FRAME_PARAMETERS = Object.freeze({
  frameWidth: 2.2,
  frameLength: 6,
  frameHeight: 1,
  wheelTrack: 2.2,
  wheelbase: 3.5,
  rideHeight: 1.0,
  // Vertical lift of the generated frame, seats, rider, and chassis overlay
  // relative to the wheel anchors (m). Wheels and physics stay put.
  offsetFromTires: -0.4,
});

let nextVehicleId = 1;

function ensureWheelScratch(count) {
  while (_wheelGrounded.length < count) {
    _wheelGrounded.push(false);
    _wheelWorldPts.push(new THREE.Vector3());
  }
}

// Front axle sits at negative local Z (chassis travels toward -Z).
function wheelIsFront(anchor) {
  return anchor.z < 0;
}

function wheelReceivesDrive(anchor, layout) {
  const front = wheelIsFront(anchor);
  switch (layout ?? 'awd') {
    case 'fwd':
      return front;
    case 'rwd':
      return !front;
    default:
      return true;
  }
}

/** Speed-scaled steering authority for closed-loop yaw-rate control. */
export function computeSteerAuthority(speedFwd, cfg) {
  if (cfg.skidSteer) return 1;
  const sp = Math.abs(speedFwd);
  const taperAt = cfg.highSpeedTaperAt ?? 22;
  const taperEnd = cfg.highSpeedTaperEnd ?? 28;
  const floor = cfg.highSpeedFloor ?? 0.4;
  if (sp <= taperAt) return 1;
  const t = THREE.MathUtils.clamp((sp - taperAt) / Math.max(1, taperEnd - taperAt), 0, 1);
  return 1 + (floor - 1) * t;
}

/** Front-wheel lock tapers with speed so keyboard steering stays controllable. */
export function computeRayCastSteerAngle(speedFwd, steerInput, rayCastCfg = {}) {
  const maxAngle = rayCastCfg.maxSteerAngle ?? 0.4;
  const wheelbase = rayCastCfg.steerWheelbase ?? 3.5;
  const maxYawRate = rayCastCfg.maxSteerYawRate ?? 0.75;
  const highSpeedYawRate = Math.min(
    maxYawRate,
    rayCastCfg.highSpeedSteerYawRate ?? 0.42,
  );
  const taperAt = rayCastCfg.steerTaperAt ?? 8;
  const taperEnd = Math.max(taperAt + 0.01, rayCastCfg.steerTaperEnd ?? 35);
  const t = THREE.MathUtils.clamp(
    (Math.abs(speedFwd) - taperAt) / (taperEnd - taperAt),
    0,
    1,
  );
  const targetYawRate = THREE.MathUtils.lerp(maxYawRate, highSpeedYawRate, t);
  // Bicycle-model steering: yaw ~= speed * tan(angle) / wheelbase. Below crawl
  // speed the equation is ill-conditioned, so retain the configured parking lock.
  const speed = Math.abs(speedFwd);
  const speedAngle = speed > 1
    ? Math.atan((targetYawRate * wheelbase) / speed)
    : maxAngle;
  const steerAngle = Math.min(maxAngle, speedAngle);
  return -THREE.MathUtils.clamp(steerInput, -1, 1) * steerAngle;
}

export class BaseVehicle {
  constructor({
    id = null,
    name = null,
    domain = null,
    config = {},
    model = null,
    chassisOverlay = undefined,
    wheelVisual = null,
    frameParameters = null,
    hideEngine = false,
    position = new THREE.Vector3(),
    rotationY = 0,
    autopilot = null,
  } = {}) {
    this.id = id ?? `vehicle-${nextVehicleId++}`;
    this.config = createVehicleConfig(config);
    this.domain = domain ?? this.config.domain ?? VEHICLE_DOMAINS.GROUND;
    this.name = name ?? `${this.domain}-vehicle`;

    this.spawnPosition = position.clone();
    this.spawnRotationY = rotationY;
    this.autopilot = autopilot && typeof autopilot === 'object'
      ? {
          throttle: 1,
          steerGain: Math.PI / 3,
          arriveRadius: 1,
          ...autopilot,
          target: autopilot.target && typeof autopilot.target === 'object'
            ? { x: Number(autopilot.target.x) || 0, z: Number(autopilot.target.z) || 0 }
            : null,
        }
      : null;

    // Caller may hand in a pre-loaded model; otherwise buildMesh() makes one.
    this.providedModel = model;
    this.group = null;
    // The authored body shell is a visual-only child of the generated chassis.
    // It therefore inherits the rigid-body frame while retaining a tunable local
    // transform. Pass false to disable it or an options object to override defaults.
    this.chassisOverlayOptions = chassisOverlay === false
      ? null
      : normalizeChassisOverlayOptions(chassisOverlay);
    this.chassisOverlay = null;
    this.wheelVisualOptions = wheelVisual?.url ? { ...wheelVisual } : null;
    this.hideEngine = hideEngine === true;
    this.chassisSocket = null;
    this.tailLightMaterials = [];
    this._tailLightGlow = 0;
    this.wetnessMaterials = [];
    this._wetness = 0;

    const [configuredWidth, configuredHeight, configuredLength] = this.config.body.size;
    const configuredInset = this.config.ground?.wheelInset ?? 0;
    const hasExplicitFrameConfig = this.domain !== VEHICLE_DOMAINS.GROUND
      || config.body?.size != null
      || config.ground?.wheels != null
      || config.ground?.wheelInset != null
      || config.ground?.rayCast != null
      || config.ground?.suspension != null;
    this.frameParameterDefaults = hasExplicitFrameConfig
      ? Object.freeze({
          frameWidth: configuredWidth,
          frameLength: configuredLength,
          frameHeight: configuredHeight,
          wheelTrack: Math.max(0.1, configuredWidth - configuredInset * 2),
          wheelbase: Math.max(0.1, configuredLength - configuredInset * 2),
          rideHeight: config.rideHeight ?? config.ground?.rideHeight ?? DEFAULT_FRAME_PARAMETERS.rideHeight,
          offsetFromTires: config.offsetFromTires
            ?? config.ground?.offsetFromTires
            ?? DEFAULT_FRAME_PARAMETERS.offsetFromTires,
        })
      : DEFAULT_FRAME_PARAMETERS;
    this.frameParameters = { ...this.frameParameterDefaults };
    if (frameParameters && typeof frameParameters === 'object') {
      for (const key of Object.keys(this.frameParameters)) {
        const value = Number(frameParameters[key]);
        if (Number.isFinite(value)) this.frameParameters[key] = value;
      }
    }
    this.frameVisual = null;
    this._defaultSuspensionRestLength = this.config.ground?.rayCast?.suspensionRestLength ?? 0.3;

    // Rapier handles (we always re-fetch fresh wrappers by handle each frame to
    // dodge the "unsafe aliasing" errors seen when many dynamic bodies contact
    // kinematics — same precaution PhysicsSystem takes).
    this.bodyHandle = null;
    this.colliderHandle = null;

    // Rapier raycast vehicle controller (DynamicRayCastVehicleController), created
    // in spawn() when config.ground.useRayCastController is set. null = legacy path.
    this.vehicleController = null;

    // Resolved per-wheel local anchor points (ground domain only).
    this.wheelAnchors = [];
    this.wheelMeshes = [];
    // Per-wheel visual suspension length (anchor -> wheel-centre, metres, smoothed).
    // Driven from the suspension raycast each frame so the wheels travel up/down
    // independently relative to the chassis. null until first ground integrate.
    this.wheelSuspLen = [];
    // Populated from Rapier's vehicle controller after each update: authoritative
    // wheel rotation, contact geometry, impulses, suspension load, and slip.
    this.wheelTelemetry = [];
    // Rally mud deform field (docs/rally-mud-tread-plan.md), set per frame by
    // VehicleSystem from the level. Null in every non-rally mode / mud-less map,
    // so the mud stamp + visual-sink paths are inert. See setGroundSurface.
    this.mudField = null;
    // Level-owned sampler used at wheel contact points. The chassis-level
    // groundSurface remains the pre-telemetry/fallback classification.
    this.groundSurfaceSampler = null;
    this.wheelSpinAngle = 0;
    this.steerWheelMesh = null;
    // Current steering-wheel spin angle (rad). Shared by the wheel mesh and the
    // hand IK targets so the hands ride the rim as it turns.
    this.steerWheelAngle = 0;

    // For engine/chassis vibration visuals (set in buildMesh for ground vehicles).
    this.engineGroup = null;
    this.pistonMeshes = [];
    this._vibrationTime = 0;

    // Engine audio simulation (RPM + layered sounds)
    this.engineAudio = null;
    this.exteriorIdleAudio = null;
    this.crashAudio = null;
    this.tireEffects = null;
    this.glassMeshes = [];
    this._windshieldShattered = false;
    this.engineRpm = 920; // current simulated RPM
    this._engineIdle = 920;
    this._engineRedline = 7800;

    // Simple automatic transmission for audio feel (multiple gears = RPM drops on shifts)
    this.currentGear = 1;
    this.maxGear = 5;
    this.gearRatios = [0, 3.82, 2.32, 1.52, 1.12, 0.86]; // realistic-ish for muscle car
    this.finalDriveRatio = 3.6;
    this._shiftCooldown = 0;

    // Pooled suspension ray (lazily created) to avoid per-frame allocations.
    this._ray = null;

    // Smoothed control state (raw targets are smoothed toward in update()).
    this.controls = makeNeutralControls();
    this._smoothed = makeNeutralControls();

    // Occupants by seat index.
    this.occupants = new Array(this.config.seats.length).fill(null);

    // Last-known telemetry for snapshot()/debug.
    this.grounded = false;
    this.groundedFraction = 0;
    // Asphalt preserves historical behavior for isolated/headless vehicles that
    // have no LevelSystem. VehicleSystem replaces this on the first live frame.
    this.groundSurface = 'asphalt';
    const asphaltSurface = this.config.ground?.surfaces?.asphalt ?? {};
    this.surfaceTuning = {
      frictionSlip: asphaltSurface.frictionSlip ?? this.config.ground?.rayCast?.frictionSlip ?? 2,
      sideFrictionStiffness: asphaltSurface.sideFrictionStiffness ?? this.config.ground?.rayCast?.sideFrictionStiffness ?? 1,
      powerOversteerScale: asphaltSurface.powerOversteerScale ?? 1,
      handbrakeRearGripScale: asphaltSurface.handbrakeRearGripScale ?? this.config.ground?.handbrakeRearGripScale ?? 0.1,
      rollingResistanceScale: asphaltSurface.rollingResistanceScale ?? 1,
    };
    this.speed = 0;
    // World-space linear velocity, refreshed each frame from the body. Used by the
    // run-over test (which direction / how fast the chassis is travelling).
    this.linearVelocity = new THREE.Vector3();
    this._previousDamageVelocity = new THREE.Vector3();
    this._hasDamageVelocity = false;
    this._damageImpactCooldown = 0;
    this.pendingDamageImpacts = [];
    // Populated by VehicleDamageSystem. These defaults keep the drive path usable
    // in isolated/headless BaseVehicle tests that do not construct the system.
    this.damage = null;
    this.enginePowerScale = 1;
    this.maxSpeedScale = 1;
    this.damageSteerBias = 0;
    this._hasVisualPose = false;
    // Pre-step body pose for fixed-step render interpolation (capturePosePreStep
    // / syncVisualFromBody).
    this._prevStepPos = new THREE.Vector3();
    this._prevStepQuat = new THREE.Quaternion();
    this._hasPrevStepPose = false;
    this.steerTelemetry = null;
    // Owned scratch for getRunOverFrame() so it allocates nothing per frame.
    this._runOverFrame = null;
    this.status = 'created';
    this.parkedMode = true;
    this._parkedPose = null;
    // Bake the authored defaults into config before VehicleSystem asks for spawn
    // clearance and before buildMesh() derives its geometry dimensions.
    this._applyFrameParameters();
  }

  // ---- lifecycle -----------------------------------------------------------

  getGroundSpawnClearance() {
    const bodyHalfHeight = (this.config.body.size?.[1] ?? 0) * 0.5;
    if (this.domain !== VEHICLE_DOMAINS.GROUND) {
      return bodyHalfHeight;
    }
    const contactSkin = this.config.body.contactSkin ?? 0;
    // Raycast controller path: spawn so the lowest wheel bottom sits on the ground
    // at settled suspension. Visual wheels hang from the frame-bottom anchors, not
    // the baked vehicleConfig connectionHeight — using only the connection point
    // was sinking tyres ~0.2 m into the terrain.
    if (this.config.ground?.useRayCastController) {
      const rc = this.config.ground.rayCast ?? {};
      const radius = rc.wheelRadius ?? this.config.ground.wheelRadius ?? 0.38;
      const restLength = rc.suspensionRestLength ?? this._defaultSuspensionRestLength ?? 0.3;
      const settleSag = rc.settleSag ?? 0.13;
      const anchorY = -(this.frameParameterDefaults?.frameHeight ?? this.config.body.size?.[1] ?? 1) * 0.5;
      const connY = Number.isFinite(rc.connectionHeight) ? rc.connectionHeight : anchorY + restLength;
      return Math.abs(connY) + restLength + radius - settleSag + contactSkin;
    }
    // The raycast spring carries the car (the recessed wheel-collider balls hang
    // above the ground at rest), so spawn at the SETTLED ride height — the spring's
    // free length minus its weight sag — to avoid a drop-in on spawn. The model is
    // mass-normalised so sag = g / (wheelCount * stiffness) exactly (independent of
    // mass): the wheels share the load, so more wheels => less sag per wheel.
    const susp = this.config.ground?.suspension ?? {};
    const restLength = susp.restLength ?? 0;
    const stiffness = susp.stiffness ?? 0;
    const wheelCount = this.config.ground?.wheels?.length ?? 4;
    const sag = stiffness > 0 ? Math.min(restLength, 9.81 / (wheelCount * stiffness)) : 0;
    return bodyHalfHeight + (restLength - sag) + contactSkin;
  }

  recover({ position, rotationY, physics }) {
    if (this.status !== 'ready' || !this.group || !physics?.world) return false;
    const body = physics.getFreshBody(this.bodyHandle);
    if (!body) return false;

    _quat.setFromAxisAngle(UP, rotationY);
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);

    this.group.position.copy(position);
    this.group.quaternion.copy(_quat);
    this._hasVisualPose = false;
    // Never interpolate across a teleport — the next sync snaps to the body.
    this._hasPrevStepPose = false;
    this._smoothed = makeNeutralControls();
    this.linearVelocity.set(0, 0, 0);
    this._previousDamageVelocity.set(0, 0, 0);
    this._hasDamageVelocity = false;
    this._damageImpactCooldown = 0;
    this.pendingDamageImpacts.length = 0;
    this.speed = 0;
    this._restoreWindshieldGlass();
    return true;
  }

  park(physics) {
    if (this.status !== 'ready') return;
    const parked = makeParkedControls();
    this.controls = parked;
    Object.assign(this._smoothed, parked);
    this.parkedMode = true;
    const body = physics?.getFreshBody?.(this.bodyHandle);
    if (!body) return;
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);
    this._captureParkedPose(body);
    this._holdParkedPose(body);
    this._syncParkedWheelVisuals();
    if (this.group && body) this._syncMeshFromBody(body);
    this._hasPrevStepPose = false;
  }

  // Let suspension settle after spawn/exit so the car does not drop in and roll away.
  settleParked(physics) {
    if (this.status !== 'ready' || typeof physics?.world?.step !== 'function') return;
    const body = physics.getFreshBody(this.bodyHandle);
    if (!body) return;

    const parked = makeParkedControls();
    this.controls = parked;
    Object.assign(this._smoothed, parked);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.wakeUp?.();

    this.parkedMode = false;
    this._parkedPose = null;
    const world = physics.world;
    const dt = physics.stepDt ?? 1 / 60;
    const previousTimestep = world.timestep;
    world.timestep = dt;
    try {
      for (let i = 0; i < 16; i += 1) {
        this.substepIntegrate({ dt, physics });
        world.step();
      }
    } finally {
      world.timestep = previousTimestep;
    }

    this.parkedMode = true;
    this._captureParkedPose(body);
    this._holdParkedPose(body);
    this._syncParkedWheelVisuals();
    if (this.group) this._syncMeshFromBody(body);
    this._hasPrevStepPose = false;
  }

  wakeForDrive(physics) {
    this.parkedMode = false;
    this._parkedPose = null;
    physics?.getFreshBody?.(this.bodyHandle)?.wakeUp?.();
  }

  _captureParkedPose(body) {
    const t = body.translation();
    const r = body.rotation();
    this._parkedPose = {
      x: t.x,
      y: t.y,
      z: t.z,
      qx: r.x,
      qy: r.y,
      qz: r.z,
      qw: r.w,
    };
  }

  _holdParkedPose(body) {
    if (!this._parkedPose) {
      this._captureParkedPose(body);
    }
    const p = this._parkedPose;
    body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    body.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);
    this.linearVelocity.set(0, 0, 0);
    this.speed = 0;
  }

  _syncParkedWheelVisuals() {
    const rc = this.config.ground?.rayCast ?? {};
    const restLen = rc.suspensionRestLength ?? this._defaultSuspensionRestLength ?? 0.3;
    const settleSag = rc.settleSag ?? 0.13;
    const anchorY = this.wheelAnchors[0]?.y ?? -(this.frameParameterDefaults?.frameHeight ?? 1) * 0.5;
    const connY = Number.isFinite(rc.connectionHeight) ? rc.connectionHeight : anchorY + restLen;
    const settledLen = Math.max(0.05, restLen - settleSag);
    for (const wheel of this.wheelMeshes) {
      const node = wheel?.userData.suspNode;
      if (node) node.position.y = connY - settledLen;
    }
    this.groundedFraction = 1;
    this.grounded = true;
  }

  async spawn({ scene, physics }) {
    if (!physics?.world || !physics?.RAPIER) {
      throw new Error('BaseVehicle.spawn requires an initialized PhysicsSystem');
    }
    const RAPIER = physics.RAPIER;
    const world = physics.world;

    this.group = this.providedModel ?? this.buildMesh();
    if (!this.providedModel && this.domain === VEHICLE_DOMAINS.GROUND) {
      await Promise.all([
        this._attachChassisOverlay(),
        this._attachWheelVisuals(),
      ]);
    }
    this.group.name = this.group.name || `Vehicle (${this.name})`;
    this.group.position.copy(this.spawnPosition);
    this.group.quaternion.setFromAxisAngle(UP, this.spawnRotationY);
    scene?.add(this.group);
    if (this.domain === VEHICLE_DOMAINS.GROUND) {
      this.tireEffects = new TireEffects({ scene, vehicle: this });
      this.exteriorIdleAudio = new ExteriorIdleAudio();
      this.crashAudio = new VehicleCrashAudio();
    }

    const [sx, sy, sz] = this.config.body.size;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z)
      .setRotation(quatToRapier(this.group.quaternion))
      .setLinearDamping(this.config.damping.linear)
      .setAngularDamping(this.config.damping.angular)
      // CCD: the chassis is a dynamic body driving over thin static colliders
      // (bridge decks are DECK_THICK 0.6 m). At the global dt ceiling (0.05 s) and
      // 30 m/s it can translate ~1.5 m in one step — 2.5x the deck thickness —
      // and tunnel clean through, dropping the car under the road. Hard CCD adds
      // one time-of-impact substep for this body only; cheap, and the default
      // World already runs a CCD solver (maxCcdSubsteps=1).
      .setCcdEnabled(this.config.spawn.ccdEnabled !== false)
      .setCanSleep(this.config.spawn.canSleep !== false);
    const softCcd = this.config.spawn.softCcdPrediction ?? 0;
    if (softCcd > 0) {
      bodyDesc.setSoftCcdPrediction(softCcd);
    }

    const body = world.createRigidBody(bodyDesc);

    // Resolve wheel anchors before building colliders: the ground domain also
    // spawns wheel COLLIDERS from them, which must exist on the body now.
    this._resolveWheelAnchors();
    // buildMesh() establishes the generated-frame scale before wheel anchors
    // exist. Reapply now so the authored default wheelbase/track are reflected in
    // both the visual wheel nodes and the controller connection points.
    this._applyFrameParameters();

    const useRayCast = this.domain === VEHICLE_DOMAINS.GROUND && this.config.ground.useRayCastController;
    const rc = this.config.ground?.rayCast ?? {};
    // A raycast vehicle's rigid shape is only its crash/obstacle envelope. It must
    // not become a fifth ground contact: a high-speed CCD hit between its leading
    // lower edge and a heightfield/deck seam behaves exactly like an invisible
    // wall, stopping the chassis and pitching it forward. Raise and shorten the
    // envelope so its floor remains clear even at maximum suspension compression;
    // the four ray wheels own normal road contact. Non-raycast vehicles retain the
    // full body envelope because their rigid colliders are their ground contacts.
    const colliderSize = useRayCast && Array.isArray(rc.chassisColliderSize)
      ? rc.chassisColliderSize
      : [sx, sy, sz];
    const colliderOffset = useRayCast && Array.isArray(rc.chassisColliderOffset)
      ? rc.chassisColliderOffset
      : [0, 0, 0];
    const half = {
      x: Math.max(0.05, Number(colliderSize[0]) || sx) * 0.5,
      y: Math.max(0.05, Number(colliderSize[1]) || sy) * 0.5,
      z: Math.max(0.05, Number(colliderSize[2]) || sz) * 0.5,
    };
    const offset = {
      x: Number(colliderOffset[0]) || 0,
      y: Number(colliderOffset[1]) || 0,
      z: Number(colliderOffset[2]) || 0,
    };
    const edgeRadius = Math.min(0.1, half.x * 0.5, half.y * 0.5, half.z * 0.5);
    const colliderDesc = RAPIER.ColliderDesc.roundCuboid(
      half.x - edgeRadius,
      half.y - edgeRadius,
      half.z - edgeRadius,
      edgeRadius,
    )
      .setTranslation(offset.x, offset.y, offset.z)
      .setFriction(this.config.body.friction)
      .setRestitution(this.config.body.restitution);
    if (useRayCast) {
      // Collider clearance is a collision fix, not a vehicle-weight tuning change.
      // Preserve the exact mass/inertia Rapier derived from the old full-size
      // round-cuboid (its mass properties use the inner cuboid, excluding the
      // border radius). Because the crash shape is translated upward/rearward, its
      // local COM is counter-translated so this collision-only offset cannot alter
      // weight transfer or introduce a pitch lever.
      const originalHalf = { x: sx * 0.5, y: sy * 0.5, z: sz * 0.5 };
      const originalRadius = Math.min(
        0.1,
        originalHalf.x * 0.5,
        originalHalf.y * 0.5,
        originalHalf.z * 0.5,
      );
      const inner = {
        x: originalHalf.x - originalRadius,
        y: originalHalf.y - originalRadius,
        z: originalHalf.z - originalRadius,
      };
      const mass = this.config.body.massOverride
        ?? 8 * inner.x * inner.y * inner.z * this.config.body.density;
      colliderDesc.setMassProperties(
        mass,
        { x: -offset.x, y: -offset.y, z: -offset.z },
        {
          x: mass * (inner.y * inner.y + inner.z * inner.z) / 3,
          y: mass * (inner.x * inner.x + inner.z * inner.z) / 3,
          z: mass * (inner.x * inner.x + inner.y * inner.y) / 3,
        },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    } else if (this.config.body.massOverride != null) {
      colliderDesc.setMass(this.config.body.massOverride);
    } else {
      colliderDesc.setDensity(this.config.body.density);
    }
    const collider = world.createCollider(colliderDesc, body);
    collider.setContactSkin?.(this.config.body.contactSkin ?? 0.02);

    // Wheel colliders (ground domain): four spherical proxies at the wheel anchors
    // that are the car's ground contact INSTEAD of the flat chassis box. The box's
    // flat bottom catches terrain peaks and takes a normal-impulse launch (the root
    // cause of off-road bounce — verified friction-independent, so only rounding
    // the contact fixes it). A round collider glides over the same peaks without
    // launching. They are fixed to the chassis (no spinning axle), so they SLIDE,
    // not roll; their friction is therefore ~0 (see wheelFriction) so the slide is
    // drag-free, and drive comes from engineForce on the body. The raycast
    // suspension still sets ride height + absorbs bumps. The colliders overlap the
    // box (colliders on one body never collide with each other) and poke ~0.38 m
    // below it so they, not the box, touch the ground. Rays exclude the whole rigid
    // body, so they never hit the vehicle's own wheels. Spheres are intentional:
    // fixed cylinder proxies have sharp side rims that inject repeating contact
    // impulses whenever chassis pitch changes.
    if (useRayCast) {
      // Raycast vehicle controller: ray wheels + integrated suspension, no rigid
      // wheel colliders. The only collider is the chassis box (kept above ground by
      // the suspension), so the car never takes a wheel-collider normal-impulse
      // launch off terrain peaks.
      this.bodyHandle = body.handle;
      this.colliderHandle = collider.handle;
      this._setupRayCastVehicle(physics, body);
      this._initializeRayCastWheelVisuals();
      this.status = 'ready';
      return this;
    }

    if (this.domain === VEHICLE_DOMAINS.GROUND && this.config.ground.wheelColliders) {
      // Recessed hard-stop radius (smaller than the visual wheelRadius) so the balls
      // hang above the ground at the spring ride height and only catch hard
      // compressions; the spring carries the car the rest of the time.
      const wheelRadius =
        this.config.ground.wheelColliderRadius ?? this.config.ground.wheelRadius ?? 0.38;
      for (const anchor of this.wheelAnchors) {
        // Use a sphere for collision even though the visual is a tyre cylinder.
        // A fixed cylinder has sharp side rims; pitch/roll makes those rims swap
        // contact features and inject a small repeating normal impulse on flat
        // ground. A sphere stays smooth for every chassis orientation.
        const wheelDesc = RAPIER.ColliderDesc.ball(wheelRadius)
          .setTranslation(anchor.x, anchor.y, anchor.z)
          .setFriction(this.config.ground.wheelFriction ?? 0)
          .setRestitution(0)
          .setDensity(this.config.body.density);
        world.createCollider(wheelDesc, body);
      }
    }

    // Note: roll stability comes from the wheelbase, angular damping, and
    // downforce. config.body.centerOfMassOffset is reserved for a future
    // compound-collider COM lowering (a zero-mass additionalMassProperties COM
    // offset is a no-op in Rapier, so it's intentionally not applied here).

    this.bodyHandle = body.handle;
    this.colliderHandle = collider.handle;

    this.status = 'ready';

    // Preload engine audio for ground vehicles (actual init happens on first throttle)
    if (this.domain === VEHICLE_DOMAINS.GROUND) {
      this._ensureEngineAudio();
    }

    return this;
  }

  dispose({ scene, physics } = {}) {
    if (physics?.world && this.vehicleController) {
      try { physics.world.removeVehicleController(this.vehicleController); } catch { /* already gone */ }
    }
    this.vehicleController = null;
    if (physics?.world && this.bodyHandle != null) {
      const body = physics.world.bodies.get(this.bodyHandle);
      if (body) {
        physics.world.removeRigidBody(body);
      }
    }
    if (scene && this.group) {
      scene.remove(this.group);
    }
    disposeObject(this.group);
    this.group = null;
    this.chassisOverlay = null;
    this.chassisSocket = null;
    this.tailLightMaterials = [];
    this._tailLightGlow = 0;
    this.wetnessMaterials = [];

    if (this.engineAudio) {
      this.engineAudio.dispose();
      this.engineAudio = null;
    }
    this.exteriorIdleAudio?.dispose();
    this.exteriorIdleAudio = null;
    this.crashAudio?.dispose();
    this.crashAudio = null;
    this.tireEffects?.dispose();
    this.tireEffects = null;
    this._ray = null;
    this.bodyHandle = null;
    this.colliderHandle = null;
    this.status = 'disposed';
  }

  // ---- per-frame -----------------------------------------------------------

  // Called once per frame BEFORE the world step. `controls` is the raw target
  // control struct (see makeNeutralControls); it is smoothed internally.
  // `integrate:false` (fixed-step mode) skips the force model and the visual
  // pose write here: integration then happens via substepIntegrate before every
  // world step (a frame may run 0..N of them), and the group pose is set after
  // the steps by syncVisualFromBody with interpolation.
  update({ dt, controls = null, physics, weatherSystem = null, integrate = true, camera = null }) {
    if (this.status !== 'ready' || !physics?.world) {
      return;
    }
    const body = physics.getFreshBody(this.bodyHandle);
    if (!body) {
      return;
    }

    // 1. Reflect the previous step's result onto the visual mesh (1-frame lag,
    //    same as shadow follow / streamed chunks — invisible in practice).
    if (integrate) {
      this._syncMeshFromBody(body, dt);
    } else {
      this._readBodyVelocity(body);
    }
    this._detectCollisionImpact(body, dt);

    // Spin the tyres from chassis forward velocity (purely visual, negligible cost).
    this._updateWheelSpin(body, dt);

    // Fixed-step mode latches the raw target here and smooths it per physics tick.
    // This makes the tick/control stream sufficient to reproduce a drive.
    this.controls = controls ?? makeNeutralControls();
    if (integrate) this._applyControlSmoothing(this.controls, dt);

    // 2c. Subtle chassis idle vibration + stronger engine shake + piston motion on accel.
    if (!this.parkedMode) {
      this._updateEngineSimulation(dt, this._smoothed);
    }
    this._updateVibrations(dt, this._smoothed, this.speed);

    // 2b. Articulate visuals (front-wheel steer, steering-wheel spin) from the
    //     smoothed steering input. Runs before the hand IK targets are refreshed
    //     so they share the same spin angle.
    this._articulate(this._smoothed.steer);

    this._updateTailLights(dt);
    if (this.damage?.brokenLights?.front && this.headlightRig) this.headlightRig.visible = false;
    this._updateWetness(dt, weatherSystem);

    // 3. Apply the domain drive model for the upcoming step (legacy path: the
    //    caller steps the world exactly once after this). In fixed-step mode the
    //    same model runs via substepIntegrate before each planned step instead.
    if (integrate) {
      this.substepIntegrate({ dt, physics });
    }
    // Keep dust/glass particles simulating after exit (parkedMode) so rooster tails
    // drift and fade instead of freezing mid-air; emission naturally stops once
    // speed hits zero.
    if (this.domain === VEHICLE_DOMAINS.GROUND) {
      this.tireEffects?.update({
        controls: this._smoothed,
        groundedFraction: this.groundedFraction,
        physics,
        surface: this.groundSurface,
        dt,
        camera,
      });
    }
  }

  // Apply the latched controls and drive model once per fixed physics tick.
  substepIntegrate({ dt, physics }) {
    if (this.status !== 'ready' || !physics?.world) return;
    const body = physics.getFreshBody(this.bodyHandle);
    if (!body) return;
    try {
      if (this.parkedMode && this.domain === VEHICLE_DOMAINS.GROUND) {
        this._holdParkedPose(body);
        this._syncParkedWheelVisuals();
        return;
      }
      if (physics.fixedStepPlanning) this._applyControlSmoothing(this.controls, dt);
      // A parked vehicle is allowed to sleep. Rapier's raycast controller can
      // update its internal wheel/velocity state without waking that rigid body,
      // leaving first forward throttle apparently ignored until a brake/reverse
      // impulse happens to wake it. Wake before applying any deliberate control
      // so the very first W/S/steer/brake input reaches the chassis this tick.
      if (vehicleControlsRequestWake(this._smoothed) && body.isSleeping?.()) {
        body.wakeUp();
      }
      // Rapier's addForce/addTorque are PERSISTENT accumulators — they are not
      // cleared after world.step(). Without this reset, each pass's forces stack
      // on top of the last, so the chassis launches upward and (once airborne, no
      // new suspension hits) keeps the accumulated force forever and never falls
      // back. Zero the accumulators every pass; integrators re-add from scratch.
      body.resetForces(false);
      body.resetTorques(false);
      switch (this.domain) {
        case VEHICLE_DOMAINS.AIR:
          this._integrateAir(body, this._smoothed, dt, physics);
          break;
        case VEHICLE_DOMAINS.WATER:
          this._integrateWater(body, this._smoothed, dt, physics);
          break;
        case VEHICLE_DOMAINS.GROUND:
        default:
          this._integrateGround(body, this._smoothed, dt, physics);
          this._enforceGroundSpeedLimit(body);
          break;
      }
    } catch (e) {
      if (!String(e?.message || e).includes('aliasing')) throw e;
    }
  }

  _syncMeshFromBody(body) {
    const t = body.translation();
    const r = body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    this.group.position.copy(_pos);
    this.group.quaternion.copy(_quat);
    this._hasVisualPose = true;
    this._readBodyVelocity(body);
  }

  _readBodyVelocity(body) {
    const v = body.linvel();
    this.linearVelocity.set(v.x, v.y, v.z);
    this.speed = Math.hypot(v.x, v.y, v.z);
  }

  // ---- fixed-step interpolation --------------------------------------------
  // Physics advances in fixed slices while rendering happens at display refresh,
  // so the visual group renders the body blended between its last two stepped
  // poses (alpha = fraction of a step accumulated since the last one). This
  // replaces the exponential _syncMeshFromBody smoothing on the fixed-step path:
  // same hitch-teleport protection, at most one step of latency, no trailing.

  // Record the pre-step pose. Called once per fixed step, before integration.
  capturePosePreStep(physics) {
    const body = physics?.getFreshBody?.(this.bodyHandle);
    if (!body) return;
    try {
      const t = body.translation();
      const r = body.rotation();
      this._prevStepPos.set(t.x, t.y, t.z);
      this._prevStepQuat.set(r.x, r.y, r.z, r.w);
      this._hasPrevStepPose = true;
    } catch {
      // Transient aliasing; keep the previous capture.
    }
  }

  // Set the visual group to the interpolated physics pose. Called after the
  // frame's steps, before the camera reads the group.
  syncVisualFromBody(physics, alpha = 1) {
    if (this.status !== 'ready' || !this.group) return;
    const body = physics?.getFreshBody?.(this.bodyHandle);
    if (!body) return;
    try {
      const t = body.translation();
      const r = body.rotation();
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      this._readBodyVelocity(body);
    } catch {
      return;
    }
    if (this._hasPrevStepPose && alpha < 1) {
      this.group.position.lerpVectors(this._prevStepPos, _pos, alpha);
      this.group.quaternion.slerpQuaternions(this._prevStepQuat, _quat, alpha);
    } else {
      this.group.position.copy(_pos);
      this.group.quaternion.copy(_quat);
    }
    this._hasVisualPose = true;
  }

  _detectCollisionImpact(body, dt) {
    const cfg = this.config.damage;
    const current = this.linearVelocity;
    this._damageImpactCooldown = Math.max(0, this._damageImpactCooldown - Math.max(0, dt || 0));
    if (!cfg?.enabled || this.domain !== VEHICLE_DOMAINS.GROUND) {
      this._previousDamageVelocity.copy(current);
      this._hasDamageVelocity = true;
      return;
    }
    if (!this._hasDamageVelocity) {
      this._previousDamageVelocity.copy(current);
      this._hasDamageVelocity = true;
      return;
    }

    _damageDelta.copy(current).sub(this._previousDamageVelocity);
    this._previousDamageVelocity.copy(current);
    const horizontalDelta = Math.hypot(_damageDelta.x, _damageDelta.z);
    const totalDelta = _damageDelta.length();
    const upFraction = totalDelta > 0 ? Math.abs(_damageDelta.y) / totalDelta : 1;

    // Remove the largest horizontal change the drive model can intentionally make
    // in one frame. A small fixed allowance covers suspension seams and solver
    // corrections without masking a real low-speed fender-bender.
    const ground = this.config.ground ?? {};
    const controls = this._smoothed ?? {};
    const expectedAccel = Math.abs(controls.throttle ?? 0) * (ground.enginePower ?? 0)
      + Math.max(controls.brake ?? 0, controls.handbrake ? 1 : 0) * (ground.brakeForce ?? 0)
      + Math.min(2, Math.abs(ground.rollingResistance ?? 0) * Math.hypot(current.x, current.z));
    const legitimateDelta = expectedAccel * Math.min(Math.max(dt || 0, 0), 0.05) + 0.55;
    const impactDeltaV = Math.max(0, horizontalDelta - legitimateDelta);
    if (
      this._damageImpactCooldown > 0
      || impactDeltaV < (cfg.minImpactDeltaV ?? 2.8)
      || upFraction > (cfg.maxUpFraction ?? 0.6)
    ) return;

    const rotation = body.rotation();
    _damageBodyQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    _damageDirection.set(-_damageDelta.x, 0, -_damageDelta.z).normalize();
    // Rapier may resolve a deep/high-speed contact over several solver frames.
    // Once a real impulse crosses the trigger, recover the approach speed along
    // that impulse normal so a 15 m/s head-on crash is not mis-tiered from only
    // the first 4 m/s solver slice. Glancing scrapes retain their small lateral
    // delta because forward travel projects near zero onto the side normal.
    const approachSpeed = Math.abs(
      (current.x - _damageDelta.x) * _damageDirection.x
      + (current.z - _damageDelta.z) * _damageDirection.z,
    );
    const severityDeltaV = Math.max(impactDeltaV, approachSpeed);
    _damageLocalDirection.copy(_damageDirection).applyQuaternion(_damageBodyQuat.clone().invert());
    const ax = Math.abs(_damageLocalDirection.x);
    const az = Math.abs(_damageLocalDirection.z);
    const zone = az >= ax
      ? (_damageLocalDirection.z < 0 ? 'front' : 'rear')
      : (_damageLocalDirection.x < 0 ? 'left' : 'right');
    const sum = Math.max(0.0001, ax + az);
    const weights = {
      front: _damageLocalDirection.z < 0 ? az / sum : 0,
      rear: _damageLocalDirection.z > 0 ? az / sum : 0,
      left: _damageLocalDirection.x < 0 ? ax / sum : 0,
      right: _damageLocalDirection.x > 0 ? ax / sum : 0,
    };
    const [width, height, length] = this.config.body.size;
    const boundaryScale = Math.min(
      ax > 0.0001 ? width * 0.5 / ax : Infinity,
      az > 0.0001 ? length * 0.5 / az : Infinity,
    );
    const localPoint = _damageLocalDirection.clone().multiplyScalar(boundaryScale);
    localPoint.y = -height * 0.15;
    const tiers = cfg.tiers ?? {};
    const tier = severityDeltaV >= (tiers.severe ?? 14)
      ? 'severe'
      : severityDeltaV >= (tiers.crumple ?? 7)
        ? 'crumple'
        : 'fender';

    this.pendingDamageImpacts.push({
      deltaV: severityDeltaV,
      impulseDeltaV: impactDeltaV,
      rawDeltaV: horizontalDelta,
      tier,
      zone,
      weights,
      localPoint,
      localDirection: _damageLocalDirection.clone(),
    });
    this._damageImpactCooldown = cfg.cooldown ?? 0.25;
    if (tier === 'severe') {
      this._shatterWindshield({
        severity: severityDeltaV,
        localDirection: _damageLocalDirection,
      });
    }
    this.crashAudio?.playImpact({
      severity: severityDeltaV,
      tier,
      glass: tier === 'severe',
      sourcePosition: this.group?.position ?? null,
      listenerPosition: this._audioListener ?? null,
    });
  }

  _isWindshieldGlassMesh(mesh) {
    const label = `${mesh.name} ${mesh.parent?.name ?? ''}`.toLowerCase();
    return /\b(?:glass front|windshield|windscreen|front glass)\b/.test(label);
  }

  _getWindshieldBurstOrigin(out) {
    const windshieldMeshes = this.glassMeshes.filter((mesh) => this._isWindshieldGlassMesh(mesh));
    const targets = windshieldMeshes.length > 0 ? windshieldMeshes : this.glassMeshes;
    if (targets.length > 0) {
      _glassBox.makeEmpty();
      for (const mesh of targets) {
        _glassBox.expandByObject(mesh);
      }
      return out.copy(_glassBox.getCenter(out));
    }

    const [,, length] = this.config.body.size;
    _glassLocal.set(0, (this.config.body.size[1] ?? 1) * 0.42, -(length ?? 4) * 0.38);
    this.group.updateWorldMatrix(true, false);
    return out.copy(_glassLocal).applyMatrix4(this.group.matrixWorld);
  }

  _shatterWindshield({ severity, localDirection }) {
    if (this._windshieldShattered || !this.group) {
      return;
    }
    this._windshieldShattered = true;

    for (const mesh of this.glassMeshes) {
      mesh.visible = false;
    }

    const origin = this._getWindshieldBurstOrigin(_pos);
    if (localDirection?.isVector3) {
      _forward.copy(localDirection).applyQuaternion(this.group.quaternion);
    } else {
      _forward.copy(FORWARD).applyQuaternion(this.group.quaternion);
    }
    _forward.multiplyScalar(-1).setY(0);
    if (_forward.lengthSq() < 1e-6) {
      _forward.copy(FORWARD).applyQuaternion(this.group.quaternion).setY(0);
    }
    _forward.normalize();
    _right.crossVectors(UP, _forward).normalize();
    this.tireEffects?.burstWindshieldGlass?.({
      origin,
      forward: _forward,
      right: _right,
      severity,
    });
  }

  _restoreWindshieldGlass() {
    this._windshieldShattered = false;
    for (const mesh of this.glassMeshes) {
      mesh.visible = true;
    }
  }

  // Chassis frame for the vehicle-vs-enemy run-over test (all world space). Returns
  // null for non-ground vehicles or before spawn; otherwise an owned, reused object
  // with the chassis position, basis axes, velocity, horizontal speed, and footprint
  // half-extents. The group pose/velocity were synced from the body at the top of
  // update(), so this is current as of the last step.
  getRunOverFrame() {
    if (this.domain !== VEHICLE_DOMAINS.GROUND || !this.group) {
      return null;
    }
    const f = this._runOverFrame ?? (this._runOverFrame = {
      position: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
    });
    f.position.copy(this.group.position);
    f.forward.copy(FORWARD).applyQuaternion(this.group.quaternion);
    f.right.copy(RIGHT).applyQuaternion(this.group.quaternion);
    f.velocity.copy(this.linearVelocity);
    const size = this.config.body.size;
    f.halfWidth = (size?.[0] ?? 2) * 0.5;
    f.halfHeight = (size?.[1] ?? 1) * 0.5;
    f.halfLength = (size?.[2] ?? 4) * 0.5;
    f.horizSpeed = Math.hypot(this.linearVelocity.x, this.linearVelocity.z);
    return f;
  }

  _applyControlSmoothing(controls, dt) {
    const target = controls ?? makeNeutralControls();
    this.controls = target;
    const c = this.config.controls;
    const s = this._smoothed;
    s.throttle = approach(s.throttle, target.throttle, c.throttleSmoothing, dt);
    s.steer = approach(s.steer, target.steer, c.steerSmoothing, dt);
    s.pitch = approach(s.pitch, target.pitch, c.pitchSmoothing, dt);
    s.roll = approach(s.roll, target.roll, c.rollSmoothing, dt);
    s.yaw = approach(s.yaw, target.yaw, c.yawSmoothing, dt);
    // Discrete controls don't smooth.
    s.brake = target.brake;
    s.handbrake = target.handbrake;
    s.boost = target.boost;
    s.vertical = target.vertical;
  }

  // `left tail light` / `right tail light` — red when braking or reversing.
  _updateTailLights(dt) {
    if (!this.tailLightMaterials.length) return;
    if (this.damage?.brokenLights?.rear) {
      this._tailLightGlow = 0;
      for (const material of this.tailLightMaterials) updateVehicleTailLightEmissive(material, 0);
      return;
    }
    const reversing = (this._smoothed.throttle ?? 0) < -0.02 ? 1 : 0;
    const brakeTarget = Math.max(
      this._smoothed.brake ?? 0,
      this._smoothed.handbrake ? 1 : 0,
      reversing,
    );
    this._tailLightGlow = approach(this._tailLightGlow, brakeTarget, 28, dt);
    for (const material of this.tailLightMaterials) {
      updateVehicleTailLightEmissive(material, this._tailLightGlow);
    }
  }

  // Rain response: ramps each wetness-aware paint material's per-vehicle
  // `wetnessUniform` (see createVehicleOverlayMaterials.js) toward 1 while
  // it's raining, 0 otherwise. Faster than the terrain/road wetness ramp in
  // WeatherSystem.js (15s up / 45s down) since a car's paint visibly picks up
  // rain quicker than standing puddles form.
  _updateWetness(dt, weatherSystem) {
    if (!this.wetnessMaterials.length) return;
    const target = weatherSystem?.weather === 'rain' ? 1 : 0;
    const rate = target > this._wetness ? 0.3 : 0.05;
    this._wetness = approach(this._wetness, target, rate, dt);
    for (const material of this.wetnessMaterials) {
      material.wetnessUniform.value = this._wetness;
    }
  }

  // Visual articulation driven by the steering input: front wheels yaw into the
  // turn and the steering wheel spins in place. The spin angle is stored so the
  // hand IK targets can ride the rim (see getSeatHandTargets). Ground-only.
  _articulate(steerInput) {
    if (this.domain !== VEHICLE_DOMAINS.GROUND) {
      return;
    }
    const art = this.config.ground.articulation;
    if (!art) {
      return;
    }
    const vis = THREE.MathUtils.clamp(steerInput, -1, 1); // +1 = steer right (D)

    // Front wheels: right turn (vis > 0) = clockwise from above = -Y, and the
    // wheel's forward (-Z) gains a +X component, pointing the tyre right.
    const wheelSteer = -vis * art.wheelSteerAngle;
    for (const wheel of this.wheelMeshes) {
      if (wheel.userData.steerable) {
        const pivot = wheel.userData.steerPivot;
        if (pivot) {
          pivot.rotation.y = wheelSteer;
        } else {
          // fallback (shouldn't happen)
          wheel.rotation.y = wheelSteer;
        }
      }
    }

    // Steering wheel spins about its hole axis (local +Z). Right turn = clockwise
    // as the driver sees it (looking along -Z, +Z is toward the driver) = -Z spin.
    this.steerWheelAngle = -vis * art.steeringWheelTurn;
    if (this.steerWheelMesh) {
      this.steerWheelMesh.rotation.z = this.steerWheelAngle;
    }
  }

  // Per-wheel visual suspension travel. `gap` is the measured anchor->contact
  // distance (metres); the wheel centre rides `radius` above the contact, so the
  // suspension length L = gap - radius and the wheel mesh node sits L below its rest
  // mount. Smoothed to avoid contact-noise jitter, then written to the mesh (the
  // steer pivot for front wheels, the wheel itself for rears) so each wheel travels
  // independently of the chassis. Called once per wheel per ground integrate.
  _setWheelVisualGap(wi, gap, radius, dt) {
    const targetL = gap - radius;
    const prev = this.wheelSuspLen[wi];
    const L = prev == null
      ? targetL
      : prev + (targetL - prev) * (1 - Math.exp(-WHEEL_SUSP_SMOOTH * dt));
    this.wheelSuspLen[wi] = L;
    const wheel = this.wheelMeshes[wi];
    const node = wheel?.userData.suspNode;
    if (node) {
      node.position.y = (wheel.userData.restY ?? 0) - L;
    }
  }

  // Visual wheel roll (all wheels rotate together from longitudinal speed).
  // Uses actual body velocity so coasting, braking, and airborne wheels behave
  // correctly. Sign chosen so +forward speed produces realistic forward roll.
  _updateWheelSpin(body, dt) {
    if (this.domain !== VEHICLE_DOMAINS.GROUND || !this.wheelMeshes?.length) {
      return;
    }
    // The controller integrates individual wheel rotation from actual contact,
    // braking, and slip. Its values are applied after updateVehicle().
    if (this.vehicleController) return;
    const radius = this.config.ground?.wheelRadius ?? 0.38;
    if (radius < 0.001) {
      return;
    }
    const v = body.linvel();
    _linvel.set(v.x, v.y, v.z);
    // The group pose was just synced from this body; use it for the forward axis.
    _forward.copy(FORWARD).applyQuaternion(this.group.quaternion);
    const speedFwd = _linvel.dot(_forward);
    // Negative so forward motion produces the conventional wheel rotation direction.
    this.wheelSpinAngle -= (speedFwd / radius) * dt;

    const spin = this.wheelSpinAngle;
    for (const wheel of this.wheelMeshes) {
      wheel.rotation.x = spin;
    }
  }

  // Visual idle/acceleration vibrations for the whole chassis (subtle) and
  // the engine group (stronger). Also animates the 4 visible "pistons".
  // Now driven primarily by simulated engineRpm (synced with audio layers).
  _updateVibrations(dt, controls, speed) {
    if (this.domain !== VEHICLE_DOMAINS.GROUND) return;
    if (this.parkedMode) {
      if (this.engineGroup) {
        this.engineGroup.position.y = 0;
        this.engineGroup.quaternion.identity();
      }
      for (const piston of this.pistonMeshes) {
        piston.position.y = piston.userData.restY ?? 0.44;
      }
      return;
    }
    this._vibrationTime += dt;

    const throttle = Math.abs(controls?.throttle ?? 0);
    const rpm = this.engineRpm || 920;
    const rpmNorm = THREE.MathUtils.clamp((rpm - 920) / (7800 - 920), 0, 1.05);
    const damageShake = 1 + Math.max(0, 0.5 - (this.damage?.engineHealth ?? 1)) * 2.4;

    const isAccel = throttle > 0.04;
    const speedFactor = Math.min(1, (speed || 0) / 12);
    const idleFactor = (1 - speedFactor) * (1 - throttle * 0.55) + 0.18;
    // Idle shake was strong enough to read as the car bouncing on the ground — keep
    // full intensity under throttle, taper to 1/10 at rest.
    const vibScale = 0.1 + 0.9 * Math.min(1, throttle / 0.22);

    const t = this._vibrationTime;

    // --- Chassis: very subtle idle shake (body rocks a tiny bit at rest) ---
    const chassisY = (Math.sin(t * 19) * (0.0011 / 3) * idleFactor +
                     Math.sin(t * 29 + 1.2) * (0.0006 / 3) * idleFactor) * vibScale;
    this.group.position.y += chassisY;

    const cRoll = Math.sin(t * 16) * (0.0025 / 3) * idleFactor * vibScale;
    const cPitch = Math.sin(t * 23 + 0.8) * (0.0020 / 3) * idleFactor * vibScale;
    const cQuat = _vibQuat.setFromEuler(_vibEuler.set(cPitch, 0, cRoll, 'XYZ'));
    this.group.quaternion.multiply(cQuat);

    // --- Engine group: stronger vibration, driven by rpm + throttle ---
    if (this.engineGroup) {
      const engBase = (0.0028 + rpmNorm * 0.0095 + (isAccel ? throttle * 0.008 : 0) + idleFactor * 0.0025)
        * damageShake
        * vibScale;
      const engY = Math.sin(t * 47) * engBase * 1.3 +
                   Math.sin(t * 61 + 1.7) * engBase * 0.7;
      this.engineGroup.position.y = engY;

      const eRoll = Math.sin(t * 44) * engBase * 2.8;
      const ePitch = Math.sin(t * 53 + 2.3) * engBase * 2.1;
      const eQuat = _vibQuat.setFromEuler(_vibEuler.set(ePitch, 0, eRoll, 'XYZ'));
      this.engineGroup.quaternion.copy(eQuat); // local vibration only
    }

    // --- 4 exposed pistons: frequency now follows real RPM ---
    if (this.pistonMeshes.length === 4) {
      const pFreq = 13 + rpmNorm * 54; // rpm-driven "engine speed"
      const pAmp = (isAccel
        ? (0.018 + rpmNorm * 0.026 + throttle * 0.022)
        : (0.0035 + rpmNorm * 0.004)) * vibScale;
      for (const piston of this.pistonMeshes) {
        const idx = piston.userData.pistonIndex ?? 0;
        // Alternating pairs + staggered phasing for 4-cyl feel (1-3 / 2-4)
        const pairPhase = (idx % 2 === 0) ? 0 : Math.PI;
        const stagger = (idx * 0.7);
        const pOffset = Math.sin(t * pFreq + pairPhase + stagger) * pAmp;
        piston.position.y = (piston.userData.restY ?? 0.44) + pOffset;
      }
    }
  }

  // ---- Engine RPM simulation + audio ---------------------------------------

  _rpmFromSpeedAndGear(gear, speed = this.speed) {
    const g = Math.max(1, Math.min(this.maxGear, gear || 1));
    const ratio = (this.gearRatios[g] || 1) * this.finalDriveRatio;
    const wheelRadius = this.config.ground?.wheelRadius ?? 0.38;
    const absSpeed = Math.max(0, Math.abs(speed || 0));
    const wheelRps = absSpeed / wheelRadius;
    // Convert wheel rotations to engine RPM via total gear ratio
    let rpm = wheelRps * ratio * (60 / (2 * Math.PI));
    return Math.max(this._engineIdle * 0.55, rpm);
  }

  async _ensureEngineAudio() {
    if (this.engineAudio || this.domain !== VEHICLE_DOMAINS.GROUND) return;
    if (typeof window === 'undefined') return;
    try {
      this.engineAudio = new EngineAudio();
      await this.engineAudio.init(resolveEngineSounds(this.config.engineProfile));
    } catch (e) {
      console.warn('[EngineAudio] Failed to initialize:', e);
      this.engineAudio = null;
    }
  }

  updateExteriorIdleAudio(listenerPosition, { inVehicle = false } = {}) {
    if (listenerPosition) this._audioListener = listenerPosition;
    if (!this.exteriorIdleAudio || !listenerPosition) return;
    if (inVehicle || !this.group || this.status !== 'ready') {
      this.exteriorIdleAudio.update(0);
      return;
    }
    const dist = listenerPosition.distanceTo(this.group.position);
    let proximity = 1;
    if (dist > EXTERIOR_IDLE_FULL_DIST) {
      const t = (dist - EXTERIOR_IDLE_FULL_DIST)
        / (EXTERIOR_IDLE_MAX_DIST - EXTERIOR_IDLE_FULL_DIST);
      proximity = 1 - THREE.MathUtils.smoothstep(t, 0, 1);
    }
    this.exteriorIdleAudio.update(proximity);
  }

  _updateEngineSimulation(dt, controls) {
    if (this.domain !== VEHICLE_DOMAINS.GROUND) return;

    const hasDriver = this.hasDriver?.() ?? false;
    const rawThrottle = controls?.throttle ?? 0;
    const throttle = Math.abs(rawThrottle);

    // Only run full engine audio + strong sim for the player-driven car
    if (!hasDriver && throttle < 0.01) {
      this.currentGear = 1;
      this._shiftCooldown = 0;
      // Let rpm decay to idle so next time player enters it sounds natural
      if (this.engineRpm > this._engineIdle) {
        this.engineRpm = Math.max(this._engineIdle, this.engineRpm - (this.engineRpm - this._engineIdle) * 3 * dt);
      }
      return;
    }

    const speed = this.speed || 0;
    const idle = this._engineIdle;
    const redline = this._engineRedline;

    // Update shift cooldown
    this._shiftCooldown = Math.max(0, this._shiftCooldown - dt);

    // === Gear-based RPM with some engine independence (closer to the original sim) ===
    const lockedRpm = this._rpmFromSpeedAndGear(this.currentGear, speed);

    // Throttle lets the engine "pull ahead" of the wheel-locked RPM (more inertia feel)
    let target = lockedRpm;
    if (throttle > 0.04) {
      const overRev = throttle * (redline - lockedRpm) * 0.65;
      target = lockedRpm + overRev;
    } else {
      target = lockedRpm * 0.9 + idle * 0.1;
    }

    // Auto shifting
    if (this._shiftCooldown <= 0) {
      if (this.currentGear < this.maxGear &&
          this.engineRpm > 5450 &&
          throttle > 0.45 &&
          speed > 11) {
        this._changeGear(this.currentGear + 1);
      } else if (this.currentGear > 1 &&
                 this.engineRpm < 2350 &&
                 throttle < 0.25) {
        this._changeGear(this.currentGear - 1);
      }
    }

    // Reverse
    if (rawThrottle < -0.05) {
      const revRpm = this._rpmFromSpeedAndGear(1, speed);
      target = revRpm * 0.7 + idle * 0.3;
    }

    // Variable coupling: after a recent shift we let RPM stay dropped longer
    // (this is what makes "going through gears" feel dynamic in the demo)
    const postShift = Math.max(0, this._shiftCooldown);
    const coupling = postShift > 0 ? 2.5 : (7.5 + throttle * 12);

    this.engineRpm = this.engineRpm || idle;
    this.engineRpm += (target - this.engineRpm) * coupling * dt;

    // Overrun / engine braking
    if (throttle < 0.03) {
      const decay = 2.8 + (this.engineRpm - idle) * 0.0005;
      this.engineRpm -= (this.engineRpm - idle) * decay * dt;
    }

    // Clamp + jitter on power
    this.engineRpm = THREE.MathUtils.clamp(this.engineRpm, idle - 25, redline + 340);
    if (throttle > 0.06) {
      this.engineRpm += (Math.random() - 0.5) * 11;
    }
    const engineDamage = 1 - (this.damage?.engineHealth ?? 1);
    if (engineDamage > 0.5) {
      this.engineRpm += (Math.random() - 0.5) * 180 * engineDamage;
    }

    // Lazy init audio
    if (!this.engineAudio && throttle > 0.04) {
      this._ensureEngineAudio();
    }

    if (this.engineAudio) {
      this.engineAudio.resume();
      // Pass current gear so audio can react to transmission state if desired
      this.engineAudio.update(this.engineRpm, throttle, this.currentGear, dt);
    }
  }

  _changeGear(newGear) {
    const oldGear = this.currentGear;
    newGear = Math.max(1, Math.min(this.maxGear, newGear));
    if (newGear === oldGear) return;

    const oldRatio = (this.gearRatios[oldGear] || 1) * this.finalDriveRatio;
    const newRatio = (this.gearRatios[newGear] || 1) * this.finalDriveRatio;

    this.currentGear = newGear;
    this._shiftCooldown = 0.18;   // this value temporarily weakens coupling in the sim above

    // Emulate the original library's omega scaling on gear change:
    // engine speed is multiplied by the ratio change.
    // This + the reduced coupling right after shift is what makes gear changes
    // sound satisfying in the repo demo.
    if (oldRatio > 0) {
      this.engineRpm *= (newRatio / oldRatio);
    }

    // Then gently pull toward the new locked RPM (instead of hard snap)
    const newLocked = this._rpmFromSpeedAndGear(newGear);
    this.engineRpm = this.engineRpm * 0.65 + newLocked * 0.35;

    this.engineRpm = THREE.MathUtils.clamp(this.engineRpm, this._engineIdle * 0.6, this._engineRedline + 200);
  }

  // ---- Rapier raycast vehicle controller -----------------------------------

  // Build the DynamicRayCastVehicleController + four ray wheels on the chassis.
  // Chassis-local axes: up = +Y, forward = -Z (the car drives toward -Z), wheel
  // axle = X. No rigid wheel colliders are created in this path.
  _setupRayCastVehicle(physics, body) {
    const rc = this.config.ground.rayCast ?? {};
    const ctrl = physics.world.createVehicleController(body);
    ctrl.indexUpAxis = 1; // Y
    ctrl.setIndexForwardAxis = 2; // Z (sign handled via engine-force direction)
    const dir = { x: 0, y: -1, z: 0 }; // suspension casts straight down (chassis-local)
    const axle = { x: -1, y: 0, z: 0 }; // wheel spin axis
    const radius = rc.wheelRadius ?? this.config.ground.wheelRadius ?? 0.38;
    const connY = rc.connectionHeight ?? -0.1;
    for (const anchor of this.wheelAnchors) {
      const conn = { x: anchor.x, y: connY, z: anchor.z };
      ctrl.addWheel(conn, dir, axle, rc.suspensionRestLength ?? 0.3, radius);
    }
    for (let i = 0; i < ctrl.numWheels(); i += 1) {
      ctrl.setWheelSuspensionStiffness(i, rc.suspensionStiffness ?? 30);
      ctrl.setWheelSuspensionCompression(i, rc.suspensionCompression ?? 2.0);
      ctrl.setWheelSuspensionRelaxation(i, rc.suspensionRelaxation ?? 2.5);
      ctrl.setWheelMaxSuspensionTravel(i, rc.maxSuspensionTravel ?? 0.3);
      ctrl.setWheelMaxSuspensionForce(i, rc.maxSuspensionForce ?? 100000);
      ctrl.setWheelFrictionSlip(i, rc.frictionSlip ?? 2.0);
      if (ctrl.setWheelSideFrictionStiffness) {
        ctrl.setWheelSideFrictionStiffness(i, rc.sideFrictionStiffness ?? 1.0);
      }
    }
    this.vehicleController = ctrl;
  }

  // Park wheel meshes at the settled suspension pose so the first rendered frame
  // matches the ground snap (avoids a one-frame tyre bury before integrate runs).
  _initializeRayCastWheelVisuals() {
    const rc = this.config.ground?.rayCast ?? {};
    const restLen = rc.suspensionRestLength ?? this._defaultSuspensionRestLength ?? 0.3;
    const settleSag = rc.settleSag ?? 0.13;
    const anchorY = this.wheelAnchors[0]?.y ?? -(this.frameParameterDefaults?.frameHeight ?? 1) * 0.5;
    const connY = Number.isFinite(rc.connectionHeight) ? rc.connectionHeight : anchorY + restLen;
    const settledLen = Math.max(0.05, restLen - settleSag);
    for (const wheel of this.wheelMeshes) {
      const node = wheel?.userData.suspNode;
      if (node) node.position.y = connY - settledLen;
    }
  }

  // Ground drive via the Rapier controller: set per-wheel engine force / brake /
  // steering, raycast + integrate the suspension (updateVehicle modifies the
  // chassis velocity directly), then read contact state. Downforce (capped) is the
  // only body force layered on top.
  _integrateGroundRayCast(body, controls, dt, physics) {
    const ctrl = this.vehicleController;
    if (!ctrl) return;
    const cfg = this.config.ground;
    const rc = cfg.rayCast ?? {};
    const mass = bodyMass(body, this.config);
    const surface = this._updateSurfaceTuning(dt);
    readBodyFrame(body);
    const speedFwd = _linvel.dot(_forward);
    this.controllerSpeed = ctrl.currentVehicleSpeed();
    const layout = cfg.driveLayout ?? 'awd';

    // Engine force (N), reusing the mass-normalised enginePower + speed-cap taper.
    let drive = 0;
    if (controls.throttle !== 0) {
      const forward = controls.throttle > 0;
      const cap = forward ? cfg.maxSpeed * this.maxSpeedScale : cfg.maxReverseSpeed;
      const scale = forward ? 1 : cfg.reverseScale;
      // Flat power until near the cap, then a short taper that only reaches 0 just
      // PAST the cap — a plain (1 - v/cap) taper chokes the top third and the car
      // can never actually reach its top speed. taperBand = fraction of the cap over
      // which power fades.
      const band = cfg.engineTaperBand ?? 0.22;
      const taperEnd = cap * (cfg.engineTaperEndScale ?? 1.04);
      const taperStart = cap * (1 - band);
      const headroom = THREE.MathUtils.clamp((taperEnd - Math.abs(speedFwd)) / (taperEnd - taperStart), 0, 1);
      drive = controls.throttle * cfg.enginePower * this.enginePowerScale * scale * headroom * mass;
    }
    let driveWheels = 0;
    for (const a of this.wheelAnchors) if (wheelReceivesDrive(a, layout)) driveWheels += 1;
    const perWheelDrive = driveWheels ? drive / driveWheels : 0;

    // Brake impulse (N·s ≈ force * dt): service brake or handbrake (rear-biased).
    const braking = controls.brake > 0 || controls.handbrake;
    const brakeImpulse = braking ? cfg.brakeForce * mass * dt : 0;
    const steerAngle = computeRayCastSteerAngle(speedFwd, controls.steer, rc);

    const restLen = rc.suspensionRestLength ?? 0.3;
    for (let i = 0; i < ctrl.numWheels(); i += 1) {
      const a = this.wheelAnchors[i];
      // Engine force is applied along the wheel forward (−Z); negate so throttle>0
      // drives the car forward (−Z).
      const previous = this.wheelTelemetry[i];
      const tractionControl = rc.tractionControl !== false && controls.throttle !== 0;
      const absActive = rc.abs !== false && braking && Math.abs(speedFwd) > (rc.absMinSpeed ?? 4);
      const tractionScale = tractionControl && previous?.slipRatio > (rc.tractionSlipThreshold ?? 0.32)
        ? THREE.MathUtils.clamp((rc.tractionSlipThreshold ?? 0.32) / previous.slipRatio, 0.2, 1)
        : 1;
      const absScale = absActive && previous?.slipRatio > (rc.absSlipThreshold ?? 0.48)
        ? (rc.absReleaseScale ?? 0.25)
        : 1;
      ctrl.setWheelEngineForce(
        i,
        wheelReceivesDrive(a, layout) ? -perWheelDrive * tractionScale : 0,
      );
      ctrl.setWheelBrake(
        i,
        (controls.handbrake && !wheelIsFront(a) ? brakeImpulse * 1.5 : brakeImpulse) * absScale,
      );
      ctrl.setWheelSteering(i, wheelIsFront(a) ? steerAngle : 0);
    }

    // Wheel rays must ignore the car's own chassis collider.
    const selfHandle = this.colliderHandle;
    const filterFlags = physics.RAPIER?.QueryFilterFlags?.EXCLUDE_SENSORS;
    ctrl.updateVehicle(dt, filterFlags, undefined, (c) => c?.handle !== selfHandle);

    let grounded = 0;
    const wheels = ctrl.numWheels();
    const mudDynamics = resolveMudWheelDynamics(cfg.mudWheelDynamics);
    let mudContactCount = 0;
    for (let i = 0; i < wheels; i += 1) {
      const inContact = ctrl.wheelIsInContact(i);
      if (inContact) grounded += 1;
      const wheel = this.wheelMeshes[i];
      const suspensionLength = ctrl.wheelSuspensionLength(i);
      if (wheel && Number.isFinite(suspensionLength)) {
        const node = wheel.userData.suspNode;
        const connY = rc.connectionHeight ?? ((wheel.userData.restY ?? 0) + restLen);
        if (node) node.position.y = connY - suspensionLength;
      }

      const rotation = ctrl.wheelRotation(i);
      const old = this.wheelTelemetry[i];
      if (wheel && Number.isFinite(rotation)) wheel.rotation.x = rotation;
      const angularVelocity = Number.isFinite(rotation) && Number.isFinite(old?.rotation) && dt > 0
        ? shortestAngleDelta(rotation, old.rotation) / dt
        : 0;
      const wheelRadius = ctrl.wheelRadius(i) ?? rc.wheelRadius ?? cfg.wheelRadius ?? 0.38;
      const wheelSurfaceSpeed = Math.abs(angularVelocity * wheelRadius);
      const slipRatio = inContact
        ? Math.abs(wheelSurfaceSpeed - Math.abs(speedFwd)) / Math.max(Math.abs(speedFwd), 2)
        : 0;
      const groundObject = inContact ? ctrl.wheelGroundObject(i) : null;
      const contactPoint = copyRapierVector(ctrl.wheelContactPoint(i), old?.contactPoint);
      const contactNormal = copyRapierVector(ctrl.wheelContactNormal(i), old?.contactNormal);
      const hardPoint = copyRapierVector(ctrl.wheelHardPoint(i), old?.hardPoint);
      const wheelSurface = inContact && contactPoint
        ? this._sampleGroundSurfaceAt(contactPoint.x, contactPoint.z)
        : this.groundSurface;
      if (inContact && wheelSurface === 'mud') mudContactCount += 1;
      const surfaceFriction = groundObject?.friction?.() ?? 0.8;
      const surfaceGrip = THREE.MathUtils.clamp(surfaceFriction / 0.8, 0.45, 1.3);
      const handbrakeGrip = controls.handbrake && !wheelIsFront(this.wheelAnchors[i])
        ? (surface.handbrakeRearGripScale ?? cfg.handbrakeRearGripScale ?? 0.1)
        : 1;
      // Keep every established non-mud tune untouched away from mud. At a mud
      // boundary, however, resolve each contact directly so one wheel can enter
      // or leave the soft corridor without switching the whole chassis early.
      const wheelTuning = wheelSurface === 'mud' || this.groundSurface === 'mud'
        ? this._surfaceProfileFor(wheelSurface)
        : surface;
      const suspensionForce = ctrl.wheelSuspensionForce(i) ?? 0;
      const normalizedLoad = THREE.MathUtils.clamp(suspensionForce / mudDynamics.loadForce, 0, 1.5);
      const mudSample = wheelSurface === 'mud' && contactPoint && this.mudField?.sampleAt
        ? this.mudField.sampleAt(contactPoint.x, contactPoint.z)
        : null;
      const rutDepth = mudSample
        ? THREE.MathUtils.clamp(mudSample.depth / (this.mudField.maxDepth || 0.2), 0, 1)
        : 0;
      const mudSoftness = wheelSurface === 'mud'
        ? THREE.MathUtils.clamp(mudDynamics.baseSoftness + (mudSample?.wetness ?? 0) * mudDynamics.rutSoftness, 0, 1)
        : 0;
      const grip = wheelSurface === 'mud'
        ? computeMudGripScales(rutDepth, slipRatio, mudDynamics)
        : { longitudinal: 1, lateral: 1 };
      ctrl.setWheelFrictionSlip(
        i,
        (wheelTuning.frictionSlip ?? rc.frictionSlip ?? 2) * surfaceGrip * handbrakeGrip * grip.longitudinal,
      );
      if (ctrl.setWheelSideFrictionStiffness) {
        ctrl.setWheelSideFrictionStiffness(
          i,
          (wheelTuning.sideFrictionStiffness ?? rc.sideFrictionStiffness ?? 1)
            * surfaceGrip * handbrakeGrip * grip.lateral,
        );
      }
      const isFront = wheelIsFront(this.wheelAnchors[i]);
      const contactStarted = Boolean(inContact && old && !old.inContact);
      const airborneTime = inContact ? 0 : (old?.airborneTime ?? 0) + dt;
      const landedAfterAir = contactStarted && (old?.airborneTime ?? 0) >= mudDynamics.landing.minAirTime;
      const landingDuration = landedAfterAir
        ? THREE.MathUtils.lerp(
          mudDynamics.landing.minDuration,
          mudDynamics.landing.maxDuration,
          THREE.MathUtils.clamp(normalizedLoad, 0, 1),
        )
        : (old?.landingDuration ?? 0);
      const landingLoad = landedAfterAir
        ? THREE.MathUtils.clamp(normalizedLoad, 0, 1.5)
        : (old?.landingLoad ?? 0);
      const landingTimeRemaining = landedAfterAir
        ? landingDuration
        : Math.max(0, (old?.landingTimeRemaining ?? 0) - dt);
      const landingIntensity = wheelSurface === 'mud' && landingDuration > 0
        ? mudDynamics.landing.intensity * landingLoad * (landingTimeRemaining / landingDuration)
        : 0;
      const torqueInput = braking
        ? Math.max(controls.brake ?? 0, controls.handbrake ? 1 : 0)
        : (wheelReceivesDrive(this.wheelAnchors[i], layout) ? Math.abs(controls.throttle ?? 0) : 0);
      const mudDigEnergy = wheelSurface === 'mud' && inContact
        ? computeMudWheelIntensity({
          slip: slipRatio,
          torque: torqueInput,
          braking,
          isFront,
          load: normalizedLoad,
          softness: mudSoftness,
          rutDepth,
          speed: Math.abs(speedFwd),
          landing: 0,
        }, mudDynamics)
        : 0;
      const mudIntensity = THREE.MathUtils.clamp(Math.max(mudDigEnergy, landingIntensity), 0, 1);
      this.wheelTelemetry[i] = {
        inContact,
        contactStarted,
        contactTransition: contactStarted ? 'landed' : (!inContact && old?.inContact ? 'airborne' : 'stable'),
        airborneTime,
        landingDuration,
        landingLoad,
        landingTimeRemaining,
        rotation,
        angularVelocity,
        slipRatio,
        forwardImpulse: ctrl.wheelForwardImpulse(i) ?? 0,
        sideImpulse: ctrl.wheelSideImpulse(i) ?? 0,
        suspensionForce,
        normalizedLoad,
        suspensionLength,
        contactPoint,
        contactNormal,
        hardPoint,
        groundColliderHandle: groundObject?.handle ?? null,
        surface: wheelSurface,
        surfaceFriction,
        rutDepth,
        mudSoftness,
        mudIntensity,
        mudDigEnergy,
        braking,
        isFront,
        torqueInput,
        longitudinalGripScale: grip.longitudinal,
        lateralGripScale: grip.lateral,
        tractionControl: controls.throttle !== 0 && old?.slipRatio > (rc.tractionSlipThreshold ?? 0.32),
        abs: braking && old?.slipRatio > (rc.absSlipThreshold ?? 0.48),
      };

    }
    this.grounded = grounded > 0;
    this.groundedFraction = wheels ? grounded / wheels : 0;

    if (this.groundedFraction > 0) {
      // The raycast controller already has baseline contact drag. Add only the
      // loose-surface excess so asphalt handling stays behavior-compatible.
      const rolling = (cfg.rollingResistance ?? 0)
        * Math.max(0, (surface.rollingResistanceScale ?? 1) - 1);
      if (rolling > 0) {
        _force.copy(_forward).multiplyScalar(-speedFwd * rolling * mass * this.groundedFraction);
        body.addForce(toRapier(_force), false);
      }
      if (mudContactCount === 0 && controls.throttle > 0 && Math.abs(controls.steer) > 0.04 && (cfg.powerOversteer ?? 0) > 0) {
        const yawAccel = -controls.steer * controls.throttle * cfg.powerOversteer
          * (surface.powerOversteerScale ?? 1) * this.groundedFraction;
        _force.copy(_up).multiplyScalar(yawAccel * mass);
        body.addTorque(toRapier(_force), true);
      }
    }

    // Low-speed yaw assist: wheel steering needs forward motion to rotate the car,
    // so add a fading closed-loop yaw torque below yawAssistMaxSpeed for arcade
    // responsiveness (and pivoting in place). Fades to 0 as the wheel steering gains
    // authority with speed. Only while grounded.
    const assistFade = THREE.MathUtils.clamp(1 - Math.abs(speedFwd) / (rc.yawAssistMaxSpeed ?? 9), 0, 1);
    if (assistFade > 0 && Math.abs(controls.steer) > 0.01 && this.groundedFraction > 0) {
      const targetYawRate = -controls.steer * (cfg.maxYawRate ?? 1) * assistFade;
      const actualYawRate = _angvel.dot(_up);
      const yawAccel = (targetYawRate - actualYawRate) * (cfg.yawStiffness ?? 10)
        * (rc.yawAssistStrength ?? 1) * this.groundedFraction;
      _force.copy(_up).multiplyScalar(yawAccel * mass);
      body.addTorque(toRapier(_force), true);
      this.steerTelemetry = { steer: controls.steer, speedFwd: Math.abs(speedFwd), authority: assistFade, targetYawRate, actualYawRate, yawAccel };
    } else {
      this.steerTelemetry = { steer: controls.steer, speedFwd: Math.abs(speedFwd), authority: 1 - assistFade, targetYawRate: 0, actualYawRate: _angvel.dot(_up), yawAccel: 0 };
    }

    // Downforce (capped) for high-speed grip, while grounded.
    let dfAccel = cfg.downforce * speedFwd * speedFwd;
    if (cfg.downforceMaxAccel != null && dfAccel > cfg.downforceMaxAccel) dfAccel = cfg.downforceMaxAccel;
    if (dfAccel > 0 && this.groundedFraction > 0) {
      _force.copy(_up).multiplyScalar(-dfAccel * mass * this.groundedFraction);
      body.addForce(toRapier(_force), false);
    }
  }

  // ---- ground drive model --------------------------------------------------

  _enforceGroundSpeedLimit(body) {
    const maxSpeed = this.config.ground?.maxSpeed * this.maxSpeedScale;
    if (!(maxSpeed > 0)) return;
    const velocity = body.linvel();
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    if (horizontalSpeed <= maxSpeed) return;
    const scale = maxSpeed / horizontalSpeed;
    body.setLinvel({
      x: velocity.x * scale,
      y: velocity.y,
      z: velocity.z * scale,
    }, true);
  }

  _integrateGround(body, controls, dt, physics) {
    if (this.damageSteerBias) {
      controls = {
        ...controls,
        steer: THREE.MathUtils.clamp((controls.steer ?? 0) + this.damageSteerBias, -1, 1),
      };
    }
    if (this.vehicleController) {
      // The raycast controller directly integrates velocity using its `dt`, so it
      // must receive the SAME fixed timestep the Rapier world will step below.
      // Frame `dt` can include a chunk-build/render hitch (clamped as high as
      // 50 ms) while the world still advances 16 ms; feeding that wall-clock gap
      // here produces a one-frame 3x engine/brake impulse and a visible speed surge.
      const worldDt = physics.world?.timestep;
      const physicsDt = Number.isFinite(worldDt) && worldDt > 0 ? worldDt : dt;
      this._integrateGroundRayCast(body, controls, physicsDt, physics);
      return;
    }
    const cfg = this.config.ground;
    const surface = this._updateSurfaceTuning(dt);
    const mass = bodyMass(body, this.config);
    readBodyFrame(body); // fills _pos/_quat/_linvel/_angvel/_forward/_right/_up

    const susp = cfg.suspension;
    const maxRayLen = susp.rayUpOffset + susp.restLength + susp.maxTravel;
    const restDist = susp.rayUpOffset + susp.restLength;
    const wheelCount = this.wheelAnchors.length;
    ensureWheelScratch(wheelCount);
    let groundedWheels = 0;

    // Visual suspension travel bounds (anchor -> wheel-centre distance): the wheel
    // centre rides `wheelRadius` above the contact, so the visual length is the
    // anchor->contact gap minus the radius, clamped to the compression/droop range.
    const visRadius = cfg.wheelRadius ?? 0.38;
    const minGap = susp.restLength - susp.maxTravel; // fully compressed
    const maxGap = susp.restLength + susp.maxTravel; // fully drooped (airborne)

    for (let wi = 0; wi < wheelCount; wi += 1) {
      const anchor = this.wheelAnchors[wi];
      _wheelLocal.copy(anchor);
      _wheelWorld.copy(_wheelLocal).applyQuaternion(_quat).add(_pos);
      _rayOrigin.copy(_up).multiplyScalar(susp.rayUpOffset).add(_wheelWorld);
      _rayDir.copy(_up).multiplyScalar(-1);

      const toi = this._castGround(physics, body, _rayOrigin, _rayDir, maxRayLen);
      if (toi == null || toi > maxRayLen) {
        _wheelGrounded[wi] = false;
        // No contact: hang the wheel at full droop so it visibly extends in the air.
        this._setWheelVisualGap(wi, maxGap, visRadius, dt);
        continue;
      }
      _wheelGrounded[wi] = true;
      _wheelWorldPts[wi].copy(_wheelWorld);
      groundedWheels += 1;

      // Visual: where the contact actually is below this wheel's anchor.
      const groundGap = THREE.MathUtils.clamp(toi - susp.rayUpOffset, minGap, maxGap);
      this._setWheelVisualGap(wi, groundGap, visRadius, dt);

      // Spring: positive when compressed (contact closer than rest distance).
      const compression = restDist - toi;
      // Damper: velocity of this wheel point along the suspension (up) axis.
      _r.copy(_wheelWorld).sub(_pos);
      _wheelVel.copy(_angvel).cross(_r).add(_linvel);
      const velAlongUp = _wheelVel.dot(_up);

      let accel = compression * susp.stiffness - velAlongUp * susp.damping;
      accel = THREE.MathUtils.clamp(accel, 0, susp.maxForceScale);
      const suspForce = accel * mass;
      _force.copy(_up).multiplyScalar(suspForce);
      // Passive suspension must not wake an already-settled parked vehicle.
      body.addForceAtPoint(toRapier(_force), toRapier(_wheelWorld), false);
    }

    this.grounded = groundedWheels > 0;
    this.groundedFraction = wheelCount ? groundedWheels / wheelCount : 0;

    if (!this.grounded) {
      return; // airborne: only gravity + damping act on the chassis
    }

    const gf = this.groundedFraction;
    const speedFwd = _linvel.dot(_forward);
    const layout = cfg.driveLayout ?? 'awd';

    // Engine / reverse, tapered near the speed cap so it doesn't run away.
    let drive = 0;
    if (controls.throttle !== 0) {
      const forwardThrottle = controls.throttle > 0;
      const cap = forwardThrottle ? cfg.maxSpeed * this.maxSpeedScale : cfg.maxReverseSpeed;
      const scale = forwardThrottle ? 1 : cfg.reverseScale;
      const headroom = THREE.MathUtils.clamp(1 - Math.abs(speedFwd) / cap, 0, 1);
      drive = controls.throttle * cfg.enginePower * this.enginePowerScale * scale * headroom;
    }
    if (drive !== 0) {
      let driveWheels = 0;
      for (let wi = 0; wi < wheelCount; wi += 1) {
        if (_wheelGrounded[wi] && wheelReceivesDrive(this.wheelAnchors[wi], layout)) {
          driveWheels += 1;
        }
      }
      if (driveWheels > 0) {
        const wheelDrive = (drive * mass * gf) / driveWheels;
        for (let wi = 0; wi < wheelCount; wi += 1) {
          if (!_wheelGrounded[wi] || !wheelReceivesDrive(this.wheelAnchors[wi], layout)) {
            continue;
          }
          _force.copy(_forward).multiplyScalar(wheelDrive);
          body.addForceAtPoint(toRapier(_force), toRapier(_wheelWorldPts[wi]), true);
        }
      }
    }

    // Brake: oppose forward motion, biased toward the front axle.
    if (controls.brake > 0 && Math.abs(speedFwd) > 0.05) {
      const totalBrake = -Math.sign(speedFwd) * controls.brake * cfg.brakeForce * mass * gf;
      const frontBias = cfg.brakeFrontBias ?? 0.6;
      let frontGrounded = 0;
      let rearGrounded = 0;
      for (let wi = 0; wi < wheelCount; wi += 1) {
        if (!_wheelGrounded[wi]) continue;
        if (wheelIsFront(this.wheelAnchors[wi])) frontGrounded += 1;
        else rearGrounded += 1;
      }
      for (let wi = 0; wi < wheelCount; wi += 1) {
        if (!_wheelGrounded[wi]) continue;
        const front = wheelIsFront(this.wheelAnchors[wi]);
        const count = front ? frontGrounded : rearGrounded;
        if (count === 0) continue;
        const share = front ? frontBias : 1 - frontBias;
        _force.copy(_forward).multiplyScalar((totalBrake * share) / count);
        body.addForceAtPoint(toRapier(_force), toRapier(_wheelWorldPts[wi]), true);
      }
    }

    // Rolling resistance.
    _force.copy(_forward).multiplyScalar(
      -speedFwd * cfg.rollingResistance * (surface.rollingResistanceScale ?? 1) * mass * gf,
    );
    body.addForce(toRapier(_force), false);

    const speedLat = _linvel.dot(_right);

    // Primary body lateral grip — cancels chassis slide without per-wheel yaw couple.
    if (cfg.lateralGrip > 0) {
      const bodyGripMul = controls.handbrake ? (cfg.handbrakeBodyGripScale ?? 0.88) : 1;
      _force.copy(_right).multiplyScalar(-speedLat * cfg.lateralGrip * bodyGripMul * mass * gf);
      body.addForce(toRapier(_force), false);
    }

    // RWD handbrake / rear-axle trim: small per-rear-wheel grip (low scale = tail slides).
    const rearAxleGrip = cfg.rearAxleGrip ?? 0;
    if (layout === 'rwd' && rearAxleGrip > 0) {
      let rearGrounded = 0;
      for (let wi = 0; wi < wheelCount; wi += 1) {
        if (_wheelGrounded[wi] && !wheelIsFront(this.wheelAnchors[wi])) rearGrounded += 1;
      }
      if (rearGrounded > 0) {
        const rearScale = controls.handbrake
          ? (surface.handbrakeRearGripScale ?? cfg.handbrakeRearGripScale ?? 0.1)
          : (cfg.rearGripScale ?? 0.58);
        const trim = rearAxleGrip * rearScale * mass / rearGrounded;
        for (let wi = 0; wi < wheelCount; wi += 1) {
          if (!_wheelGrounded[wi] || wheelIsFront(this.wheelAnchors[wi])) continue;
          _r.copy(_wheelWorldPts[wi]).sub(_pos);
          _wheelVel.copy(_angvel).cross(_r).add(_linvel);
          const velLat = _wheelVel.dot(_right);
          _force.copy(_right).multiplyScalar(-velLat * trim * gf);
          body.addForceAtPoint(toRapier(_force), toRapier(_wheelWorldPts[wi]), false);
        }
      }
    }

    // Closed-loop yaw-rate steering.
    const sp = Math.abs(speedFwd);
    const authority = computeSteerAuthority(speedFwd, cfg);
    const reverseSign = !cfg.skidSteer && speedFwd < -0.5 ? -1 : 1;
    const sensitivity = cfg.steerSensitivity ?? 1;
    let targetYawRate = -controls.steer * (cfg.maxYawRate ?? 1) * sensitivity * authority * reverseSign;
    if (
      layout === 'rwd' &&
      cfg.powerOversteer > 0 &&
      controls.throttle > 0 &&
      Math.abs(controls.steer) > 0.05
    ) {
      targetYawRate += -controls.steer * controls.throttle * cfg.powerOversteer
        * (surface.powerOversteerScale ?? 1) * authority;
    }
    const actualYawRate = _angvel.dot(_up);
    let yawAccel = (targetYawRate - actualYawRate) * (cfg.yawStiffness ?? 10) * gf;
    if (cfg.yawDamping > 0) {
      yawAccel -= actualYawRate * cfg.yawDamping * gf;
    }
    if (yawAccel !== 0) {
      _force.copy(_up).multiplyScalar(yawAccel * mass);
      body.addTorque(toRapier(_force), true);
    }

    this.steerTelemetry = {
      steer: controls.steer,
      speedFwd: sp,
      authority,
      targetYawRate,
      actualYawRate,
      yawAccel,
    };

    // Light weathervane when not steering (return-to-center comes from target yaw → 0).
    if (!cfg.skidSteer && speedFwd > 0.5 && Math.abs(controls.steer) < 0.05 && cfg.caster?.alignRate) {
      const gripScale = controls.handbrake
        ? (cfg.handbrakeRearGripScale ?? cfg.handbrakeGripScale)
        : 1;
      const align = -(cfg.caster.alignRate) * speedLat * gripScale * gf;
      if (align !== 0) {
        _force.copy(_up).multiplyScalar(align * mass);
        body.addTorque(toRapier(_force), false);
      }
    }

    // Downforce: more grip the faster you go, but CAPPED so the unbounded v^2 term
    // can't saturate the suspension support at highway speed (which bottomed the
    // springs onto the rigid wheel balls and rode hard — the high-speed bounce/pop).
    let dfAccel = cfg.downforce * speedFwd * speedFwd;
    if (cfg.downforceMaxAccel != null && dfAccel > cfg.downforceMaxAccel) {
      dfAccel = cfg.downforceMaxAccel;
    }
    _force.copy(_up).multiplyScalar(-dfAccel * mass * gf);
    body.addForce(toRapier(_force), false);
  }

  // ---- air drive model -----------------------------------------------------

  _integrateAir(body, controls, dt, physics) {
    const cfg = this.config.air;
    const mass = bodyMass(body, this.config);
    readBodyFrame(body);
    void physics;
    void dt;

    const speedFwd = Math.max(0, _linvel.dot(_forward));
    const authority = THREE.MathUtils.clamp((speedFwd - cfg.minSpeed) / cfg.minSpeed + 1, 0, 1);

    // Thrust.
    const thrust = cfg.cruiseThrust + Math.max(0, controls.throttle) * cfg.throttleThrust;
    _force.copy(_forward).multiplyScalar(thrust * mass);
    body.addForce(toRapier(_force), true);

    // Lift (along body up, grows with airspeed).
    const lift = THREE.MathUtils.clamp(cfg.liftCoeff * speedFwd * speedFwd, 0, cfg.maxLift);
    _force.copy(_up).multiplyScalar(lift * mass);
    body.addForce(toRapier(_force), true);

    // Drag.
    _force.copy(_linvel).multiplyScalar(-cfg.drag * mass);
    body.addForce(toRapier(_force), true);

    // Control-surface torques (faded by airspeed authority).
    // Pitch torque about body +right rotates the nose (-Z) toward +Y (nose-up).
    // Controls map W => pitch=+1 => intended nose-down, so negate to match.
    _force.copy(_right).multiplyScalar(-controls.pitch * cfg.pitchTorque * authority * mass);
    body.addTorque(toRapier(_force), true);
    _force.copy(_forward).multiplyScalar(-controls.roll * cfg.rollTorque * authority * mass);
    body.addTorque(toRapier(_force), true);
    _force.copy(_up).multiplyScalar(-controls.yaw * cfg.yawTorque * authority * mass);
    body.addTorque(toRapier(_force), true);

    this.grounded = false;
    this.groundedFraction = 0;
  }

  // ---- water drive model ---------------------------------------------------

  _integrateWater(body, controls, dt, physics) {
    const cfg = this.config.water;
    const mass = bodyMass(body, this.config);
    readBodyFrame(body);
    void physics;
    void dt;

    const depth = cfg.waterLevel - _pos.y; // >0 when the origin is below water
    const submersion = THREE.MathUtils.clamp((depth + cfg.draft) / (cfg.draft * 2), 0, 1);
    this.grounded = submersion > 0.05;
    this.groundedFraction = submersion;

    if (submersion <= 0) {
      return; // fully airborne; gravity does the rest
    }

    // Buoyancy.
    _force.copy(UP).multiplyScalar(cfg.buoyancy * submersion * mass);
    body.addForce(toRapier(_force), true);

    const speedFwd = _linvel.dot(_forward);
    const speedLat = _linvel.dot(_right);
    const speedUp = _linvel.dot(UP);

    // Thrust (only bites when submerged).
    if (controls.throttle !== 0) {
      const headroom = THREE.MathUtils.clamp(1 - Math.abs(speedFwd) / cfg.maxSpeed, 0, 1);
      _force.copy(_forward).multiplyScalar(controls.throttle * cfg.enginePower * submersion * headroom * mass);
      body.addForce(toRapier(_force), true);
    }

    // Rudder.
    const authority = THREE.MathUtils.clamp(Math.abs(speedFwd) / cfg.steerFullSpeedAt, 0, 1);
    _force.copy(UP).multiplyScalar(-controls.steer * cfg.steerTorque * authority * submersion * mass);
    body.addTorque(toRapier(_force), true);

    // Water resistance.
    _force.copy(_forward).multiplyScalar(-speedFwd * cfg.linearDrag * mass);
    body.addForce(toRapier(_force), true);
    _force.copy(_right).multiplyScalar(-speedLat * cfg.lateralDrag * submersion * mass);
    body.addForce(toRapier(_force), true);
    _force.copy(UP).multiplyScalar(-speedUp * cfg.verticalDrag * submersion * mass);
    body.addForce(toRapier(_force), true);
  }

  _castGround(physics, body, origin, dir, maxToi) {
    const RAPIER = physics.RAPIER;
    const world = physics.world;
    const collider = world.colliders.get(this.colliderHandle);
    // Reuse a single Ray across casts to avoid per-wheel, per-frame GC churn
    // (Ray/Vector are plain JS objects here, not wasm heap — but 4+ rays/frame
    // per vehicle still adds up). Mutate its origin/dir in place.
    if (this._ray == null) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    }
    const ray = this._ray;
    ray.origin.x = origin.x; ray.origin.y = origin.y; ray.origin.z = origin.z;
    ray.dir.x = dir.x; ray.dir.y = dir.y; ray.dir.z = dir.z;
    const hit = world.castRay(ray, maxToi, true, undefined, undefined, collider, body);
    if (!hit) {
      return null;
    }
    // rapier3d-compat renamed `toi` -> `timeOfImpact` across versions; support both.
    return hit.timeOfImpact ?? hit.toi ?? null;
  }

  // ---- occupants / seats ---------------------------------------------------

  get driverSeatIndex() {
    const idx = this.config.seats.findIndex((s) => s.isDriver);
    return idx >= 0 ? idx : 0;
  }

  hasDriver() {
    return this.occupants[this.driverSeatIndex] != null;
  }

  seatOccupant(seatIndex, occupant) {
    if (seatIndex < 0 || seatIndex >= this.occupants.length) {
      return false;
    }
    this.occupants[seatIndex] = occupant;
    return true;
  }

  clearOccupant(occupant) {
    const idx = this.occupants.indexOf(occupant);
    if (idx >= 0) {
      this.occupants[idx] = null;
      return idx;
    }
    return -1;
  }

  // World-space transform of a seat (for snapping the rider). Reads the current
  // mesh transform, which reflects the last physics step. The position follows
  // the chassis fully (the seat moves with the body), but the orientation is kept
  // UPRIGHT and aligned to the chassis heading — the rider yaws with the vehicle
  // but never pitches/rolls with it. The rider also faces the travel direction:
  // the character model's forward is +Z while the chassis drives toward -Z, so
  // the basis is built from the chassis travel dir (-Z) directly.
  getSeatWorldTransform(seatIndex, outPosition, outQuaternion) {
    const seat = this.config.seats[seatIndex];
    if (!seat || !this.group) {
      return null;
    }
    _seatPos.fromArray(seat.offset);
    _seatPos.y += this.frameParameters.offsetFromTires ?? 0;
    this.group.updateWorldMatrix(true, false);
    outPosition.copy(_seatPos).applyMatrix4(this.group.matrixWorld);
    if (outQuaternion) {
      // Travel direction (chassis -Z) flattened to the horizon.
      _seatForward.copy(FORWARD).applyQuaternion(this.group.quaternion).setY(0);
      _seatRight.crossVectors(UP, _seatForward);
      if (_seatRight.lengthSq() <= 1e-6) {
        _seatRight.set(1, 0, 0);
      } else {
        _seatRight.normalize();
      }
      _seatForward.crossVectors(_seatRight, UP).normalize();
      _seatBasis.makeBasis(_seatRight, UP, _seatForward);
      outQuaternion.setFromRotationMatrix(_seatBasis);
      // Per-seat facing offset (e.g. sideways passenger seats), yaw about up.
      _seatFacingQuat.setFromAxisAngle(UP, seat.facing ?? 0);
      outQuaternion.multiply(_seatFacingQuat).normalize();
    }
    return outPosition;
  }

  // World-space hand targets for a seat's steering wheel / yoke, for arm IK.
  // Returns null if the seat has no `handGrip`. Mirrors the horse grip layout so
  // the same IK consumer (applyMountIk) can drive it: { center, left, right,
  // tangent, normal }. `tangent`/`normal` are the chassis right/forward so the
  // IK pole vector points the elbows sensibly.
  getSeatHandTargets(seatIndex, out) {
    const seat = this.config.seats[seatIndex];
    const grip = seat?.handGrip;
    if (!grip || !this.group) {
      return null;
    }
    _gripPos.fromArray(grip.offset);
    _gripPos.y += this.frameParameters.offsetFromTires ?? 0;
    this.group.updateWorldMatrix(true, false);
    out.center.copy(_gripPos).applyMatrix4(this.group.matrixWorld);
    _gripRight.copy(RIGHT).applyQuaternion(this.group.quaternion).setY(0).normalize();
    _gripForward.copy(FORWARD).applyQuaternion(this.group.quaternion).setY(0).normalize();
    const half = (grip.spacing ?? 0.3) * 0.5;
    // Hands space left/right across the wheel.
    out.left.copy(out.center).addScaledVector(_gripRight, -half);
    out.right.copy(out.center).addScaledVector(_gripRight, half);
    // Ride the rim: rotate the grip points about the wheel's spin axis (chassis
    // local +Z in world — the same axis the steering wheel mesh spins about) by
    // the current steering-wheel angle, so the hands follow the turning wheel.
    // Only the positions rotate; the pole (tangent/normal) stays fixed so the
    // elbows don't flail.
    if (this.steerWheelAngle) {
      _gripAxis.set(0, 0, 1).applyQuaternion(this.group.quaternion).normalize();
      _spinQuat.setFromAxisAngle(_gripAxis, this.steerWheelAngle);
      out.left.sub(out.center).applyQuaternion(_spinQuat).add(out.center);
      out.right.sub(out.center).applyQuaternion(_spinQuat).add(out.center);
    }
    // IMPORTANT: tangent must be the FORWARD axis, not right. solveContactChain
    // builds the elbow pole as `tangent * poleSide` with poleSide = -1 for BOTH
    // arms; the arms are mirror-rigged, so the pole only reads correctly on each
    // when its horizontal part lies on the sagittal plane. Forward gives both
    // elbows a symmetric down-and-back bias; using `right` here pulls both elbows
    // to one side and inverts the right elbow.
    out.tangent.copy(_gripForward);
    out.normal.copy(_gripRight);
    return out;
  }

  // World-space exit position, projected to ground via the level if available.
  getExitWorldPosition(outPosition, level = null) {
    const off = this.config.exitOffset;
    outPosition.set(off[0], off[1], off[2]).applyQuaternion(this.group.quaternion).add(this.group.position);
    const ground = level?.getGroundHeightAt?.(outPosition, 0.5);
    if (Number.isFinite(ground)) {
      outPosition.y = ground;
    }
    return outPosition;
  }

  distanceTo(point) {
    return this.group ? this.group.position.distanceTo(point) : Infinity;
  }

  setGroundSurface(surface) {
    this.groundSurface = surface === 'asphalt' || surface === 'dirt' || surface === 'mud'
      ? surface
      : 'offroad';
  }

  setGroundSurfaceSampler(sampler) {
    this.groundSurfaceSampler = sampler ?? null;
  }

  _sampleGroundSurfaceAt(x, z) {
    const sampler = this.groundSurfaceSampler;
    if (!sampler) return this.groundSurface;
    const sampled = typeof sampler === 'function'
      ? sampler(x, z)
      : sampler?.getRoadSurfaceAt?.(x, z);
    return sampled === 'asphalt' || sampled === 'dirt' || sampled === 'mud'
      ? sampled
      : 'offroad';
  }

  _surfaceProfileFor(surface) {
    const profiles = this.config.ground?.surfaces;
    let profile = profiles?.[surface] ?? profiles?.offroad ?? this.surfaceTuning;
    if (isLooseGroundSurface(surface)) {
      profile = applyLooseSurfaceTraction(
        profile,
        profiles?.asphalt,
        this.config.ground?.traction,
      );
    }
    return profile;
  }

  // Rally mud: stamp tyre ruts into the shared deform field from this frame's
  // wheel telemetry. All four wheels cut the rut (front carves, rear follows in).
  // A rolling wheel lays a shallow continuous rut; a SPINNING/bogged wheel bores
  // progressively deeper each frame (the `add` accumulation) — so bad throttle
  // control digs you a hole. Parked cars (speed < 0.5, no spin) don't bore.
  // (docs/rally-mud-tread-plan.md §6)
  stampMudRuts(mudField, dt = 1 / 60) {
    if (!mudField) return;
    const speed = Math.abs(this.controllerSpeed ?? this.speed ?? 0);
    const speedFactor = Math.min(1, speed / 8);
    // Fresh ruts are wet + churned; rain raises the baseline (M3).
    const wet = Math.min(1, 0.55 + 0.45 * (rainWetness.value ?? 0));
    const step = Math.max(0, Math.min(0.05, dt));
    let rutDirectionX = 0;
    let rutDirectionZ = -1;
    if (this.group?.quaternion) {
      _forward.copy(FORWARD).applyQuaternion(this.group.quaternion).setY(0);
      if (_forward.lengthSq() > 1e-6) {
        _forward.normalize();
        rutDirectionX = _forward.x;
        rutDirectionZ = _forward.z;
      }
    }
    for (const t of this.wheelTelemetry) {
      if (!t?.inContact || !t.contactPoint || (t.surface ?? this.groundSurface) !== 'mud') continue;
      const load = THREE.MathUtils.clamp(t.normalizedLoad ?? (t.suspensionForce ?? 0) / 3000, 0, 1.5);
      const slip = THREE.MathUtils.clamp(t.slipRatio ?? 0, 0, 1);
      const digEnergy = THREE.MathUtils.clamp(t.mudDigEnergy ?? t.mudIntensity ?? (slip * load), 0, 1);
      // Base rut only when actually moving; wheelspin digs even standing still.
      const base = speed >= 0.5 ? 0.035 + 0.08 * speedFactor * (0.5 + 0.5 * load) : 0;
      const dig = digEnergy * 0.2 * step; // ~0.2 m/s at full loaded wheelspin
      if (base <= 0 && dig <= 0) continue;
      // A ~0.22 m brush (spans ~2 of the field's 0.15 m cells) so the rut is a
      // TIGHT tyre-width trough — one wheel, not a wide merged wallow — while
      // still having a cell of falloff for a smooth wall instead of a spike.
      mudField.stampBrush(t.contactPoint.x, t.contactPoint.z, 0.22, {
        depth: base,
        add: dig,
        wetness: wet,
        tread: 1,
        directionX: rutDirectionX,
        directionZ: rutDirectionZ,
      });
    }
  }

  _updateSurfaceTuning(dt) {
    const profiles = this.config.ground?.surfaces;
    let target = profiles?.[this.groundSurface] ?? profiles?.offroad;
    if (!target) return this.surfaceTuning;
    if (isLooseGroundSurface(this.groundSurface)) {
      target = applyLooseSurfaceTraction(
        target,
        profiles?.asphalt,
        this.config.ground?.traction,
      );
    }
    const alpha = 1 - Math.exp(-Math.max(0, target.gripLerp ?? 4) * Math.max(0, dt));
    for (const key of [
      'frictionSlip', 'sideFrictionStiffness', 'powerOversteerScale',
      'handbrakeRearGripScale', 'rollingResistanceScale',
    ]) {
      const fallback = key.endsWith('Scale') ? 1 : 0;
      const next = Number.isFinite(target[key]) ? target[key] : fallback;
      this.surfaceTuning[key] = THREE.MathUtils.lerp(this.surfaceTuning[key] ?? next, next, alpha);
    }
    return this.surfaceTuning;
  }

  // ---- overridable hooks ---------------------------------------------------

  onEnter(/* character, seatIndex */) {}
  onExit(/* character, seatIndex */) {}

  async _attachChassisOverlay() {
    const options = this.chassisOverlayOptions;
    if (!options?.url || !this.group) return null;
    if (options.url.startsWith('/') && typeof window === 'undefined') return null;

    try {
      const gltf = await createGltfLoader().loadAsync(options.url);
      const overlay = gltf.scene;
      overlay.name = 'Vehicle chassis overlay';
      overlay.userData.vehicleChassisOverlay = true;
      const hasTripoPartNames = overlayHasTripoPartNames(overlay);
      overlay.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;

        const partKind = hasTripoPartNames
          ? classifyVehicleOverlayMesh(child, options.profileId, {
            disableGlassDetection: options.disableGlassDetection === true,
          })
          : VEHICLE_OVERLAY_PART.CHASSIS;
        child.userData.vehicleOverlayPart = partKind;
        child.userData.vehicleDamageGeometryUnique = true;
        if (partKind === VEHICLE_OVERLAY_PART.GLASS) {
          this.glassMeshes.push(child);
        }

        if (child.geometry) {
          child.geometry = prepareVehicleOverlayGeometry(child.geometry);
        }

        const previous = child.material;
        const chassisSurfaceMode = resolveChassisSurfaceMode(options);
        child.material = resolveVehicleOverlayMaterial(partKind, previous, {
          chassisSurfaceMode,
          useAuthoredTexture: options.useAuthoredTexture === true,
        });
        if (partKind === VEHICLE_OVERLAY_PART.TAIL_LIGHT || isVehicleTailLightMesh(child)) {
          child.userData.vehicleTailLight = true;
          updateVehicleTailLightEmissive(child.material, 0);
          this.tailLightMaterials.push(child.material);
        }
        if (child.material.wetnessUniform) {
          this.wetnessMaterials.push(child.material);
        }
        disposeMaterial(previous, {
          preserveMaps: chassisSurfaceMode === 'texture' || chassisSurfaceMode === 'mix',
        });
      });
      if (this.tailLightMaterials.length < 2) {
        console.warn(
          `Vehicle chassis overlay: expected 2 tail lights, found ${this.tailLightMaterials.length}`,
        );
      }
      this.chassisSocket.add(overlay);
      this.chassisOverlay = overlay;
      this.resetChassisOverlayTransform();
      return overlay;
    } catch (error) {
      console.warn(`Unable to load vehicle chassis overlay: ${options.url}`, error);
      return null;
    }
  }

  async _attachWheelVisuals() {
    const options = this.wheelVisualOptions;
    if (!options?.url || !this.group || !this.wheelMeshes.length) return null;
    if (options.url.startsWith('/') && typeof window === 'undefined') return null;

    try {
      const gltf = await createGltfLoader().loadAsync(options.url);
      const source = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(source);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const sourceRadius = Math.max(size.x, size.y) * 0.5 || 1;
      const sourceWidth = size.z || 1;
      const radiusScale = (this.config.ground?.wheelRadius ?? 0.38) / sourceRadius;
      const widthScale = (this.config.ground?.wheelWidth ?? 0.3) / sourceWidth;

      for (let index = 0; index < this.wheelMeshes.length; index += 1) {
        const wheel = this.wheelMeshes[index];
        const anchor = this.wheelAnchors[index] ?? this._computeAutoWheels()[index];
        const anchorX = Number.isFinite(anchor.x) ? anchor.x : anchor[0];
        const visual = source.clone(true);
        visual.name = `${wheel.name} authored tire`;
        // The asset axle is local Z. Rotate it toward the outward vehicle X axis
        // on each side. Using opposite rotations (instead of a negative-scale
        // mirror) keeps the authored front face visible and gives both sides the
        // correct directional tread orientation.
        visual.rotation.y = anchorX < 0 ? -Math.PI / 2 : Math.PI / 2;
        visual.scale.set(radiusScale, radiusScale, widthScale);
        visual.position.copy(center)
          .multiply(visual.scale)
          .applyQuaternion(visual.quaternion)
          .multiplyScalar(-1);
        visual.traverse((child) => {
          if (!child.isMesh) return;
          child.castShadow = true;
          child.receiveShadow = true;
        });
        wheel.add(visual);
        const materials = Array.isArray(wheel.material) ? wheel.material : [wheel.material];
        for (const material of materials) material.visible = false;
        wheel.userData.authoredVisual = visual;
      }
      return source;
    } catch (error) {
      console.warn(`Unable to load vehicle wheel visual: ${options.url}`, error);
      return null;
    }
  }

  getChassisOverlayTransform() {
    const overlay = this.chassisOverlay;
    if (!overlay) return null;
    _euler.setFromQuaternion(overlay.quaternion, 'XYZ');
    const degrees = (value) => Number(THREE.MathUtils.radToDeg(value).toFixed(3));
    return {
      position: vectorSnapshot(overlay.position),
      rotationDegrees: {
        x: degrees(_euler.x),
        y: degrees(_euler.y),
        z: degrees(_euler.z),
      },
      scale: vectorSnapshot(overlay.scale),
    };
  }

  setChassisOverlayTransform({ position, rotationDegrees, rotation, scale } = {}) {
    const overlay = this.chassisOverlay;
    if (!overlay) return null;
    setVectorComponents(overlay.position, position);
    const rotationInput = rotationDegrees ?? rotation;
    if (rotationInput) {
      _euler.setFromQuaternion(overlay.quaternion, 'XYZ');
      setEulerDegrees(_euler, rotationInput);
      overlay.quaternion.setFromEuler(_euler);
    }
    setScale(overlay.scale, scale);
    if (this.chassisOverlayOptions) {
      if (position) {
        this.chassisOverlayOptions.position = vectorToArray(
          position,
          this.chassisOverlayOptions.position,
        );
      }
      if (rotationInput) {
        this.chassisOverlayOptions.rotationDegrees = vectorToArray(
          rotationInput,
          this.chassisOverlayOptions.rotationDegrees,
        );
      }
      if (scale != null) {
        this.chassisOverlayOptions.scale = scaleToArray(scale, this.chassisOverlayOptions.scale);
      }
    }
    return this.getChassisOverlayTransform();
  }

  adjustChassisOverlayTransform({ position, rotationDegrees, rotation, scaleMultiplier, scale } = {}) {
    const overlay = this.chassisOverlay;
    if (!overlay) return null;
    addVectorComponents(overlay.position, position);
    const rotationInput = rotationDegrees ?? rotation;
    if (rotationInput) {
      _euler.setFromQuaternion(overlay.quaternion, 'XYZ');
      addEulerDegrees(_euler, rotationInput);
      overlay.quaternion.setFromEuler(_euler);
    }
    multiplyScale(overlay.scale, scaleMultiplier ?? scale);
    return this.getChassisOverlayTransform();
  }

  resetChassisOverlayTransform() {
    const overlay = this.chassisOverlay;
    const options = this.chassisOverlayOptions;
    if (!overlay || !options) return null;
    overlay.position.set(0, 0, 0);
    setVectorComponents(overlay.position, options.position ?? DEFAULT_CHASSIS_OVERLAY.position);
    const rotation = options.rotationDegrees ?? DEFAULT_CHASSIS_OVERLAY.rotationDegrees;
    overlay.rotation.set(0, 0, 0, 'XYZ');
    setEulerDegrees(overlay.rotation, rotation);
    overlay.scale.set(1, 1, 1);
    setScale(overlay.scale, options.scale ?? DEFAULT_CHASSIS_OVERLAY.scale);
    return this.getChassisOverlayTransform();
  }

  getFrameParameters() {
    const clean = (value) => Number(value.toFixed(4));
    return Object.fromEntries(
      Object.entries(this.frameParameters).map(([key, value]) => [key, clean(value)]),
    );
  }

  setFrameParameters(options = {}, physics = null) {
    const aliases = {
      frameWidth: ['frameWidth', 'width'],
      frameLength: ['frameLength', 'length'],
      frameHeight: ['frameHeight', 'height'],
      wheelTrack: ['wheelTrack', 'trackWidth', 'wheelWidth'],
      wheelbase: ['wheelbase', 'wheelBase'],
      rideHeight: ['rideHeight', 'heightFromGround', 'groundClearance'],
      offsetFromTires: ['offsetFromTires', 'tireOffset', 'bodyOffsetFromTires', 'frameLift'],
    };
    const minDimension = new Set([
      'frameWidth', 'frameLength', 'frameHeight', 'wheelTrack', 'wheelbase', 'rideHeight',
    ]);
    for (const [parameter, names] of Object.entries(aliases)) {
      const value = names.map((name) => Number(options[name])).find(Number.isFinite);
      if (value != null) {
        this.frameParameters[parameter] = minDimension.has(parameter) ? Math.max(0.1, value) : value;
      }
    }
    this._applyFrameParameters(physics);
    return this.getFrameParameters();
  }

  adjustFrameParameters(options = {}, physics = null) {
    const current = this.getFrameParameters();
    const aliases = {
      frameWidth: ['frameWidth', 'width'],
      frameLength: ['frameLength', 'length'],
      frameHeight: ['frameHeight', 'height'],
      wheelTrack: ['wheelTrack', 'trackWidth', 'wheelWidth'],
      wheelbase: ['wheelbase', 'wheelBase'],
      rideHeight: ['rideHeight', 'heightFromGround', 'groundClearance'],
      offsetFromTires: ['offsetFromTires', 'tireOffset', 'bodyOffsetFromTires', 'frameLift'],
    };
    const next = {};
    for (const [parameter, names] of Object.entries(aliases)) {
      const delta = names.map((name) => Number(options[name])).find(Number.isFinite);
      if (delta != null) next[parameter] = current[parameter] + delta;
    }
    return this.setFrameParameters(next, physics);
  }

  resetFrameParameters(physics = null) {
    this.frameParameters = { ...this.frameParameterDefaults };
    this._applyFrameParameters(physics);
    return this.getFrameParameters();
  }

  _applyFrameParameters(physics = null) {
    const params = this.frameParameters;
    const defaults = this.frameParameterDefaults;
    const physicsHeight = defaults.frameHeight;

    if (this.frameVisual) {
      const frameScaleY = params.frameHeight / defaults.frameHeight;
      this.frameVisual.scale.set(
        params.frameWidth / defaults.frameWidth,
        frameScaleY,
        params.frameLength / defaults.frameLength,
      );
      // frameHeight is visual-only for the generated frame: scale about the rail
      // line so wheels + authored chassis overlay stay put.
      const frameHeightLift = GENERATED_FRAME_RAIL_Y * (1 - frameScaleY);
      const tireOffset = params.offsetFromTires ?? 0;
      this.frameVisual.position.y = frameHeightLift + tireOffset;
    }

    if (this.chassisSocket) {
      this.chassisSocket.position.y = params.offsetFromTires ?? 0;
    }

    if (this.domain === VEHICLE_DOMAINS.GROUND && this.wheelAnchors.length) {
      const anchorY = -physicsHeight * 0.5;
      const rideHeightDelta = (params.rideHeight ?? defaults.rideHeight) - defaults.rideHeight;
      for (let i = 0; i < this.wheelAnchors.length; i += 1) {
        const anchor = this.wheelAnchors[i];
        anchor.x = (anchor.x < 0 ? -1 : 1) * params.wheelTrack * 0.5;
        anchor.y = anchorY;
        anchor.z = (anchor.z < 0 ? -1 : 1) * params.wheelbase * 0.5;
        const node = this.wheelMeshes[i]?.userData.suspNode;
        if (node) {
          node.position.x = anchor.x;
          // Longer ride-height suspension puts the wheel farther below the
          // chassis. Previously both connection height and rest length moved
          // together, cancelling this setting completely.
          node.position.y = anchor.y - rideHeightDelta;
          node.position.z = anchor.z;
        }
      }
      // Frame transform + wheel anchors are now current — re-solve the axle struts.
      this._updateWheelAxles();
    }

    this.config.body.size = [params.frameWidth, physicsHeight, params.frameLength];
    const collider = physics?.world?.colliders?.get?.(this.colliderHandle);
    collider?.setHalfExtents?.({
      x: params.frameWidth * 0.5,
      y: physicsHeight * 0.5,
      z: params.frameLength * 0.5,
    });

    const rc = this.config.ground?.rayCast;
    const controller = this.vehicleController;
    if (rc) {
      const defaultRest = this._defaultSuspensionRestLength;
      const restLength = Math.max(
        0.05,
        defaultRest + (params.rideHeight - this.frameParameterDefaults.rideHeight),
      );
      rc.suspensionRestLength = restLength;
      const anchorY = this.wheelAnchors.length
        ? this.wheelAnchors[0].y
        : -defaults.frameHeight * 0.5;
      // Tie the controller connection to the visual wheel anchors so physics
      // suspension length and the rendered tyre centres stay aligned.
      // Keep the suspension TOP fixed to the chassis while rest length changes.
      // Moving both by the same delta makes rideHeight a physical no-op.
      rc.connectionHeight = anchorY + defaultRest;
      if (!controller) return;
      const connectionY = rc.connectionHeight;
      for (let i = 0; i < controller.numWheels(); i += 1) {
        const anchor = this.wheelAnchors[i];
        controller.setWheelChassisConnectionPointCs(i, {
          x: anchor.x,
          y: connectionY,
          z: anchor.z,
        });
        controller.setWheelSuspensionRestLength(i, restLength);
      }
    }
  }

  buildMesh() {
    // Deliberately bare-bones car: exposed lower frame, running gear, engine,
    // and driver controls. Subclasses can still replace this with an authored model.
    const group = new THREE.Group();
    const [sx, sy, sz] = this.config.body.size;
    const bodyMeshColor = this.domain === VEHICLE_DOMAINS.AIR
      ? 0x9fb4c8
      : this.domain === VEHICLE_DOMAINS.WATER
        ? 0x4f7a8a
        : 0xb24a4a;
    const bodyMaterial = createSurfaceMaterial(
      this.domain === VEHICLE_DOMAINS.GROUND ? 'rust' : 'steel',
      { fallbackColor: bodyMeshColor, roughness: 0.76, metalness: 0.5, repeat: [3, 5], bumpScale: 0.035 },
    );
    const darkMetal = createSurfaceMaterial('steel', { roughness: 0.68, metalness: 0.72, repeat: [3, 6], bumpScale: 0.018 });
    const engineMetal = createSurfaceMaterial('engine', { roughness: 0.46, metalness: 0.82, repeat: [4, 4], bumpScale: 0.012 });
    const seatMaterial = createSurfaceMaterial('leather', { roughness: 0.82, metalness: 0.02, repeat: [4, 5], bumpScale: 0.025 });
    const harnessMaterial = createSurfaceMaterial('fabric', { roughness: 0.9, metalness: 0, repeat: [4, 10], bumpScale: 0.018 });
    const seatShellMaterial = new THREE.MeshStandardMaterial({
      color: 0x15191c,
      roughness: 0.28,
      metalness: 0.68,
      side: THREE.DoubleSide,
    });
    const addBox = (name, size, position, material = darkMetal, parent = group) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const createTaperedPanel = (bottomWidth, topWidth, height, depth) => {
      const bw = bottomWidth * 0.5;
      const tw = topWidth * 0.5;
      const h = height * 0.5;
      const d = depth * 0.5;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        -bw, -h, -d, bw, -h, -d, bw, -h, d, -bw, -h, d,
        -tw, h, -d, tw, h, -d, tw, h, d, -tw, h, d,
      ], 3));
      geometry.setIndex([
        0, 1, 5, 0, 5, 4,
        2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
        1, 2, 6, 1, 6, 5,
        4, 5, 6, 4, 6, 7,
        3, 2, 1, 3, 1, 0,
      ]);
      geometry.computeVertexNormals();
      return geometry;
    };
    const tubeUp = new THREE.Vector3(0, 1, 0);
    const addTube = (name, start, end, radius = 0.065, material = darkMetal, parent = group) => {
      const from = new THREE.Vector3(...start);
      const to = new THREE.Vector3(...end);
      const direction = to.clone().sub(from);
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, direction.length(), 10),
        material,
      );
      mesh.name = name;
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(tubeUp, direction.normalize());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const weldGeometry = new THREE.SphereGeometry(0.09, 10, 7);
    const addWeld = (position, parent = group) => {
      const weld = new THREE.Mesh(weldGeometry, engineMetal);
      weld.name = 'Welded frame joint';
      weld.position.set(...position);
      weld.scale.set(1.15, 0.82, 1.15);
      weld.castShadow = true;
      parent.add(weld);
      return weld;
    };

    if (this.domain !== VEHICLE_DOMAINS.GROUND) {
      addBox('Vehicle body', [sx, sy, sz], [0, 0, 0], bodyMaterial);
      return group;
    }

    // Raised, open ladder/space frame. The old broad floor pan read as a flat
    // vehicle body and sat inside the tyre crowns. Every visible lower member is
    // now above the tyres, with open air and diagonal bracing between the rails.
    const frameY = GENERATED_FRAME_RAIL_Y;
    const railX = sx * 0.36;
    const frameFront = -sz * 0.43;
    const frameRear = sz * 0.43;
    const crossZs = [frameFront, -sz * 0.14, sz * 0.12, frameRear];

    for (const x of [-railX, railX]) {
      addTube('Main chassis rail', [x, frameY, frameFront], [x, frameY, frameRear], 0.085);
      // Upper rails turn the flat ladder into a rigid three-dimensional frame.
      addTube('Upper chassis rail', [x, frameY, frameFront], [x, 0.34, -sz * 0.16], 0.065);
      addTube('Upper chassis rail', [x, 0.34, -sz * 0.16], [x, 0.3, sz * 0.32], 0.065);
      addTube('Rear chassis brace', [x, 0.3, sz * 0.32], [x, frameY, frameRear], 0.065);
    }
    for (const z of crossZs) {
      addTube('Chassis crossmember', [-railX, frameY, z], [railX, frameY, z], 0.075);
      addWeld([-railX, frameY, z]);
      addWeld([railX, frameY, z]);
    }

    // Alternating welded X-braces resist frame twist but leave the underside open.
    addTube('Lower diagonal brace', [-railX, frameY + 0.015, frameFront], [railX, frameY + 0.015, -sz * 0.14], 0.052);
    addTube('Lower diagonal brace', [railX, frameY + 0.015, frameFront], [-railX, frameY + 0.015, -sz * 0.14], 0.052);
    addTube('Lower diagonal brace', [-railX, frameY + 0.015, sz * 0.12], [railX, frameY + 0.015, frameRear], 0.052);
    addTube('Lower diagonal brace', [railX, frameY + 0.015, sz * 0.12], [-railX, frameY + 0.015, frameRear], 0.052);

    // Individual steel pedestals support all four seats without introducing a
    // sheet-metal passenger floor.
    for (const seat of this.config.seats) {
      const seatX = seat.offset[0];
      const seatZ = seat.offset[2] + 0.04;
      for (const x of [seatX - 0.22, seatX + 0.22]) {
        addTube('Seat mounting rail', [x, 0.2, seatZ - 0.28], [x, 0.2, seatZ + 0.28], 0.045);
        addTube('Seat pedestal', [x, frameY, seatZ - 0.22], [x, 0.2, seatZ - 0.22], 0.045);
        addTube('Seat pedestal', [x, frameY, seatZ + 0.22], [x, 0.2, seatZ + 0.22], 0.045);
      }
    }

      // Generate textures for tire (tread + visible sidewalls) and rim/hubcap.
      // Using CanvasTextures gives crisp details, proper metallic rim, and
      // sidewall patterns without heavy shaders. Shared across all wheels.
      const tireTex = createTireTexture();
      const rimTex = createRimTexture();

      const tireMat = new THREE.MeshStandardMaterial({
        map: tireTex,
        roughness: 0.92,
        metalness: 0.08,
      });
      const rimMat = new THREE.MeshStandardMaterial({
        map: rimTex,
        roughness: 0.38,
        metalness: 0.78,
        envMapIntensity: 0.6,
      });

      const wheelGeo = new THREE.CylinderGeometry(
        this.config.ground.wheelRadius,
        this.config.ground.wheelRadius,
        this.config.ground.wheelWidth ?? 0.3,
        24,
      );
      wheelGeo.rotateZ(Math.PI / 2); // align cylinder axis to X

      // Explicit groups help when using material arrays for tread vs caps.
      if (wheelGeo.groups && wheelGeo.groups.length >= 3) {
        wheelGeo.groups[0].materialIndex = 0; // cylinder sides = tireMat (tread + sidewall)
        wheelGeo.groups[1].materialIndex = 1; // cap1 = rim
        wheelGeo.groups[2].materialIndex = 2; // cap2 = rim
      }

      for (const anchor of this._computeAutoWheels()) {
        // [tire (sides), rim (face), rim (face)]
        // Tire texture has sidewall bands near the edges + tread in center.
        // Rim texture is the circular hubcap with rings, lugs, and an asymmetry for spin.
        const wheel = new THREE.Mesh(wheelGeo, [tireMat, rimMat, rimMat]);
        wheel.name = anchor[2] < 0 ? 'Front wheel' : 'Rear wheel';
        // Front wheels (anchor z < 0, since the chassis drives toward -Z) steer.
        wheel.userData.steerable = anchor[2] < 0;
        wheel.castShadow = true;

        if (wheel.userData.steerable) {
          // Use a parent pivot for steering so that yaw (Y) is applied around
          // the vertical axis first. Then the wheel's own X rotation (spin) is
          // applied around the now-steered axle. This makes spin + steer compose
          // correctly (no more wrong-axis rolling when turned).
          const pivot = new THREE.Group();
          pivot.name = wheel.name + ' steer';
          pivot.position.fromArray(anchor);
          pivot.add(wheel);           // wheel sits at local origin of pivot
          // wheel.position remains (0,0,0)
          group.add(pivot);
          wheel.userData.steerPivot = pivot;
          // Suspension travel moves the steer pivot (so steer yaw + travel compose).
          wheel.userData.suspNode = pivot;
        } else {
          wheel.position.fromArray(anchor);
          group.add(wheel);
          wheel.userData.suspNode = wheel;
        }
        // Neutral mount height for the suspension node (anchor Y). Visual travel is
        // applied as restY - suspensionLength.
        wheel.userData.restY = anchor[1];

        this.wheelMeshes.push(wheel);
      }

      // Wheel axle struts are NOT built here at fixed positions — the chassis ride
      // height and wheel track/base can differ from the body box. They are created
      // after the frame/wheel split (below) and IK-solved by _updateWheelAxles so
      // each axle always spans the CURRENT frame underside to the CURRENT tyre
      // centre. Stash the rail attach reference (side X, underside Y) for it.
      this._buildRailX = railX;
      this._buildRailY = frameY;
      this._buildRailRadius = 0.085; // main chassis rail tube radius

      // Exposed front engine block, pulled close to the cockpit rather than
      // floating at the nose, with four deliberately visible moving pistons.
      if (!this.hideEngine) {
        const engineZ = -sz * 0.25;
        const enginePivotY = 0.28;

        // Engine mount carries the static orientation; engineGroup stays the
        // vibration target so _updateVibrations does not wipe a base rotation.
        const engineMount = new THREE.Group();
        engineMount.name = 'Engine mount';
        engineMount.position.set(0, enginePivotY, engineZ);
        engineMount.rotation.y = Math.PI * 0.5;
        group.add(engineMount);

        const engineGroup = new THREE.Group();
        engineGroup.name = 'Engine';
        engineMount.add(engineGroup);
        this.engineGroup = engineGroup;
        this.pistonMeshes = [];

        addBox('Engine block', [sx * 0.58, 0.42, sz * 0.22], [0, 0, 0], engineMetal, engineGroup);
        addBox('Engine head', [sx * 0.48, 0.13, sz * 0.18], [0, 0.27, 0], darkMetal, engineGroup);
        const pistonMaterial = new THREE.MeshStandardMaterial({
          color: 0xc5cbd0,
          roughness: 0.24,
          metalness: 0.92,
        });
        const pistonRodGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10);
        const pistonCrownGeometry = new THREE.CylinderGeometry(0.09, 0.085, 0.1, 14);
        const sleeveGeometry = new THREE.TorusGeometry(0.1, 0.022, 7, 14);
        sleeveGeometry.rotateX(Math.PI * 0.5);
        const pistonXs = [-0.34, -0.11, 0.11, 0.34];
        for (let i = 0; i < pistonXs.length; i++) {
          const x = pistonXs[i];
          const sleeve = new THREE.Mesh(sleeveGeometry, engineMetal);
          sleeve.name = 'Piston sleeve';
          sleeve.position.set(x, 0.35, 0);
          sleeve.castShadow = true;
          engineGroup.add(sleeve);

          const piston = new THREE.Group();
          piston.name = 'Exposed engine piston';
          piston.position.set(x, 0.44, 0);
          piston.userData.pistonIndex = i;
          piston.userData.restY = 0.44;

          const rod = new THREE.Mesh(pistonRodGeometry, pistonMaterial);
          rod.name = 'Piston rod';
          rod.position.y = -0.08;
          rod.castShadow = true;
          piston.add(rod);

          const crown = new THREE.Mesh(pistonCrownGeometry, pistonMaterial);
          crown.name = 'Piston crown';
          crown.position.y = 0.07;
          crown.castShadow = true;
          piston.add(crown);

          engineGroup.add(piston);
          this.pistonMeshes.push(piston);
        }
      }

      // A low firewall closes the engine/cockpit gap. Two uprights run from the
      // floor rails into the dash crossbar, with diagonal braces back to the pan.
      addBox('Engine firewall', [sx * 0.76, 0.48, 0.09], [0, 0.34, -0.57], bodyMaterial);
      const dashY = 0.72;
      const dashZ = -0.31;
      for (const x of [-sx * 0.34, sx * 0.34]) {
        addTube('Dashboard upright', [x, frameY, -0.5], [x, dashY, dashZ], 0.06);
        addTube('Dashboard frame brace', [x, frameY, 0.12], [x, dashY, dashZ], 0.055);
        addWeld([x, dashY, dashZ]);
      }

      // Makeshift dash: a bare crossbar, small instrument pod, steering column,
      // and the wheel itself aligned with the left-side driver.
      addTube('Dashboard crossbar', [-sx * 0.4, dashY, dashZ], [sx * 0.4, dashY, dashZ], 0.065);

      // Compact molded buckets: a tapered carbon shell, reclined inset padding,
      // integrated bolsters, and a close-fitting harness instead of stacked boxes.
      const seatBackGeometry = createTaperedPanel(0.42, 0.5, 0.68, 0.065);
      for (const seat of this.config.seats) {
        const bucket = new THREE.Group();
        bucket.name = `${seat.name} formula bucket seat`;
        bucket.position.set(seat.offset[0], 0, seat.offset[2]);
        group.add(bucket);

        const lowerShell = addBox('Bucket seat lower shell', [0.52, 0.075, 0.62], [0, 0.255, 0], seatShellMaterial, bucket);
        lowerShell.rotation.x = 0.1;
        const cushion = addBox('Bucket seat cushion', [0.43, 0.105, 0.5], [0, 0.325, -0.015], seatMaterial, bucket);
        cushion.rotation.x = 0.1;

        const shellBack = new THREE.Mesh(seatBackGeometry, seatShellMaterial);
        shellBack.name = 'Tapered bucket seat shell';
        shellBack.position.set(0, 0.64, 0.245);
        shellBack.rotation.x = 0.2;
        shellBack.castShadow = true;
        shellBack.receiveShadow = true;
        bucket.add(shellBack);

        const backPad = addBox('Bucket seat back pad', [0.36, 0.49, 0.045], [0, 0.61, 0.185], seatMaterial, bucket);
        backPad.rotation.x = 0.2;

        for (const side of [-1, 1]) {
          const hipBolster = addBox(
            'Bucket seat hip bolster',
            [0.07, 0.19, 0.48],
            [side * 0.245, 0.39, 0.015],
            seatShellMaterial,
            bucket,
          );
          hipBolster.rotation.z = side * -0.12;
          const shoulderBolster = addBox(
            'Bucket seat shoulder bolster',
            [0.075, 0.28, 0.12],
            [side * 0.245, 0.71, 0.205],
            seatShellMaterial,
            bucket,
          );
          shoulderBolster.rotation.z = side * -0.09;
        }

        const headPad = addBox('Bucket seat head pad', [0.28, 0.13, 0.045], [0, 0.91, 0.27], seatMaterial, bucket);
        headPad.rotation.x = 0.2;

        for (const x of [-0.09, 0.09]) {
          const strap = addBox(
            'Racing harness strap',
            [0.045, 0.46, 0.018],
            [x, 0.61, 0.153],
            harnessMaterial,
            bucket,
          );
          strap.rotation.x = 0.2;
        }
        const lapBelt = addBox('Racing lap belt', [0.39, 0.045, 0.025], [0, 0.4, -0.02], harnessMaterial, bucket);
        lapBelt.rotation.x = 0.1;
      }

      const driver = this.config.seats.find((s) => s.isDriver);
      const grip = driver?.handGrip;
      if (grip) {
        addBox('Instrument pod', [0.42, 0.2, 0.1], [grip.offset[0], grip.offset[1] + 0.04, -0.25], bodyMaterial);
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.34, 10), darkMetal);
        column.name = 'Steering column';
        column.rotation.x = Math.PI * 0.5;
        column.position.set(grip.offset[0], grip.offset[1], grip.offset[2] - 0.17);
        column.castShadow = true;
        group.add(column);

        const steerGeo = new THREE.TorusGeometry((grip.spacing ?? 0.3) * 0.5, 0.025, 8, 20);
        // TorusGeometry's ring already lies in the XY plane with its hole axis
        // along Z, so the wheel faces the driver (who looks along -Z) as-is.
        // Don't rotate it — a rotateY here turns the wheel sideways (edge-on).
        const steer = new THREE.Mesh(
          steerGeo,
          new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.3 }),
        );
        steer.position.fromArray(grip.offset);
        steer.castShadow = true;
        group.add(steer);
        this.steerWheelMesh = steer;
      }
    // Keep generated frame/body parts under a dedicated transform, while wheels
    // remain direct chassis children so wheelbase/track changes reposition them
    // without stretching the tyre geometry. The authored overlay is attached later
    // and intentionally remains independent from both controls.
    const wheelNodes = new Set(this.wheelMeshes.map((wheel) => wheel.userData.suspNode));
    const frameVisual = new THREE.Group();
    frameVisual.name = 'Generated chassis frame';
    for (const child of [...group.children]) {
      if (!wheelNodes.has(child)) frameVisual.add(child);
    }
    group.add(frameVisual);
    this.frameVisual = frameVisual;

    // Per-wheel axle assemblies (chassis-space, NOT under frameVisual, so they are
    // placed directly by the IK solver rather than inheriting the frame scale).
    // Each is a main axle plus two thinner support brackets; positions/orientations
    // are solved in _updateWheelAxles from the live frame + wheel transforms.
    this.wheelAxleGroup = new THREE.Group();
    this.wheelAxleGroup.name = 'Wheel axles';
    group.add(this.wheelAxleGroup);
    this.wheelAxles = [];
    const axleBallGeo = new THREE.SphereGeometry(0.07, 10, 8);
    const makeStrut = (name, radius) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10), darkMetal);
      m.name = name;
      m.castShadow = true;
      this.wheelAxleGroup.add(m);
      return m;
    };
    for (let index = 0; index < this._computeAutoWheels().length; index += 1) {
      const ball = new THREE.Mesh(axleBallGeo, engineMetal);
      ball.name = 'Axle socket';
      ball.castShadow = true;
      this.wheelAxleGroup.add(ball);
      this.wheelAxles.push({
        index,
        axle: makeStrut('Wheel axle', 0.05),
        bracketF: makeStrut('Axle support bracket', 0.032),
        bracketR: makeStrut('Axle support bracket', 0.032),
        ball,
      });
    }

    this.chassisSocket = new THREE.Group();
    this.chassisSocket.name = 'Chassis overlay socket';
    group.add(this.chassisSocket);

    this._applyFrameParameters();
    return group;
  }

  // IK-solve the wheel axle struts: span the CURRENT frame underside (on the side,
  // at each wheel's z) to the CURRENT tyre hub, plus two fore/aft support brackets
  // converging on the hub. Re-run whenever the frame or wheels move
  // (_applyFrameParameters), so it stays correct as ride height / track / wheelbase
  // change instead of being baked at fixed body-box positions.
  _updateWheelAxles() {
    if (!this.wheelAxles?.length || !this.wheelAnchors?.length) return;
    const sv = this.frameVisual;
    const scaleX = sv ? sv.scale.x : 1;
    const scaleY = sv ? sv.scale.y : 1;
    const offY = sv ? sv.position.y : 0;
    // Underside of the side rail, in chassis space (tracks frame scale + lift).
    const frameUndersideY = (this._buildRailY - this._buildRailRadius) * scaleY + offY;
    const halfW = (this.config.ground.wheelWidth ?? 0.3) * 0.5;
    const bracketSpacing = 0.32;
    for (const a of this.wheelAxles) {
      const anchor = this.wheelAnchors[a.index];
      if (!anchor) continue;
      const sgnX = anchor.x < 0 ? -1 : 1;
      const frameX = sgnX * this._buildRailX * scaleX;
      const socketX = anchor.x - sgnX * halfW; // inner hub face, on the side
      const wheelY = this.wheelMeshes[a.index]?.userData.suspNode?.position.y ?? anchor.y;
      _tirePt.set(socketX, wheelY, anchor.z);
      // Main axle: frame underside (at the wheel's z) -> tyre hub.
      _frmPt.set(frameX, frameUndersideY, anchor.z);
      orientStrutBetween(a.axle, _frmPt, _tirePt);
      // Two thinner support brackets braced fore/aft on the frame.
      _frmPt.set(frameX, frameUndersideY, anchor.z - bracketSpacing);
      orientStrutBetween(a.bracketF, _frmPt, _tirePt);
      _frmPt.set(frameX, frameUndersideY, anchor.z + bracketSpacing);
      orientStrutBetween(a.bracketR, _frmPt, _tirePt);
      a.ball.position.copy(_tirePt);
    }
  }

  // ---- wheels --------------------------------------------------------------

  _resolveWheelAnchors() {
    if (this.domain !== VEHICLE_DOMAINS.GROUND) {
      this.wheelAnchors = [];
      return;
    }
    const explicit = this.config.ground.wheels;
    const anchors = explicit ?? this._computeAutoWheels();
    this.wheelAnchors = anchors.map((a) => new THREE.Vector3().fromArray(a));
  }

  _computeAutoWheels() {
    const [sx, sy, sz] = this.config.body.size;
    const inset = this.config.ground.wheelInset;
    const x = sx * 0.5 - inset;
    const z = sz * 0.5 - inset;
    const y = -sy * 0.5; // wheels at the bottom of the chassis
    return [
      [-x, y, -z], // front-left
      [x, y, -z], // front-right
      [-x, y, z], // rear-left
      [x, y, z], // rear-right
    ];
  }

  // Steer toward `autopilot.target` at full throttle. Used by collision-test maps
  // and any other scripted drive-to-point scenarios.
  computeAutopilotControls() {
    const c = makeNeutralControls();
    const target = this.autopilot?.target;
    if (!target || !this.group) return c;

    const pos = this.group.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    c.throttle = this.autopilot.throttle ?? 1;

    const desiredYaw = Math.atan2(-dx, -dz);
    let yawError = desiredYaw - this.group.rotation.y;
    yawError = Math.atan2(Math.sin(yawError), Math.cos(yawError));
    const gain = this.autopilot.steerGain ?? Math.PI / 3;
    c.steer = THREE.MathUtils.clamp(yawError / gain, -1, 1);
    return c;
  }

  // ---- debug ---------------------------------------------------------------

  snapshot() {
    _euler.setFromQuaternion(this.group?.quaternion ?? _quat, 'YXZ');
    return {
      id: this.id,
      name: this.name,
      domain: this.domain,
      status: this.status,
      grounded: this.grounded,
      groundedFraction: Number(this.groundedFraction.toFixed(2)),
      groundSurface: this.groundSurface,
      traction: Number((this.config.ground?.traction ?? 0.55).toFixed(2)),
      surfaceGrip: {
        frictionSlip: Number((this.surfaceTuning.frictionSlip ?? 0).toFixed(3)),
        sideFrictionStiffness: Number((this.surfaceTuning.sideFrictionStiffness ?? 0).toFixed(3)),
      },
      speed: Number(this.speed.toFixed(2)),
      substeps: this._lastSubsteps ?? 1,
      rayCastController: !!this.vehicleController,
      controllerSpeed: Number((this.controllerSpeed ?? 0).toFixed(2)),
      maxWheelSlip: Number(Math.max(0, ...this.wheelTelemetry.map((wheel) => wheel?.slipRatio ?? 0)).toFixed(3)),
      mudIntensity: Number(Math.max(0, ...this.wheelTelemetry.map((wheel) => wheel?.mudIntensity ?? 0)).toFixed(3)),
      wheelMud: this.wheelTelemetry.map((wheel, index) => ({
        index,
        surface: wheel?.surface ?? this.groundSurface,
        intensity: Number((wheel?.mudIntensity ?? 0).toFixed(3)),
        slip: Number((wheel?.slipRatio ?? 0).toFixed(3)),
        load: Number((wheel?.normalizedLoad ?? 0).toFixed(3)),
        rutDepth: Number((wheel?.rutDepth ?? 0).toFixed(3)),
        contactTransition: wheel?.contactTransition ?? 'unknown',
      })),
      dust: this.tireEffects?.dust?.snapshot?.() ?? null,
      mudSplash: this.tireEffects?.mudSplash?.snapshot?.() ?? null,
      glassBurst: this.tireEffects?.glassBurst?.snapshot?.() ?? null,
      tractionControlActive: this.wheelTelemetry.some((wheel) => wheel?.tractionControl === true),
      absActive: this.wheelTelemetry.some((wheel) => wheel?.abs === true),
      groundSpeed: Number(Math.hypot(this.linearVelocity.x, this.linearVelocity.z).toFixed(2)),
      throttle: Number((this._smoothed.throttle ?? 0).toFixed(3)),
      position: this.group
        ? {
            x: Number(this.group.position.x.toFixed(2)),
            y: Number(this.group.position.y.toFixed(2)),
            z: Number(this.group.position.z.toFixed(2)),
          }
        : null,
      yawDeg: Number(THREE.MathUtils.radToDeg(_euler.y).toFixed(1)),
      steer: this.steerTelemetry
        ? {
            input: Number(this.steerTelemetry.steer.toFixed(2)),
            authority: Number(this.steerTelemetry.authority.toFixed(2)),
            targetYawRate: Number(this.steerTelemetry.targetYawRate.toFixed(2)),
            actualYawRate: Number(this.steerTelemetry.actualYawRate.toFixed(2)),
          }
        : null,
      occupied: this.occupants.some((o) => o != null),
      hasDriver: this.hasDriver(),
      damage: this.damage
        ? {
            engineHealth: Number(this.damage.engineHealth.toFixed(2)),
            enginePowerScale: Number(this.enginePowerScale.toFixed(2)),
            maxSpeedScale: Number(this.maxSpeedScale.toFixed(2)),
            bumpers: { ...this.damage.bumpers },
            impacts: this.damage.impactCount,
          }
        : null,
      chassisOverlay: this.getChassisOverlayTransform(),
      frameParameters: this.getFrameParameters(),
    };
  }
}

// ---- helpers ---------------------------------------------------------------

function optionComponent(value, key, index) {
  const component = Array.isArray(value) ? value[index] : value?.[key];
  const number = Number(component);
  return Number.isFinite(number) ? number : null;
}

function shortestAngleDelta(to, from) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function copyRapierVector(value, target = null) {
  if (!value) return null;
  const vector = target ?? new THREE.Vector3();
  return vector.set(value.x, value.y, value.z);
}

function normalizeChassisOverlayOptions(overrides = {}) {
  const chassisSurfaceMode = resolveChassisSurfaceMode(overrides);
  return {
    url: overrides.url ?? DEFAULT_CHASSIS_OVERLAY.url,
    profileId: typeof overrides.profileId === 'string' ? overrides.profileId : null,
    disableGlassDetection: overrides.disableGlassDetection === true,
    chassisSurfaceMode,
    useAuthoredTexture: chassisSurfaceMode !== 'metallic',
    position: vectorToArray(overrides.position, DEFAULT_CHASSIS_OVERLAY.position),
    rotationDegrees: vectorToArray(
      overrides.rotationDegrees,
      DEFAULT_CHASSIS_OVERLAY.rotationDegrees,
    ),
    scale: scaleToArray(overrides.scale, DEFAULT_CHASSIS_OVERLAY.scale),
  };
}

function vectorToArray(value, fallback) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') {
    return [
      value.x ?? fallback[0],
      value.y ?? fallback[1],
      value.z ?? fallback[2],
    ];
  }
  return [...fallback];
}

function scaleToArray(value, fallback) {
  if (Number.isFinite(Number(value))) {
    const uniform = Number(value);
    return [uniform, uniform, uniform];
  }
  return vectorToArray(value, fallback);
}

function vectorSnapshot(vector) {
  const clean = (value) => Number(value.toFixed(4));
  return { x: clean(vector.x), y: clean(vector.y), z: clean(vector.z) };
}

function setVectorComponents(target, value) {
  if (!value) return;
  for (const [key, index] of [['x', 0], ['y', 1], ['z', 2]]) {
    const component = optionComponent(value, key, index);
    if (component != null) target[key] = component;
  }
}

function addVectorComponents(target, value) {
  if (!value) return;
  for (const [key, index] of [['x', 0], ['y', 1], ['z', 2]]) {
    const component = optionComponent(value, key, index);
    if (component != null) target[key] += component;
  }
}

function setEulerDegrees(target, value) {
  if (!value) return;
  for (const [key, index] of [['x', 0], ['y', 1], ['z', 2]]) {
    const component = optionComponent(value, key, index);
    if (component != null) target[key] = THREE.MathUtils.degToRad(component);
  }
}

function addEulerDegrees(target, value) {
  if (!value) return;
  for (const [key, index] of [['x', 0], ['y', 1], ['z', 2]]) {
    const component = optionComponent(value, key, index);
    if (component != null) target[key] += THREE.MathUtils.degToRad(component);
  }
}

function setScale(target, value) {
  if (Number.isFinite(Number(value))) {
    target.setScalar(Number(value));
    return;
  }
  setVectorComponents(target, value);
}

function multiplyScale(target, value) {
  if (Number.isFinite(Number(value))) {
    target.multiplyScalar(Number(value));
    return;
  }
  if (!value) return;
  for (const [key, index] of [['x', 0], ['y', 1], ['z', 2]]) {
    const component = optionComponent(value, key, index);
    if (component != null) target[key] *= component;
  }
}

export function makeNeutralControls() {
  return {
    throttle: 0, // -1 reverse .. 1 forward
    steer: 0, // -1 left .. 1 right (ground/water yaw)
    brake: 0, // 0..1
    handbrake: false,
    pitch: 0, // -1..1 (air)
    roll: 0, // -1..1 (air)
    yaw: 0, // -1..1 (air rudder)
    boost: false,
    vertical: 0, // -1..1 (VTOL / submarine, reserved)
  };
}

/** Undriven ground vehicles: full service brake + handbrake so they stay put on slopes. */
export function makeParkedControls() {
  return {
    ...makeNeutralControls(),
    brake: 1,
    handbrake: true,
  };
}

export function vehicleControlsRequestWake(controls) {
  if (!controls) return false;
  return Math.abs(controls.throttle ?? 0) > 0.001
    || Math.abs(controls.steer ?? 0) > 0.001
    || Math.abs(controls.brake ?? 0) > 0.001
    || Math.abs(controls.pitch ?? 0) > 0.001
    || Math.abs(controls.roll ?? 0) > 0.001
    || Math.abs(controls.yaw ?? 0) > 0.001
    || Math.abs(controls.vertical ?? 0) > 0.001
    || controls.handbrake === true
    || controls.boost === true;
}

function approach(current, target, rate, dt) {
  if (!Number.isFinite(rate) || rate <= 0) {
    return target;
  }
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// Reads body transform + velocities into the shared scratch vectors and derives
// the local axis vectors in world space.
function readBodyFrame(body) {
  const t = body.translation();
  const r = body.rotation();
  const v = body.linvel();
  const w = body.angvel();
  _pos.set(t.x, t.y, t.z);
  _quat.set(r.x, r.y, r.z, r.w);
  _linvel.set(v.x, v.y, v.z);
  _angvel.set(w.x, w.y, w.z);
  _forward.copy(FORWARD).applyQuaternion(_quat);
  _right.copy(RIGHT).applyQuaternion(_quat);
  _up.copy(UP).applyQuaternion(_quat);
}

function bodyMass(body, config) {
  const m = body.mass?.();
  if (Number.isFinite(m) && m > 0) {
    return m;
  }
  return config.body.massOverride ?? 1000;
}

function toRapier(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function quatToRapier(q) {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function createSurfaceMaterial(kind, {
  fallbackColor = 0xffffff,
  roughness = 0.7,
  metalness = 0,
  repeat = [4, 4],
  bumpScale = 0.02,
} = {}) {
  // Small deterministic data textures keep the vehicle self-contained while
  // still feeding real color/roughness/bump samples through MeshStandardMaterial.
  const size = 64;
  const colorData = new Uint8Array(size * size * 4);
  const surfaceData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const n = surfaceNoise(x, y, kind.length * 97);
      const fine = surfaceNoise(x * 3, y * 3, kind.length * 193);
      const sample = surfaceSample(kind, x, y, n, fine);
      colorData[i] = sample.color[0];
      colorData[i + 1] = sample.color[1];
      colorData[i + 2] = sample.color[2];
      colorData[i + 3] = 255;
      surfaceData[i] = sample.height;
      surfaceData[i + 1] = sample.roughness;
      surfaceData[i + 2] = sample.height;
      surfaceData[i + 3] = 255;
    }
  }

  const colorMap = new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  configureSurfaceTexture(colorMap, repeat);
  const surfaceMap = new THREE.DataTexture(surfaceData, size, size, THREE.RGBAFormat);
  configureSurfaceTexture(surfaceMap, repeat);

  return new THREE.MeshStandardMaterial({
    color: fallbackColor,
    map: colorMap,
    roughness,
    roughnessMap: surfaceMap,
    metalness,
    bumpMap: surfaceMap,
    bumpScale,
  });
}

function configureSurfaceTexture(texture, repeat) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.needsUpdate = true;
}

function surfaceSample(kind, x, y, noise, fine) {
  if (kind === 'rust') {
    const chip = noise > 0.83;
    const deepRust = fine > 0.91;
    return {
      color: deepRust ? [58, 31, 23] : chip ? [176, 76, 34] : [113 + noise * 25, 48 + fine * 14, 35 + noise * 8],
      roughness: chip ? 248 : 195 + fine * 42,
      height: chip ? 105 + fine * 45 : 150 + noise * 45,
    };
  }
  if (kind === 'rubber') {
    const tread = ((x + Math.floor(y / 3) * 2) % 9) < 3;
    return {
      color: tread ? [12, 13, 13] : [25 + fine * 8, 26 + fine * 8, 27 + fine * 8],
      roughness: 232 + noise * 20,
      height: tread ? 80 : 185 + fine * 35,
    };
  }
  if (kind === 'leather') {
    const crease = Math.abs(Math.sin((x + noise * 7) * 0.32) * Math.cos((y + fine * 5) * 0.21));
    return {
      color: [42 + noise * 17, 37 + noise * 12, 34 + noise * 10],
      roughness: 182 + fine * 48,
      height: 125 + crease * 65,
    };
  }
  if (kind === 'fabric') {
    const weave = (x % 4 < 2) === (y % 4 < 2);
    return {
      color: weave ? [174, 43, 34] : [118, 27, 24],
      roughness: 225 + noise * 24,
      height: weave ? 185 : 105,
    };
  }
  if (kind === 'engine') {
    const grime = noise > 0.88 || (y > 48 && fine > 0.62);
    return {
      color: grime ? [48, 45, 39] : [119 + fine * 45, 122 + fine * 42, 119 + fine * 38],
      roughness: grime ? 230 : 105 + noise * 65,
      height: 145 + fine * 65,
    };
  }

  const scratch = (x + Math.floor(noise * 5)) % 19 === 0;
  return {
    color: scratch ? [91, 93, 91] : [42 + fine * 22, 45 + fine * 22, 46 + fine * 22],
    roughness: scratch ? 130 : 165 + noise * 55,
    height: scratch ? 90 : 150 + fine * 45,
  };
}

function surfaceNoise(x, y, seed) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 0.137) * 43758.5453;
  return value - Math.floor(value);
}

// Generate a CanvasTexture for the tire: central tread area + sidewall bands
// near each edge of the cylinder (visible when looking at the wheel from the side).
// The texture is repeated around the circumference.
function createTireTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  // Very dark rubber base
  ctx.fillStyle = '#151517';
  ctx.fillRect(0, 0, size, size);

  const sidewallHeight = Math.floor(size * 0.22);

  // Sidewall zones (top and bottom of the texture = the two sides of the tire)
  ctx.fillStyle = '#222225';
  ctx.fillRect(0, 0, size, sidewallHeight);
  ctx.fillRect(0, size - sidewallHeight, size, sidewallHeight);

  // Sidewall surface details (subtle rings + small blocks for that molded look)
  ctx.fillStyle = '#2a2a2d';
  for (let i = 0; i < 5; i++) {
    const y1 = Math.floor(sidewallHeight * (0.2 + i * 0.13));
    const y2 = size - sidewallHeight + Math.floor(sidewallHeight * (0.15 + i * 0.13));
    ctx.fillRect(0, y1, size, 4);
    ctx.fillRect(0, y2, size, 4);
  }

  // Small "nubs" or branding simulation on the sidewalls
  ctx.fillStyle = '#1c1c1f';
  for (let x = 8; x < size; x += 22) {
    for (let k = 0; k < 3; k++) {
      const yy = Math.floor(sidewallHeight * (0.35 + k * 0.22));
      ctx.fillRect(x, yy, 9, 6);
      ctx.fillRect(x, size - sidewallHeight - yy - 6, 9, 6);
    }
  }

  // Central tread band
  ctx.fillStyle = '#0f0f11';
  ctx.fillRect(0, sidewallHeight, size, size - sidewallHeight * 2);

  // Longitudinal grooves (the main tread channels)
  ctx.strokeStyle = '#070709';
  ctx.lineWidth = 7;
  const numGrooves = 6;
  for (let g = 0; g < numGrooves; g++) {
    const gx = Math.floor(((g + 0.5) / numGrooves) * size);
    ctx.beginPath();
    ctx.moveTo(gx, sidewallHeight + 2);
    ctx.lineTo(gx, size - sidewallHeight - 2);
    ctx.stroke();
  }

  // Transverse sipes / blocks for realistic tread
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const blockW = 11;
  for (let x = 4; x < size; x += 17) {
    for (let y = sidewallHeight + 8; y < size - sidewallHeight - 8; y += 19) {
      if (((x + y) & 7) > 3) {
        ctx.fillRect(x, y, blockW, 7);
      }
    }
  }

  // Bevel lines where sidewall meets tread
  ctx.strokeStyle = '#111113';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, sidewallHeight);
  ctx.lineTo(size, sidewallHeight);
  ctx.moveTo(0, size - sidewallHeight);
  ctx.lineTo(size, size - sidewallHeight);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(5, 1); // tread repeats around the tire, sidewalls stay at the edges
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Generate a CanvasTexture for the wheel rim / hubcap (applied to the cylinder caps).
// Classic stepped design with rings, lugs, center, and one offset detail so spinning
// is obvious.
function createRimTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  const cx = size * 0.5;
  const cy = size * 0.5;
  const maxR = size * 0.475;

  // Base brushed / metallic silver with radial gradient for depth
  const g = ctx.createRadialGradient(
    cx - 18, cy - 22, maxR * 0.15,
    cx + 12, cy + 14, maxR * 1.05
  );
  g.addColorStop(0, '#e6e8eb');
  g.addColorStop(0.35, '#b8bbc0');
  g.addColorStop(0.6, '#7a7d82');
  g.addColorStop(0.82, '#55585c');
  g.addColorStop(1, '#3f4145');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.fill();

  // Outer lip / bead that meets the tire
  ctx.strokeStyle = '#2a2b2e';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.stroke();

  // Several concentric hubcap steps (classic look)
  const rings = [0.88, 0.73, 0.57, 0.40, 0.23];
  ctx.strokeStyle = '#3a3c40';
  ctx.lineWidth = 3.5;
  rings.forEach(f => {
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Inner highlight rings for polish
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  rings.forEach(f => {
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * f - 2, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Lug bolts / nuts (5 typical)
  const boltOrbit = maxR * 0.60;
  const boltCount = 5;
  const boltSize = maxR * 0.065;
  for (let i = 0; i < boltCount; i++) {
    const a = (i / boltCount) * (Math.PI * 2) + 0.55;
    const bx = cx + Math.cos(a) * boltOrbit;
    const by = cy + Math.sin(a) * boltOrbit;

    // dark bolt head
    ctx.fillStyle = '#1f2124';
    ctx.beginPath();
    ctx.arc(bx, by, boltSize, 0, Math.PI * 2);
    ctx.fill();

    // inner ring / recess
    ctx.fillStyle = '#2f3135';
    ctx.beginPath();
    ctx.arc(bx, by, boltSize * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // tiny center dot
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(bx, by, boltSize * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  // Center cap / hub
  ctx.fillStyle = '#2c2e31';
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.175, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#484a4e';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.175, 0, Math.PI * 2);
  ctx.stroke();

  // Small inner detail on center
  ctx.fillStyle = '#1a1b1d';
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.065, 0, Math.PI * 2);
  ctx.fill();

  // One asymmetric detail (small bright tab / valve mark) so you can see the wheel spin
  ctx.fillStyle = '#d4d6da';
  const tabAngle = 2.35;
  const tabDist = maxR * 0.78;
  const tx = cx + Math.cos(tabAngle) * tabDist;
  const ty = cy + Math.sin(tabAngle) * tabDist;
  ctx.beginPath();
  ctx.arc(tx, ty, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // Very subtle outer ring highlight for rim definition
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.93, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function overlayHasTripoPartNames(root) {
  let found = false;
  root.traverse((node) => {
    if (node.name?.startsWith?.('tripo_part_')) found = true;
  });
  return found;
}

function disposeObject(object) {
  if (!object) {
    return;
  }
  object.traverse?.((child) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach(disposeMaterial);
      } else {
        disposeMaterial(material);
      }
    }
  });
}

function disposeMaterial(material, { preserveMaps = false } = {}) {
  if (!material) return;
  if (!preserveMaps) {
    material.map?.dispose?.();
    material.roughnessMap?.dispose?.();
    if (material.bumpMap !== material.roughnessMap) material.bumpMap?.dispose?.();
    material.normalMap?.dispose?.();
    material.metalnessMap?.dispose?.();
  }
  material.dispose?.();
}
