import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';

const MAX_HOOKS = 2;
const MIN_TETHER_LENGTH = 8;
const MAX_TETHER_LENGTH = 130;
const MIN_FIRE_RANGE = 3;
const MAX_FIRE_RANGE = 140;
const FIRE_COOLDOWN = 0.32;
const ATTACH_BLEND_SECONDS = 0.14;
const SWING_START_DURATION_FALLBACK = 1.4;
const SWING_MULTI_START_DURATION_FALLBACK = 1.4;
const ATTACH_COOLDOWN_SECONDS = 0.28;
const ROOT_HANG_OFFSET = 0;
const HAND_ATTACH_HEIGHT = 1.32;
const CLIMB_SPEED = 2.1;
const SWING_PUMP = 8.5;
const SWING_DAMPING = 0.08;
const MAX_ANGLE = 1.45;
const MAX_ANGULAR_VELOCITY = 5.2;
const SPRING_STIFFNESS = 58;
const SPRING_DAMPER = 8.5;
const STREET_FOLLOW_ACCEL = 28;
const WALL_SLIDE_RETAIN = 0.94;
const BUILDING_AVOID_BODY_RADIUS = 0.48;
const RELEASE_BASE_UP = 2.0;
const RELEASE_ARC_UP = 7.0;
const RELEASE_MIN_UP = 4.5;
const RELEASE_BASE_OUT = 2.0;
const RELEASE_ARC_OUT = 4.0;
const RELEASE_MOMENTUM_SECONDS = 0.58;
const RELEASE_FREE_FALL_SECONDS = 0.4;
const INPUT_THRESHOLD = 0.12;
const LINE_WIDTH = 0.045;
const LINE_SEGMENTS = 12;
// Free-floating grapple target cursor — shows where pressing E (or middle-click) will currently land.
const CURSOR_RECOMPUTE_INTERVAL = 0.09; // seconds between candidate raycast searches
const CURSOR_FOLLOW_LERP = 16;          // smoothing rate as the best target jumps buildings
const CURSOR_RADIUS = 1.1;              // outer ring radius (world units)
const CURSOR_FADE_RATE = 9;             // opacity fade-in/out rate per second
const CURSOR_HOLD_SECONDS = 0.7;        // keep showing the last target if a search misses
const CURSOR_SCREEN_SCALE = 0.055;      // scale factor vs camera distance (constant apparent size)
const CURSOR_SCALE_MIN = 0.6;           // clamp so very near targets stay sensible
const CURSOR_SCALE_MAX = 30;            // clamp so very far/high targets stay readable
const CURSOR_CAMERA_OFFSET = 1.5;       // float in front of the surface so it isn't occluded
const CURSOR_PLAYER_HEIGHT_OFFSET = 1.35; // display near torso height; the grapple still attaches high
// Pump energy amplifier at bottom of arc — rewards timing like a real pendulum pump
const PUMP_PHASE_BOOST = 1.4;
// Peak arc launch: release near top of arc for a hard upward pop
const PEAK_LAUNCH_UP = 16;
const PEAK_LAUNCH_THRESHOLD = 0.78;
// Velocity safety ceiling during swing (m/s)
const MAX_SWING_SPEED = 52;
// Fraction of the player's horizontal momentum carried into an airborne swing launch
// (so a fast approach / wingsuit burst slings forward instead of snapping to rest).
const HOOK_AIR_MOMENTUM_RETAIN = 0.7;
// Dual-rope pull launch: double-tap fire with both ropes out yanks the player
// forward in a hard burst, then auto-detaches once the burst momentum bleeds off.
const PULL_LAUNCH_SPEED = 48;            // initial forward burst speed (m/s)
const PULL_LAUNCH_UP = 9;                // upward kick added to the burst
const PULL_LAUNCH_DRAG = 1.1;            // per-second exponential drag on the burst
const PULL_LAUNCH_MIN_SECONDS = 0.18;    // minimum airtime before detach is allowed
const PULL_LAUNCH_MAX_SECONDS = 0.85;    // hard cap before forcing the detach
const PULL_LAUNCH_DETACH_SPEED = 24;     // detach once horizontal speed bleeds to this
// Ground-launch sequence: stay planted while swingStart plays, then lerp into the air.
const GROUND_LAUNCH_HOLD_SECONDS = 0.22;   // how long to stay planted before the lift
const GROUND_LAUNCH_LIFT_SECONDS = 0.38;   // how long the pull-into-air lerp takes
const GROUND_LAUNCH_FORWARD = 5;           // how far forward the lift target sits
const GROUND_LAUNCH_HEIGHT = 5.5;          // how high the lift target sits

const probeOrigin = new THREE.Vector3();
const aimDirection = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const rootPosition = new THREE.Vector3();
const ropeDown = new THREE.Vector3(0, -1, 0);
const ropeUp = new THREE.Vector3(0, 1, 0);
const facingDirection = new THREE.Vector3();
const socketDirection = new THREE.Vector3();
const releaseVelocity = new THREE.Vector3();
const tensionForce = new THREE.Vector3();
const hookOffset = new THREE.Vector3();
const planeNormal = new THREE.Vector3();
const currentRopeDir = new THREE.Vector3();
const tangentialDir = new THREE.Vector3();
const ribbonPoint = new THREE.Vector3();
const ribbonNext = new THREE.Vector3();
const ribbonPrevious = new THREE.Vector3();
const ribbonTangent = new THREE.Vector3();
const ribbonSide = new THREE.Vector3();
const cardAxisX = new THREE.Vector3(1, 0, 0);
const cardAxisZ = new THREE.Vector3(0, 0, 1);
const cardWorldUp = new THREE.Vector3(0, 1, 0);
const worldNormal = new THREE.Vector3();
const attachPoint = new THREE.Vector3();
const towardAnchor = new THREE.Vector3();
const cursorTargetPoint = new THREE.Vector3();
const cursorCameraPos = new THREE.Vector3();
const cursorWorldQuat = new THREE.Quaternion();

export class HookSwingSystem {
  constructor() {
    this.lastCandidate = null;
    this.scene = null;
    this.visualRoot = new THREE.Group();
    this.visualRoot.name = 'Hook Swing Visuals';
    this.tetherVisuals = [];
    this.cursorVisual = null;
    this.cursorPosition = new THREE.Vector3();
    this.cursorVisible = false;
    this.cursorOpacity = 0;
    this.recomputeTimer = 0;
    this.cachedCandidate = null;
    this.cursorDebug = {
      visible: false,
      opacity: 0,
      hasCandidate: false,
      searched: false,
      held: false,
      search: null,
    };
  }

  initialize(scene) {
    this.scene = scene;
    if (this.visualRoot.parent !== scene) {
      scene?.add(this.visualRoot);
    }

    while (this.tetherVisuals.length < MAX_HOOKS) {
      const visual = createTetherVisual();
      visual.group.visible = false;
      this.tetherVisuals.push(visual);
      this.visualRoot.add(visual.group);
    }

    if (!this.cursorVisual) {
      this.cursorVisual = createCursorVisual();
      this.cursorVisual.group.visible = false;
      this.visualRoot.add(this.cursorVisual.group);
    }
  }

