// Default runtime player mesh (Mixamo skeleton + external Mixamo clip pack).
// Old Mara body remains at /assets/models/climber.glb via ?playerModel=climber.
export const MARA_MODEL_URL = '/assets/models/player-tpose.glb';

const INJURED_PACK = '/assets/animation-packs/male-injured-pack';

// The rifle pack drives the arm chains correctly but exports loose fingers.
// Borrow only the closed finger tracks from the known-good great-sword grip;
// wrist/arm transforms remain entirely owned by each rifle locomotion clip.
const FP_RIFLE_GRIP_FINGER_PREFIXES = Object.freeze([
  'mixamorigLeftHandThumb',
  'mixamorigLeftHandIndex',
  'mixamorigLeftHandMiddle',
  'mixamorigLeftHandRing',
  'mixamorigRightHandThumb',
  'mixamorigRightHandIndex',
  'mixamorigRightHandMiddle',
  'mixamorigRightHandRing',
]);

function injuredLoop(file, { fadeIn = 0.18, timeScale = 1, movementScale = 1 } = {}) {
  return {
    url: `${INJURED_PACK}/${file}`,
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn,
    timeScale,
    rootMotion: {
      horizontal: true,
      movementScale,
      blend: 0.35,
      drive: 'locomotion',
    },
  };
}

function injuredPose(file, { loop = true, fadeIn = 0.18, timeScale = 1 } = {}) {
  return {
    url: `${INJURED_PACK}/${file}`,
    loop,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn,
    timeScale,
  };
}

// --- Hybrid FP/TP weapon locomotion families (Rifle 8-Way + Pistol packs) ---
// Normalized clip dirs are produced by `npm run import:loco-packs`.
// State keys are `${kind}_${slug}` (slug == clean filename), so the shared
// resolver in weaponLocomotion.js builds keys directly from movement/stance.
const RIFLE_LOCO_PACK = '/assets/animation-packs/weapon-rifle-8way';
const PISTOL_LOCO_PACK = '/assets/animation-packs/weapon-pistol';
const LOCO_DIRS_8 = ['fwd', 'fwd_left', 'fwd_right', 'bwd', 'bwd_left', 'bwd_right', 'left', 'right'];
const LOCO_DIRS_6 = ['fwd', 'fwd_left', 'fwd_right', 'bwd', 'bwd_left', 'bwd_right'];

// One weapon-locomotion clip. Moving clips drive locomotion root motion; still
// clips (idle/aim/turn/jump/transition) lock the root. Fingers borrow the known
// closed grip from armedIdle (these packs export loose fingers) like the fp_* set.
function weaponLocoClip(pack, slug, {
  loop = true,
  loopBlend = 0,
  moving = true,
  movementScale = 1,
  blend = 0.35,
  fadeIn = 0.18,
  timeScale = null,
} = {}) {
  const entry = {
    url: `${pack}/${slug}.fbx`,
    loop,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
  };
  if (timeScale != null) entry.timeScale = timeScale;
  if (loopBlend > 0) entry.loopBlend = loopBlend;
  if (moving) {
    entry.rootMotion = { horizontal: true, movementScale, blend, drive: 'locomotion' };
  }
  return entry;
}

function buildWeaponLocoStates(kind, pack, opts) {
  const states = {};
  const key = (suffix) => `${kind}_${suffix}`;
  const still = (slug, o = {}) => weaponLocoClip(pack, slug, { moving: false, ...o });
  const move = (slug, o = {}) => weaponLocoClip(pack, slug, { moving: true, ...o });

  states[key('idle')] = still('idle', { fadeIn: 0.22 });
  if (opts.aim) states[key('aim_idle')] = still('aim_idle', { fadeIn: 0.2 });
  if (opts.crouch) {
    states[key('crouch_idle')] = still('crouch_idle', { fadeIn: 0.2 });
    if (opts.crouchAim) states[key('crouch_aim_idle')] = still('crouch_aim_idle', { fadeIn: 0.2 });
  }

  for (const tier of opts.tiers) {
    const timeScale = tier === 'sprint' ? 1.18 : tier === 'run' ? 1.05 : 1;
    const movementScale = tier === 'sprint' ? 1.2 : 1;
    const blend = tier === 'walk' ? 0.4 : 0.35;
    for (const dir of opts.dirs) {
      // Some source packs have diagonal clips whose hips track is not safe to
      // use for gameplay displacement. Keep the animation, but let the normal
      // movement solver own translation for those directions.
      const rootMotionScale = opts.rootMotionScaleByDir?.[dir] ?? 1;
      const sourceDir = opts.sourceDirByDir?.[dir] ?? dir;
      states[key(`${tier}_${dir}`)] = move(`${tier}_${sourceDir}`, {
        timeScale,
        movementScale: movementScale * rootMotionScale,
        blend,
        loopBlend: opts.loopBlendByDir?.[dir] ?? 0,
      });
    }
  }
  if (opts.crouchWalk) {
    for (const dir of opts.dirs) states[key(`crouch_walk_${dir}`)] = move(`crouch_walk_${dir}`, { blend: 0.4 });
  }
  if (opts.strafe) {
    states[key('strafe_left')] = move('strafe_left');
    states[key('strafe_right')] = move('strafe_right');
  }
  if (opts.turn) {
    states[key('turn_left')] = still('turn_left', { loop: false, fadeIn: 0.16 });
    states[key('turn_right')] = still('turn_right', { loop: false, fadeIn: 0.16 });
  }
  if (opts.crouchTurn) {
    states[key('crouch_turn_left')] = still('crouch_turn_left', { loop: false, fadeIn: 0.16 });
    states[key('crouch_turn_right')] = still('crouch_turn_right', { loop: false, fadeIn: 0.16 });
  }
  if (opts.crouchEnterExit) {
    states[key('crouch_enter')] = still('crouch_enter', { loop: false, fadeIn: 0.14 });
    states[key('crouch_exit')] = still('crouch_exit', { loop: false, fadeIn: 0.14 });
  }
  for (const j of opts.jumps || []) states[key(j)] = still(j, { loop: j === 'jump_loop', fadeIn: 0.1 });
  return states;
}

