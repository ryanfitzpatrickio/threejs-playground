import * as THREE from 'three';
import { TraversalActionSystem } from './TraversalActionSystem.js';
import { TRAVERSAL_ACTION_DEFINITIONS } from './TraversalActionDefinitions.js';

const HANG_FACE_OFFSET = 0.34;
const HANG_ROOT_DROP_FROM_LEDGE = 1.7;
const HAND_TARGET_SPACING = 0.26;
const HAND_TARGET_REACH = 0.25;
const HAND_TARGET_Y_OFFSET = -0.01;
const HAND_TARGET_NORMAL_OFFSET = 0.18;
const HAND_TARGET_CLIMB_TOP_Y_OFFSET = 0.065;
const HAND_TARGET_CLIMB_TOP_NORMAL_OFFSET = -0.2;
const HAND_TARGET_CLIMB_TOP_START = 0.56;
const HAND_TARGET_CLIMB_TOP_END = 0.78;
const HAND_TARGET_MARKER_SIZE = 0.12;
const HAND_TARGET_MARKERS_VISIBLE = false;
const HAND_TARGET_SNAP_DISTANCE = 1.5;
const HAND_TARGET_RETURN_SMOOTHING = 8;
const FREE_HANG_IDLE_SEQUENCE = [
  { state: 'freeHangIdleAlt2', seconds: Infinity },
];
const SHIMMY_SPEED = 1.25;
const HOP_DISTANCE = 1.86;
const HOP_ACTION_DURATION_SECONDS = 2.15;
const HOP_ACTION_EXIT_PROGRESS = 0.98;
const HOP_DOUBLE_TAP_SECONDS = 0.3;
const CLIMB_INPUT_THRESHOLD = -0.5;
const HANG_DOWN_INPUT_THRESHOLD = 0.5;
const CLIMB_UP_FOOT_PLANT_START = 0.7;
const MIN_ROOT_MOTION_ALONG_DELTA = 0.0001;
const MIN_LEDGE_FACE_DISTANCE = 0.04;
const MAX_LEDGE_FACE_DISTANCE = 0.48;
const MIN_LEDGE_INPUT_APPROACH = 0.35;
const MIN_LEDGE_VELOCITY_APPROACH = 0.18;
const LEDGE_GRAB_MIN_ROOT_DROP = 1.05;
const LEDGE_GRAB_MAX_ROOT_DROP = 1.75;
const CLIMB_TOP_OFFSET = 0.58;
const CLIMB_TOP_SUPPORT_INWARD_MIN = 0.05;
const CLIMB_TOP_SUPPORT_INWARD_MAX = 1.35;
const CLIMB_TOP_REQUIRED_SHELF_DEPTH = CLIMB_TOP_OFFSET + 0.16;
const CLIMB_REJECT_INPUT_LOCK_SECONDS = 0.18;
// Runtime stand-clearance probe. Buildings are a single AABB collider plus a
// detailed trimesh, so setback walls only exist in the trimesh and must be
// found with a geometry raycast (not getBlockingColliderAt). We cast inward
// from the ledge edge at chest height and read the distance to the first wall:
//   < STAND_MIN_DEPTH         -> no room to stand, treat as a wall ledge
//   < COVER_SNEAK_MAX_DEPTH   -> standable but narrow with a wall behind (sneak)
//   >= COVER_SNEAK_MAX_DEPTH  -> open shelf, normal locomotion
const STAND_PROBE_HEIGHT = 1.0;
const STAND_PROBE_EPSILON = 0.06;
const STAND_PROBE_MAX_DISTANCE = 1.4;
const STAND_MIN_DEPTH = 0.5;
const COVER_SNEAK_MAX_DEPTH = 1.15;
// Wall-ledge "up" hop: reach window (vertical rise) for grabbing a higher ledge.
// City floors are ~4-5m tall with roughly one ledge per floor, so the window
// must span a full floor (plus margin) to reach the next ledge up, while staying
// under two floors so a single hop never skips a ledge.
const HOP_UP_MIN_RISE = 0.9;
const HOP_UP_MAX_RISE = 5.6;
const HOP_UP_ACTION_DURATION_SECONDS = 0.62;
const HOP_UP_ACTION_EXIT_PROGRESS = 0.92;
const CLIMB_FALLBACK_MIN_HEIGHT = 0.12;
const CLIMB_ACTION = TRAVERSAL_ACTION_DEFINITIONS.ledgeClimb;
const CONTINUE_CLIMB_INPUT_SETTLE_SECONDS = 0.22;
const DROP_FREE_FALL_SECONDS = 0.45;
const HANG_ENTRY_INPUT_LOCK_SECONDS = 0.22;
const WALL_JUMP_OUTWARD_SPEED = 4.45;
const WALL_JUMP_UP_SPEED = 6.15;
const WALL_JUMP_FREE_FALL_SECONDS = 0.28;
const LEDGE_APPROACH_STANDING_SPEED = 0.45;
const LEDGE_APPROACH_TIMEOUT_SECONDS = 2.8;
const LEDGE_APPROACH_INTENTS = {
  standingTop: 'standingTop',
  standingJump: 'standingJump',
  airborneMomentum: 'airborneMomentum',
};
const LEDGE_ATTACH_PROFILES = {
  jumpToFreeHang: {
    clipDuration: 2.467,
    timeScale: 1.55,
    exitProgress: 0.88,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.18,
      endProgress: 0.76,
    },
  },
  jumpToHang: {
    clipDuration: 2,
    timeScale: 1.55,
    exitProgress: 0.9,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.1,
      endProgress: 0.66,
    },
  },
  jumpingToHanging: {
    clipDuration: 1.5,
    timeScale: 1.45,
    exitProgress: 0.9,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.16,
      endProgress: 0.74,
    },
  },
  idleToBracedHang: {
    clipDuration: 1.267,
    timeScale: 1.35,
    exitProgress: 0.92,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.22,
      endProgress: 0.78,
    },
  },
  bracedHangAttach: {
    clipDuration: 1.3,
    timeScale: 1.35,
    exitProgress: 0.92,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.18,
      endProgress: 0.76,
    },
  },
};
const MODE_SWITCH_PROFILES = {
  freeHangToBraced: {
    clipDuration: 0.85,
    timeScale: 1.35,
    exitProgress: 0.92,
  },
  bracedToFreeHang: {
    clipDuration: 0.85,
    timeScale: 1.35,
    exitProgress: 0.92,
  },
};
const LEDGE_CLIMB_DOWN_PROFILES = {
  freeHangClimbDown: {
    clipDuration: 3.867,
    timeScale: 4,
    exitProgress: 0.96,
    motionWarp: {
      position: 'startToTarget',
      curve: 'ledgeClimbDown',
      outwardStartProgress: 0.04,
      outwardEndProgress: 0.36,
      dropStartProgress: 0.16,
      dropEndProgress: 0.9,
    },
  },
  bracedHangToCrouchDown: {
    clipDuration: 1.133,
    timeScale: 4,
    exitProgress: 0.96,
    motionWarp: {
      position: 'startToTarget',
      curve: 'ledgeClimbDown',
      outwardStartProgress: 0.04,
      outwardEndProgress: 0.36,
      dropStartProgress: 0.16,
      dropEndProgress: 0.9,
    },
  },
};

const hangPosition = new THREE.Vector3();
const climbEndPosition = new THREE.Vector3();
const facing = new THREE.Vector3();
const ledgeApproachNormal = new THREE.Vector3();
const ledgeApproachInput = new THREE.Vector3();
const ledgeApproachVelocity = new THREE.Vector3();
const rootMotionMovement = new THREE.Vector3();
const rootMotionTotalMovement = new THREE.Vector3();
const rootMotionTangent = new THREE.Vector3();
const handTargetPoint = new THREE.Vector3();
const handTargetNormal = new THREE.Vector3();
const handTargetTangent = new THREE.Vector3();
const leftHandTargetPosition = new THREE.Vector3();
const rightHandTargetPosition = new THREE.Vector3();
const currentHandLeft = new THREE.Vector3();
const currentHandRight = new THREE.Vector3();
const hiddenMarkerPosition = new THREE.Vector3(0, -1000, 0);
const hangCameraMove = new THREE.Vector3();
const hangTangent = new THREE.Vector3();
const continueClimbProbePosition = new THREE.Vector3();
const continueClimbTargetPosition = new THREE.Vector3();
const standProbeOrigin = new THREE.Vector3();
const standProbeDirection = new THREE.Vector3();

const handTargetGeometry = new THREE.BoxGeometry(
  HAND_TARGET_MARKER_SIZE,
  HAND_TARGET_MARKER_SIZE,
  HAND_TARGET_MARKER_SIZE,
);
const leftHandTargetMaterial = new THREE.MeshStandardMaterial({
  color: 0x2f80ed,
  emissive: 0x123c70,
  roughness: 0.35,
  metalness: 0.05,
});
const rightHandTargetMaterial = new THREE.MeshStandardMaterial({
  color: 0xffc857,
  emissive: 0x6f4a12,
  roughness: 0.35,
  metalness: 0.05,
});