  dispose() {
    this.visualRoot.removeFromParent();
    for (const visual of this.tetherVisuals) {
      visual.cardA?.geometry?.dispose();
      visual.cardB?.geometry?.dispose();
      visual.cardA?.material?.dispose();
      visual.cardB?.material?.dispose();
    }
    this.tetherVisuals = [];

    if (this.cursorVisual) {
      this.cursorVisual.ring?.geometry?.dispose();
      this.cursorVisual.dot?.geometry?.dispose();
      this.cursorVisual.ringMat?.dispose();
      this.cursorVisual.dotMat?.dispose();
      this.cursorVisual = null;
    }
  }

  update({ delta, input, movement, character, level, camera }) {
    character.hookSwingCooldown = Math.max(0, (character.hookSwingCooldown ?? 0) - delta);
    this.lastCandidate = null;

    const blocked =
      character.hang?.active ||
      character.wallRun?.active ||
      character.wallClimb?.active ||
      character.rope?.active ||
      character.mount?.active;

    if (blocked) {
      if (character.hookSwing?.active) {
        this.detachAll({ character });
      }
      this.updateCursor({ candidate: null, delta });
      return movement;
    }

    if (character.hookSwing?.active) {
      this.updateCursor({ candidate: null, delta });
      return this.updateActiveSwing({ delta, input, movement, character, level, camera });
    }

    // Realtime grapple target: locate the current best candidate (throttled) and
    // drive the floating cursor so the player can see where E will take them as
    // they move past buildings at different heights and speeds.
    const candidate = this.refreshCandidate({ level, camera, character, delta, force: input.hookFirePressed });

    this.lastCandidate = candidate
      ? {
          distance: Number(candidate.distance.toFixed(3)),
          heightAbove: Number((candidate.heightAbovePlayer ?? 0).toFixed(3)),
          mesh: candidate.meshName ?? null,
          normalY: Number(candidate.normal.y.toFixed(3)),
        }
      : null;

    this.updateCursor({ candidate, delta, camera, character });

    if (!canFireHook({ input, movement, character })) {
      return movement;
    }

    if (!candidate) {
      return movement;
    }

    this.fireHook({ character, candidate, movement, camera });
    return this.overrideMovement({ movement, character, moving: false });
  }

  // Throttled candidate search: reuse the cached result between intervals so the
  // per-frame raycast fan doesn't run every tick, but force a fresh search on the
  // actual fire press for an accurate launch.
  refreshCandidate({ level, camera, character, delta, force }) {
    this.recomputeTimer -= delta;
    this.candidateHold = Math.max(0, (this.candidateHold ?? 0) - delta);

    let result = null;
    let searched = false;
    const usedHeldCandidate = !force && this.recomputeTimer > 0 && Boolean(this.cachedCandidate);
    if (force) {
      // Fire press: full forgiving fan for an accurate launch.
      this.recomputeTimer = CURSOR_RECOMPUTE_INTERVAL;
      result = tryFindHookAttach({ level, camera, character, coarse: false });
      searched = true;
    } else if (this.recomputeTimer <= 0) {
      // Cursor preview: cheap small-fan search.
      this.recomputeTimer = CURSOR_RECOMPUTE_INTERVAL;
      result = tryFindHookAttach({ level, camera, character, coarse: true });
      searched = true;
    }

    if (searched) {
      if (result) {
        this.cachedCandidate = result;
        this.candidateHold = CURSOR_HOLD_SECONDS;
      } else if (this.candidateHold <= 0) {
        // Only drop the target once the hold window expires, so brief misses
        // (between buildings, momentary sky) don't flicker the cursor off.
        this.cachedCandidate = null;
      }
    }

    this.cursorDebug.searched = searched;
    this.cursorDebug.held = usedHeldCandidate || (!result && Boolean(this.cachedCandidate));
    this.cursorDebug.hasCandidate = Boolean(this.cachedCandidate);
    this.cursorDebug.search = level?.lastHookSearch ?? null;

    return this.cachedCandidate;
  }

  // Position and fade the floating target reticle toward the current best
  // candidate. Passing candidate: null fades it out.
  updateCursor({ candidate, delta, camera, character }) {
    const visual = this.cursorVisual;
    if (!visual) {
      return;
    }

    if (!candidate) {
      this.cursorOpacity = Math.max(0, this.cursorOpacity - delta * CURSOR_FADE_RATE);
      if (this.cursorOpacity <= 0.001) {
        visual.group.visible = false;
        this.cursorVisible = false;
      } else {
        applyCursorOpacity(visual, this.cursorOpacity);
      }
      this.cursorDebug.visible = visual.group.visible;
      this.cursorDebug.opacity = Number(this.cursorOpacity.toFixed(3));
      this.cursorDebug.hasCandidate = false;
      return;
    }

    // Display the reticle at the candidate's street/player-height projection so
    // the player can read it without looking up; the hook still fires to the
    // real high candidate.position.
    cursorTargetPoint.copy(candidate.position);
    if (character?.group?.position) {
      cursorTargetPoint.y = character.group.position.y + CURSOR_PLAYER_HEIGHT_OFFSET;
    }

    // Float it a bit toward the camera so it sits in front of the building face
    // instead of z-fighting or being hidden by the very surface it marks.
    if (camera) {
      camera.getWorldPosition(cursorCameraPos);
      towardAnchor.subVectors(cursorCameraPos, cursorTargetPoint);
      if (towardAnchor.lengthSq() > 1e-6) {
        towardAnchor.normalize();
        cursorTargetPoint.addScaledVector(towardAnchor, CURSOR_CAMERA_OFFSET);
      }
    }

    if (!this.cursorVisible) {
      // Snap into place when first appearing, then smooth-follow afterward.
      this.cursorPosition.copy(cursorTargetPoint);
    } else {
      const t = 1 - Math.exp(-CURSOR_FOLLOW_LERP * delta);
      this.cursorPosition.lerp(cursorTargetPoint, t);
    }

    this.cursorVisible = true;
    this.cursorOpacity = Math.min(1, this.cursorOpacity + delta * CURSOR_FADE_RATE);

    visual.group.visible = true;
    visual.group.position.copy(this.cursorPosition);

    // Billboard toward the camera and scale by distance for a roughly constant
    // on-screen size (so high/far targets stay readable instead of shrinking).
    let apparentScale = 1;
    if (camera) {
      camera.getWorldQuaternion(cursorWorldQuat);
      visual.group.quaternion.copy(cursorWorldQuat);
      const dist = cursorCameraPos.distanceTo(this.cursorPosition);
      apparentScale = THREE.MathUtils.clamp(dist * CURSOR_SCREEN_SCALE, CURSOR_SCALE_MIN, CURSOR_SCALE_MAX);
    }

    const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.09;
    visual.group.scale.setScalar(apparentScale * pulse);

    applyCursorOpacity(visual, this.cursorOpacity);
    this.cursorDebug.visible = true;
    this.cursorDebug.opacity = Number(this.cursorOpacity.toFixed(3));
    this.cursorDebug.position = vectorSnapshot(this.cursorPosition);
    this.cursorDebug.attachPosition = vectorSnapshot(candidate.position);
  }

