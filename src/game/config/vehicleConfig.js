// Opinionated defaults for the vehicle base class (BaseVehicle / VehicleSystem).
//
// Design stance:
//  - Every vehicle is a *dynamic* Rapier rigid body (a "chassis"). The base class
//    applies forces/torques before the shared world.step() and reads the resulting
//    transform after — exactly the "apply before step, sync after" rhythm the rest
//    of the simulation uses (rope, telekinesis chunks).
//  - Drive models are split by `domain`: 'ground' (raycast suspension + tyre grip),
//    'air' (thrust + lift + control-surface torques), 'water' (buoyancy + planing).
//    The base class ships all three; a concrete vehicle (car/tank/plane/boat) mostly
//    supplies a model, a collider size, a seat layout, and a few tuning overrides.
//  - Force tuning values below are MASS-NORMALISED: they are accelerations (m/s^2) or
//    rates (1/s), and the base class multiplies them by the body's mass when applying
//    `addForce`. That keeps a light motorcycle and a heavy tank tunable with the same
//    numbers — only the collider/density changes the feel implicitly.

import * as THREE from 'three';

export const VEHICLE_DOMAINS = Object.freeze({
  GROUND: 'ground',
  AIR: 'air',
  WATER: 'water',
});

// Ground-car speed cap — sim uses m/s; the HUD shows km/h.
export const GROUND_VEHICLE_MAX_SPEED_MS = (200 * 1609.344) / 3600; // 200 mph ≈ 89.41 m/s