export class LedgeHangSystem {
  constructor() {
    this.handTargetMarkers = null;
    this.traversalActionSystem = new TraversalActionSystem();
    this.actionSnapshot = null;
    this.lastAffordance = null;
    this.lastHangState = null;
  }

  update({ delta, input, movement, character, level, wallClimbSystem, cameraBasis }) {
    character.ledgeGrabCooldown = Math.max(0, (character.ledgeGrabCooldown ?? 0) - delta);
    this.lastAffordance = null;
    this.lastHangState = { active: false };

    if (character.wallClimb?.active || character.rope?.active) {
      this.hideHandTargetMarkers();
      return movement;
    }

    if (character.hang?.active) {
      return this.updateActiveHang({ delta, input, movement, character, level, wallClimbSystem, cameraBasis });
    }

    this.hideHandTargetMarkers();
    this.tickLedgeApproach({ delta, movement, character });

    // Prime (or refresh) the standingTop ledgeApproach intent while grounded and
    // moving slowly or stationary near a top ledge. This is what allows deliberate
    // top-ledge interactions without letting casual "run into corner" while moving
    // trigger an instant pop via startTopAttach.
    if (movement.grounded && !movement.airborne && !character.hang?.active && !character.wallClimb?.active && !character.rope?.active) {
      const topLedge = level.findTopLedgeCandidate({
        position: character.group.position,
        input,
      });
      if (topLedge) {
        const speed = movement.speed ?? 0;
        const wasMoving = movement.wantsMove || speed > LEDGE_APPROACH_STANDING_SPEED;
        if (!wasMoving) {
          const current = character.ledgeApproach;
          if (!current || current.intent !== LEDGE_APPROACH_INTENTS.standingTop) {
            character.ledgeApproach = {
              intent: LEDGE_APPROACH_INTENTS.standingTop,
              timeout: LEDGE_APPROACH_TIMEOUT_SECONDS,
            };
          } else if ((current.timeout ?? 0) < LEDGE_APPROACH_TIMEOUT_SECONDS * 0.5) {
            current.timeout = LEDGE_APPROACH_TIMEOUT_SECONDS;
          }
        }
      }
    }

    if (movement.justJumped) {
      recordLedgeApproachIntent({ movement, input, character, level });
    }

    if (
      movement.justJumped &&
      character.ledgeApproach?.intent === LEDGE_APPROACH_INTENTS.standingTop
    ) {
      const topLedge = level.findTopLedgeCandidate({
        position: character.group.position,
        input,
      });

      if (topLedge) {
        this.startTopAttach({
          character,
          ledge: topLedge,
          mode: preferredHangModeForLedge(topLedge),
        });
        return this.overrideMovement({ movement, character });
      }
    }

    if (canStartTopAttach({ movement, character, input }) &&
        character.ledgeApproach?.intent === LEDGE_APPROACH_INTENTS.standingTop) {
      const topLedge = level.findTopLedgeCandidate({
        position: character.group.position,
        input,
      });

      if (topLedge) {
        this.startTopAttach({
          character,
          ledge: topLedge,
          mode: preferredHangModeForLedge(topLedge),
        });
        return this.overrideMovement({ movement, character });
      }
    }

    if (!canAutoGrab({ movement, input, character })) {
      this.lastAffordance = {
        state: 'inactive',
        reason: autoGrabBlockReason({ movement, input, character }),
      };
      return movement;
    }

    const ledge = level.findLedgeCandidate({
      position: character.group.position,
      minVerticalOffset: -LEDGE_GRAB_MAX_ROOT_DROP,
      maxVerticalOffset: -LEDGE_GRAB_MIN_ROOT_DROP,
    });

    if (!ledge) {
      this.lastAffordance = {
        state: 'rejected',
        reason: 'no-candidate',
      };
      return movement;
    }

    const affordance = evaluateLedgeAttachAffordance({ character, input, ledge });

    if (!affordance.allowed) {
      this.lastAffordance = affordance;
      return movement;
    }

    // Choose the ledge "along" point based on the current animated hand positions
    // (rather than purely from root projection). This makes the hand IK targets
    // line up with where the hands actually are in the jump pose at the moment we
    // start the attach. Fixes "hands don't line up when landing above the ledge point"
    // while still triggering the grab at the original affordance timing (preserves
    // near-miss catches that the previous strict wait was breaking).
    let attachLedge = ledge;
    const controller = character.animationController;
    if (controller?.handBones?.length) {
      const leftBone = controller.handBones.find((b) => b && /left/i.test(b.name));
      const rightBone = controller.handBones.find((b) => b && /right/i.test(b.name));
      if (leftBone && rightBone) {
        leftBone.getWorldPosition(currentHandLeft);
        rightBone.getWorldPosition(currentHandRight);
        const axis = ledge.axis;
        const midAlong = axis === 'x'
          ? (currentHandLeft.x + currentHandRight.x) / 2
          : (currentHandLeft.z + currentHandRight.z) / 2;
        const pad = 0.24;
        const adjusted = THREE.MathUtils.clamp(midAlong, ledge.min + pad, ledge.max - pad);
        attachLedge = { ...ledge, along: adjusted };
      }
    }

    this.lastAffordance = affordance;

    this.attachToLedge({
      character,
      ledge: attachLedge,
      mode: preferredHangModeForLedge(attachLedge),
      approach: character.ledgeApproach,
    });

    return this.overrideMovement({ movement, character });
  }

  tickLedgeApproach({ delta, movement, character }) {
    if (!character.ledgeApproach) {
      return;
    }

    if (movement.justLanded && !character.hang?.active) {
      character.ledgeApproach = null;
      return;
    }

    character.ledgeApproach.timeout = Math.max(0, (character.ledgeApproach.timeout ?? 0) - delta);

    if (character.ledgeApproach.timeout <= 0) {
      character.ledgeApproach = null;
    }
  }

  updateActiveHang({ delta, input, movement, character, level, wallClimbSystem, cameraBasis }) {
    const hang = character.hang;
    this.lastHangState = summarizeHangState(hang);
    tickHopTapTimer(hang, delta);

    if (hang.transition) {
      this.updateTraversalAction({ character, delta });

      this.updateHandTargetMarkers({ character, delta });

      if (canInterruptHangEntryWithClimb({ hang, input })) {
        if (this.tryContinueWallClimbFromHang({ character, input, level, wallClimbSystem })) {
          return this.overrideMovement({ movement, character });
        }

        this.startClimb(character, level);
        this.updateHandTargetMarkers({ character, delta });
        return this.overrideMovement({ movement, character });
      }

      if (canInterruptClimbWithHangDown({ hang, input })) {
        this.startClimbDown(character);
        this.updateHandTargetMarkers({ character, delta });
        return this.overrideMovement({ movement, character });
      }

      if (this.canFinishTransition(hang)) {
        const finishedTransition = hang.transition;
        this.finishTransition({ character, hang, wallClimbSystem, level });

        if (!character.hang) {
          if (character.wallClimb?.active && wallClimbSystem?.overrideMovement) {
            return wallClimbSystem.overrideMovement({ movement, character });
          }

          return this.releaseMovement({ movement, character });
        }

        const followDirection = resolveCameraRelativeHangDirection({ input, hang, cameraBasis });

        if (finishedTransition === 'hop' && followDirection) {
          resetHangIdleCycle(character.hang);
          this.shimmy({ character, direction: followDirection, delta, level });
          this.placeCharacterAtHang(character);
          this.updateHandTargetMarkers({ character, delta });
          return this.overrideMovement({ movement, character });
        }
      }

      return this.overrideMovement({ movement, character });
    }

    if (!wantsHangDown(input)) {
      hang.dropReleaseRequired = false;
    }

    if (!wantsClimb(input)) {
      hang.climbReleaseRequired = false;
    }

    hang.inputLockTimer = Math.max(0, (hang.inputLockTimer ?? 0) - delta);

    if (hang.inputLockTimer > 0) {
      hang.animationState = resolveHangIdleAnimationState({ hang });
      this.placeCharacterAtHang(character);
      this.updateHandTargetMarkers({ character, delta });
      return this.overrideMovement({ movement, character });
    }

    if (input.jumpPressed && isWallJumpPrepared({ hang, input })) {
      this.startWallJump(character);
      return this.overrideMovement({ movement, character });
    }

    if (input.jumpPressed || (wantsClimb(input) && !hang.climbReleaseRequired)) {
      if (this.tryContinueWallClimbFromHang({ character, input, level, wallClimbSystem })) {
        return this.overrideMovement({ movement, character });
      }

      this.startClimb(character, level);
      return this.overrideMovement({ movement, character });
    }

    if (wantsWallJumpPrepare({ hang, input })) {
      hang.wallJumpPrepared = true;
      hang.animationState = 'bracedHang';
      this.placeCharacterAtHang(character);
      this.updateHandTargetMarkers({ character, delta });
      return this.overrideMovement({ movement, character });
    }

    hang.wallJumpPrepared = false;

    if (wantsHangDown(input) && !hang.dropReleaseRequired) {
      this.startDrop(character);
      return this.overrideMovement({ movement, character });
    }

    const tapDirection = resolveDirectionalTap({ input, hang, cameraBasis });

    if (
      tapDirection &&
      shouldStartHopFromDirectionalTap({ hang, direction: tapDirection })
    ) {
      this.startHop({ character, direction: tapDirection, level });
      return this.overrideMovement({ movement, character });
    }

    const shimmyDirection = resolveCameraRelativeHangDirection({ input, hang, cameraBasis });

    if (shimmyDirection) {
      resetHangIdleCycle(hang);
      this.shimmy({ character, direction: shimmyDirection, delta, level });
      // shimmy() will override animationState with the appropriate shimmy variant for the mode
    } else {
      hang.animationState = resolveHangIdleAnimationState({ hang, delta, advance: true });
    }

    this.placeCharacterAtHang(character);
    this.updateHandTargetMarkers({ character, delta });

    return this.overrideMovement({ movement, character });
  }