  fireHook({ character, candidate, movement, camera }) {
    const anchor = candidate.position.clone();
    const playerPos = character.group.position.clone();
    const distance = THREE.MathUtils.clamp(
      playerPos.distanceTo(anchor),
      MIN_TETHER_LENGTH,
      MAX_TETHER_LENGTH,
    );
    const swingTangent = computeSwingTangent({ anchor, playerPos, camera, fallback: movement?.direction });

    let hookSwing = character.hookSwing;
    if (!hookSwing?.active) {
      hookSwing = this.createHookSwingState({ character, anchor, distance, swingTangent });
      character.hookSwing = hookSwing;
    } else if (hookSwing.hooks.length < MAX_HOOKS) {
      hookSwing.hooks.push(createHookEntry({ anchor, distance, swingTangent, character }));
      hookSwing.primaryIndex = hookSwing.hooks.length - 1;
      hookSwing.swingMultiStartElapsed = 0;
      hookSwing.swingMultiStartDuration =
        character.animationController?.durationFor?.('swingMultiStart') ?? SWING_MULTI_START_DURATION_FALLBACK;
    } else {
      hookSwing.hooks.shift();
      hookSwing.hooks.push(createHookEntry({ anchor, distance, swingTangent, character }));
      hookSwing.primaryIndex = hookSwing.hooks.length - 1;
    }

    hookSwing.active = true;
    hookSwing.attachBlend = ATTACH_BLEND_SECONDS;
    hookSwing.attachBlendDuration = ATTACH_BLEND_SECONDS;
    hookSwing.attachStartPosition = character.group.position.clone();
    hookSwing.lastFireTime = performance.now() * 0.001;
    hookSwing.velocity = hookSwing.velocity ?? new THREE.Vector3();

    if (hookSwing.hooks.length === 1) {
      hookSwing.swingStartElapsed = 0;
      hookSwing.swingStartDuration =
        character.animationController?.durationFor?.('swingStart') ?? SWING_START_DURATION_FALLBACK;
    }

    hookSwing.animationState = hookSwing.hooks.length > 1 ? 'hookMulti' : 'swingStart';

    const primary = hookSwing.hooks[hookSwing.primaryIndex];
    buildSwingPlane(primary, primary.anchor, character.group.position);

    hookOffset.subVectors(primary.anchor, character.group.position);
    if (movement?.grounded) {
      // Ground-launch sequence: hold at ground while swingStart plays, then lerp
      // the character up and forward as if pulled into the air, then hand off to
      // swing physics. velocity stays zero until the lift ends.
      hookSwing.groundLaunch = {
        elapsed: 0,
        startPos: character.group.position.clone(),
        liftTarget: computeGroundLaunchTarget(primary.anchor, character.group.position),
      };
      hookSwing.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
      const launchTotal = GROUND_LAUNCH_HOLD_SECONDS + GROUND_LAUNCH_LIFT_SECONDS + 0.08;
      character.forceFreeFallTimer = Math.max(character.forceFreeFallTimer ?? 0, launchTotal);
      character.groundSnapBlockTimer = Math.max(character.groundSnapBlockTimer ?? 0, launchTotal);
    } else if (hookOffset.lengthSq() > 1) {
      // Airborne fire: pull toward anchor blended with camera look direction.
      hookSwing.velocity.copy(hookOffset).normalize().multiplyScalar(13);
      if (camera) {
        camera.getWorldDirection(aimDirection);
        hookSwing.velocity.addScaledVector(aimDirection, 8);
      }
      // Carry the player's existing horizontal momentum into the swing so a fast
      // approach (e.g. bursting out of a wingsuit glide) slings forward instead of
      // snapping to rest. Read before character.velocity is zeroed below.
      hookSwing.velocity.addScaledVector(character.velocity, HOOK_AIR_MOMENTUM_RETAIN);
      hookSwing.velocity.y = Math.max(hookSwing.velocity.y, 8);
    } else {
      hookSwing.velocity.set(0, 0, 0);
    }

    character.hang = null;
    character.wallRun = null;
    character.wallClimb = null;
    character.rope = null;
    character.traversalAction = null;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = movement?.verticalVelocity ?? character.verticalVelocity ?? 0;
    character.grounded = false;

    this.applyPosition({ character, hookSwing, delta: ATTACH_BLEND_SECONDS, level: null });
  }

  createHookSwingState({ character, anchor, distance, swingTangent }) {
    return {
      active: true,
      hooks: [createHookEntry({ anchor, distance, swingTangent, character })],
      primaryIndex: 0,
      velocity: new THREE.Vector3(),
      attachBlend: ATTACH_BLEND_SECONDS,
      attachBlendDuration: ATTACH_BLEND_SECONDS,
      attachStartPosition: character.group.position.clone(),
      lastFireTime: performance.now() * 0.001,
      animationState: 'hookSwing',
      swingPhase: 0,
    };
  }

  // Drives the ground-launch sequence. Returns true when the lift finishes and
  // normal swing physics should take over; false while still in hold or lift.
  updateGroundLaunch({ delta, hookSwing, character }) {
    const gl = hookSwing.groundLaunch;
    gl.elapsed += delta;

    if (gl.elapsed < GROUND_LAUNCH_HOLD_SECONDS) {
      // Hold phase: stay planted. Animation (swingStart) plays, rope is taut.
      character.group.position.copy(gl.startPos);
      hookSwing.velocity.set(0, 0, 0);
      return false;
    }

    const liftElapsed = gl.elapsed - GROUND_LAUNCH_HOLD_SECONDS;
    const liftT = Math.min(liftElapsed / GROUND_LAUNCH_LIFT_SECONDS, 1.0);
    const eased = easeInOutCubic(liftT);

    // Record previous position so we can derive velocity for the handoff.
    const prevX = character.group.position.x;
    const prevY = character.group.position.y;
    const prevZ = character.group.position.z;

    character.group.position.lerpVectors(gl.startPos, gl.liftTarget, eased);

    // Keep swing velocity in sync with the lerp derivative so the transition
    // into physics feels continuous rather than snapping.
    if (delta > 0.0001) {
      hookSwing.velocity.set(
        (character.group.position.x - prevX) / delta,
        (character.group.position.y - prevY) / delta,
        (character.group.position.z - prevZ) / delta,
      );
    }

    if (liftT >= 1.0) {
      hookSwing.groundLaunch = null;
      return true;
    }

    return false;
  }

  seedHookPendulum({ hook, character }) {
    const anchor = hook.anchor;
    const playerPos = character.group.position;
    buildSwingPlane(hook, anchor, playerPos);

    const pivotLength = Math.max(1.1, hook.currentLength);
    const tangentialSpeed = character.velocity.dot(hook.planeTangent);
    hook.angularVelocity = THREE.MathUtils.clamp(
      tangentialSpeed / pivotLength,
      -MAX_ANGULAR_VELOCITY,
      MAX_ANGULAR_VELOCITY,
    );
  }