const RIFLE_LOCO_STATES = buildWeaponLocoStates('rifle', RIFLE_LOCO_PACK, {
  dirs: LOCO_DIRS_8,
  tiers: ['walk', 'run', 'sprint'],
  aim: true,
  crouch: true,
  crouchAim: true,
  crouchWalk: true,
  turn: true,
  crouchTurn: true,
  jumps: ['jump_up', 'jump_loop', 'jump_down'],
});

const PISTOL_LOCO_STATES = buildWeaponLocoStates('pistol', PISTOL_LOCO_PACK, {
  dirs: LOCO_DIRS_6,
  tiers: ['walk', 'run'],
  aim: false,
  crouch: true,
  crouchAim: false,
  crouchWalk: false,
  strafe: true,
  // The pistol forward-diagonal hips tracks introduce a visible positional
  // snap when sampled as gameplay root motion. The clips still play normally;
  // movement remains driven by the regular input/velocity solver.
  rootMotionScaleByDir: {
    fwd_left: 0,
    fwd_right: 0,
    bwd_left: 0,
    bwd_right: 0,
  },
  // The source pistol pack's forward arc files are mislabeled left/right.
  sourceDirByDir: { fwd_left: 'fwd_right', fwd_right: 'fwd_left' },
  loopBlendByDir: {
    fwd_left: 0.12,
    fwd_right: 0.12,
    bwd_left: 0.12,
    bwd_right: 0.12,
  },
  turn: false,
  crouchTurn: false,
  crouchEnterExit: true,
  jumps: ['jump', 'jump_alt'],
});

// Reload clips are NOT in the base packs — drop a Mixamo reload FBX into the
// source dir and run `npm run import:loco-packs` (see import-locomotion-packs.mjs).
// Played upper-body-only over locomotion legs (AnimationStateSystem reload branch),
// so no finger-grip override — the reload's own hand motion drives the arms. Until
// the file exists these entries lazy-fail harmlessly and the reload layer stays
// inert (resolveReloadState gates on hasState).
function weaponReloadClip(pack) {
  return {
    url: `${pack}/reload.fbx`,
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    // The source Mixamo reload is ~3.3s; speed it toward the gun reload window
    // (~1.5s) so it reads as a full reload before blending back to locomotion.
    timeScale: 1.9,
    optionalAsset: true,
  };
}