  attachToLedge({ character, ledge, mode, approach = null }) {
    const resolvedMode = mode ?? preferredHangModeForLedge(ledge);
    const plan = resolveLedgeAttachPlan({ mode: resolvedMode, approach });

    if (plan.transition === 'topAttach') {
      this.startTopAttach({
        character,
        ledge,
        mode: resolvedMode,
        approach: plan.approach,
        animationState: plan.animationState,
        profile: plan.profile,
      });
      return;
    }

    this.startAirborneAttach({
      character,
      ledge,
      mode: resolvedMode,
      approach: plan.approach,
      animationState: plan.animationState,
      profile: plan.profile,
    });
  }

  snapToLedgeHang({
    character,
    ledge,
    mode = null,
    autoClimb = false,
    level = null,
    climbDuration = null,
    climbRecoverySeconds = null,
  }) {
    const resolvedMode = mode ?? preferredHangModeForLedge(ledge);

    character.hang = {
      active: true,
      mode: resolvedMode,
      ledge,
      along: ledge.along,
      animationState: resolvedMode === 'braced' ? 'bracedHang' : 'freeHangIdleAlt2',
      approach: 'wallClimbHands',
      transition: null,
      timer: 0,
      transitionDuration: null,
      handTargets: {
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
      },
      // Auto-mantle from a wall ladder: no input lock / re-press required.
      inputLockTimer: autoClimb ? 0 : HANG_ENTRY_INPUT_LOCK_SECONDS,
      climbReleaseRequired: !autoClimb,
      idleCycle: createHangIdleCycle(resolvedMode),
    };

    resetHangIdleCycle(character.hang);
    character.wallClimb = null;
    character.traversalAction = null;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    character.ledgeApproach = null;
    character.group.position.copy(this.calculateHangRootPosition(character.hang));
    this.faceLedge(character, character.hang);
    this.updateHandTargetMarkers({ character, immediate: true });
    this.actionSnapshot = null;
    this.lastAffordance = {
      state: 'accepted',
      reason: autoClimb ? 'wall-climb-auto-mantle' : 'wall-climb-hands',
      ledge: ledge.name,
      mode: resolvedMode,
    };

    if (autoClimb) {
      this.startClimb(character, level, {
        duration: climbDuration ?? 0.38,
        recoverySeconds: climbRecoverySeconds ?? 0.06,
        exitProgress: 0.92,
      });
    }
  }