  // Begin the dual-rope pull launch: snap velocity into a hard forward burst
  // aimed where the camera looks (falling back to the current swing heading).
  startPullLaunch({ character, hookSwing, camera }) {
    if (camera) {
      camera.getWorldDirection(aimDirection);
      aimDirection.y = 0;
    } else {
      aimDirection.set(0, 0, 0);
    }
    if (aimDirection.lengthSq() < 0.0001 && hookSwing.velocity) {
      aimDirection.set(hookSwing.velocity.x, 0, hookSwing.velocity.z);
    }
    if (aimDirection.lengthSq() < 0.0001) {
      aimDirection.set(0, 0, -1);
    }
    aimDirection.normalize();

    hookSwing.velocity = hookSwing.velocity ?? new THREE.Vector3();
    hookSwing.velocity.copy(aimDirection).multiplyScalar(PULL_LAUNCH_SPEED);
    hookSwing.velocity.y = PULL_LAUNCH_UP;

    hookSwing.pullLaunch = { elapsed: 0 };
    hookSwing.groundLaunch = null;
    hookSwing.animationState = 'hookMulti';

    character.grounded = false;
    character.verticalVelocity = 0;
  }

  // Drive the pull launch each frame: integrate the burst as a drag-damped
  // ballistic arc, then detach both ropes once the momentum has bled off.
  updatePullLaunch({ delta, movement, character, level }) {
    const hookSwing = character.hookSwing;
    const launch = hookSwing.pullLaunch;
    launch.elapsed += delta;

    const gravity = GAME_CONFIG.character.gravity;
    const velocity = hookSwing.velocity;

    velocity.y -= gravity * delta;
    velocity.multiplyScalar(Math.exp(-PULL_LAUNCH_DRAG * delta));
    character.group.position.addScaledVector(velocity, delta);

    this.applyBuildingAvoidance({ level, character, hookSwing });

    const primary = hookSwing.hooks[hookSwing.primaryIndex];
    buildSwingPlane(primary, primary.anchor, character.group.position);
    this.faceSwingDirection({ character, hookSwing, pumpInput: 0 });

    hookSwing.swingPhase = 0;
    hookSwing.animationState = 'hookMulti';

    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;

    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const expired =
      launch.elapsed >= PULL_LAUNCH_MAX_SECONDS ||
      (launch.elapsed >= PULL_LAUNCH_MIN_SECONDS && horizontalSpeed <= PULL_LAUNCH_DETACH_SPEED);

    if (expired) {
      return this.releaseFromLaunch({ character, movement });
    }

    return this.overrideMovement({
      movement: { ...movement, moving: true, wantsMove: true, grounded: false, airborne: false, verticalVelocity: 0 },
      character,
      moving: true,
    });
  }

  // End the pull launch: carry the burst velocity into free fall and detach
  // both ropes.
  releaseFromLaunch({ character, movement }) {
    const hookSwing = character.hookSwing;
    releaseVelocity.copy(hookSwing?.velocity ?? new THREE.Vector3());

    character.velocity.set(releaseVelocity.x, 0, releaseVelocity.z);
    character.verticalVelocity = releaseVelocity.y;
    character.grounded = false;
    character.forceFreeFallTimer = RELEASE_FREE_FALL_SECONDS;
    character.airMomentumLockTimer = RELEASE_MOMENTUM_SECONDS;
    character.groundSnapBlockTimer = RELEASE_MOMENTUM_SECONDS;
    character.hookSwingCooldown = ATTACH_COOLDOWN_SECONDS;
    this.detachAll({ character });

    return {
      ...movement,
      moving: true,
      wantsMove: true,
      speed: Math.hypot(releaseVelocity.x, releaseVelocity.z),
      grounded: false,
      airborne: true,
      hookSwinging: false,
      hookSwingState: null,
      justJumped: true,
      justLanded: false,
      swingRelease: true,
      height: character.group.position.y,
      verticalVelocity: character.verticalVelocity,
    };
  }

  updateActiveSwing({ delta, input, movement, character, level, camera }) {
    const hookSwing = character.hookSwing;

    if (input.jumpPressed || input.hookReleasePressed) {
      this.release({ character });
      return {
        ...movement,
        moving: true,
        wantsMove: true,
        speed: character.velocity.length(),
        grounded: false,
        airborne: true,
        hookSwinging: false,
        hookSwingState: null,
        justJumped: true,
        justLanded: false,
        swingRelease: true,
        height: character.group.position.y,
        verticalVelocity: character.verticalVelocity,
      };
    }

    // Dual-rope pull launch: keep driving the burst once it has begun.
    if (hookSwing.pullLaunch) {
      return this.updatePullLaunch({ delta, movement, character, level });
    }

    // Double-tap fire with both ropes out → yank forward in a hard burst.
    if (input.hookFireDoubleTapped && hookSwing.hooks.length >= MAX_HOOKS) {
      this.startPullLaunch({ character, hookSwing, camera });
      return this.updatePullLaunch({ delta, movement, character, level });
    }

    if (input.hookFirePressed && (hookSwing.lastFireTime ?? 0) + FIRE_COOLDOWN <= performance.now() * 0.001) {
      const candidate = tryFindHookAttach({ level, camera, character });

      if (candidate) {
        this.fireHook({ character, candidate, movement, camera });
      }
    }

    // Ground-launch sequence: hold at ground while animation starts, then lerp into
    // the air. Skips normal swing physics until the lift finishes.
    if (hookSwing.groundLaunch) {
      const launched = this.updateGroundLaunch({ delta, hookSwing, character });

      if (hookSwing.hooks.length === 1 && (hookSwing.swingStartElapsed ?? Infinity) < (hookSwing.swingStartDuration ?? SWING_START_DURATION_FALLBACK)) {
        hookSwing.swingStartElapsed = (hookSwing.swingStartElapsed ?? 0) + delta;
      }
      hookSwing.swingPhase = 0;
      hookSwing.animationState = 'swingStart';
      this.faceSwingDirection({ character, hookSwing, pumpInput: 0 });
      character.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
      character.grounded = false;

      if (launched) {
        // Lift finished — seed the swing plane from the new position so physics
        // picks up with correct angle and angular velocity.
        const primary = hookSwing.hooks[hookSwing.primaryIndex];
        buildSwingPlane(primary, primary.anchor, character.group.position);
      }

      return this.overrideMovement({ movement: { ...movement, moving: false, wantsMove: false, grounded: false, airborne: false, verticalVelocity: 0 }, character, moving: false });
    }

    const climbInput = Math.abs(input.moveZ) > INPUT_THRESHOLD ? -input.moveZ : 0;
    const pumpInput = Math.abs(input.moveX) > INPUT_THRESHOLD ? input.moveX : 0;
    const gravity = GAME_CONFIG.character.gravity;

    this.updateMultiHookForces({ hookSwing, climbInput, pumpInput, gravity, delta, character, level });

    if (hookSwing.hooks.length === 1 && (hookSwing.swingStartElapsed ?? Infinity) < (hookSwing.swingStartDuration ?? SWING_START_DURATION_FALLBACK)) {
      hookSwing.swingStartElapsed = (hookSwing.swingStartElapsed ?? 0) + delta;
    }
    if (hookSwing.hooks.length > 1 && (hookSwing.swingMultiStartElapsed ?? Infinity) < (hookSwing.swingMultiStartDuration ?? SWING_MULTI_START_DURATION_FALLBACK)) {
      hookSwing.swingMultiStartElapsed = (hookSwing.swingMultiStartElapsed ?? 0) + delta;
    }

    hookSwing.swingPhase = computeSwingPhase(hookSwing.hooks[hookSwing.primaryIndex]);
    hookSwing.animationState = resolveHookAnimationState({ hookSwing, climbInput, pumpInput });

    this.applyPosition({ character, hookSwing, delta, level });
    this.faceSwingDirection({ character, hookSwing, pumpInput });
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;

    const speed = hookSwing.velocity?.length?.() ?? 0;

    return this.overrideMovement({
      movement: {
        ...movement,
        moving: Math.abs(climbInput) > 0 || Math.abs(pumpInput) > 0,
        wantsMove: Math.abs(climbInput) > 0 || Math.abs(pumpInput) > 0,
        speed,
        grounded: false,
        airborne: false,
        justJumped: false,
        justLanded: false,
        verticalVelocity: 0,
      },
      character,
      moving: Math.abs(climbInput) > 0 || Math.abs(pumpInput) > 0,
    });
  }