export const MARA_ANIMATION_MANIFEST = {
  ...RIFLE_LOCO_STATES,
  ...PISTOL_LOCO_STATES,
  rifle_reload: weaponReloadClip(RIFLE_LOCO_PACK),
  pistol_reload: weaponReloadClip(PISTOL_LOCO_PACK),
  idle: {
    url: '/assets/animation-packs/locomotion-pack-2/idle.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    fadeIn: 0.22,
  },
  jog: {
    url: '/assets/animation-packs/locomotion-pack-2/running.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    fadeIn: 0.2,
    timeScale: 1.08,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
    transitions: {
      wallRunDiagonalEnter: { fade: 0.18 },
      wallRunDiagonalEnterOpposite: { fade: 0.18 },
      wallRunDiagonalExit: { fade: 0.16 },
      wallRunDiagonalExitOpposite: { fade: 0.16 },
    },
  },
  sprint: {
    url: '/assets/animation-packs/locomotion-pack-2/running.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    fadeIn: 0.14,
    timeScale: 1.32,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1.25,
      blend: 0.42,
      drive: 'locomotion',
    },
  },
  runningSlide: {
    url: '/assets/animation-packs/Running Slide (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 1,
      drive: 'slide',
    },
    fadeIn: 0.08,
    transitions: {
      jog: { fade: 0.18, startAt: 0.06 },
      sprint: { fade: 0.16, startAt: 0.04 },
      idle: { fade: 0.16 },
    },
  },
  brace: {
    url: '/assets/animations/Crouch Idle (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
  },
  walk: {
    url: '/assets/animation-packs/locomotion-pack-2/walking.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.45,
      drive: 'locomotion',
    },
  },
  // Mud-road locomotion. AnimationStateSystem selects these only while Mara is
  // over a `mud` road and only after the streamed clip is available.
  mudIdle: injuredPose('injured idle.fbx', { fadeIn: 0.22 }),
  mudHurtingIdle: injuredPose('injured hurting idle.fbx'),
  mudStumbleIdle: injuredPose('injured stumble idle.fbx'),
  mudWaveIdle: injuredPose('injured wave idle.fbx'),
  mudWalk: injuredLoop('injured walk.fbx', { fadeIn: 0.2 }),
  mudWalkBack: injuredLoop('injured walk backwards.fbx'),
  mudWalkTurnLeft: injuredLoop('injured walk left turn.fbx'),
  mudWalkTurnRight: injuredLoop('injured walk right turn.fbx'),
  mudTurnLeft: injuredLoop('injured turn left.fbx'),
  mudTurnRight: injuredLoop('injured turn right.fbx'),
  mudBackTurnLeft: injuredLoop('injured backwards turn left.fbx'),
  mudBackTurnRight: injuredLoop('injured backwards turn right.fbx'),
  mudRun: injuredLoop('injured run.fbx', { fadeIn: 0.16, timeScale: 1.08 }),
  mudRunBack: injuredLoop('injured run backwards.fbx', { fadeIn: 0.16 }),
  mudRunTurnLeft: injuredLoop('injured run left turn.fbx', { fadeIn: 0.16 }),
  mudRunTurnRight: injuredLoop('injured run right turn.fbx', { fadeIn: 0.16 }),
  mudRunBackTurnLeft: injuredLoop('injured run backwards left turn.fbx', { fadeIn: 0.16 }),
  mudRunBackTurnRight: injuredLoop('injured run backwards right turn.fbx', { fadeIn: 0.16 }),
  mudStandingJump: injuredPose('injured standing jump.fbx', { loop: false, fadeIn: 0.08 }),
  mudRunJump: injuredPose('injured run jump.fbx', { loop: false, fadeIn: 0.07 }),
  ledgeCoverIdle: {
    url: '/assets/animation-packs/ledge-traversal/cover-idle.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
  },
  ledgeCoverSneakLeft: {
    url: '/assets/animation-packs/ledge-traversal/left-cover-sneak.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    timeScale: 1.05,
  },
  ledgeCoverSneakRight: {
    url: '/assets/animation-packs/ledge-traversal/right-cover-sneak.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    timeScale: 1.05,
  },
  strafeLeft: {
    url: '/assets/animation-packs/locomotion-pack-2/left strafe.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  strafeRight: {
    url: '/assets/animation-packs/locomotion-pack-2/right strafe.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  turnLeft: {
    url: '/assets/animation-packs/locomotion-pack-2/left turn.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
  },
  turnRight: {
    url: '/assets/animation-packs/locomotion-pack-2/right turn.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
  },
  jump: {
    url: '/assets/animation-packs/Jumping Up (3).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  jumpMoving: {
    url: '/assets/animation-packs/running Jump.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.07,
    transitions: {
      wallRunDiagonalEnter: { fade: 0.2 },
      wallRunDiagonalEnterOpposite: { fade: 0.2 },
      freeFall: { fade: 0.14 },
    },
  },
  freeFall: {
    url: '/assets/animation-packs/Falling Idle (2).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    transitions: {
      wallRunDiagonalEnter: { fade: 0.18 },
      wallRunDiagonalEnterOpposite: { fade: 0.18 },
    },
  },
  // Swim (river water). Placeholder reuses idle until a dedicated swim/tread clip
  // is added — the STATE is what matters (AnimationStateSystem returns 'swim' while
  // movement.inWater). Position is driven by MovementSystem buoyancy, not the clip.
  swim: {
    url: '/assets/animation-packs/locomotion-pack-2/idle.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.2,
  },
  land: {
    url: '/assets/animation-packs/Falling To Landing (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    endAt: 0.9,
    fadeIn: 0.06,
    timeScale: 1.28,
  },
  // Wingsuit flight poses. Position is driven by WingsuitFlightSystem, so these are
  // pose-only (rootPosition locked). Coast is the trim glide; dive is the steep
  // speed-building descent. WingsuitFlightSystem picks between them by pitch and the
  // controller crossfades — blending coast<->dive and in/out of flying.
  wingsuitCoast: {
    url: '/assets/animation-packs/wingsuit/fly-coast.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.3,
  },
  wingsuitDive: {
    url: '/assets/animation-packs/wingsuit/fly-dive.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.26,
  },
  landMoving: {
    url: '/assets/animation-packs/Fall A Land To Run Forward.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1.25,
      blend: 0.45,
    },
    fadeIn: 0.06,
    timeScale: 1.16,
    transitions: {
      jog: {
        fade: 0.28,
        startAt: 0.08,
      },
      idle: {
        fade: 0.22,
      },
    },
  },
  jumpBig: {
    url: '/assets/animation-packs/Big Jump.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  jumpDown: {
    url: '/assets/animation-packs/Jumping Down (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  landRoll: {
    url: '/assets/animation-packs/Falling To Roll (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  frontFlip: {
    url: '/assets/animation-packs/stunts/Front Flip.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  frontTwistFlip: {
    url: '/assets/animation-packs/stunts/Front Twist Flip.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  aerialEvade: {
    url: '/assets/animation-packs/stunts/Aerial Evade.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
  },
  idleSmallVault: {
    url: '/assets/animation-packs/vaults/idle-to-small-vault-to-run.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.12,
    transitions: {
      jog: { fade: 0.18, startAt: 0.08 },
      idle: { fade: 0.18 },
    },
  },
  runVault: {
    url: '/assets/animation-packs/vaults/run-to-vault-to-run.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    timeScale: 1.15,
    transitions: {
      jog: { fade: 0.16, startAt: 0.08 },
      idle: { fade: 0.18 },
    },
  },
  runButtVault: {
    url: '/assets/animation-packs/vaults/run-to-butt-vault-to-run.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    timeScale: 1.15,
    transitions: {
      jog: { fade: 0.16, startAt: 0.08 },
      idle: { fade: 0.18 },
    },
  },
  runFancyVault: {
    url: '/assets/animation-packs/vaults/run-to-fancy-vault-to-run.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    timeScale: 1.15,
    transitions: {
      jog: { fade: 0.16, startAt: 0.08 },
      idle: { fade: 0.18 },
    },
  },
  bracedHang: {
    url: '/assets/animation-packs/Braced Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.85,
    fadeIn: 0.18,
    transitions: {
      freeHang: { fade: 0.22 },
      bracedToFreeHang: { fade: 0.08 },
    },
  },
  bracedHangEnter: {
    url: '/assets/animation-packs/Braced Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.45,
    endAt: 1.3,
    fadeIn: 0.06,
    timeScale: 1.5,
    transitions: {
      freeHang: { fade: 0.08 },
      bracedHang: { fade: 0.1 },
    },
  },
  bracedHangExit: {
    url: '/assets/animation-packs/Braced To Free Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.32,
    endAt: 0.92,
    fadeIn: 0.06,
    timeScale: 1.5,
    transitions: {
      bracedHang: { fade: 0.08 },
      freeHang: { fade: 0.1 },
    },
  },
  bracedHangAttach: {
    url: '/assets/animation-packs/Braced Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.35,
    transitions: {
      freeFall: { fade: 0.08 },
      jump: { fade: 0.08 },
      jumpMoving: { fade: 0.08 },
      idle: { fade: 0.08 },
    },
  },
  bracedHangDrop: {
    url: '/assets/animation-packs/Braced Hang Drop (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  bracedHangHopLeft: {
    url: '/assets/animation-packs/Braced Hang Hop Left (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      bracedHangShimmyLeft: { fade: 0.22 },
      bracedHangShimmyRight: { fade: 0.18 },
      bracedHang: { fade: 0.18 },
    },
  },
  bracedHangHopRight: {
    url: '/assets/animation-packs/Braced Hang Hop Right (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      bracedHangShimmyLeft: { fade: 0.18 },
      bracedHangShimmyRight: { fade: 0.22 },
      bracedHang: { fade: 0.18 },
    },
  },
  bracedHangHopUp: {
    url: '/assets/animation-packs/Braced Hang Hop Up (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      bracedHang: { fade: 0.18 },
      freeHangIdleAlt2: { fade: 0.18 },
      freeHang: { fade: 0.18 },
    },
  },
  bracedHangShimmyLeft: {
    url: '/assets/animation-packs/Braced Hang Shimmy left.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  bracedHangShimmyRight: {
    url: '/assets/animation-packs/Braced Hang Shimmy (3).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  bracedHangShimmyAlt: {
    url: '/assets/animation-packs/Braced Hang Shimmy (2).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  bracedHangToCrouch: {
    url: '/assets/animation-packs/Braced Hang To Crouch (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    timeScale: 2.1,
    transitions: {
      idle: { fade: 0.32 },
      brace: { fade: 0.26 },
    },
  },
  bracedHangToCrouchDown: {
    url: '/assets/animation-packs/Braced Hang To Crouch (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    reversed: true,
    fadeIn: 0.1,
    timeScale: 4,
    transitions: {
      idle: { fade: 0.1 },
      jump: { fade: 0.08 },
    },
  },
  bracedToFreeHang: {
    url: '/assets/animation-packs/Braced To Free Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.35,
    transitions: {
      freeHang: { fade: 0.1 },
      bracedHang: { fade: 0.1 },
    },
  },
  dropToFreeHang: {
    url: '/assets/animation-packs/Drop To Freehang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  freeHang: {
    url: '/assets/animation-packs/Hanging.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    transitions: {
      bracedHang: { fade: 0.18 },
      freeHangToBraced: { fade: 0.08 },
    },
  },
  freeHangIdleAlt: {
    url: '/assets/animation-packs/Hanging Idle (4).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
  },
  freeHangIdleAlt2: {
    url: '/assets/animation-packs/Hanging Idle (6).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
  },
  // Hook swing animations.
  swingStart: {
    url: '/assets/animation-packs/Start Swinging.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
    endAt: 1.5,   // clip is 2.03s — cut landing (tune if too early/late)
    transitions: {
      hookSwing: { fade: 0.28 },
    },
  },
  hookSwing: {
    url: '/assets/animation-packs/Start Swinging.fbx',
    loop: true,
    pingPong: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.22,
    startAt: 0.9,  // tune — loop starts here
    endAt: 2.03,    // tune — cut landing (clip is 2.03s)
  },
  swingMultiStart: {
    url: '/assets/animation-packs/Swinging (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.14,
    endAt: 1.4,   // clip is 1.97s — cut landing (tune)
    transitions: {
      hookMulti: { fade: 0.28 },
    },
  },
  hookMulti: {
    url: '/assets/animation-packs/Swinging (1).fbx',
    loop: true,
    pingPong: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.22,
    startAt: 0.6,  // tune — loop starts here
    endAt: 1.4,    // clip is 1.97s — cut landing (tune)
  },
  swingLand: {
    url: '/assets/animation-packs/Swing To Land.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    transitions: {
      jog: { fade: 0.24, startAt: 0.08 },
      idle: { fade: 0.28 },
    },
  },
  swingLand1: {
    url: '/assets/animation-packs/Swing To Land (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    transitions: {
      jog: { fade: 0.24, startAt: 0.08 },
      idle: { fade: 0.28 },
    },
  },
  swingLand2: {
    url: '/assets/animation-packs/Swing To Land (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    transitions: {
      jog: { fade: 0.24, startAt: 0.08 },
      idle: { fade: 0.28 },
    },
  },
  swingLand3: {
    url: '/assets/animation-packs/Swing To Land (3).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    transitions: {
      jog: { fade: 0.24, startAt: 0.08 },
      idle: { fade: 0.28 },
    },
  },
  stylishFlip: {
    url: '/assets/animation-packs/Stylish Flip.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  swingIntoWall: {
    url: '/assets/animation-packs/Swing Into Wall 2.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
  },
  wallCrash: {
    url: '/assets/animation-packs/Wall Crash 2.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
  },
  hanging: {
    url: '/assets/animation-packs/Hanging.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
  },
  freeHangHopLeft: {
    url: '/assets/animation-packs/Free Hang Hop Left (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      leftShimmy: { fade: 0.22 },
      rightShimmy: { fade: 0.18 },
      movingWhileHanging: { fade: 0.2 },
      freeHangIdleAlt2: { fade: 0.18 },
    },
  },
  freeHangHopLeftAlt: {
    url: '/assets/animation-packs/Free Hang Hop Left (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      leftShimmy: { fade: 0.22 },
      rightShimmy: { fade: 0.18 },
      movingWhileHanging: { fade: 0.2 },
      freeHangIdleAlt2: { fade: 0.18 },
    },
  },
  freeHangHopRight: {
    url: '/assets/animation-packs/Free Hang Hop Right (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      leftShimmy: { fade: 0.18 },
      rightShimmy: { fade: 0.22 },
      movingWhileHanging: { fade: 0.2 },
      freeHangIdleAlt2: { fade: 0.18 },
    },
  },
  freeHangHopRightAlt: {
    url: '/assets/animation-packs/Free Hang Hop Right (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    transitions: {
      leftShimmy: { fade: 0.18 },
      rightShimmy: { fade: 0.22 },
      movingWhileHanging: { fade: 0.2 },
      freeHangIdleAlt2: { fade: 0.18 },
    },
  },
  freeHangToBraced: {
    url: '/assets/animation-packs/Free Hang To Braced (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.35,
    transitions: {
      freeHang: { fade: 0.1 },
      bracedHang: { fade: 0.1 },
    },
  },
  freeHangClimb: {
    url: '/assets/animation-packs/Freehang Climb (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    timeScale: 2.6,
    transitions: {
      idle: { fade: 0.32 },
      jog: { fade: 0.26 },
    },
  },
  freeHangClimbDown: {
    url: '/assets/animation-packs/Freehang Climb (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    reversed: true,
    fadeIn: 0.1,
    timeScale: 4,
    transitions: {
      idle: { fade: 0.1 },
      jump: { fade: 0.08 },
    },
  },
  freeHangDrop: {
    url: '/assets/animation-packs/Freehang Drop (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  idleToBracedHang: {
    url: '/assets/animation-packs/Idle To Braced Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.35,
    transitions: {
      idle: { fade: 0.08 },
      jump: { fade: 0.08 },
      freeFall: { fade: 0.08 },
      jumpMoving: { fade: 0.08 },
    },
  },
  jumpFromWall: {
    url: '/assets/animation-packs/Jump From Wall (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
  },
  jumpToFreeHang: {
    url: '/assets/animation-packs/Jump To Freehang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.55,
    transitions: {
      freeFall: { fade: 0.08 },
      jump: { fade: 0.08 },
      jumpMoving: { fade: 0.08 },
    },
  },
  jumpToHang: {
    url: '/assets/animation-packs/Jump To Hang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.55,
    transitions: {
      freeFall: { fade: 0.08 },
      jump: { fade: 0.08 },
      jumpMoving: { fade: 0.08 },
    },
  },
  jumpingToHanging: {
    url: '/assets/animation-packs/Jumping To Hanging (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.45,
    transitions: {
      freeFall: { fade: 0.08 },
      jump: { fade: 0.08 },
      jumpMoving: { fade: 0.08 },
    },
  },
  leftShimmy: {
    url: '/assets/animation-packs/Left Shimmy (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  rightShimmy: {
    url: '/assets/animation-packs/Right Shimmy (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  movingWhileHanging: {
    url: '/assets/animation-packs/Moving While Hanging (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
  },
  wallClimbUp: {
    url: '/assets/animation-packs/Climbing Up Wall (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 2.15,
      blend: 1,
      drive: 'wall',
    },
    fadeIn: 0.12,
    transitions: {
      wallClimbDown: { fade: 0.16 },
      leftShimmy: { fade: 0.14 },
      rightShimmy: { fade: 0.14 },
      freeHangIdleAlt2: { fade: 0.16 },
    },
  },
  wallClimbDown: {
    url: '/assets/animation-packs/Climbing Down Wall (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 2.15,
      blend: 1,
      drive: 'wall',
    },
    fadeIn: 0.12,
    transitions: {
      wallClimbUp: { fade: 0.16 },
      leftShimmy: { fade: 0.14 },
      rightShimmy: { fade: 0.14 },
      freeHangIdleAlt2: { fade: 0.16 },
    },
  },
  wallRunDiagonalEnter: {
    url: '/assets/animation-packs/Diagonal Wall Run (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0,
    endAt: 0.42,
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'wallRun',
    },
    fadeIn: 0.12,
    transitions: {
      jog: { fade: 0.2, startAt: 0.04 },
      wallRunDiagonalExit: { fade: 0.14 },
    },
  },
  wallRunLoop: {
    url: '/assets/animation-packs/Diagonal Wall Run (1).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.42,
    endAt: 0.72,
    fadeIn: 0.1,
    timeScale: 0.88,
    transitions: {
      wallRunDiagonalExit: { fade: 0.18 },
      wallRunDiagonalExitOpposite: { fade: 0.18 },
    },
  },
  wallRunDiagonalExit: {
    url: '/assets/animation-packs/Diagonal Wall Run (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.72,
    endAt: 1.133,
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'wallRun',
    },
    fadeIn: 0.12,
    transitions: {
      freeFall: { fade: 0.24 },
      jumpMoving: { fade: 0.18 },
    },
  },
  wallRunDiagonalEnterOpposite: {
    url: '/assets/animation-packs/Diagonal Wall Run opposite.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0,
    endAt: 0.42,
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'wallRun',
    },
    fadeIn: 0.12,
    transitions: {
      jog: { fade: 0.2, startAt: 0.04 },
      wallRunDiagonalExitOpposite: { fade: 0.14 },
    },
  },
  wallRunDiagonalExitOpposite: {
    url: '/assets/animation-packs/Diagonal Wall Run opposite.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    startAt: 0.72,
    endAt: 1.133,
    rootMotion: {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'wallRun',
    },
    fadeIn: 0.12,
    transitions: {
      freeFall: { fade: 0.24 },
      jumpMoving: { fade: 0.18 },
    },
  },
  standToFreeHang: {
    url: '/assets/animation-packs/Stand To Freehang (1).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 1.35,
    transitions: {
      idle: { fade: 0.08 },
      jump: { fade: 0.08 },
    },
  },
  // --- Great sword combat (milestones 1-3) ---
  // Extra fields (hitWindow, comboChain, attackKind) are ignored by the clip
  // loader but read directly from this manifest by CombatSystem.
  drawSword: {
    url: '/assets/animation-packs/draw a great sword 1.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.12,
    combat: { kind: 'draw' },
  },
  sheatheSword: {
    url: '/assets/animation-packs/draw a great sword 1.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    reversed: true,
    fadeIn: 0.12,
    combat: { kind: 'sheathe' },
  },
  // --- FP rifle locomotion (M4; from dust-and-bullets rifle pack) ---
  fp_idle: {
    url: '/assets/animation-packs/weapon-rifle/idle.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.2,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
  },
  fp_walk: {
    url: '/assets/animation-packs/weapon-rifle/walk.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.18,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.4,
      drive: 'locomotion',
    },
  },
  fp_run: {
    url: '/assets/animation-packs/weapon-rifle/run.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    timeScale: 1.05,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  fp_walkBackward: {
    url: '/assets/animation-packs/weapon-rifle/walkBackward.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.4,
      drive: 'locomotion',
    },
  },
  fp_runBackward: {
    url: '/assets/animation-packs/weapon-rifle/runBackward.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  fp_strafeLeft: {
    url: '/assets/animation-packs/weapon-rifle/strafeLeft.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  fp_strafeRight: {
    url: '/assets/animation-packs/weapon-rifle/strafeRight.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.16,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },
  },
  fp_jump: {
    url: '/assets/animation-packs/weapon-rifle/jump.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.1,
    trackOverrideSourceState: 'armedIdle',
    trackOverrideBonePrefixes: FP_RIFLE_GRIP_FINGER_PREFIXES,
  },

  armedIdle: {
    url: '/assets/animation-packs/great sword idle.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.22,

  },
  armedWalk: {
    url: '/assets/animation-packs/great sword walk.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.45,
      drive: 'locomotion',
    },

  },
  armedJog: {
    url: '/assets/animation-packs/great sword run.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.2,
    timeScale: 1.08,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },

  },
  armedSprint: {
    url: '/assets/animation-packs/great sword run (2).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.14,
    timeScale: 1.32,
    rootMotion: {
      horizontal: true,
      movementScale: 1.25,
      blend: 0.42,
      drive: 'locomotion',
    },

  },
  // Armed backwards and strafes (to support full 4 direction locomotion when armed).
  // Clips use the pack naming (left/right strafe files map to Left/Right states).
  // Group yaw uses atan2 on velocity so side inputs turn the body to face the move dir.
  armedBack: {
    url: '/assets/animation-packs/great sword walk.fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.45,
      drive: 'locomotion',
    },

  },
  armedStrafeLeft: {
    url: '/assets/animation-packs/great sword strafe (3).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },

  },
  armedStrafeRight: {
    url: '/assets/animation-packs/great sword strafe (4).fbx',
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 0.35,
      drive: 'locomotion',
    },

  },
  // --- Attacks (milestone 2). Armed attacks have no root motion and are layered
  // (upper-body swing + locomotion legs). Unarmed attacks (sheathed) are full-body
  // and may specify rootMotion to drive position from the clip. `combat` read by CombatSystem. ---
  lightSlash1: {
    url: '/assets/animation-packs/great sword slash.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,

    combat: {
      attackKind: 'light',
      comboChain: ['lightSlash2'],
      hitWindow: { start: 0.25, end: 0.55 },
    },
  },
  lightSlash2: {
    url: '/assets/animation-packs/great sword slash (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,

    combat: {
      attackKind: 'light',
      comboChain: ['lightSlash3'],
      hitWindow: { start: 0.22, end: 0.52 },
    },
  },
  lightSlash3: {
    url: '/assets/animation-packs/great sword slash (3).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,

    combat: {
      attackKind: 'light',
      comboChain: [],
      hitWindow: { start: 0.24, end: 0.54 },
    },
  },
  heavyAttack: {
    url: '/assets/animation-packs/great sword high spin attack.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    timeScale: 0.95,

    combat: {
      attackKind: 'heavy',
      comboChain: [],
      hitWindow: { start: 0.4, end: 0.72 },
    },
  },
  // Arc-cut follow-through (V release): slash guide orientation picks the clip.
  // Geometry commits immediately on release; this clip supplies the impact pose.
  aimCutVertical: {
    url: '/assets/animation-packs/great sword slash.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,

    combat: {
      attackKind: 'aimCut',
      comboChain: [],
    },
  },
  aimCutHorizontal: {
    // Horizontal slice. Note: slight lean in the animation (not full crouch like slash 5).
    // Best true edge-cut horizontal from the set (low blade-dot = slicing, not bash).
    url: '/assets/animation-packs/great sword slash (3).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,

    combat: {
      attackKind: 'aimCut',
      comboChain: [],
    },
  },
  // --- Unarmed hand-to-hand (Phase A). Available when the sword is sheathed.
  // `hitShape:'body'` routes CombatSystem to castBody (forward-arc) instead of the
  // blade sweep; `knockback.mode` picks stagger / knockback / throw on hit;
  // `requiresEnemy` gates the grab/throw on a target in range (CombatSystem.findGrabTarget). ---
  unarmedLight: {
    url: '/assets/animation-packs/stunts/Front Flip.fbx', // placeholder jab — swap for a real punch clip
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 1,
    },
    combat: {
      attackKind: 'light',
      comboChain: [],
      hitWindow: { start: 0.25, end: 0.5 },
      hitShape: 'body',
      reach: 1.8,
      arc: Math.PI * 0.6,
      knockback: { mode: 'stagger' },
    },
  },
  dropKick: {
    url: '/assets/animation-packs/stunts/Drop Kick.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    combat: {
      attackKind: 'heavy',
      comboChain: [],
      hitWindow: { start: 0.3, end: 0.6 },
      hitShape: 'body',
      reach: 2.4,
      arc: Math.PI * 0.4,
      knockback: { mode: 'knockback', power: 6 },
    },
  },
  butterflyTwirl: {
    url: '/assets/animation-packs/stunts/Butterfly Twirl.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.08,
    rootMotion: {
      horizontal: true,
      movementScale: 1,
      blend: 1,
    },
    combat: {
      attackKind: 'heavy',
      comboChain: [],
      hitWindow: { start: 0.25, end: 0.75 },
      hitShape: 'body',
      reach: 2.6,
      arc: Math.PI * 2,
      knockback: { mode: 'knockback', power: 4 },
    },
  },
  grabAndSlam: {
    url: '/assets/animation-packs/stunts/Grab And Slam.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    combat: {
      attackKind: 'heavy',
      comboChain: [],
      hitWindow: { start: 0.35, end: 0.55 },
      hitShape: 'body',
      reach: 1.8,
      arc: Math.PI * 0.3,
      knockback: { mode: 'throw' },
      requiresEnemy: true,
    },
  },
  flyingShoulderThrow: {
    url: '/assets/animation-packs/stunts/Flying Shoulder Throw.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
    combat: {
      attackKind: 'heavy',
      comboChain: [],
      hitWindow: { start: 0.4, end: 0.62 },
      hitShape: 'body',
      reach: 2.0,
      arc: Math.PI * 0.35,
      knockback: { mode: 'throw' },
      requiresEnemy: true,
    },
  },
  // --- Player hit reactions (Phase B). PlayerDamageSystem sets character.hitReaction;
  // AnimationStateSystem layers the upper body on grounded hits while legs locomote. ---
  hitBackward: {
    url: '/assets/animation-packs/stunts/Getting Hit Backwards.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
  },
  hitThrown: {
    url: '/assets/animation-packs/stunts/Getting Thrown.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.05,
  },

  // Armed (greatsword) flinch/impact reactions (upper-body layer when grounded).
  armedHitBackward: {
    url: '/assets/animation-packs/great sword impact.fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.06,
  },
  armedHitThrown: {
    url: '/assets/animation-packs/great sword impact (2).fbx',
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: 'locked',
    fadeIn: 0.05,
  },
  // Telekinesis / magic states (Phase 2). Unarmed full-body; armed use upper layer via armedTele*.
  // spell cast.fbx for grab/throw gesture; magic-locomotion standing idle for hold; great sword casting + power up for armed.
  // rootPosition locked, short fades 0.08-0.12 per design.
  teleGrab: {
    url: "/assets/animation-packs/spell cast.fbx",
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.1,
  },
  teleHold: {
    url: "/assets/animation-packs/magic-locomotion-pack/standing idle.fbx",
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.12,
  },
  teleThrow: {
    url: "/assets/animation-packs/spell cast.fbx",
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.08,
  },
  armedTeleGrab: {
    url: "/assets/animation-packs/great sword casting.fbx",
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.1,
  },
  armedTeleHold: {
    url: "/assets/animation-packs/great sword power up.fbx",
    loop: true,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.12,
  },
  armedTeleThrow: {
    url: "/assets/animation-packs/great sword casting.fbx",
    loop: false,
    retarget: false,
    useBakedClip: false,
    rootPosition: "locked",
    fadeIn: 0.08,
  },

};