  startAirborneAttach({
    character,
    ledge,
    mode,
    approach,
    animationState,
    profile,
  }) {
    const attachDuration = profile.clipDuration / profile.timeScale;

    character.hang = {
      active: true,
      mode,
      ledge,
      along: ledge.along,
      animationState,
      approach,
      transition: 'attach',
      timer: attachDuration,
      transitionDuration: attachDuration,
      handTargets: {
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
      },
      idleCycle: createHangIdleCycle(mode),
    };

    const targetPosition = this.calculateHangRootPosition(character.hang);
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeAttach',
      animationState,
      targetPosition,
      duration: attachDuration,
      exitProgress: profile.exitProgress,
      motionWarp: profile.motionWarp,
      context: {
        ledge,
        attachArcHeight: resolveAttachArcHeight({
          start: character.group.position,
          target: targetPosition,
        }),
      },
    });

    character.hang.action = action;
    character.hang.timer = action.duration;
    character.hang.transitionDuration = action.duration;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    character.ledgeApproach = null;
    this.faceLedge(character, character.hang);
    this.updateHandTargetMarkers({ character, immediate: true });
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
    this.lastAffordance = airborneAttachAffordanceSnapshot({ ledge, approach, animationState });
  }

  startTopAttach({
    character,
    ledge,
    mode,
    approach = LEDGE_APPROACH_INTENTS.standingTop,
    animationState = mode === 'braced' ? 'bracedHangToCrouchDown' : 'freeHangClimbDown',
    profile = LEDGE_CLIMB_DOWN_PROFILES[animationState],
  }) {
    const attachDuration = profile.clipDuration / profile.timeScale;

    character.hang = {
      active: true,
      mode,
      ledge,
      along: ledge.along,
      animationState,
      approach,
      transition: 'topAttach',
      timer: attachDuration,
      transitionDuration: attachDuration,
      handTargets: {
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
      },
      dropReleaseRequired: true,
      idleCycle: createHangIdleCycle(mode),
    };

    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeClimb',
      animationState,
      targetPosition: this.calculateHangRootPosition(character.hang),
      duration: attachDuration,
      exitProgress: profile.exitProgress,
      motionWarp: false,
      context: {
        ledge,
        matchRootMotionToTarget: true,
      },
    });

    character.hang.action = action;
    character.hang.timer = action.duration;
    character.hang.transitionDuration = action.duration;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    character.ledgeApproach = null;
    this.faceLedge(character, character.hang);
    this.updateHandTargetMarkers({ character, immediate: true });
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
    this.lastAffordance = topAttachAffordanceSnapshot({ ledge, approach, animationState });
  }

  shimmy({ character, direction, delta, level }) {
    const hang = character.hang;
    const rootMotionAlong = sampleHangRootMotionAlong({ character, direction, delta });
    const alongDelta = Number.isFinite(rootMotionAlong)
      ? rootMotionAlong
      : direction * SHIMMY_SPEED * delta;
    const desiredAlong = hang.along + alongDelta;

    if (wouldMovePastLedgeEnd({ hang, desiredAlong, direction })) {
      if (this.startCorner({ character, direction, level })) {
        return;
      }
    }

    hang.along = THREE.MathUtils.clamp(
      desiredAlong,
      hang.ledge.min + 0.32,
      hang.ledge.max - 0.32,
    );

    if (hang.mode === 'braced') {
      hang.animationState = direction < 0 ? 'bracedHangShimmyLeft' : 'bracedHangShimmyRight';
      return;
    }

    hang.animationState = direction < 0 ? 'leftShimmy' : 'rightShimmy';
  }

  startHop({ character, direction, level }) {
    const hang = character.hang;
    const desiredAlong = hang.along + direction * HOP_DISTANCE;

    if (wouldMovePastLedgeEnd({ hang, desiredAlong, direction })) {
      if (this.startCorner({ character, direction, level })) {
        return;
      }
    }

    const targetAlong = THREE.MathUtils.clamp(
      desiredAlong,
      hang.ledge.min + 0.32,
      hang.ledge.max - 0.32,
    );

    if (Math.abs(targetAlong - hang.along) < 0.08) {
      return;
    }

    const animationState = hopAnimationStateFor({ mode: hang.mode, direction });
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeHop',
      animationState,
      motionWarp: false,
      duration: HOP_ACTION_DURATION_SECONDS,
      exitProgress: HOP_ACTION_EXIT_PROGRESS,
      context: {
        ledge: hang.ledge,
        startAlong: hang.along,
        targetAlong,
        direction,
      },
    });

    hang.transition = 'hop';
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  startCorner({ character, direction, level }) {
    const hang = character.hang;
    const nextLedge = level.findConnectedLedgeAtCorner({
      ledge: hang.ledge,
      direction,
    });

    if (!nextLedge) {
      return false;
    }

    const animationState = hang.mode === 'braced'
      ? (direction < 0 ? 'bracedHangShimmyLeft' : 'bracedHangShimmyRight')
      : (direction < 0 ? 'leftShimmy' : 'rightShimmy');
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeCorner',
      animationState,
      targetPosition: this.calculateHangRootPosition({
        ...hang,
        ledge: nextLedge,
        along: nextLedge.along,
      }),
      context: {
        fromLedge: hang.ledge,
        toLedge: nextLedge,
        direction,
      },
    });

    hang.transition = 'corner';
    hang.nextLedge = nextLedge;
    hang.nextAlong = nextLedge.along;
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);

    return true;
  }

  // Wall-ledge "up": hop straight up to grab a higher ledge on the same wall if
  // one is within reach. Continuing a wall-climb surface is handled by the
  // caller before this, so here we only look for a higher hang ledge.
  tryHopUpToHigherLedge({ character, level }) {
    const hang = character.hang;

    if (!hang?.ledge || hang.transition || !level?.findHopUpLedgeCandidate) {
      return false;
    }

    const higher = level.findHopUpLedgeCandidate({
      position: character.group.position,
      fromLedge: hang.ledge,
      minRise: HOP_UP_MIN_RISE,
      maxRise: HOP_UP_MAX_RISE,
    });

    if (!higher) {
      return false;
    }

    this.startHopUpToLedge({ character, ledge: higher });
    return true;
  }

  startHopUpToLedge({ character, ledge }) {
    const hang = character.hang;
    const along = THREE.MathUtils.clamp(
      ledge.along ?? hang.along,
      ledge.min + 0.32,
      ledge.max - 0.32,
    );
    const animationState = 'bracedHangHopUp';
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeHop',
      animationState,
      targetPosition: this.calculateHangRootPosition({ ...hang, ledge, along }),
      duration: HOP_UP_ACTION_DURATION_SECONDS,
      exitProgress: HOP_UP_ACTION_EXIT_PROGRESS,
      context: {
        ledge,
        fromLedge: hang.ledge,
      },
    });

    hang.transition = 'hopUp';
    hang.nextLedge = ledge;
    hang.nextAlong = along;
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  startClimb(character, level, {
    duration = null,
    recoverySeconds = null,
    exitProgress = null,
  } = {}) {
    const hang = character.hang;
    const clearance = probeStandClearance({ level, ledge: hang?.ledge, along: hang?.along });

    if (hang) {
      hang.standClearance = clearance;
    }

    if (!canClimbOntoLedge(hang?.ledge) || !clearance.canStand) {
      if (this.tryHopUpToHigherLedge({ character, level })) {
        return;
      }

      this.rejectClimb(character);
      return;
    }

    const animationState = hang.mode === 'braced' ? 'bracedHangToCrouch' : 'freeHangClimb';
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeClimb',
      animationState,
      targetPosition: this.calculateClimbTopPosition(hang),
      duration: duration ?? undefined,
      exitProgress: exitProgress ?? undefined,
      context: {
        ledge: hang.ledge,
      },
    });
    if (Number.isFinite(recoverySeconds)) {
      action.recoverySeconds = recoverySeconds;
    }

    hang.transition = 'climb';
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  rejectClimb(character) {
    const hang = character.hang;

    if (!hang) {
      return;
    }

    hang.climbReleaseRequired = true;
    hang.inputLockTimer = CLIMB_REJECT_INPUT_LOCK_SECONDS;
    hang.animationState = resolveHangIdleAnimationState({ hang });
    this.placeCharacterAtHang(character);
    this.actionSnapshot = null;
    this.lastAffordance = {
      state: 'rejected',
      reason: 'ledge-top-not-standable',
      ledge: hang.ledge?.name ?? null,
      shelfDepth: Number.isFinite(hang.ledge?.shelfDepth)
        ? Number(hang.ledge.shelfDepth.toFixed(3))
        : null,
      requiredShelfDepth: Number(CLIMB_TOP_REQUIRED_SHELF_DEPTH.toFixed(3)),
    };
  }

  startClimbDown(character) {
    const hang = character.hang;

    this.startTopAttach({
      character,
      ledge: {
        ...hang.ledge,
        along: hang.along,
      },
      mode: hang.mode,
      approach: hang.approach ?? LEDGE_APPROACH_INTENTS.standingTop,
    });
  }

  startDrop(character) {
    const hang = character.hang;
    const animationState = hang.mode === 'braced' ? 'bracedHangDrop' : 'freeHangDrop';
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeDrop',
      animationState,
      context: {
        ledge: hang.ledge,
      },
    });

    hang.transition = 'drop';
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  startModeSwitch({ character, mode }) {
    const hang = character.hang;

    if (hang.transition || hang.mode === mode) {
      return;
    }

    const animationState = mode === 'braced' ? 'freeHangToBraced' : 'bracedToFreeHang';
    const profile = MODE_SWITCH_PROFILES[animationState];
    const switchDuration = profile.clipDuration / profile.timeScale;
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeModeSwitch',
      animationState,
      duration: switchDuration,
      exitProgress: profile.exitProgress,
      context: {
        ledge: hang.ledge,
      },
    });

    hang.transition = 'modeSwitch';
    hang.nextMode = mode;
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = animationState;
    this.placeCharacterAtHang(character);
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  startWallJump(character) {
    const hang = character.hang;
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeWallJump',
      animationState: 'jumpFromWall',
      context: {
        ledge: hang.ledge,
      },
    });

    hang.transition = 'wallJump';
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = 'jumpFromWall';
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  tryContinueWallClimbFromHang({ character, input, level, wallClimbSystem }) {
    const hang = character.hang;

    if (!hang?.ledge || !level?.findClimbSurfaceCandidate || !wallClimbSystem?.attach) {
      return false;
    }

    const point = pointOnLedge({ ledge: hang.ledge, along: hang.along });
    continueClimbProbePosition
      .set(point.x, hang.ledge.y + 0.18, point.z)
      .addScaledVector(hang.ledge.normal, 0.42);

    const climbCandidate = level.findClimbSurfaceCandidate({
      position: continueClimbProbePosition,
      maxFaceDistance: 0.68,
      minFaceDistance: -0.18,
      verticalPadding: 0.04,
      blockName: hang.ledge.blockName ?? null,
      face: hang.ledge.face ?? null,
      normalHint: hang.ledge.normal,
      minNormalDot: 0.92,
      // Only continue onto a surface that starts at/above this ledge and reaches
      // higher than it. Without these, this re-grabs the surface the player just
      // climbed (its top sits exactly at hang.ledge.y), trapping them back on
      // the wall instead of letting them top out onto the ledge.
      minOriginY: hang.ledge.y - 0.15,
      minTopY: hang.ledge.y + 0.45,
    });

    if (!climbCandidate) {
      return false;
    }

    this.startContinueWallClimb({
      character,
      input,
      surface: climbCandidate,
      wallClimbSystem,
    });
    return true;
  }

  startContinueWallClimb({ character, input, surface, wallClimbSystem }) {
    const hang = character.hang;
    const targetPosition = wallClimbSystem.resolveSurfaceRootPosition?.({
      surface,
      target: continueClimbTargetPosition,
    }) ?? continueClimbTargetPosition
      .copy(surface.point)
      .addScaledVector(surface.normal, surface.rootOffset ?? 0.38);
    const action = this.traversalActionSystem.start({
      character,
      type: 'ledgeContinueClimb',
      animationState: 'bracedHangHopUp',
      targetPosition,
      context: {
        ledge: hang.ledge,
        climbSurface: surface,
        matchRootMotionToTarget: true,
      },
    });

    hang.transition = 'continueClimb';
    hang.continueClimbSurface = surface;
    hang.continueClimbInput = {
      brace: input.brace === true,
      jumpPressed: input.jumpPressed === true,
    };
    hang.timer = action.duration;
    hang.transitionDuration = action.duration;
    hang.action = action;
    hang.animationState = 'bracedHangHopUp';
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);
  }

  finishTransition({ character, hang, wallClimbSystem, level }) {
    if (hang.transition === 'climb') {
      this.finishClimb(character, level);
      return;
    }

    if (hang.transition === 'continueClimb') {
      this.finishContinueWallClimb({ character, hang, wallClimbSystem });
      return;
    }

    if (hang.transition === 'drop') {
      this.finishDrop(character);
      return;
    }

    if (hang.transition === 'wallJump') {
      this.finishWallJump(character);
      return;
    }

    if (hang.transition === 'attach') {
      this.traversalActionSystem.finish(character);
      this.placeCharacterAtHang(character);
      hang.inputLockTimer = HANG_ENTRY_INPUT_LOCK_SECONDS;
      this.actionSnapshot = null;
    }

    if (hang.transition === 'topAttach') {
      this.traversalActionSystem.finish(character);
      this.placeCharacterAtHang(character);
      hang.inputLockTimer = HANG_ENTRY_INPUT_LOCK_SECONDS;
      this.actionSnapshot = null;
    }

    if (hang.transition === 'hop') {
      this.traversalActionSystem.finish(character);
      this.actionSnapshot = null;
    }

    if (hang.transition === 'corner') {
      this.traversalActionSystem.finish(character);
      hang.ledge = hang.nextLedge ?? hang.ledge;
      hang.along = hang.nextAlong ?? hang.along;
      hang.nextLedge = null;
      hang.nextAlong = null;
      this.faceLedge(character, hang);
      this.actionSnapshot = null;
    }

    if (hang.transition === 'hopUp') {
      this.traversalActionSystem.finish(character);
      hang.ledge = hang.nextLedge ?? hang.ledge;
      hang.along = hang.nextAlong ?? hang.along;
      hang.nextLedge = null;
      hang.nextAlong = null;
      hang.standClearance = null;
      hang.inputLockTimer = HANG_ENTRY_INPUT_LOCK_SECONDS;
      this.placeCharacterAtHang(character);
      this.actionSnapshot = null;
    }

    if (hang.transition === 'modeSwitch') {
      this.traversalActionSystem.finish(character);
      hang.mode = hang.nextMode;
      hang.nextMode = null;
      this.placeCharacterAtHang(character);
      this.actionSnapshot = null;
    }

    hang.transition = null;
    hang.transitionDuration = null;
    hang.action = null;
    resetHangIdleCycle(hang);
    hang.animationState = resolveHangIdleAnimationState({ hang });
  }

  finishContinueWallClimb({ character, hang, wallClimbSystem }) {
    const surface = hang.continueClimbSurface ?? hang.action?.context?.climbSurface;
    const continueInput = hang.continueClimbInput ?? {};

    this.traversalActionSystem.finish(character);

    if (!surface || !wallClimbSystem?.attach) {
      this.actionSnapshot = null;
      this.hideHandTargetMarkers();
      return;
    }

    wallClimbSystem.attach({
      character,
      surface,
      input: continueInput,
    });

    if (character.wallClimb) {
      character.wallClimb.ignoreJumpPressed = continueInput.jumpPressed === true;
      character.wallClimb.forceClimbUpTimer = 0;
      character.wallClimb.inputSettleTimer = CONTINUE_CLIMB_INPUT_SETTLE_SECONDS;
      character.wallClimb.attachBlend = 0;
      character.wallClimb.animationState = continueInput.brace === true
        ? 'bracedHang'
        : 'freeHangIdleAlt2';
    }

    wallClimbSystem.snapActiveClimbToSurface?.(character);
    this.actionSnapshot = null;
    this.hideHandTargetMarkers();
  }

  canFinishTransition(hang) {
    return this.traversalActionSystem.canFinish(hang.action);
  }

  finishClimb(character, level) {
    const hang = character.hang;
    const topPosition = this.resolveClimbFinishPosition(hang, character.group.position);
    const finishedAction = this.traversalActionSystem.finish(character);

    character.group.position.copy(topPosition);
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;

    // Only enter cover-sneak (a ledgeStandSupport) when the shelf is narrow and
    // has a wall behind it. On an open shelf, leave the support null so the
    // player tops out into normal locomotion. Reuse the climb-start probe when
    // present, otherwise probe now from the resolved level reference.
    const clearance = hang.standClearance
      ?? probeStandClearance({ level, ledge: hang.ledge, along: hang.along });
    character.ledgeStandSupport = clearance.coverSneak
      ? createLedgeStandSupport(hang.ledge)
      : null;

    character.animationController?.plantFeetOnTopOut?.(topPosition.y);
    character.traversalRecoveryTimer = finishedAction?.recoverySeconds ?? CLIMB_ACTION.recoverySeconds;
    character.ledgeGrabCooldown = 0.35;
    character.hang = null;
    this.actionSnapshot = null;
    this.hideHandTargetMarkers();
  }

  finishDrop(character) {
    this.traversalActionSystem.finish(character);
    character.verticalVelocity = -0.8;
    character.grounded = false;
    character.forceFreeFallTimer = DROP_FREE_FALL_SECONDS;
    character.ledgeGrabCooldown = 0.45;
    character.hang = null;
    this.actionSnapshot = null;
    this.hideHandTargetMarkers();
  }

  finishWallJump(character) {
    const hang = character.hang;
    const normal = hang.ledge.normal;

    this.traversalActionSystem.finish(character);
    character.velocity.set(
      normal.x * WALL_JUMP_OUTWARD_SPEED,
      0,
      normal.z * WALL_JUMP_OUTWARD_SPEED,
    );
    character.verticalVelocity = WALL_JUMP_UP_SPEED;
    character.grounded = false;
    character.forceFreeFallTimer = WALL_JUMP_FREE_FALL_SECONDS;
    character.ledgeGrabCooldown = 0.5;
    character.hang = null;
    this.actionSnapshot = null;
    this.hideHandTargetMarkers();
  }

  placeCharacterAtHang(character) {
    character.group.position.copy(this.calculateHangRootPosition(character.hang));
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;

    this.faceLedge(character, character.hang);
  }

  calculateHangRootPosition(hang) {
    const { ledge, along } = hang;
    const point = pointOnLedge({ ledge, along });
    const normal = ledge.normal;

    hangPosition.set(
      point.x + normal.x * HANG_FACE_OFFSET,
      ledge.y - HANG_ROOT_DROP_FROM_LEDGE,
      point.z + normal.z * HANG_FACE_OFFSET,
    );

    return hangPosition.clone();
  }

  faceLedge(character, hang) {
    const normal = hang.ledge.normal;
    facing.set(-normal.x, 0, -normal.z);
    character.group.rotation.y = Math.atan2(facing.x, facing.z);
  }

  updateTraversalAction({ character, delta }) {
    const hang = character.hang;
    const action = this.traversalActionSystem.update({ character, delta });

    if (!hang.action || !action) {
      hang.timer = Math.max(0, hang.timer - delta);
      this.placeCharacterAtHang(character);
      return;
    }

    hang.action = action;
    if (hang.transition === 'hop') {
      updateHopAlongFromRootMotion({ character, hang, action, delta });
      this.placeCharacterAtHang(character);
    } else {
      updateHangAlongFromAction({ hang, action });
    }
    hang.timer = Math.max(0, action.duration - action.elapsed);
    this.actionSnapshot = this.traversalActionSystem.snapshot(character);

    if (shouldPlantFeetDuringClimb({ hang, action })) {
      character.animationController?.plantFeetOnTopOut?.(hang.ledge.y);
    }

    if (shouldAnchorHangDuringTransition(hang)) {
      this.placeCharacterAtHang(character);
    }
  }

  resolveClimbFinishPosition(hang, currentPosition) {
    const targetPosition = hang.action?.targetPosition ?? this.calculateClimbTopPosition(hang);

    if (currentPosition.y >= hang.ledge.y - CLIMB_FALLBACK_MIN_HEIGHT) {
      return new THREE.Vector3(
        targetPosition.x,
        targetPosition.y,
        targetPosition.z,
      );
    }

    return targetPosition;
  }

  calculateClimbTopPosition(hang) {
    const { ledge, along } = hang;
    const normal = ledge.normal;
    const topPosition = pointOnLedge({ ledge, along });

    climbEndPosition.set(
      topPosition.x - normal.x * CLIMB_TOP_OFFSET,
      ledge.y,
      topPosition.z - normal.z * CLIMB_TOP_OFFSET,
    );

    return climbEndPosition.clone();
  }

  updateHandTargetMarkers({ character, delta = 0, immediate = false }) {
    if (!character.hang?.active) {
      this.hideHandTargetMarkers();
      return;
    }

    calculateHandTargetPositions({
      hang: character.hang,
      animationController: character.animationController,
      leftTarget: leftHandTargetPosition,
      rightTarget: rightHandTargetPosition,
    });

    character.hang.handTargets.left.copy(leftHandTargetPosition);
    character.hang.handTargets.right.copy(rightHandTargetPosition);

    if (!HAND_TARGET_MARKERS_VISIBLE) {
      this.hideHandTargetMarkers();
      return;
    }

    const markers = this.ensureHandTargetMarkers(character);

    if (!markers) {
      return;
    }

    const snapToTarget = immediate || shouldSnapHandTargetsToLedge(character.hang);

    moveHandTargetMarker({
      marker: markers.left,
      target: leftHandTargetPosition,
      delta,
      immediate: snapToTarget,
    });
    moveHandTargetMarker({
      marker: markers.right,
      target: rightHandTargetPosition,
      delta,
      immediate: snapToTarget,
    });

    markers.left.visible = true;
    markers.right.visible = true;
  }

  ensureHandTargetMarkers(character) {
    if (this.handTargetMarkers) {
      return this.handTargetMarkers;
    }

    const parent = character.group.parent;

    if (!parent) {
      return null;
    }

    const left = new THREE.Mesh(handTargetGeometry, leftHandTargetMaterial);
    const right = new THREE.Mesh(handTargetGeometry, rightHandTargetMaterial);
    left.name = 'Debug Left Hand Ledge Target';
    right.name = 'Debug Right Hand Ledge Target';
    left.castShadow = false;
    left.receiveShadow = false;
    right.castShadow = false;
    right.receiveShadow = false;
    left.visible = false;
    right.visible = false;
    parent.add(left, right);
    this.handTargetMarkers = { left, right };

    return this.handTargetMarkers;
  }

  hideHandTargetMarkers() {
    if (!this.handTargetMarkers) {
      return;
    }

    this.handTargetMarkers.left.visible = false;
    this.handTargetMarkers.right.visible = false;
    this.handTargetMarkers.left.position.copy(hiddenMarkerPosition);
    this.handTargetMarkers.right.position.copy(hiddenMarkerPosition);
  }

  snapshot() {
    return {
      action: this.actionSnapshot,
      affordance: this.lastAffordance,
      state: this.lastHangState,
      handTargets: this.handTargetMarkers
        ? {
            left: markerSnapshot(this.handTargetMarkers.left),
            right: markerSnapshot(this.handTargetMarkers.right),
          }
        : null,
    };
  }

  dispose() {
    this.handTargetMarkers?.left.removeFromParent();
    this.handTargetMarkers?.right.removeFromParent();
    this.handTargetMarkers = null;
    this.actionSnapshot = null;
    this.lastAffordance = null;
  }

  overrideMovement({ movement, character }) {
    return {
      ...movement,
      moving: false,
      wantsMove: false,
      speed: 0,
      grounded: false,
      airborne: false,
      hanging: true,
      hangState: character.hang?.animationState ?? 'freeHang',
      verticalVelocity: 0,
      height: character.group.position.y,
    };
  }

  releaseMovement({ movement, character }) {
    return {
      ...movement,
      grounded: character.grounded,
      airborne: !character.grounded,
      hanging: false,
      hangState: null,
      verticalVelocity: character.verticalVelocity,
      height: character.group.position.y,
    };
  }
}