  updateSingleHookPendulum({ hook, climbInput, pumpInput, gravity, delta }) {
    const pivotLength = Math.max(1.1, hook.currentLength);
    const gravityAcceleration = -(gravity / pivotLength) * Math.sin(hook.angle);
    const pumpAcceleration = pumpInput * SWING_PUMP / Math.max(1.2, pivotLength);

    hook.angularVelocity += (gravityAcceleration + pumpAcceleration) * delta;
    hook.angularVelocity *= Math.exp(-SWING_DAMPING * delta);
    hook.angularVelocity = THREE.MathUtils.clamp(
      hook.angularVelocity,
      -MAX_ANGULAR_VELOCITY,
      MAX_ANGULAR_VELOCITY,
    );
    hook.angle = THREE.MathUtils.clamp(
      hook.angle + hook.angularVelocity * delta,
      -MAX_ANGLE,
      MAX_ANGLE,
    );
    hook.currentLength = THREE.MathUtils.clamp(
      hook.currentLength - climbInput * CLIMB_SPEED * delta,
      MIN_TETHER_LENGTH,
      MAX_TETHER_LENGTH,
    );
  }

  updateMultiHookForces({ hookSwing, climbInput, pumpInput, gravity, delta, character, level }) {
    const playerPos = character.group.position;
    if (!hookSwing.velocity) {
      hookSwing.velocity = new THREE.Vector3();
    }

    const preAvoidance = level?.computeHookSwingAvoidance?.({
      position: playerPos,
      velocity: hookSwing.velocity,
      bodyRadius: BUILDING_AVOID_BODY_RADIUS,
    });

    tensionForce.set(0, -gravity, 0);

    if (preAvoidance) {
      tensionForce.add(preAvoidance.repulsion);
      if (preAvoidance.inCorridor) {
        tensionForce.addScaledVector(preAvoidance.streetForward, STREET_FOLLOW_ACCEL);
      }
    }

    for (let index = 0; index < hookSwing.hooks.length; index += 1) {
      const hook = hookSwing.hooks[index];
      const isPrimary = index === hookSwing.primaryIndex;
      const climbScale = isPrimary ? 1 : 0.55;

      hook.currentLength = THREE.MathUtils.clamp(
        hook.currentLength - climbInput * CLIMB_SPEED * climbScale * delta,
        MIN_TETHER_LENGTH * (isPrimary ? 1 : 0.65),
        MAX_TETHER_LENGTH,
      );

      hookOffset.subVectors(playerPos, hook.anchor);
      const dist = hookOffset.length();
      const stretch = dist - hook.currentLength;

      if (stretch > 0.01 && dist > 0.001) {
        hookOffset.multiplyScalar(1 / dist);
        const weight = isPrimary ? 1.15 : 0.75;
        tensionForce.addScaledVector(hookOffset, -SPRING_STIFFNESS * stretch * weight);
        tensionForce.addScaledVector(hookSwing.velocity, -SPRING_DAMPER * weight * 0.08);
      }

      if (isPrimary) {
        const pivotLength = Math.max(1.1, hook.currentLength);
        const gravityAcceleration = -(gravity / pivotLength) * Math.sin(hook.angle);
        // Pump harder at the bottom of the arc (cos(angle) → 1 at bottom, lower at sides)
        const bottomPhase = Math.max(0, Math.cos(hook.angle));
        const pumpPhaseMultiplier = 1.0 + bottomPhase * PUMP_PHASE_BOOST;
        const pumpAcceleration = pumpInput * SWING_PUMP * pumpPhaseMultiplier / Math.max(1.2, pivotLength);
        hook.angularVelocity += (gravityAcceleration + pumpAcceleration) * delta;
        hook.angularVelocity *= Math.exp(-SWING_DAMPING * delta);
        hook.angularVelocity = THREE.MathUtils.clamp(
          hook.angularVelocity,
          -MAX_ANGULAR_VELOCITY,
          MAX_ANGULAR_VELOCITY,
        );
        hook.angle = THREE.MathUtils.clamp(
          hook.angle + hook.angularVelocity * delta,
          -MAX_ANGLE,
          MAX_ANGLE,
        );
      }
    }

    hookSwing.velocity.addScaledVector(tensionForce, delta);
    hookSwing.velocity.multiplyScalar(Math.exp(-0.08 * delta));
    // Safety ceiling to prevent runaway velocity from sustained pumping
    const swingSpeedSq = hookSwing.velocity.lengthSq();
    if (swingSpeedSq > MAX_SWING_SPEED * MAX_SWING_SPEED) {
      hookSwing.velocity.multiplyScalar(MAX_SWING_SPEED / Math.sqrt(swingSpeedSq));
    }
    playerPos.addScaledVector(hookSwing.velocity, delta);

    for (const hook of hookSwing.hooks) {
      hookOffset.subVectors(playerPos, hook.anchor);
      const dist = hookOffset.length();
      if (dist > hook.currentLength && dist > 0.001) {
        // Unit radial direction (player → anchor outward).
        hookOffset.multiplyScalar(1 / dist);
        // Snap the position back onto the rope sphere.
        playerPos.addScaledVector(hookOffset, -(dist - hook.currentLength));
        // ...and bleed off the outward velocity component so it doesn't fling
        // back past the limit next frame. Without this, position is corrected
        // but the velocity keeps pointing outward, so a fast/high swing bounces
        // in and out of the constraint every frame — the rubber-banding. Killing
        // the radial component leaves a clean tangential (pendulum) velocity.
        const radialSpeed = hookSwing.velocity.dot(hookOffset);
        if (radialSpeed > 0) {
          hookSwing.velocity.addScaledVector(hookOffset, -radialSpeed);
        }
      }
    }

    const primary = hookSwing.hooks[hookSwing.primaryIndex];
    buildSwingPlane(primary, primary.anchor, playerPos);

    this.applyBuildingAvoidance({ level, character, hookSwing });
  }

