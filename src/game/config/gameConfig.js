export const GAME_CONFIG = {
  world: {
    planeSize: 180,
    planeSegments: 72,
  },
  camera: {
    followHeight: 2.75,
    followDistance: 6,
    minDistance: 3.2,
    maxDistance: 10.5,
    lookHeight: 1.05,
    lookSensitivity: 0.0032,
    zoomStep: 0.75,
    minPitch: -0.46,
    maxPitch: 0.58,
    initialPitch: 0.12,
    smoothing: 7.5,
    rootMotionSmoothing: 3.8,
    targetSmoothing: 16,
    rootMotionTargetSmoothing: 3.2,
    maxTargetLag: 8,
    // On-foot first person (interiors always use this regardless of the toggle).
    onFootEyeHeight: 1.62,
    onFootEyeForward: 0.06,
    onFootFirstPersonFov: 74,
    onFootFirstPersonSmoothing: 28,
    // Chase / cockpit camera while driving. Comfort-first defaults; per-feel overrides
    // in `vehicle.feels` restore older dramatic tuning when requested.
    // Springs stay soft so the chase cam is a smooth follow, not a stiff mount that
    // amplifies suspension / steering micro-wobble into the view.
    vehicle: {
      followDistance: 5.8,
      followHeight: 1.45,
      lookAhead: 5.5,
      lookHeight: 0.75,
      pitch: 0.1,
      // Planar target tracks the car tightly so high speed never rubber-bands; the
      // camera *position* spring and orientation filters stay soft for a smooth follow.
      yawSmoothing: 4.2,
      positionSmoothing: 6.5,
      targetSmoothing: 14,
      maxTargetLag: 14,
      steerLookStrength: 0,
      steerOffsetSmoothing: 7,
      lateralShift: 0,
      // Meters of pull-back at maxSpeedForEffects (clamped via speed ease).
      // Slight dramatic ease-out; speed feel also from FOV + look-ahead.
      speedDistanceBoost: 1.35,
      speedLookAheadBoost: 2.6,
      // Target lag budget (m) for planar chase tracking. Keep tight so the car
      // fills the frame; anti-twitch comes from height/yaw/look filters, not lag.
      maxChaseLag: 1.15,
      // Cap on speed-scaled planar tracking. High enough to hold lag near maxChaseLag
      // at highway speed; smoothness comes from height/yaw/look filters, not lag.
      maxTrackingSmoothing: 48,
      maxPositionSmoothing: 42,
      // Live chassis blend is XZ-only — full blend leaks suspension bounce into Y.
      speedLiveAnchor: 0.45,
      // Vertical chase anchor is filtered harder than planar follow (suspension heave).
      targetHeightSmoothing: 3.4,
      speedFovBoost: 0,
      maxSpeedForEffects: 67,
      baseFov: 54,
      defaultFov: 48,
      maxCameraYawRate: 1.55,
      // Low-pass filters that keep per-physics-step noise (heading/velocity/
      // suspension wobble) out of the chase framing and camera orientation.
      speedSmoothing: 4,
      lookTargetSmoothing: 9,
      modeBlendDuration: 0.45,
      horizonPitchSmoothing: 1.5,
      velocityLookBlend: 0.2,
      velocityLookMaxAngle: 0.28,
      focusReticleOpacity: 0.22,
      rearViewBlendSpeed: 12,
      feels: {
        comfort: {
          steerLookStrength: 0,
          lateralShift: 0,
          // Mild FOV pump so high speed still reads as fast without yanking the camera back.
          speedFovBoost: 3.5,
          yawSmoothing: 4.2,
          positionSmoothing: 6.5,
          targetSmoothing: 14,
          maxCameraYawRate: 1.55,
          horizonPitchSmoothing: 1.5,
          velocityLookBlend: 0.2,
          firstPersonFov: 60,
          horizonLock: true,
          cockpitRollLock: true,
        },
        default: {
          steerLookStrength: 0.06,
          lateralShift: 0.1,
          speedFovBoost: 4,
          yawSmoothing: 5.5,
          positionSmoothing: 8,
          targetSmoothing: 16,
          maxCameraYawRate: 2.2,
          horizonPitchSmoothing: 2.4,
          velocityLookBlend: 0.28,
          firstPersonFov: 66,
          horizonLock: true,
          cockpitRollLock: true,
        },
        cinematic: {
          steerLookStrength: 0.28,
          lateralShift: 0.55,
          speedFovBoost: 6,
          speedDistanceBoost: 2.0,
          yawSmoothing: 11,
          positionSmoothing: 16,
          targetSmoothing: 20,
          maxChaseLag: 1.15,
          maxTrackingSmoothing: 48,
          maxPositionSmoothing: 40,
          speedLiveAnchor: 0.55,
          lookTargetSmoothing: 18,
          maxCameraYawRate: Infinity,
          horizonPitchSmoothing: 48,
          velocityLookBlend: 0,
          firstPersonFov: 72,
          horizonLock: false,
          cockpitRollLock: false,
        },
      },
    },
    // Driving camera presets — cycled from the top-bar eye control while in a vehicle.
    vehicleCameraModes: {
      close: {
        followDistance: 5.8,
        followHeight: 1.45,
        lookAhead: 5.5,
        lookHeight: 0.75,
        pitch: 0.1,
      },
      medium: {
        followDistance: 8.8,
        followHeight: 2.05,
        lookAhead: 7.2,
        lookHeight: 0.85,
        pitch: 0.12,
      },
      far: {
        followDistance: 12.5,
        followHeight: 2.85,
        lookAhead: 9.5,
        lookHeight: 1.0,
        pitch: 0.14,
      },
      firstPerson: {
        // Chassis-local offset from the driver seat anchor (x, y, z). -Z is forward.
        eyeOffset: [0, 0.68, -0.14],
        fov: 60,
      },
    },
    vehicleCameraModeOrder: ['close', 'medium', 'far', 'firstPerson'],
  },
  character: {
    // Selects a profile from playerModelProfiles.js. Override at runtime with
    // ?playerModel=mixamo or ?playerModel=mesh2motion for side-by-side testing.
    playerModel: 'mixamo',
    // Jacket / cloth experiments (three-simplecloth). Disabled by default — set
    // jacketExperiments: true to re-enable, or force a one-off test with
    // ?jacket=cloth or ?jacket=procedural in the URL.
    jacketExperiments: false,
    // Target mode when jacketExperiments is true: "cloth" | "procedural" | "off".
    jacket: 'cloth',
    walkSpeed: 2.1,
    jogSpeed: 4.1,
    sprintSpeed: 6.15,
    braceSpeed: 0.9,
    acceleration: 14,
    airAcceleration: 5.5,
    rotationSmoothing: 11,
    jumpSpeed: 5.4,
    gravity: 15.5,
    maxStamina: 1,
    // Player damage (no death — health gates hit-reactions and regenerates).
    maxHealth: 100,
    healthRegenDelay: 4,
    healthRegenRate: 12,
    hitIframeSeconds: 0.35,
    lightHitReactionSeconds: 0.6,
    heavyHitReactionSeconds: 1.1,
    knockbackPower: 5,
    lowHealthHeavyThreshold: 25,
    // Acrobatics (Phase C) — all disabled by default; enable one-by-one as needed.
    enableJumpBig: false,
    enableLandRoll: false,
    enableDodge: false,
    enableAirDash: false,
    jumpBigMultiplier: 1.35,
    landRollImpactThreshold: 13,
    dodgePower: 9,
    dodgeIframeSeconds: 0.35,
    dodgeDuration: 0.5,
    airDashPower: 7,
    footRadius: 0.28,
    collisionHeight: 1.62,
    groundSnapHeight: 0.18,
    groundSnapDownHeight: 0.52,
    // Visual model offset relative to ground snap / physics feet.
    // Negative lowers the character (fixes floating feet).
    playerGroundOffset: -0.05,
    // Swim domain: entering a river (feet below the water surface) replaces gravity
    // with a buoyancy spring, slows horizontal movement, and plays the swim state.
    water: {
      surfaceOffset: 0.1,   // feet must be this far below the surface to count as in-water
      enterWeight: 0.5,     // corridor weight to ENTER the water (hysteresis)
      exitWeight: 0.2,      // corridor weight to LEAVE the water (hysteresis)
      floatDepth: 0.9,      // buoyancy rests the feet this far below the surface
      buoyancy: 8,          // spring stiffness toward floatDepth
      buoyancyDamp: 4,      // vertical velocity damping (settles the float)
      maxVerticalSpeed: 3,  // clamp on sink/rise speed while swimming
      paddleUp: 3.5,        // upward kick (m/s) on jump input while swimming
      speedScale: 0.6,      // horizontal speed multiplier while swimming
      accelScale: 0.6,      // horizontal acceleration multiplier while swimming
    },
  },

  // Wingsuit membrane (Part A) + flight mode (Part B).
  wingsuit: {
    // Membrane now deploys on flight activation (double-tap Space in the air),
    // not at spawn. Set true to keep it always visible while tuning the cloth.
    deployByDefault: false,
    color: 0x8a2f3a,
    opacity: 0.92,
    // Flight model (Part B). Arcade wingsuit: dive to build speed, flare to brake
    // and climb, glide at trim. W/S pitch, A/D bank-turn.
    flight: {
      minAltitude: 2.2, // must be at least this far above ground to deploy
      gravity: 12, // forward-axis gravity that converts dives into speed
      minSpeed: 6, // never stall below this (keeps the glide alive)
      maxSpeed: 42, // terminal/dive cap
      dragBase: 0.0016, // quadratic form drag
      dragFlare: 0.02, // extra drag while flaring (S)
      pitchTrim: -0.12, // gentle nose-down glide angle (rad)
      pitchDive: -0.95, // nose-down target when diving (W)
      pitchFlare: 0.55, // nose-up target when flaring (S)
      pitchRate: 3.2, // how fast pitch eases toward target
      turnRate: 1.5, // yaw rad/s at full bank input
      turnDrag: 0.25, // speed bleed while turning
      maxBank: 0.6, // visual roll (rad) at full turn input
      bankRate: 6, // how fast the visual bank eases
      diveAnimPitch: -0.45, // pitch (rad) below which the dive pose blends in
      pitchVisualGain: 1.6, // exaggerate the body's up/down tilt vs the actual arc
      maxVisualPitch: 1.15, // clamp on the visual body pitch (rad, ~66°)
      grappleBurst: 16, // forward speed (m/s) added when grappling out of a glide
      grappleBurstUp: 4, // upward kick (m/s) on the grapple burst
      exitFreeFallSeconds: 0.35, // free-fall blend window after toggling off in air
    },
  },

  // CrowdSystem (phases 1-2 only): dedicated cheap instanced ambient (soldier poses).
  // maxCapacity for InstancedMesh; offsets match soldier archetype exactly.
  // promotion* etc present for future phases but unused in v1 basic instancing.
  // ring* added for m2 static placement (no magic numbers in impl).
  crowd: {
    maxCapacity: 256,
    groundOffset: -0.05,
    targetHeight: 1.85,
    phaseStep: 1 / 12,
    promotionRadius: 22,
    demotionHysteresis: 8,
    baseSidewalkDensity: 0.65,
    dynamicFillerTarget: 32,
    ringCount: 0,
    ringRadius: 28,
    // Note: extra keys (phaseStep etc) are per plan examples for future phases; M1/M2 reads only capacity/offsets/ring*. These are the authoritative defaults (code fallbacks reference these values for resilience).
  },
};