function recordLedgeApproachIntent({ movement, input, character, level }) {
  const position = character.group.position;
  const wasMoving = movement.wantsMove || movement.speed > LEDGE_APPROACH_STANDING_SPEED;
  const topLedge = level.findTopLedgeCandidate({ position, input });

  if (!wasMoving && topLedge) {
    character.ledgeApproach = {
      intent: LEDGE_APPROACH_INTENTS.standingTop,
      timeout: LEDGE_APPROACH_TIMEOUT_SECONDS,
    };
    return;
  }

  const ledge = level.findLedgeCandidate({
    position,
    maxHorizontalDistance: wasMoving ? 0.75 : 0.55,
  });

  if (!ledge) {
    character.ledgeApproach = wasMoving && topLedge
      ? {
          intent: LEDGE_APPROACH_INTENTS.airborneMomentum,
          timeout: LEDGE_APPROACH_TIMEOUT_SECONDS,
        }
      : null;
    return;
  }

  const affordance = evaluateLedgeAttachAffordance({ character, input, ledge });
  const facingLedge = affordance.allowed || (ledge.faceDistance ?? Infinity) < 0.65;

  if (!facingLedge && !topLedge) {
    character.ledgeApproach = null;
    return;
  }

  if (!wasMoving) {
    character.ledgeApproach = {
      intent: topLedge
        ? LEDGE_APPROACH_INTENTS.standingTop
        : LEDGE_APPROACH_INTENTS.standingJump,
      timeout: LEDGE_APPROACH_TIMEOUT_SECONDS,
    };
    return;
  }

  character.ledgeApproach = {
    intent: LEDGE_APPROACH_INTENTS.airborneMomentum,
    timeout: LEDGE_APPROACH_TIMEOUT_SECONDS,
  };
}