  applyBuildingAvoidance({ level, character, hookSwing }) {
    if (!level?.computeHookSwingAvoidance || !hookSwing?.velocity) {
      return;
    }

    const avoidance = level.computeHookSwingAvoidance({
      position: character.group.position,
      velocity: hookSwing.velocity,
      bodyRadius: BUILDING_AVOID_BODY_RADIUS,
    });

    if (avoidance.hasWall && avoidance.wallNormal.lengthSq() > 0) {
      const intoWall = hookSwing.velocity.dot(avoidance.wallNormal);
      if (intoWall < 0) {
        hookSwing.velocity.addScaledVector(avoidance.wallNormal, -intoWall * WALL_SLIDE_RETAIN);
      }
    }

    if (avoidance.penetration > 0 && avoidance.wallNormal.lengthSq() > 0) {
      character.group.position.addScaledVector(avoidance.wallNormal, avoidance.penetration * 0.9);
      const intoWall = hookSwing.velocity.dot(avoidance.wallNormal);
      if (intoWall < 0) {
        hookSwing.velocity.addScaledVector(avoidance.wallNormal, -intoWall);
      }
    }
  }

  applyPosition({ character, hookSwing, delta, level }) {
    const primary = hookSwing.hooks[hookSwing.primaryIndex];

    hookOffset.subVectors(character.group.position, primary.anchor);
    if (hookOffset.lengthSq() > 0.0001) {
      primary.ropeDirection = primary.ropeDirection ?? new THREE.Vector3();
      primary.ropeDirection.copy(hookOffset).normalize();
      primary.socketPoint = primary.socketPoint ?? new THREE.Vector3();
      primary.socketPoint.copy(character.group.position);
    }

    if (level?.getGroundHeightAt) {
      const groundY = level.getGroundHeightAt(character.group.position, 0.55);
      if (Number.isFinite(groundY) && character.group.position.y < groundY + 0.2) {
        character.group.position.y = groundY + 0.2;
        if (hookSwing.velocity) {
          hookSwing.velocity.y = Math.max(hookSwing.velocity.y, 0);
        }
      }
    }

    if ((hookSwing.attachBlend ?? 0) > 0) {
      hookSwing.attachBlend = Math.max(0, hookSwing.attachBlend - delta);
      const duration = hookSwing.attachBlendDuration || ATTACH_BLEND_SECONDS;
      const alpha = 1 - hookSwing.attachBlend / duration;
      targetPosition.lerpVectors(
        hookSwing.attachStartPosition,
        character.group.position,
        easeOutCubic(THREE.MathUtils.clamp(alpha, 0, 1)),
      );
      character.group.position.copy(targetPosition);
      return;
    }
  }

  updateSocket(hook) {
    getRopeDirection(hook, socketDirection);

    hook.ropeDirection = hook.ropeDirection ?? new THREE.Vector3();
    hook.socketPoint = hook.socketPoint ?? new THREE.Vector3();
    hook.ropeDirection.copy(socketDirection);
    hook.socketPoint
      .copy(hook.anchor)
      .addScaledVector(hook.ropeDirection, hook.currentLength);
  }

  faceSwingDirection({ character, hookSwing, pumpInput }) {
    const primary = hookSwing.hooks[hookSwing.primaryIndex];
    const velocity = hookSwing.velocity;

    if (velocity && velocity.lengthSq() > 2.5) {
      facingDirection.set(velocity.x, 0, velocity.z);
    } else {
      const sign = Math.sign(pumpInput || primary.angularVelocity || primary.angle || 1);
      facingDirection.copy(primary.swingTangent).multiplyScalar(sign);
    }

    if (facingDirection.lengthSq() > 0.0001) {
      facingDirection.normalize();
      character.group.rotation.y = Math.atan2(facingDirection.x, facingDirection.z);
    }
  }

  release({ character }) {
    const hookSwing = character.hookSwing;
    if (!hookSwing?.active) {
      return;
    }

    const primary = hookSwing.hooks[hookSwing.primaryIndex];
    const angle = primary.angle;
    const angularVelocity = primary.angularVelocity;
    const swingSpeed = hookSwing.velocity?.length?.() ?? 0;

    // How far into the arc we are — 1.0 = fully at MAX_ANGLE (top of arc)
    const peakFraction = THREE.MathUtils.clamp(Math.abs(angle) / MAX_ANGLE, 0, 1);
    const isPeakLaunch = peakFraction >= PEAK_LAUNCH_THRESHOLD;

    releaseVelocity.copy(hookSwing.velocity ?? new THREE.Vector3());
    if (releaseVelocity.lengthSq() < 4) {
      getTangentialDirection(primary, tangentialDir);
      releaseVelocity.copy(tangentialDir).multiplyScalar(8);
    }

    getTangentialDirection(primary, tangentialDir);
    const arcDirection = Math.sign(angle || angularVelocity || 1);

    if (isPeakLaunch) {
      // Peak arc launch: pop hard upward, scale with swing speed for Spider-Man feel
      const launchStrength = THREE.MathUtils.clamp(
        (peakFraction - PEAK_LAUNCH_THRESHOLD) / (1.0 - PEAK_LAUNCH_THRESHOLD),
        0, 1,
      );
      const upBoost = PEAK_LAUNCH_UP * launchStrength + swingSpeed * 0.55;
      releaseVelocity.y += upBoost;
      // Small outward nudge to clear the tether, horizontal momentum is already there
      releaseVelocity.addScaledVector(tangentialDir, arcDirection * RELEASE_BASE_OUT);
    } else {
      const arcAmount = THREE.MathUtils.clamp((Math.abs(angle) - 0.32) / 0.5, 0, 1);
      releaseVelocity
        .addScaledVector(tangentialDir, arcDirection * (RELEASE_BASE_OUT + RELEASE_ARC_OUT * arcAmount))
        .addScaledVector(primary.planeRest, RELEASE_BASE_UP + RELEASE_ARC_UP * arcAmount);
    }

    character.velocity.set(releaseVelocity.x, 0, releaseVelocity.z);
    character.verticalVelocity = Math.max(RELEASE_MIN_UP, releaseVelocity.y);
    character.grounded = false;
    character.forceFreeFallTimer = RELEASE_FREE_FALL_SECONDS;
    character.airMomentumLockTimer = RELEASE_MOMENTUM_SECONDS;
    character.groundSnapBlockTimer = RELEASE_MOMENTUM_SECONDS;
    character.hookSwingCooldown = ATTACH_COOLDOWN_SECONDS;
    this.detachAll({ character });
  }

  detachAll({ character }) {
    character.hookSwing = null;
  }