export const DEFAULT_VEHICLE_CONFIG = {
  domain: VEHICLE_DOMAINS.GROUND,

  // Layered in-cabin engine audio profile ('bac' | 'boxer' | 'quad' | 'electric'). See engineProfiles.js.
  engineProfile: 'bac',

  // Chassis collider + inertia. `density` drives mass (mass = density * volume) unless
  // `massOverride` is set. Friction is intentionally low; lateral grip is modelled
  // explicitly per-domain so the collider doesn't fight the drive model on slopes.
  body: {
    size: [2.0, 0.9, 4.2], // full extents (x = width, y = height, z = length)
    density: 18,
    massOverride: null,
    friction: 0.55,
    restitution: 0.0,
    contactSkin: 0.02,
    // Lower the visual/collider center a touch so the body resists rolling. Applied
    // as an additional mass-properties COM offset when the runtime supports it.
    centerOfMassOffset: [0, -0.35, 0.14], // slight rear bias for RWD weight transfer
  },

  // Baseline damping. Per-domain integrators add their own drag on top of this; these
  // values mostly keep an undriven/parked vehicle from drifting or spinning forever.
  damping: {
    // Low linear damping so high-speed drag doesn't cap the top end short of the
    // 150 mph soft cap (the raycast controller's tyre friction holds a parked car,
    // so it doesn't need damping to stop drifting).
    linear: 0.03,
    angular: 0.65, // lower = less rotational drag (looser turn carry)
  },

  spawn: {
    canSleep: true, // parked vehicles settle instead of being re-awakened forever
    // Continuous-collision detection on the dynamic chassis so it cannot tunnel
    // thin static colliders (e.g. the 0.6 m bridge deck) at speed / under a frame
    // hitch. Hard CCD only; add softCcdPrediction here only if seam tests still drop.
    ccdEnabled: true,
    // Soft CCD uses predictive constraints instead of harsh shape-cast hits on
    // thin deck segments — reduces the speed wobble / rubber-band feel at highway
    // pace while hard CCD remains the tunneling backstop. ~maxSpeed * max frame dt.
    softCcdPrediction: GROUND_VEHICLE_MAX_SPEED_MS * 0.05,
  },

  // Control input smoothing (rate of an exponential approach toward the raw target).
  // Higher = snappier. Steering is smoothed harder than throttle for stability.
  controls: {
    // Keyboard steering is binary, so a slower ramp prevents a tap from producing
    // an immediate chassis rotation while still reaching full lock when held.
    // Slightly softer than a pure digital snap so chassis yaw eases through corners.
    steerSmoothing: 3.1,
    throttleSmoothing: 5,
    pitchSmoothing: 6,
    rollSmoothing: 6,
    yawSmoothing: 6,
  },

  // Seats: the first `isDriver` seat receives control input. Offsets are local-space
  // (meters) relative to the chassis origin, and describe where the rider's HIPS
  // land (the base class hip-anchors the occupant, like the horse saddle).
  //  - `facing` (radians): yaw offset from "facing the travel direction". 0 = the
  //    rider looks forward along the chassis nose. (The character model faces +Z
  //    while the chassis drives toward -Z, so the base flip is handled internally.)
  //  - `handGrip`: optional steering-wheel / yoke attachment for hand IK. `offset`
  //    is chassis-local (where the wheel center sits) and `spacing` is the hand
  //    separation. Omit for passenger seats that don't hold a wheel.
  seats: [
    {
      name: 'driver',
      // Left-hand-drive layout. The chassis travels toward local -Z, making -X
      // the driver's side.
      offset: [-0.48, 0.4, 0.5],
      facing: 0,
      isDriver: true,
      handGrip: { offset: [-0.48, 0.74, -0.04], spacing: 0.34 },
    },
    {
      name: 'front-passenger',
      offset: [0.48, 0.4, 0.5],
      facing: 0,
      isDriver: false,
    },
    {
      name: 'rear-left-passenger',
      offset: [-0.48, 0.4, 1.35],
      facing: 0,
      isDriver: false,
    },
    {
      name: 'rear-right-passenger',
      offset: [0.48, 0.4, 1.35],
      facing: 0,
      isDriver: false,
    },
  ],

  // Where the player is ejected on exit (local-space, projected to ground).
  exitOffset: [-1.6, 0.0, 0.0],

  // ---- RUN-OVER: flinging enemies the car hits ---------------------------------
  // When a driven GROUND vehicle moving above `minSpeed` overlaps a live (squishy)
  // enemy's footprint, the enemy is converted to a full-body ragdoll and launched.
  // Launch velocity (m/s) = travelDir * (speed * forwardScale + forwardBase)
  //   + worldUp * (speed * upScale + upBase) + sideways kick away from chassis centre.
  // So faster impacts throw enemies harder and higher ("up and over the car").
  runOver: {
    enabled: true,
    minSpeed: 3.5, // m/s; below this the car just bumps them (no ragdoll launch)
    clearance: 0.4, // extra margin (m) added to the chassis footprint for the hit test
    verticalMargin: 0.4, // slack (m) on the chassis-vs-enemy vertical overlap test
    forwardScale: 0.85, // launch carried along travel dir, proportional to speed
    forwardBase: 3, // baseline forward launch (m/s) even at minSpeed
    upScale: 0.55, // upward launch proportional to speed
    upBase: 7, // baseline upward launch (m/s) — they always pop into the air
    sideKick: 2.5, // lateral fling away from the chassis centreline (m/s)
    maxPerFrame: 2, // cap ragdoll spawns/frame so ploughing a crowd can't spike
  },

  // Collision damage is driven by the horizontal velocity discontinuity between
  // physics steps. Thresholds are delta-velocity in m/s, so tuning is independent
  // of chassis mass.
  damage: {
    enabled: true,
    minImpactDeltaV: 2.8,
    maxUpFraction: 0.6,
    tiers: { fender: 3, crumple: 7, severe: 14 },
    deformRadius: 1.1,
    depthPerDeltaV: 0.035,
    bendUp: 0.45,
    maxCrumpleDepth: { front: 0.55, rear: 0.5, side: 0.3 },
    engineDamagePerDeltaV: 0.045,
    limpPowerFloor: 0.3,
    limpSpeedFloor: 0.4,
    bumperDetachDepth: 0.35,
    bumperDropSpeed: 22,
    bumperLifeSeconds: 15,
    cooldown: 0.25,
  },

  // ---- GROUND: arcade raycast suspension ---------------------------------------
  // Per-wheel downward rays apply spring/damper forces (handles slopes, kerbs, flips,
  // landings). Drive/grip/steer are applied at the body for stability and feel.
  ground: {
    // null => auto four-corner layout derived from body.size. Otherwise an array of
    // [x, y, z] local anchor points (one ray per entry).
    wheels: null,
    wheelInset: 0.12, // how far in from the body corners the auto wheels sit
    wheelRadius: 0.38,
    // Physical wheel colliders: four spherical proxies near the wheel anchors that
    // are the car's ground contact instead of the flat chassis box. The box's flat
    // bottom catches terrain peaks and launches the car (the root cause of off-road
    // bounce); a round collider glides over the same peaks. They are fixed to the
    // chassis, so they SLIDE rather than spin (hence wheelFriction ~0 — any higher
    // is drag that stalls the car; drive is a force on the body via enginePower).
    // They are now RECESSED hard-stops, not the primary support: the raycast spring
    // CARRIES the car (so each wheel has real travel and can compress into its well
    // independently — see wheelColliderRadius), and the round balls only catch hard
    // compressions/landings so the box never reaches a peak. Set false for box-only
    // contact (legacy).
    wheelColliders: true,
    wheelWidth: 0.3, // visual tyre width; collision uses a rimless sphere
    // Collision radius of the recessed hard-stop balls. SMALLER than the visual
    // wheelRadius so the balls hang above the ground at the spring ride height,
    // leaving ~(rideHeight - this) of compression travel before they bottom out.
    // Too large and the car rests on the balls (no travel); too small and a sharp
    // peak can reach the box before a ball rounds it.
    wheelColliderRadius: 0.26,
    // Friction of the wheel colliders. They slide (no spinning axle), so friction
    // here is pure drag — keep it ~0. Drive comes from engineForce on the body, not
    // wheel traction; raise only if the car slides uncontrollably on slopes.
    wheelFriction: 0.08,

    // The spring CARRIES the car (it is not a bump trim on top of rigid wheel
    // colliders), which is what gives each wheel real, independent travel; the
    // recessed balls (wheelColliderRadius) only hard-stop big compressions. The four
    // wheels share the load, so the settled compression is small (sag = g /
    // (4 * stiffness) ≈ 0.07 m) and the ride height stays near the original. Damping
    // is raised vs a pure bump-trim so the weight-bearing spring doesn't bob at
    // speed. NOTE: because the spring (not a rigid ball) is now the contact, the car
    // can launch off sharp peaks on rough terrain — an accepted trade for visible
    // per-wheel suspension (see the verify-vehicle-suspension launch test).
    suspension: {
      restLength: 0.45, // spring free length; settled ride ≈ restLength - sag (~0.38)
      maxTravel: 0.32, // compression allowed below restLength (also the droop range)
      rayUpOffset: 0.3, // cast starts this far above the wheel anchor
      stiffness: 34, // spring accel per meter of compression (x mass)
      // Raised 8 -> 12 to settle terrain-following bounce faster while driving over
      // rolling procedural terrain (the residual "tiny jump" once the streaming
      // frame-hitch was fixed). The heave mode is already overdamped;
      // the extra damping mainly kills the rebound velocity when a launched wheel
      // lands, without changing the compression spring / maxForceScale that provide
      // the deliberate per-wheel travel + peak-launch behaviour. Still well clear of
      // numerical trouble even at the 0.05s dt ceiling (damping*dt = 0.6 < 1).
      damping: 12, // damper accel per (m/s) of compression velocity (x mass)
      maxForceScale: 14, // clamp suspension accel to this * mass
    },

    // Rapier raycast vehicle controller (DynamicRayCastVehicleController). When on,
    // the wheels are RAY-CASTS with integrated suspension — there are NO rigid wheel
    // colliders, so the chassis never takes a normal-impulse launch off terrain
    // peaks (the high-speed "pop" the recessed balls caused). Replaces the custom
    // force-spring + wheel balls + the world substep on the ground path. The legacy
    // model is kept (useRayCastController:false) for comparison/regression.
    useRayCastController: true,
    // Handling model for the raycast controller path:
    //   'controller'      — original friction scalars + body-level helpers
    //   'controller-slip' — slip-modulated tyre model + load/ARB + drift assist +
    //                       powertrain/diff (docs/vehicle-advanced-suspension-plan.md)
    handlingModel: 'controller-slip',
    // Slip-angle tyre model (M1). Surfaces scale mu0* / K*; controller path maps
    // the envelope onto setWheelFrictionSlip / setWheelSideFrictionStiffness.
    // British spelling `tyre` matches the plan doc (TireEffects keeps US `tire`).
    // alphaPeakDeg 14° (vs plan ~8°): intentional Tier-A tradeoff so mid-speed
    // closed-loop steer keeps geometric yaw on asphalt; dirt/mud peak later.
    tyre: {
      vFloor: 2.0,
      blendBelow: 1.5,
      mu0Long: 1.6,
      mu0Lat: 1.7,
      muRefLong: 1.6,
      muRefLat: 1.7,
      kLoad: 0.15,
      Fz0: 0.25,
      long: { K: 9.0, scale: 8.0, kappaPeak: 0.18 },
      lat: { K: 10.0, alphaPeakDeg: 14 },
      combinedEllipse: true,
      residualMin: 0.38,
      controllerLongGain: 1.0,
      // Slightly under 1 keeps highway yaw under the steer-verify ceiling while
      // mid-speed closed-loop still clears the floor.
      controllerLatGain: 0.95,
    },
    // Named handling presets (merge onto ground). 'sim' = assist off, steeper falloff.
    handlingPresets: {
      simcade: {},
      sim: {
        driftAssist: { enabled: false, strength: 0 },
        tyre: { residualMin: 0.22, kLoad: 0.18, lat: { alphaPeakDeg: 10, K: 12 } },
      },
    },
    // Geometric load transfer + ARB balance (M2).
    loadTransfer: {
      useGeometric: true,
      hCG: 0.55,
      blendSusp: 0.5,
    },
    antiRoll: {
      front: 0.6, // stiffer front → understeer-safe default
      rear: 0.45,
      rollDamp: 2.5,
      rollStiffness: 18,
    },
    // Progressive spring + slow/fast damper via per-step controller setters (M3).
    suspensionDynamics: {
      enabled: true,
      spring: {
        k: 24,
        progressiveStart: 0.7,
        progressiveRate: 1.6,
        bumpStopStart: 0.85,
        bumpStopK: 6,
        bumpStopDamp: 0.4,
      },
      damper: {
        vKnee: 0.5,
        cLowBump: 5,
        cHighBump: 14,
        cLowRebound: 7,
        cHighRebound: 10,
      },
      maxForceCap: 4000,
    },
    // Arcade drift assist (M4) — ON by default (sim-cade / V-Rally target).
    driftAssist: {
      enabled: true,
      strength: 1.0,
      countersteerMax: 0.35,
      slipTriggerDeg: 12,
      yawTargetGain: 1.2,
      recoveryEnvelopeDeg: 45,
      recoveryGripBoost: 0.45,
      throttleBiasGain: 0.15,
      targetSlipDeg: 22,
      minSpeed: 4,
    },
    // Engine curve + gears + clutch (M5). Replaces flat enginePower when
    // handlingModel is controller-slip and powertrain.enabled.
    powertrain: {
      enabled: true,
      // driveLayout lives on ground.driveLayout; powertrain may override.
      engine: {
        idleRPM: 900,
        peakRPM: 6000,
        redline: 7200,
        peakTorque: 220,
        idleTorqueFrac: 0.55,
        redlineTorqueFrac: 0.72,
      },
      gears: [3.5, 2.1, 1.45, 1.05, 0.82],
      finalDrive: 3.9,
      shiftTime: 0.18,
      autoShift: true,
      upshiftRPM: 6400,
      downshiftRPM: 2200,
      clutch: { slipGain: 4.0, maxLock: 1.0 },
      forceScale: 1.0,
      wheelRadius: 0.38,
    },
    differentials: {
      centre: { type: 'lsd', bias: 0.55 },
      front: { type: 'lsd', bias: 0.4 },
      rear: { type: 'lsd', bias: 0.5 },
    },
    rayCast: {
      // The rigid chassis is an obstacle/crash envelope, not a road-contact skid
      // plate. Keep its floor above the road through the ENTIRE suspension stroke
      // and pull its nose behind the front axle. Otherwise a heightfield chunk
      // edge or tiny deck seam can hit the leading lower edge at highway speed;
      // CCD then correctly treats that edge as a wall and converts the car's
      // forward velocity into an instant stop + forward flip. The ray wheels own
      // all ordinary ground contact. Mass is still derived from body.size below,
      // so these dimensions do not make the car lighter.
      chassisColliderSize: [2.0, 0.5, 4.2],
      chassisColliderOffset: [0, 0.25, 0.12],
      connectionHeight: -0.05, // wheel suspension top, chassis-local Y (above the floor box)
      wheelRadius: 0.38,
      // Extra ride height/travel keeps the chassis box off short terrain peaks.
      // Strong bump/rebound damping prevents a short high-speed compression from
      // becoming upward launch velocity, while the lower spring rate keeps travel.
      // Slightly softer spring + firmer dampers settle rolling terrain faster so
      // the visual chassis tracks the world more smoothly at speed.
      suspensionRestLength: 0.4,
      suspensionStiffness: 22,
      suspensionCompression: 13.5,
      suspensionRelaxation: 13.5,
      // ≤ restLength − 0.02 (SuspensionModel clamps travel so rest stays positive).
      maxSuspensionTravel: 0.38,
      // N cap on a wheel's suspension force. This is the launch limiter: when a
      // wheel ray suddenly reads deep compression (heightfield pops in under the
      // car, seam lip at a chunk boundary, hard landing) the controller applies
      // force*dt straight to chassis velocity. At ~136 kg chassis mass the old
      // 100000 cap allowed ~12 m/s of Δv per wheel in ONE 16 ms step — the
      // "hit something invisible, car flips and flies" spike. 4000 N still holds
      // ~12 g across four wheels (firm landings stay supported) but bounds any
      // single-step kick to ~0.5 m/s per wheel.
      maxSuspensionForce: 4000,
      frictionSlip: 2.0, // tyre longitudinal grip (too high can flip)
      sideFrictionStiffness: 0.9, // less lateral trip force during abrupt corrections
      tractionControl: true,
      tractionSlipThreshold: 0.32,
      abs: true,
      absMinSpeed: 4,
      absSlipThreshold: 0.48,
      absReleaseScale: 0.25,
      // Physical steering targets a bounded yaw rate using the bicycle model.
      // This makes wheel lock shrink with speed instead of making yaw sensitivity
      // grow linearly with speed (particularly important for binary A/D input).
      maxSteerAngle: 0.4,
      steerWheelbase: 3.5,
      maxSteerYawRate: 0.75,
      highSpeedSteerYawRate: 0.42,
      steerTaperAt: 8,
      steerTaperEnd: 35,
      // The controller steers via wheel angle, which needs forward motion to rotate
      // the car. Add a fading yaw torque below this speed (m/s) so the arcade car
      // stays responsive / can pivot at low speed; above it the wheel steering
      // (realistic, no launch) takes over.
      yawAssistMaxSpeed: 10,
      // Boost on the low-speed yaw-assist torque so it overcomes the controller's
      // tyre side-friction and pivots the car (arcade responsiveness).
      yawAssistStrength: 2.2,
      // Weight sag (m) the suspension settles under gravity. Subtracted from the
      // spawn ride height so the car spawns AT its settled height (no drop-in
      // transient that reads as a vertical "bounce" on the first second).
      settleSag: 0.12,
    },

    // Which axle(s) receive engine torque. 'rwd' applies drive at the rear
    // contact points (addForceAtPoint) so throttle pushes the tail and the car
    // rotates under power in a turn; 'fwd' / 'awd' split or front-drive instead.
    driveLayout: 'rwd', // 'rwd' | 'fwd' | 'awd'

    enginePower: 7.5, // quick muscle-car launch without hypercar/rocket acceleration
    // Start easing engine force earlier so 120–150 mph takes commitment instead of
    // arriving almost as quickly as the initial acceleration. Power still fades to
    // zero just beyond maxSpeed, so the configured 150 mph remains reachable.
    engineTaperBand: 0.32,
    // Leave enough force near the cap to overcome chassis drag. The hard speed
    // limiter still prevents exceeding maxSpeed; this only avoids asymptoting low.
    engineTaperEndScale: 1.12,
    brakeForce: 22, // deceleration accel under brake (x mass)
    reverseScale: 0.45, // reverse is weaker than forward
    maxSpeed: GROUND_VEHICLE_MAX_SPEED_MS, // 150 mph soft cap (drive force tapers past this)
    maxReverseSpeed: 9,
    rollingResistance: 0.65, // passive forward drag rate (1/s)
    // Garage "Traction" stat (0.4–1.0). 0.55 = authored dirt/mud profiles unchanged;
    // higher = more grip and less rolling drag on loose surfaces (faster in mud/dirt).
    traction: 0.55,

    // Surface profiles are sampled from the level road corridor under the
    // chassis. Friction values are absolute controller settings; the remaining
    // fields scale the baseline ground tune.
    surfaces: {
      asphalt: {
        frictionSlip: 2.0,
        sideFrictionStiffness: 0.9,
        // Tyre-model peaks (controller-slip). Dirt/mud lower μ and soften K so
        // slides start earlier and last longer past the limit (rally).
        mu0Long: 1.6,
        mu0Lat: 1.7,
        Klat: 10,
        Klong: 9,
        alphaPeakDeg: 14,
        powerOversteerScale: 1,
        handbrakeRearGripScale: 0.1,
        rollingResistanceScale: 1,
        gripLerp: 4,
      },
      dirt: {
        frictionSlip: 1.15,
        sideFrictionStiffness: 0.5,
        mu0Long: 1.05,
        mu0Lat: 1.0,
        Klat: 7.5,
        Klong: 7,
        alphaPeakDeg: 16,
        powerOversteerScale: 1.6,
        handbrakeRearGripScale: 0.05,
        rollingResistanceScale: 1.4,
        gripLerp: 4,
      },
      // Rally wet (docs/advanced-wet-roads-plan.md): between dirt and mud —
      // slicker than dirt, grippier than mud, NO bog/dig-in (fast gripLerp like dirt).
      wet: {
        frictionSlip: 0.85,
        sideFrictionStiffness: 0.38,
        mu0Long: 0.78,
        mu0Lat: 0.72,
        Klat: 6.5,
        Klong: 6,
        alphaPeakDeg: 18,
        powerOversteerScale: 1.7,
        handbrakeRearGripScale: 0.08,
        rollingResistanceScale: 1.6,
        gripLerp: 4,
      },
      offroad: {
        frictionSlip: 0.9,
        sideFrictionStiffness: 0.4,
        mu0Long: 0.85,
        mu0Lat: 0.8,
        Klat: 7,
        Klong: 6.5,
        alphaPeakDeg: 18,
        powerOversteerScale: 1.35,
        handbrakeRearGripScale: 0.04,
        rollingResistanceScale: 1.7,
        gripLerp: 3.2,
      },
      // Rally mud: the lowest-grip, draggiest profile — the car BOGS and squirms.
      // Very low longitudinal grip → wheelspin under power (mud flies); very low
      // side grip → the tail steps out easily; heavy rolling drag → it feels like
      // wading, bleeding speed the moment you're off the throttle; slow gripLerp
      // so it wallows into a wet patch instead of snapping to the new grip.
      mud: {
        frictionSlip: 0.55,
        sideFrictionStiffness: 0.22,
        mu0Long: 0.5,
        mu0Lat: 0.42,
        Klat: 5.5,
        Klong: 5,
        alphaPeakDeg: 22,
        powerOversteerScale: 2.4,
        handbrakeRearGripScale: 0.02,
        rollingResistanceScale: 2.5,
        gripLerp: 3.0,
      },
    },

    // Contact-local mud response shared by tyre grip, rut digging, and both mud
    // particle layers. Slip bands intentionally keep ordinary rolling clean.
    mudWheelDynamics: {
      slipBands: [
        { slip: 0.05, intensity: 0 },
        { slip: 0.15, intensity: 0.08 },
        { slip: 0.30, intensity: 0.28 },
        { slip: 0.50, intensity: 0.52 },
        { slip: 0.80, intensity: 0.82 },
        { slip: 1.00, intensity: 1 },
      ],
      loadForce: 300,
      baseSoftness: 0.62,
      rutSoftness: 0.38,
      rutAmplification: 0.45,
      brakingScale: 0.38,
      brakingRearScale: 0.18,
      speedTaper: { start: 12, end: 38, minimum: 0.08, extremeSlipRetention: 0.78 },
      landing: { minAirTime: 0.08, minDuration: 0.2, maxDuration: 0.5, intensity: 0.85 },
      grip: { maxRutLoss: 0.35, longitudinalRutLoss: 0.28, lateralRutLoss: 0.35 },
      emission: { clodPerIntensity: 150, liquidPerIntensity: 620 },
    },

    lateralGrip: 8.5, // body-level sideways slip cancellation (1/s, x mass)
    // RWD rear-axle trim rate (1/s) — applied per rear wheel, scaled by rearGripScale.
    rearAxleGrip: 2.5,
    rearGripScale: 0.58,
    handbrakeGripScale: 0.25,
    handbrakeBodyGripScale: 0.88,
    handbrakeFrontGripScale: 0.88,
    handbrakeRearGripScale: 0.1,
    // Additive yaw-rate bias (rad/s) when throttling through a turn (RWD).
    powerOversteer: 0.35,
    brakeFrontBias: 0.62,

    // Closed-loop yaw-rate steering (see computeSteerAuthority in BaseVehicle).
    maxYawRate: 0.78, // low-speed yaw-assist target; wheel steering owns speed
    yawStiffness: 10, // how hard the chassis chases target yaw rate (1/s)
    yawDamping: 0, // optional derivative damping on yaw rate
    steerSensitivity: 1, // global multiplier on maxYawRate
    highSpeedTaperAt: (22 / 36) * GROUND_VEHICLE_MAX_SPEED_MS, // full steer authority below ~92 mph
    highSpeedTaperEnd: (28 / 36) * GROUND_VEHICLE_MAX_SPEED_MS, // min authority by ~116 mph
    highSpeedFloor: 0.4, // min authority fraction at very high speed
    caster: {
      alignRate: 0.6, // light weathervane when not steering
    },
    skidSteer: false, // tanks: steer at any speed, including in place
    downforce: 0.04, // downward accel per (m/s)^2 of forward speed (x mass)
    // Cap on the downforce accel (m/s^2). The v^2 term is unbounded, so at highway
    // speed (now up to ~67 m/s) it reached ~179 m/s^2 — far past the ~40 m/s^2 the
    // four springs can support — bottoming the suspension onto the rigid wheel balls
    // and riding hard ("tyre pop"/bounce at speed). Capping keeps the low/mid-speed
    // plant identical (the cap isn't reached until ~20 m/s) while stopping the
    // high-speed runaway that saturates the suspension. Left below the spring support
    // so bumps still have travel headroom under full downforce. null = uncapped.
    downforceMaxAccel: 20,
    // Visual articulation from the steering input: front wheels steer into the
    // turn and the steering wheel spins, both scaled by these max angles. The
    // steering-wheel spin is shared with the hand IK so the hands ride the rim.
    articulation: {
      wheelSteerAngle: 0.6, // max front-wheel visual yaw (rad), ~34°
      steeringWheelTurn: 2.4, // max steering-wheel spin (rad), ~137° each way
    },

    // Rally dirt-dust rooster tail (TireEffects.DirtDustSystem). CPU-simulated
    // particle pool rendered as GPU billboards (InstancedMesh + TSL). Every knob
    // here is read once at TireEffects construction; mergeConfig deep-merges, so
    // a rally build can override e.g. { dust: { color: { mid: [...] } } } without
    // restating the whole block. Color triples are linear RGB consumed directly
    // by the shader's colorNode — tune by eye in a real browser.
    dust: {
      poolSize: 6000, // instanced-quad count == CPU pool size (fixed at first frame)
      textureSize: 96, // puff gradient resolution (CanvasTexture)
      emitAllWheelsAbove: 0.55, // also emit from front axle above this slip intensity
      emitRate: {
        base: 8, // particles/s baseline when moving on a loose surface
        perSpeed: 0.85, // * min(speed, speedCap)
        speedCap: 38,
        perIntensity: 28, // * slip/brake/handbrake intensity (0..1)
        driftBoost: 14, // added when lateralSpeed > driftThreshold
        driftThreshold: 3,
        maxPerFrame: 10,
        burstAtIntensity: 0.72, // extra puffs per emit slot above this slip
        burstParticles: 2,
      },
      life: { min: 0.95, max: 2.35 }, // seconds
      size: { baseMin: 0.55, baseMax: 1.05, ageGrow: 1.85 }, // metres; final = base*(1+age*ageGrow)
      buoyancy: 0.95, // initial upward accel (m/s^2), decays with age
      gravity: 0.52, // downward accel (m/s^2) that takes over as buoyancy fades
      drag: 0.65, // horizontal velocity decay (1/s)
      turbulence: 0.2, // per-particle sin-wobble amplitude (m/s)
      color: {
        fresh: [0.42, 0.29, 0.17], // dark brown (~#6b4a2b) — just kicked up
        mid: [0.72, 0.60, 0.42], // tan (~#b89a6c)
        old: [0.85, 0.80, 0.72], // pale (~#d8cdb8) — dispersing
      },
      drift: {
        fanScale: 0.18, // lateralSpeed → sideways plume bias
        coneWiden: 1.4, // extra random spread when drifting
        smoothstart: 2, // smoothstep(lateralSpeed) range
        smoothend: 8,
      },
      spin: {
        roostScale: 0.05, // rear slipRatio → backward roost boost
        upBias: 0.68, // rear slipRatio → upward kick boost
      },
      opacity: { peak: 1.0, fadePow: 1.35 }, // death fade via scale + material opacity

      // Rally MUD spray profile (docs/rally-mud-tread-plan.md §8). A partial
      // override deep-merged onto the dust config above and used only while
      // `surface === 'mud'` (DirtDustSystem swaps to it, no forked system):
      // darker, heavier, shorter-lived — ballistic clods that arc and fall,
      // not billowing dust. Bigger initial size, little age-grow.
      // Mud throws discrete CLODS, not a smoke plume: small, opaque, hard-edged
      // dark specks that arc and fall (heavy gravity, no buoyancy, no age-grow),
      // and FEW of them so they never haze over the ruts. DirtDustSystem also
      // swaps to a hard clod texture on mud so nothing reads as smoke.
      // Wet-road water spray (docs/advanced-wet-roads-plan.md M4): lighter colour,
      // fine droplets, higher buoyancy, shorter life — the roost a wet stage throws.
      // Same pool as dirt; DirtDustSystem swaps the profile on surface === 'wet'.
      water: {
        clod: false,
        life: { min: 0.45, max: 0.95 },
        buoyancy: 1.4,
        gravity: 1.8,
        drag: 0.9,
        turbulence: 0.35,
        emitRate: {
          base: 12, perSpeed: 1.4, speedCap: 36, perIntensity: 48,
          driftBoost: 22, driftThreshold: 3, maxPerFrame: 16,
          burstAtIntensity: 0.65, burstParticles: 3,
        },
        size: { baseMin: 0.28, baseMax: 0.55, ageGrow: 1.1 },
        color: {
          fresh: [0.72, 0.78, 0.82], // cool water spray
          mid: [0.82, 0.86, 0.88],
          old: [0.9, 0.92, 0.94],
        },
        opacity: { peak: 0.72, fadePow: 1.5 },
      },
      mud: {
        clod: true, // render with the hard clod texture, not the soft puff
        life: { min: 0.35, max: 0.7 }, // short — flick up and splat back down
        buoyancy: 0.0, // no rise at all
        gravity: 3.2, // heavy, ballistic
        drag: 0.35,
        turbulence: 0.22,
        emitRate: {
          base: 15, perSpeed: 2.0, speedCap: 30, perIntensity: 80,
          driftBoost: 40, driftThreshold: 3, maxPerFrame: 30,
          burstAtIntensity: 0.6, burstParticles: 2,
        },
        size: { baseMin: 0.12, baseMax: 0.28, ageGrow: 0.0 }, // small, no billow
        color: {
          fresh: [0.22, 0.15, 0.09], // wet brown clod — lighter than before, still darker than dirt dust
          mid: [0.32, 0.22, 0.13],
          old: [0.42, 0.30, 0.20],
        },
        opacity: { peak: 1.0, fadePow: 0.6 }, // stay solid, then blink out
        // Fine wet streaks are rendered in a second instanced pool. Scheduling
        // comes from contact-local mudWheelDynamics; this block retains the
        // particle pool, shape, lifetime, and launch geometry.
        liquid: {
          poolSize: 6000,
          emitRate: { base: 120, perSpeed: 20, perThrottle: 550, speedCap: 46, maxPerFrame: 120 },
          life: { min: 0.3, max: 0.72, speedThin: 0.6 },
          size: {
            widthMin: 0.1, widthMax: 0.24, lengthMin: 0.16, lengthMax: 0.4,
            speedThin: 0.7, sheetEvery: 4, sheetWidth: 2.8, sheetLength: 1.55,
          },
          // angularVelocity * wheelRadius drives the tangential throw. Rear
          // wheels fire almost straight back; fronts fan 45° back/out with only
          // a small lift so the spray clears the sill without shooting skyward.
          launch: {
            tangentialScale: 0.28, speedScale: 0.07,
            rearYawDeg: 6, frontYawDeg: 45,
            rearElevationDeg: 9, frontElevationDeg: 6,
            // Wide per-particle fan so rear roost reads chaotic, not a single hose.
            randomYawDeg: 24, randomElevationDeg: 18, randomSpeedScale: 0.55,
            randomLateral: 0.42, randomUpKick: 0.95, rearFanDeg: 34,
            inheritVelocity: 0.02,
            // The visual mud ribbon is 0.28 m above the terrain collider.
            visualSurfaceLift: 0.3, spawnLift: 0.1,
          },
          breakup: { delay: 0.075, fragments: 3, speedScale: 0.82, spread: 0.7, sizeScale: 0.42, life: 0.32 },
          gravity: 11.5,
          drag: 0.9,
          turbulence: 0.42,
          color: { fresh: [0.20, 0.13, 0.07], old: [0.36, 0.25, 0.16] },
          opacity: 0.72,
        },
      },
    },
  },

  // ---- AIR: arcade flight ------------------------------------------------------
  air: {
    cruiseThrust: 6, // baseline forward accel (keeps the glide alive) (x mass)
    throttleThrust: 14, // extra forward accel at full throttle (x mass)
    liftCoeff: 0.02, // upward accel per (m/s)^2 of forward speed (x mass)
    maxLift: 26, // clamp on lift accel (x mass)
    drag: 0.6, // velocity-proportional drag rate (1/s)
    pitchTorque: 5, // nose up/down (x mass)
    rollTorque: 6, // bank (x mass)
    yawTorque: 2.5, // rudder (x mass)
    minSpeed: 4, // below this, control authority fades (near stall)
  },

  // ---- WATER: buoyant boat -----------------------------------------------------
  water: {
    waterLevel: 0.0, // world Y of the water plane
    draft: 0.6, // submersion depth that yields full buoyancy
    buoyancy: 18, // upward accel at full submersion (x mass)
    enginePower: 9, // forward thrust accel (x mass)
    maxSpeed: 16,
    steerTorque: 4, // rudder yaw (x mass)
    steerFullSpeedAt: 4,
    lateralDrag: 6, // sideways water resistance (1/s, x mass)
    verticalDrag: 3, // vertical water resistance (1/s, x mass)
    linearDrag: 1.4, // forward water resistance (1/s)
  },
};