function shouldAnchorHangDuringTransition(hang) {
  return hang.transition === 'drop'
    || hang.transition === 'wallJump'
    || hang.transition === 'modeSwitch';
}

function canInterruptHangEntryWithClimb({ hang, input }) {
  return isHangEntryTransition(hang) && wantsClimb(input);
}

function canInterruptClimbWithHangDown({ hang, input }) {
  return hang.transition === 'climb' && wantsHangDown(input);
}

function isWallJumpPrepared({ hang, input }) {
  return hang.wallJumpPrepared === true && wantsWallJumpPrepare({ hang, input });
}

function wantsWallJumpPrepare({ hang, input }) {
  return preferredHangModeForLedge(hang.ledge) === 'braced'
    && input.brace
    && wantsHangDown(input);
}

function preferredHangModeForLedge(ledge) {
  return ledge?.hangMode === 'free'
    ? 'free'
    : 'braced';
}

function isHangEntryTransition(hang) {
  return hang.transition === 'attach' || hang.transition === 'topAttach';
}

function wantsClimb(input) {
  return input.moveZ < CLIMB_INPUT_THRESHOLD;
}

function wantsHangDown(input) {
  return input.moveZ > HANG_DOWN_INPUT_THRESHOLD;
}

function resolveBracedAttachAnimation(approach) {
  if (approach?.intent === LEDGE_APPROACH_INTENTS.standingJump) {
    return 'jumpingToHanging';
  }

  return 'jumpToFreeHang';
}

function resolveLedgeAttachPlan({ mode, approach }) {
  const intent = approach?.intent;

  if (intent === LEDGE_APPROACH_INTENTS.standingTop) {
    const animationState = mode === 'braced'
      ? 'bracedHangToCrouchDown'
      : 'freeHangClimbDown';

    return {
      transition: 'topAttach',
      animationState,
      profile: LEDGE_CLIMB_DOWN_PROFILES[animationState],
      approach: intent,
    };
  }

  if (intent === LEDGE_APPROACH_INTENTS.standingJump) {
    const animationState = mode === 'braced'
      ? resolveBracedAttachAnimation(approach)
      : 'jumpingToHanging';

    return {
      transition: 'attach',
      animationState,
      profile: LEDGE_ATTACH_PROFILES[animationState],
      approach: intent,
    };
  }

  const animationState = mode === 'braced'
    ? resolveBracedAttachAnimation(approach)
    : 'jumpToFreeHang';

  return {
    transition: 'attach',
    animationState,
    profile: LEDGE_ATTACH_PROFILES[animationState],
    approach: intent ?? LEDGE_APPROACH_INTENTS.airborneMomentum,
  };
}

function resolveAttachArcHeight({ start, target }) {
  const horizontal = Math.hypot(target.x - start.x, target.z - start.z);
  const verticalDrop = start.y - target.y;

  return THREE.MathUtils.clamp(
    horizontal * 0.24 + Math.max(0, verticalDrop) * 0.42 + 0.16,
    0.18,
    0.82,
  );
}

function canAutoGrab({ movement, input, character }) {
  return (
    (character.ledgeGrabCooldown ?? 0) <= 0 &&
    input.moveZ <= 0.2 &&
    movement.airborne &&
    movement.verticalVelocity <= 1.25
  );
}

function canStartTopAttach({ movement, character, input }) {
  return (
    (character.ledgeGrabCooldown ?? 0) <= 0 &&
    movement.grounded &&
    !movement.airborne &&
    !!input?.brace
  );
}

function autoGrabBlockReason({ movement, input, character }) {
  if ((character.ledgeGrabCooldown ?? 0) > 0) {
    return 'cooldown';
  }

  if (input.moveZ > 0.2) {
    return 'drop-input';
  }

  if (!movement.airborne) {
    return 'not-airborne';
  }

  if (movement.verticalVelocity > 1.25) {
    return 'rising-too-fast';
  }

  return 'none';
}

function evaluateLedgeAttachAffordance({ character, input, ledge }) {
  ledgeApproachNormal.set(ledge.normal.x, 0, ledge.normal.z).normalize();
  ledgeApproachInput.set(input.moveX, 0, input.moveZ);
  ledgeApproachVelocity.set(character.velocity.x, 0, character.velocity.z);

  const inputApproach = ledgeApproachInput.lengthSq() > 0.0001
    ? -ledgeApproachInput.normalize().dot(ledgeApproachNormal)
    : 0;
  const velocityApproach = -ledgeApproachVelocity.dot(ledgeApproachNormal);
  const snapshot = {
    state: 'candidate',
    allowed: false,
    reason: null,
    ledge: ledge.name,
    face: ledge.face,
    verticalOffset: Number((ledge.verticalOffset ?? 0).toFixed(3)),
    faceDistance: Number((ledge.faceDistance ?? 0).toFixed(3)),
    inputApproach: Number(inputApproach.toFixed(3)),
    velocityApproach: Number(velocityApproach.toFixed(3)),
  };

  if (
    !Number.isFinite(ledge.faceDistance) ||
    ledge.faceDistance < MIN_LEDGE_FACE_DISTANCE ||
    ledge.faceDistance > MAX_LEDGE_FACE_DISTANCE
  ) {
    snapshot.reason = 'face-distance';
    return snapshot;
  }

  if (inputApproach < MIN_LEDGE_INPUT_APPROACH && velocityApproach < MIN_LEDGE_VELOCITY_APPROACH) {
    snapshot.reason = 'not-approaching';
    return snapshot;
  }

  snapshot.allowed = true;
  snapshot.reason = 'allowed';
  return snapshot;
}