  overrideMovement({ movement, character, moving }) {
    const hookSwing = character.hookSwing;
    const primary = hookSwing?.hooks?.[hookSwing.primaryIndex];
    const speed = hookSwing?.hooks?.length === 1 && primary
      ? Math.abs(primary.angularVelocity) * Math.max(1.1, primary.currentLength)
      : hookSwing?.velocity?.length?.() ?? 0;

    return {
      ...movement,
      moving,
      wantsMove: moving,
      speed,
      direction: primary?.swingTangent?.clone?.() ?? movement.direction,
      grounded: false,
      airborne: false,
      hookSwinging: true,
      hookSwingState: hookSwing?.animationState ?? 'hookSwing',
      hookCount: hookSwing?.hooks?.length ?? 0,
      swingPhase: hookSwing?.swingPhase ?? 0,
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }

  syncVisuals({ character, animationController }) {
    const hookSwing = character?.hookSwing;
    const hookCount = hookSwing?.active ? hookSwing.hooks.length : 0;

    while (this.tetherVisuals.length < hookCount) {
      this.tetherVisuals.push(createTetherVisual());
      this.visualRoot.add(this.tetherVisuals[this.tetherVisuals.length - 1].group);
    }

    for (let index = 0; index < this.tetherVisuals.length; index += 1) {
      const visual = this.tetherVisuals[index];
      const hook = hookSwing?.hooks?.[index];

      if (!hook) {
        visual.group.visible = false;
        continue;
      }

      visual.group.visible = true;
      const muzzle = getMuzzlePosition(animationController, character, index);
      const points = [
        { x: muzzle.x, y: muzzle.y, z: muzzle.z, t: 0 },
        { x: hook.anchor.x, y: hook.anchor.y, z: hook.anchor.z, t: 1 },
      ];

      updateRopeCard({ mesh: visual.cardA, points, width: LINE_WIDTH, sideHint: cardAxisX });
      updateRopeCard({ mesh: visual.cardB, points, width: LINE_WIDTH, sideHint: cardAxisZ });
    }
  }

  snapshot(character) {
    const hookSwing = character?.hookSwing;

    return {
      candidate: this.lastCandidate,
      active: Boolean(hookSwing?.active),
      cursor: {
        ...this.cursorDebug,
        visualReady: Boolean(this.cursorVisual),
        parented: this.cursorVisual?.group?.parent === this.visualRoot,
      },
      hookCount: hookSwing?.hooks?.length ?? 0,
      state: hookSwing?.animationState ?? null,
      swingPhase: Number((hookSwing?.swingPhase ?? 0).toFixed(3)),
      primary: hookSwing?.hooks?.[hookSwing?.primaryIndex ?? 0]
        ? {
            length: Number((hookSwing.hooks[hookSwing.primaryIndex].currentLength ?? 0).toFixed(3)),
            angle: Number((hookSwing.hooks[hookSwing.primaryIndex].angle ?? 0).toFixed(3)),
            angularVelocity: Number((hookSwing.hooks[hookSwing.primaryIndex].angularVelocity ?? 0).toFixed(3)),
            anchor: vectorSnapshot(hookSwing.hooks[hookSwing.primaryIndex].anchor),
          }
        : null,
    };
  }
}

function createHookEntry({ anchor, distance, swingTangent, character }) {
  return {
    anchor: anchor.clone(),
    restLength: distance,
    currentLength: distance,
    swingTangent: swingTangent.clone(),
    planeRest: new THREE.Vector3(0, -1, 0),
    planeTangent: swingTangent.clone(),
    angle: 0,
    angularVelocity: THREE.MathUtils.clamp(
      character.velocity.length() / Math.max(1.1, distance),
      -1.5,
      1.5,
    ),
    ropeDirection: new THREE.Vector3(0, -1, 0),
    socketPoint: new THREE.Vector3(),
    attachTime: performance.now() * 0.001,
  };
}

function tryFindHookAttach({ level, camera, character, coarse = false }) {
  return level.findHookAttachCandidate({
    camera,
    playerPosition: character.group.position,
    maxDistance: MAX_FIRE_RANGE,
    minDistance: MIN_FIRE_RANGE,
    coarse,
  });
}

function canFireHook({ input, movement, character }) {
  if ((character.hookSwingCooldown ?? 0) > 0) {
    return false;
  }

  if (character.mount?.active) {
    return false;
  }

  return input.hookFirePressed;
}

function buildSwingPlane(hook, anchor, targetPos) {
  hookOffset.subVectors(targetPos, anchor);
  const dist = Math.max(0.5, hookOffset.length());
  hook.currentLength = THREE.MathUtils.clamp(dist, MIN_TETHER_LENGTH, MAX_TETHER_LENGTH);
  hook.restLength = hook.currentLength;

  if (hookOffset.lengthSq() > 0.0001) {
    currentRopeDir.copy(hookOffset).multiplyScalar(1 / dist);
  } else {
    currentRopeDir.set(0, -1, 0);
  }

  hook.planeRest = hook.planeRest ?? new THREE.Vector3();
  hook.planeTangent = hook.planeTangent ?? new THREE.Vector3();

  planeNormal.crossVectors(currentRopeDir, ropeDown);
  if (planeNormal.lengthSq() <= 1e-6) {
    planeNormal.set(1, 0, 0);
  } else {
    planeNormal.normalize();
  }

  hook.planeTangent.crossVectors(ropeDown, planeNormal);
  if (hook.planeTangent.lengthSq() <= 1e-6) {
    hook.planeTangent.set(1, 0, 0);
  } else {
    hook.planeTangent.normalize();
  }

  hook.planeRest.copy(ropeDown).addScaledVector(planeNormal, -ropeDown.dot(planeNormal));
  if (hook.planeRest.lengthSq() <= 1e-6) {
    hook.planeRest.copy(currentRopeDir);
  } else {
    hook.planeRest.normalize();
  }

  if (hook.planeRest.dot(currentRopeDir) < 0) {
    hook.planeRest.negate();
    hook.planeTangent.negate();
  }

  hook.angle = THREE.MathUtils.clamp(
    Math.atan2(currentRopeDir.dot(hook.planeTangent), currentRopeDir.dot(hook.planeRest)),
    -MAX_ANGLE,
    MAX_ANGLE,
  );
  hook.swingTangent.copy(hook.planeTangent);
}

function getRopeDirection(hook, target) {
  return target
    .copy(hook.planeRest)
    .multiplyScalar(Math.cos(hook.angle))
    .addScaledVector(hook.planeTangent, Math.sin(hook.angle))
    .normalize();
}

function getTangentialDirection(hook, target) {
  return target
    .copy(hook.planeRest)
    .multiplyScalar(-Math.sin(hook.angle))
    .addScaledVector(hook.planeTangent, Math.cos(hook.angle))
    .normalize();
}

function computeSwingTangent({ anchor, playerPos, camera, fallback }) {
  // Camera horizontal forward is the best tangent — the player is pointing at where
  // they want to go, so the swing plane should face that direction.
  if (camera) {
    camera.getWorldDirection(aimDirection);
    aimDirection.y = 0;
    if (aimDirection.lengthSq() > 0.01) {
      return aimDirection.clone().normalize();
    }
  }

  const horizontal = new THREE.Vector3(
    playerPos.x - anchor.x,
    0,
    playerPos.z - anchor.z,
  );

  if (horizontal.lengthSq() > 0.04) {
    return horizontal.normalize();
  }

  if (fallback && fallback.lengthSq() > 0.0001) {
    return new THREE.Vector3(fallback.x, 0, fallback.z).normalize();
  }

  return new THREE.Vector3(1, 0, 0);
}

function computeSwingPhase(hook) {
  if (!hook) {
    return 0;
  }

  // Low point of arc ≈ rope aligned with gravity rest direction in the swing plane.
  return THREE.MathUtils.clamp((Math.cos(hook.angle) + 1) * 0.5, 0, 1);
}

function resolveHookAnimationState({ hookSwing }) {
  if (hookSwing.hooks.length > 1) {
    const multiElapsed = hookSwing.swingMultiStartElapsed ?? Infinity;
    const multiDuration = hookSwing.swingMultiStartDuration ?? SWING_MULTI_START_DURATION_FALLBACK;
    return multiElapsed < multiDuration ? 'swingMultiStart' : 'hookMulti';
  }

  const elapsed = hookSwing.swingStartElapsed ?? Infinity;
  const duration = hookSwing.swingStartDuration ?? SWING_START_DURATION_FALLBACK;
  return elapsed < duration ? 'swingStart' : 'hookSwing';
}

function getMuzzlePosition(animationController, character, index = 0) {
  const boneName = index % 2 === 0 ? 'mixamorigRightHand' : 'mixamorigLeftHand';
  const modelRoot = animationController?.modelRoot;
  if (modelRoot) {
    modelRoot.updateMatrixWorld(true);
    const bone = modelRoot.getObjectByName(boneName);
    if (bone) {
      const pos = new THREE.Vector3();
      bone.getWorldPosition(pos);
      return pos;
    }
  }

  const side = index % 2 === 0 ? 0.28 : -0.28;
  return character.group.position.clone().add(new THREE.Vector3(side, HAND_ATTACH_HEIGHT, 0.12));
}

function createCursorVisual() {
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });

  // RingGeometry lies in the XY plane with its normal along +Z, so the group's
  // +Z is aligned to the surface normal when placed.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(CURSOR_RADIUS * 0.62, CURSOR_RADIUS, 44),
    ringMat,
  );
  ring.name = 'Hook Cursor Ring';
  ring.renderOrder = 999;

  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 14), dotMat);
  dot.name = 'Hook Cursor Dot';
  dot.renderOrder = 999;

  const group = new THREE.Group();
  group.name = 'Hook Target Cursor';
  group.renderOrder = 999;
  group.add(ring, dot);

  return { group, ring, dot, ringMat, dotMat };
}