// Deep-merge a partial override onto the defaults. Arrays and THREE objects are
// replaced wholesale (not merged element-wise), which is what callers want for
// `size`, `wheels`, `seats`, etc.
export function createVehicleConfig(overrides = {}) {
  return mergeConfig(DEFAULT_VEHICLE_CONFIG, overrides);
}

/** Neutral garage traction — authored dirt/mud surface tables apply as-is. */
export const LOOSE_SURFACE_TRACTION_BASELINE = 0.55;

const LOOSE_GROUND_SURFACES = new Set(['dirt', 'wet', 'mud', 'offroad']);

/**
 * Scale a loose-surface profile (dirt/mud/offroad) by the garage traction stat.
 * Higher traction → more longitudinal grip, less rolling drag, closer to asphalt pace.
 */
export function applyLooseSurfaceTraction(profile, asphaltProfile, traction = LOOSE_SURFACE_TRACTION_BASELINE) {
  if (!profile) return profile;
  const asphalt = asphaltProfile ?? DEFAULT_VEHICLE_CONFIG.ground.surfaces.asphalt;
  const blend = THREE.MathUtils.clamp(
    (Number(traction) - LOOSE_SURFACE_TRACTION_BASELINE) / 0.45,
    -0.35,
    1,
  );
  if (Math.abs(blend) < 1e-4) return profile;

  const lerp = (from, to, t) => from + (to - from) * t;
  if (blend > 0) {
    return {
      ...profile,
      frictionSlip: lerp(profile.frictionSlip, asphalt.frictionSlip, blend * 0.72),
      sideFrictionStiffness: lerp(profile.sideFrictionStiffness, asphalt.sideFrictionStiffness, blend * 0.5),
      mu0Long: lerp(profile.mu0Long ?? profile.frictionSlip * 0.8, asphalt.mu0Long ?? asphalt.frictionSlip * 0.8, blend * 0.72),
      mu0Lat: lerp(profile.mu0Lat ?? profile.sideFrictionStiffness * 1.8, asphalt.mu0Lat ?? asphalt.sideFrictionStiffness * 1.8, blend * 0.5),
      Klat: lerp(profile.Klat ?? 7, asphalt.Klat ?? 10, blend * 0.5),
      Klong: lerp(profile.Klong ?? 6.5, asphalt.Klong ?? 9, blend * 0.5),
      alphaPeakDeg: lerp(profile.alphaPeakDeg ?? 16, asphalt.alphaPeakDeg ?? 14, blend * 0.5),
      rollingResistanceScale: lerp(profile.rollingResistanceScale, 1, blend * 0.58),
      powerOversteerScale: lerp(profile.powerOversteerScale, 1, blend * 0.22),
    };
  }
  const worsen = -blend;
  return {
    ...profile,
    frictionSlip: profile.frictionSlip * (1 - worsen * 0.32),
    sideFrictionStiffness: profile.sideFrictionStiffness * (1 - worsen * 0.28),
    mu0Long: (profile.mu0Long ?? profile.frictionSlip * 0.8) * (1 - worsen * 0.32),
    mu0Lat: (profile.mu0Lat ?? profile.sideFrictionStiffness * 1.8) * (1 - worsen * 0.28),
    Klat: (profile.Klat ?? 7) * (1 - worsen * 0.15),
    Klong: (profile.Klong ?? 6.5) * (1 - worsen * 0.15),
    alphaPeakDeg: (profile.alphaPeakDeg ?? 16) * (1 + worsen * 0.12),
    rollingResistanceScale: profile.rollingResistanceScale * (1 + worsen * 0.38),
    powerOversteerScale: profile.powerOversteerScale * (1 + worsen * 0.18),
  };
}

/**
 * Apply a named handling preset ('simcade' | 'sim') onto a vehicle config override.
 * Sim: drift assist off + steeper μ fall-off.
 */
export function applyHandlingPreset(config = {}, presetName = 'simcade') {
  const base = config ?? {};
  const presets = DEFAULT_VEHICLE_CONFIG.ground.handlingPresets ?? {};
  const preset = presets[presetName];
  if (!preset || presetName === 'simcade') return base;
  return mergeConfig(base, { ground: preset });
}

export function isLooseGroundSurface(surface) {
  return LOOSE_GROUND_SURFACES.has(surface);
}

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = key in base ? mergeConfig(base[key], override[key]) : override[key];
    }
    return out;
  }
  return override !== undefined ? override : base;
}

function isPlainObject(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof THREE.Vector3) &&
    !(value instanceof THREE.Euler) &&
    !(value instanceof THREE.Quaternion)
  );
}