function topAttachAffordanceSnapshot({ ledge, approach, animationState }) {
  return {
    state: 'top-candidate',
    allowed: true,
    reason: 'top-attach',
    approach,
    animationState,
    ledge: ledge.name,
    face: ledge.face,
    insideDistance: Number((ledge.insideDistance ?? 0).toFixed(3)),
    inputApproach: Number((ledge.inputApproach ?? 0).toFixed(3)),
  };
}

function airborneAttachAffordanceSnapshot({ ledge, approach, animationState }) {
  return {
    state: 'airborne-candidate',
    allowed: true,
    reason: 'airborne-attach',
    approach,
    animationState,
    ledge: ledge.name,
    face: ledge.face,
    verticalOffset: Number((ledge.verticalOffset ?? 0).toFixed(3)),
    faceDistance: Number((ledge.faceDistance ?? 0).toFixed(3)),
  };
}

function hopAnimationStateFor({ mode, direction }) {
  if (mode === 'braced') {
    return direction < 0 ? 'bracedHangHopLeft' : 'bracedHangHopRight';
  }

  return direction < 0 ? 'freeHangHopLeft' : 'freeHangHopRight';
}

function updateHangAlongFromAction({ hang, action }) {
  const startAlong = action.context?.startAlong;
  const targetAlong = action.context?.targetAlong;

  if (!Number.isFinite(startAlong) || !Number.isFinite(targetAlong)) {
    return;
  }

  hang.along = THREE.MathUtils.lerp(
    startAlong,
    targetAlong,
    action.warpAlpha ?? action.progress,
  );
}

function updateHopAlongFromRootMotion({ character, hang, action, delta }) {
  const direction = action.context?.direction ?? 0;
  const targetAlong = action.context?.targetAlong;
  const rootMotion = sampleHangRootMotionAlongDetails({ character, direction, delta });
  const rootMotionAlong = rootMotion?.delta ?? null;

  if (Number.isFinite(rootMotionAlong)) {
    const totalAlong = Math.abs(rootMotion.total);
    const desiredDistance = Math.abs((targetAlong ?? hang.along) - (action.context?.startAlong ?? hang.along));
    const rootMotionScale =
      totalAlong > MIN_ROOT_MOTION_ALONG_DELTA && desiredDistance > MIN_ROOT_MOTION_ALONG_DELTA
        ? desiredDistance / totalAlong
        : 1;
    const desiredAlong = hang.along + rootMotionAlong * rootMotionScale;

    if (Number.isFinite(targetAlong)) {
      hang.along = direction >= 0
        ? Math.min(desiredAlong, targetAlong)
        : Math.max(desiredAlong, targetAlong);
      return;
    }

    hang.along = desiredAlong;
    return;
  }

  if (!Number.isFinite(targetAlong)) {
    return;
  }

  hang.along = THREE.MathUtils.lerp(
    action.context?.startAlong ?? hang.along,
    targetAlong,
    action.progress,
  );
}

function wouldMovePastLedgeEnd({ hang, desiredAlong, direction }) {
  if (direction > 0) {
    return desiredAlong > hang.ledge.max - 0.32;
  }

  return desiredAlong < hang.ledge.min + 0.32;
}

function canClimbOntoLedge(ledge) {
  if (!ledge) {
    return false;
  }

  if (!Number.isFinite(ledge.shelfDepth)) {
    return true;
  }

  return ledge.shelfDepth >= CLIMB_TOP_REQUIRED_SHELF_DEPTH;
}

// Casts a horizontal ray inward from the ledge edge (at chest height) to find
// the nearest wall behind the would-be standing spot. Distinguishes a true wall
// ledge (no room to stand) from a narrow standable shelf with a wall behind it
// (cover-sneak) from an open shelf (normal locomotion).
function probeStandClearance({ level, ledge, along }) {
  if (!level?.raycastGeometry || !ledge?.normal) {
    return { wallDistance: Infinity, canStand: true, coverSneak: false };
  }

  standProbeDirection.set(-ledge.normal.x, 0, -ledge.normal.z);

  if (standProbeDirection.lengthSq() <= 0.0001) {
    return { wallDistance: Infinity, canStand: true, coverSneak: false };
  }

  standProbeDirection.normalize();

  const resolvedAlong = Number.isFinite(along) ? along : ledge.along ?? (ledge.min + ledge.max) * 0.5;
  const point = pointOnLedge({ ledge, along: resolvedAlong });
  standProbeOrigin
    .set(point.x, ledge.y + STAND_PROBE_HEIGHT, point.z)
    .addScaledVector(standProbeDirection, STAND_PROBE_EPSILON);

  const hits = level.raycastGeometry({
    origin: standProbeOrigin,
    direction: standProbeDirection,
    near: 0,
    far: STAND_PROBE_MAX_DISTANCE,
    firstHitOnly: true,
  });

  const wallDistance = hits.length > 0
    ? hits[0].distance + STAND_PROBE_EPSILON
    : Infinity;
  const canStand = wallDistance >= STAND_MIN_DEPTH;
  const coverSneak = canStand && wallDistance < COVER_SNEAK_MAX_DEPTH;

  return { wallDistance, canStand, coverSneak };
}

// Snapshot of the active hang, exposed via `snapshot().state` so the console
// can show exactly why a climb-up / drop / shimmy input is or isn't honoured.
function summarizeHangState(hang) {
  if (!hang) {
    return { active: false };
  }

  const ledge = hang.ledge;

  return {
    active: true,
    mode: hang.mode ?? null,
    transition: hang.transition ?? null,
    animationState: hang.animationState ?? null,
    inputLockTimer: Number((hang.inputLockTimer ?? 0).toFixed(3)),
    climbReleaseRequired: hang.climbReleaseRequired === true,
    dropReleaseRequired: hang.dropReleaseRequired === true,
    along: Number((hang.along ?? 0).toFixed(3)),
    standClearance: hang.standClearance
      ? {
          wallDistance: Number.isFinite(hang.standClearance.wallDistance)
            ? Number(hang.standClearance.wallDistance.toFixed(3))
            : null,
          canStand: hang.standClearance.canStand === true,
          coverSneak: hang.standClearance.coverSneak === true,
        }
      : null,
    ledge: ledge
      ? {
          name: ledge.name ?? null,
          blockName: ledge.blockName ?? null,
          face: ledge.face ?? null,
          y: Number((ledge.y ?? 0).toFixed(2)),
          shelfDepth: Number.isFinite(ledge.shelfDepth)
            ? Number(ledge.shelfDepth.toFixed(2))
            : null,
          standable: canClimbOntoLedge(ledge),
        }
      : null,
  };
}

function pointOnLedge({ ledge, along }) {
  return {
    x: ledge.axis === 'x' ? along : ledge.x,
    y: ledge.y,
    z: ledge.axis === 'z' ? along : ledge.z,
  };
}

function createLedgeStandSupport(ledge) {
  if (!ledge) {
    return null;
  }

  return {
    ledgeName: ledge.name,
    blockName: ledge.blockName,
    face: ledge.face,
    axis: ledge.axis,
    min: ledge.min,
    max: ledge.max,
    fixed: ledge.axis === 'x' ? ledge.z : ledge.x,
    normal: { ...ledge.normal },
    tangent: { ...ledge.tangent },
    y: ledge.y,
    inwardMin: CLIMB_TOP_SUPPORT_INWARD_MIN,
    inwardMax: CLIMB_TOP_SUPPORT_INWARD_MAX,
    inwardOffset: CLIMB_TOP_OFFSET,
  };
}

function calculateHandTargetPositions({ hang, animationController, leftTarget, rightTarget }) {
  const { ledge, along } = hang;
  const point = pointOnLedge({ ledge, along });
  const state = hang.animationState ?? animationController?.currentState ?? 'freeHang';
  const phase = getShimmyPhase({ hang, animationController });
  const offsets = handTargetOffsetsForState({ state, phase });
  const climbTopAlpha = climbTopHandTargetAlpha({ hang, state, phase });
  const yOffset = THREE.MathUtils.lerp(
    HAND_TARGET_Y_OFFSET,
    HAND_TARGET_CLIMB_TOP_Y_OFFSET,
    climbTopAlpha,
  );
  const normalOffset = THREE.MathUtils.lerp(
    HAND_TARGET_NORMAL_OFFSET,
    HAND_TARGET_CLIMB_TOP_NORMAL_OFFSET,
    climbTopAlpha,
  );

  handTargetPoint.set(point.x, ledge.y + yOffset, point.z);
  handTargetNormal.set(ledge.normal.x, ledge.normal.y, ledge.normal.z);
  handTargetTangent.set(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z);

  leftTarget
    .copy(handTargetPoint)
    .addScaledVector(handTargetTangent, offsets.left)
    .addScaledVector(handTargetNormal, normalOffset);
  rightTarget
    .copy(handTargetPoint)
    .addScaledVector(handTargetTangent, offsets.right)
    .addScaledVector(handTargetNormal, normalOffset);
}