function applyCursorOpacity(visual, opacity) {
  visual.ringMat.opacity = 0.9 * opacity;
  visual.dotMat.opacity = 0.95 * opacity;
}

function createTetherVisual() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xc8d4e8,
    metalness: 0.35,
    roughness: 0.42,
    side: THREE.DoubleSide,
  });

  const cardA = new THREE.Mesh(createRibbonGeometry(LINE_SEGMENTS), material);
  const cardB = new THREE.Mesh(createRibbonGeometry(LINE_SEGMENTS), material.clone());
  cardA.name = 'Hook Tether Card A';
  cardB.name = 'Hook Tether Card B';

  const group = new THREE.Group();
  group.name = 'Hook Tether';
  group.add(cardA, cardB);

  return { group, cardA, cardB };
}

function createRibbonGeometry(rows) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(rows * 2 * 3);

  for (let row = 0; row < rows; row += 1) {
    const t = rows <= 1 ? 0 : row / (rows - 1);
    positions[row * 6] = 0;
    positions[row * 6 + 1] = t;
    positions[row * 6 + 2] = 0;
    positions[row * 6 + 3] = 0;
    positions[row * 6 + 4] = t;
    positions[row * 6 + 5] = 0;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function updateRopeCard({ mesh, points, width, sideHint }) {
  const geometry = mesh?.geometry;
  const position = geometry?.attributes?.position;

  if (!position) {
    return;
  }

  const rows = position.count / 2;
  const halfWidth = width * 0.5;

  for (let row = 0; row < rows; row += 1) {
    const t = rows <= 1 ? 0 : row / (rows - 1);
    samplePoint(points, t, ribbonPoint);
    samplePoint(points, Math.min(1, t + 0.04), ribbonNext);
    samplePoint(points, Math.max(0, t - 0.04), ribbonPrevious);
    ribbonTangent.subVectors(ribbonNext, ribbonPrevious);

    if (ribbonTangent.lengthSq() <= 0.0001) {
      ribbonTangent.copy(cardWorldUp);
    } else {
      ribbonTangent.normalize();
    }

    ribbonSide.copy(sideHint).addScaledVector(ribbonTangent, -sideHint.dot(ribbonTangent));

    if (ribbonSide.lengthSq() <= 0.0001) {
      ribbonSide.crossVectors(cardWorldUp, ribbonTangent);
    }

    if (ribbonSide.lengthSq() <= 0.0001) {
      ribbonSide.copy(sideHint);
    } else {
      ribbonSide.normalize();
    }

    position.setXYZ(
      row * 2,
      ribbonPoint.x - ribbonSide.x * halfWidth,
      ribbonPoint.y - ribbonSide.y * halfWidth,
      ribbonPoint.z - ribbonSide.z * halfWidth,
    );
    position.setXYZ(
      row * 2 + 1,
      ribbonPoint.x + ribbonSide.x * halfWidth,
      ribbonPoint.y + ribbonSide.y * halfWidth,
      ribbonPoint.z + ribbonSide.z * halfWidth,
    );
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

function samplePoint(points, t, target) {
  if (Number.isFinite(points[0]?.t)) {
    const targetT = THREE.MathUtils.clamp(t, 0, 1);
    let index = 0;

    while (index < points.length - 2 && points[index + 1].t < targetT) {
      index += 1;
    }

    const a = points[index];
    const b = points[index + 1] ?? a;
    const span = Math.max(0.000001, (b.t ?? 1) - (a.t ?? 0));
    const localT = THREE.MathUtils.clamp((targetT - (a.t ?? 0)) / span, 0, 1);

    target.set(
      THREE.MathUtils.lerp(a.x, b.x, localT),
      THREE.MathUtils.lerp(a.y, b.y, localT),
      THREE.MathUtils.lerp(a.z, b.z, localT),
    );

    return target;
  }

  const scaled = THREE.MathUtils.clamp(t, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const localT = scaled - index;
  const a = points[index];
  const b = points[index + 1] ?? a;

  target.set(
    THREE.MathUtils.lerp(a.x, b.x, localT),
    THREE.MathUtils.lerp(a.y, b.y, localT),
    THREE.MathUtils.lerp(a.z, b.z, localT),
  );

  return target;
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// Compute the world-space target for the ground-launch lift: a point up and
// forward from the player in the direction of the anchor, placed high enough
// that rope tension has a meaningful arc to work with.
function computeGroundLaunchTarget(anchor, playerPos) {
  towardAnchor.set(anchor.x - playerPos.x, 0, anchor.z - playerPos.z);
  const horizDist = towardAnchor.length();
  if (horizDist > 0.01) {
    towardAnchor.multiplyScalar(1 / horizDist);
  } else {
    towardAnchor.set(0, 0, -1);
  }
  return new THREE.Vector3(
    playerPos.x + towardAnchor.x * Math.min(horizDist * 0.35, GROUND_LAUNCH_FORWARD),
    playerPos.y + GROUND_LAUNCH_HEIGHT,
    playerPos.z + towardAnchor.z * Math.min(horizDist * 0.35, GROUND_LAUNCH_FORWARD),
  );
}

function vectorSnapshot(vector) {
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}
