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
    steerSmoothing: 4.0,
    throttleSmoothing: 6,
    pitchSmoothing: 7,
    rollSmoothing: 7,
    yawSmoothing: 7,
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
      handGrip: { offset: [-0.48, 0.62, -0.04], spacing: 0.34 },
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
      // Raised 8 -> 11 to settle terrain-following bounce faster while driving over
      // rolling procedural terrain (the residual "tiny jump" once the streaming
      // frame-hitch was fixed). The heave mode is already overdamped (zeta~1.37);
      // the extra damping mainly kills the rebound velocity when a launched wheel
      // lands, without changing the compression spring / maxForceScale that provide
      // the deliberate per-wheel travel + peak-launch behaviour. Still well clear of
      // numerical trouble even at the 0.05s dt ceiling (damping*dt = 0.55 < 1).
      damping: 11, // damper accel per (m/s) of compression velocity (x mass)
      maxForceScale: 14, // clamp suspension accel to this * mass
    },

    // Rapier raycast vehicle controller (DynamicRayCastVehicleController). When on,
    // the wheels are RAY-CASTS with integrated suspension — there are NO rigid wheel
    // colliders, so the chassis never takes a normal-impulse launch off terrain
    // peaks (the high-speed "pop" the recessed balls caused). Replaces the custom
    // force-spring + wheel balls + the world substep on the ground path. The legacy
    // model is kept (useRayCastController:false) for comparison/regression.
    useRayCastController: true,
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
      suspensionRestLength: 0.4,
      suspensionStiffness: 24,
      suspensionCompression: 12.0,
      suspensionRelaxation: 12.0,
      maxSuspensionTravel: 0.42,
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