function climbTopHandTargetAlpha({ hang, state, phase }) {
  if (!isClimbUpState(state) || hang.transition !== 'climb') {
    return 0;
  }

  return smoothStep(THREE.MathUtils.clamp(
    (phase - HAND_TARGET_CLIMB_TOP_START) / (HAND_TARGET_CLIMB_TOP_END - HAND_TARGET_CLIMB_TOP_START),
    0,
    1,
  ));
}

function shouldSnapHandTargetsToLedge(hang) {
  return hang?.transition === 'climb' && isClimbUpState(hang.animationState);
}

function shouldPlantFeetDuringClimb({ hang, action }) {
  return hang?.transition === 'climb'
    && isClimbUpState(hang.animationState)
    && (action?.progress ?? 0) >= CLIMB_UP_FOOT_PLANT_START;
}

function getShimmyPhase({ hang, animationController }) {
  const duration = hang.transitionDuration;

  if (Number.isFinite(duration) && duration > 0) {
    return THREE.MathUtils.clamp(1 - (hang.timer ?? 0) / duration, 0, 1);
  }

  return animationController?.getCurrentActionNormalizedTime?.() ?? 0;
}

function handTargetOffsetsForState({ state, phase }) {
  if (isRightShimmyState(state)) {
    return shimmyHandOffsets({ phase, direction: 1 });
  }

  if (isLeftShimmyState(state)) {
    return shimmyHandOffsets({ phase, direction: -1 });
  }

  return {
    left: -HAND_TARGET_SPACING,
    right: HAND_TARGET_SPACING,
  };
}

function shimmyHandOffsets({ phase, direction }) {
  const leadReach = smoothStep(THREE.MathUtils.clamp(phase / 0.42, 0, 1));
  const followReach = smoothStep(THREE.MathUtils.clamp((phase - 0.52) / 0.42, 0, 1));

  if (direction > 0) {
    return {
      left: -HAND_TARGET_SPACING + HAND_TARGET_REACH * followReach,
      right: HAND_TARGET_SPACING + HAND_TARGET_REACH * leadReach * (1 - followReach),
    };
  }

  return {
    left: -HAND_TARGET_SPACING - HAND_TARGET_REACH * leadReach * (1 - followReach),
    right: HAND_TARGET_SPACING - HAND_TARGET_REACH * followReach,
  };
}

function isRightShimmyState(state) {
  return state === 'rightShimmy' || state === 'bracedHangShimmyRight';
}

function isLeftShimmyState(state) {
  return state === 'leftShimmy' || state === 'bracedHangShimmyLeft';
}

function isClimbUpState(state) {
  return state === 'freeHangClimb' || state === 'bracedHangToCrouch';
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

function moveHandTargetMarker({ marker, target, delta, immediate }) {
  if (immediate || !marker.visible || marker.position.distanceTo(target) > HAND_TARGET_SNAP_DISTANCE) {
    marker.position.copy(target);
    return;
  }

  marker.position.lerp(
    target,
    1 - Math.exp(-HAND_TARGET_RETURN_SMOOTHING * delta),
  );
}

function markerSnapshot(marker) {
  return {
    visible: marker.visible,
    x: Number(marker.position.x.toFixed(3)),
    y: Number(marker.position.y.toFixed(3)),
    z: Number(marker.position.z.toFixed(3)),
  };
}

function sampleHangRootMotionAlong({ character, direction, delta }) {
  return sampleHangRootMotionAlongDetails({ character, direction, delta })?.delta ?? null;
}

function sampleHangRootMotionAlongDetails({ character, direction, delta }) {
  const rootMotion = character.animationController?.sampleRootMotionDelta?.(delta);

  if (!rootMotion || rootMotion.drive !== 'hang' || !character.hang?.ledge) {
    return null;
  }

  rootMotionMovement.copy(rootMotion.delta).applyQuaternion(character.group.quaternion);
  rootMotionTotalMovement.copy(rootMotion.totalDelta).applyQuaternion(character.group.quaternion);
  rootMotionTangent.set(
    character.hang.ledge.tangent.x,
    character.hang.ledge.tangent.y,
    character.hang.ledge.tangent.z,
  );

  const alongDelta = rootMotionMovement.dot(rootMotionTangent);
  const totalAlong = rootMotionTotalMovement.dot(rootMotionTangent);

  if (Math.abs(alongDelta) < MIN_ROOT_MOTION_ALONG_DELTA) {
    return null;
  }

  return {
    delta: Math.sign(direction || alongDelta) * Math.abs(alongDelta),
    total: Math.sign(direction || totalAlong) * Math.abs(totalAlong),
  };
}

function tickHopTapTimer(hang, delta) {
  if (!hang) {
    return;
  }

  hang.hopTapTimer = Math.max(0, (hang.hopTapTimer ?? 0) - delta);

  if (hang.hopTapTimer <= 0) {
    hang.hopTapDirection = 0;
  }
}

function resolveDirectionalTap({ input, hang, cameraBasis }) {
  const pressedX = Number(input.rightPressed) - Number(input.leftPressed);
  const pressedZ = 0;

  if (pressedX === 0 && pressedZ === 0) {
    return 0;
  }

  return resolveCameraRelativeHangDirection({
    input: {
      moveX: pressedX,
      moveZ: pressedZ,
    },
    hang,
    cameraBasis,
  });
}

function resolveCameraRelativeHangDirection({ input, hang, cameraBasis }) {
  if (!hang?.ledge || !input) {
    return 0;
  }

  const inputX = Math.abs(input.moveX) > 0.2 ? input.moveX : 0;
  const inputZ = Math.abs(input.moveZ) > 0.2 ? input.moveZ : 0;

  if (!inputX && !inputZ) {
    return 0;
  }

  const right = cameraBasis?.right;
  const forward = cameraBasis?.forward;

  if (!right || !forward) {
    return inputX ? Math.sign(inputX) : 0;
  }

  hangCameraMove
    .set(0, 0, 0)
    .addScaledVector(right, inputX)
    .addScaledVector(forward, inputZ);

  if (hangCameraMove.lengthSq() <= 0.0001) {
    return 0;
  }

  hangTangent.set(
    hang.ledge.axis === 'z' ? 0 : 1,
    0,
    hang.ledge.axis === 'z' ? 1 : 0,
  );

  if (hangTangent.lengthSq() <= 0.0001) {
    return 0;
  }

  const along = hangCameraMove.normalize().dot(hangTangent.normalize());

  return Math.abs(along) > 0.28
    ? Math.sign(along)
    : 0;
}

function shouldStartHopFromDirectionalTap({ hang, direction }) {
  if (!direction) {
    return false;
  }

  const isDoubleTap =
    hang.hopTapDirection === direction &&
    (hang.hopTapTimer ?? 0) > 0;

  hang.hopTapDirection = direction;
  hang.hopTapTimer = HOP_DOUBLE_TAP_SECONDS;

  if (!isDoubleTap) {
    return false;
  }

  hang.hopTapDirection = 0;
  hang.hopTapTimer = 0;
  return true;
}

function createHangIdleCycle(mode) {
  if (mode === 'braced') {
    return null;
  }

  return {
    mode,
    index: 0,
    timer: FREE_HANG_IDLE_SEQUENCE[0].seconds,
    state: FREE_HANG_IDLE_SEQUENCE[0].state,
  };
}

function resetHangIdleCycle(hang) {
  hang.idleCycle = createHangIdleCycle(hang.mode);
}

function resolveHangIdleAnimationState({ hang, delta = 0, advance = false }) {
  if (hang.mode === 'braced') {
    hang.idleCycle = null;
    return getBaseHangIdleAnimationState(hang.mode);
  }

  if (!hang.idleCycle || hang.idleCycle.mode !== hang.mode) {
    hang.idleCycle = createHangIdleCycle(hang.mode);
  }

  if (advance && hang.idleCycle) {
    hang.idleCycle.timer -= delta;

    while (hang.idleCycle.timer <= 0) {
      hang.idleCycle.index = (hang.idleCycle.index + 1) % FREE_HANG_IDLE_SEQUENCE.length;
      const entry = FREE_HANG_IDLE_SEQUENCE[hang.idleCycle.index];
      hang.idleCycle.state = entry.state;
      hang.idleCycle.timer += entry.seconds;
    }
  }

  return hang.idleCycle?.state ?? getBaseHangIdleAnimationState(hang.mode);
}

function getBaseHangIdleAnimationState(mode) {
  return mode === 'braced' ? 'bracedHang' : 'freeHang';
}
