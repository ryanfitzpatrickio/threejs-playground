import { GAME_CONFIG } from '../config/gameConfig.js';
import { normalizeWeaponLocoKind, resolveWeaponLocomotionState } from '../characters/player/weaponLocomotion.js';
import {
  applyLeanRoll,
  movementToLocomotionAxes,
  resolveSpineAimBones,
} from '../characters/player/firstPersonRig.js';

// Cover-peek lean smoothing (rad/s-ish exponential rate) for the weapon stance.
const LEAN_SMOOTHING = 11;

const SWING_LAND_STATES = ['swingLand', 'swingLand1', 'swingLand2', 'swingLand3'];

const MIN_LAUNCH_SECONDS = 0.32;
const FREE_FALL_VELOCITY = -0.25;
const LANDING_LEAD_HEIGHT = 0.58;
const LANDING_LEAD_VELOCITY = -1.8;
// Horizontal speed (m/s) at which the legs fully blend from an override's
// footwork back to locomotion during a draw/sheathe/attack.
const LEG_BLEND_SPEED = 1.2;

const JUMP_BIG_HOLD_SECONDS = 0.85;
const LAND_ROLL_HOLD_SECONDS = 1.1;

export class AnimationStateSystem {
  constructor() {
    this.status = 'waiting';
    this.state = 'loading';
    this.playbackState = 'loading';
    this.locomotionSurface = null;
    this.elapsed = 0;
    this.airborneElapsed = 0;
    this.jumpStartedMoving = false;
    this.landingArmed = false;
    this.landingTimer = 0;
    this.landingState = 'land';
    this.jumpBigTimer = 0;
    this.landRollTimer = 0;
    this.leanAmount = 0;
    this._leanSpineRoot = null;
    this._leanSpineBones = null;
  }

  start({ character }) {
    this.status = 'running';
    this.state = 'idle';
    this.playbackState = 'idle';
    this.locomotionSurface = null;
    this.elapsed = 0;
    this.airborneElapsed = 0;
    this.jumpStartedMoving = false;
    this.landingArmed = false;
    this.landingTimer = 0;
    this.landingState = 'land';
    this.jumpBigTimer = 0;
    this.landRollTimer = 0;

    if (character.animationController) {
      character.animationController.play('idle', 0);
      return;
    }

    applyIdlePose(character, 0);
  }

  update({ delta, input, movement, character, level = null }) {
    if (this.status !== 'running') {
      return;
    }

    this.elapsed += delta;

    // Decay the ground-dodge timer (clears the override when it ends).
    if (GAME_CONFIG.character.enableDodge && (character.dodgeTimer ?? 0) > 0) {
      character.dodgeTimer = Math.max(0, character.dodgeTimer - delta);
      if (character.dodgeTimer <= 0) {
        character.dodgeOverride = null;
      }
    }
    // Clear an air-dash override once its window ends (so free-fall resumes).
    if (GAME_CONFIG.character.enableAirDash && (character.airDashTimer ?? 0) > 0) {
      character.airDashTimer = Math.max(0, character.airDashTimer - delta);
      if (character.airDashTimer <= 0 && character.airborneAnimationOverride === 'aerialEvade') {
        character.airborneAnimationOverride = null;
      }
    }

    if (this.jumpBigTimer > 0) {
      this.jumpBigTimer = Math.max(0, this.jumpBigTimer - delta);
    }
    if (this.landRollTimer > 0) {
      this.landRollTimer = Math.max(0, this.landRollTimer - delta);
    }

    this.state = this.resolveAnimationState({ input, movement, character, delta });
    this.locomotionSurface = resolveLocomotionSurface({ character, level });
    const surfacePlaybackState = (state) => resolveSurfacePlaybackState({
      state,
      movement,
      surface: this.locomotionSurface,
      controller: character.animationController,
    });
    this.playbackState = surfacePlaybackState(this.state);
    character.sway = Math.sin(this.elapsed * 1.35) * (this.state === 'brace' ? 0.12 : 0.045);

    if (character.animationController) {
      character.animationController.setMirrorX?.(movement.ledgeTraversing && movement.ledgeTraversalMirror === true);

      const combat = character.combat;
      const armed = !!combat?.armed;
      const override = combat?.animationOverride ?? null;
      // Flinch does not interrupt active combat overrides. Grounded flinch is split:
      // legs keep locomotion, torso plays the hit clip (armed or unarmed).
      const hitReactionActive = Boolean(
        character.hitReaction && (character.hitReactionTimer ?? 0) > 0 && !combat?.animationOverride
      );
      const flinchLayered = hitReactionActive
        && !movement.sliding
        && !movement.airborne;
      const dodgeActive = GAME_CONFIG.character.enableDodge && Boolean(
        character.dodgeOverride && (character.dodgeTimer ?? 0) > 0,
      );

      let groundingState = this.state;

      // Feet-only turn-in-place: drive the turn clip on the legs only while the
      // aim idle holds the hips/torso/arms, so the rifle stays aimed and the
      // FP camera keeps tracking the mouse — only the feet shuffle around.
      const gunTurn = Boolean(combat?.weaponClass)
        && typeof this.state === 'string'
        && this.state.includes('_turn_')
        && !movement.airborne
        && !movement.sliding;
      let footworkApplied = false;
      if (gunTurn && character.animationController.setFootwork) {
        const bodyState = this.resolveAimIdleState(character);
        footworkApplied = character.animationController.setFootwork(this.state, bodyState);
        if (footworkApplied) groundingState = bodyState;
      }

      // Reload: legs keep locomotion (lower), the upper body plays the reload.
      // Inert until a `${kind}_reload` clip is present (resolveReloadState → null).
      const reloadUpper = combat?.reloading && !movement.airborne && !movement.sliding && !movement.hanging
        ? this.resolveReloadState(character)
        : null;

      if (footworkApplied) {
        // Footwork owns the pose; the normal layer dims out via footworkWeight.
      } else if (reloadUpper) {
        character.animationController.clearFootwork?.();
        character.animationController.setLayered(true);
        // Lower body keeps the resolved gun locomotion (idle/walk/run legs).
        character.animationController.play(this.playbackState);
        character.animationController.setUpperBodyState(reloadUpper);
        character.animationController.setAttackLegs(null, 0);
        groundingState = this.playbackState;
      } else if (flinchLayered && !dodgeActive) {
        character.animationController.clearFootwork?.();
        character.animationController.setLayered(true);
        const lowerState = surfacePlaybackState(resolveLocomotionLower(input, movement));
        character.animationController.play(lowerState);
        character.animationController.setUpperBodyState(resolveHitReactionUpper(character));
        character.animationController.setAttackLegs(null, 0);
        groundingState = lowerState;
      } else if (
        character.carrying
        && !movement.sliding
        && !movement.airborne
        && !dodgeActive
        && !hitReactionActive
      ) {
        // Two-hand carry (propane tank, etc.): upper body holds a front grip pose
        // while legs keep normal locomotion. Prefer a dedicated clip if present;
        // great-sword idle is a solid two-hand front hold fallback.
        character.animationController.clearFootwork?.();
        character.animationController.setLayered(true);
        const lowerState = surfacePlaybackState(resolveLocomotionLower(input, movement));
        character.animationController.play(lowerState);
        const holdState = character.animationController.hasState?.('carryHold')
          ? 'carryHold'
          : 'armedIdle';
        character.animationController.setUpperBodyState(holdState);
        character.animationController.setAttackLegs(null, 0);
        groundingState = lowerState;
      } else if (armed && !movement.sliding && !dodgeActive && !hitReactionActive) {
        character.animationController.clearFootwork?.();
        // Layered rig for armed locomotion/attacks (but NOT during slide).
        // The locomotion base drives the legs and stays crossfaded
        // (so idle<->jog stays smooth). The override clip's lower half is layered
        // on top via setAttackLegs and blended by speed: full override footwork
        // when standing (moveBlend~0), blending fully to locomotion as the player
        // moves (moveBlend~1). Upper body plays the armed pose or the override.
        character.animationController.setLayered(true);
        const lowerState = surfacePlaybackState(resolveLocomotionLower(input, movement));
        character.animationController.play(lowerState);
        character.animationController.setUpperBodyState(this.state);
        const moveBlend = Math.max(0, Math.min(1, movement.speed / LEG_BLEND_SPEED));
        character.animationController.setAttackLegs(override, override ? 1 - moveBlend : 0);
        groundingState = lowerState;
      } else {
        // Unarmed or sliding: play full body clip (slide gets its own root motion).
        // Disable upper/lower separation during slide so root motion works properly.
        character.animationController.clearFootwork?.();
        character.animationController.setLayered(false);
        character.animationController.setUpperBodyState(null);
        character.animationController.setAttackLegs(null, 0);
        character.animationController.play(this.playbackState);
        groundingState = this.playbackState;
      }

      character.animationController.update(delta);
      character.animationController.applyFootGrounding({
        state: groundingState,
        groundHeight: movement.groundHeight,
        characterHeight: movement.height,
        delta,
      });
      character.animationController.applyHangIk(character.hang);
      character.animationController.applyWallRunIk(character.wallRun);
      character.animationController.applyVaultIk(character.vault);
      // While driving, the mount object is null — feed the vehicle state instead.
      // The torso stabilizer only needs `.active` for the ridingHorse (core-locked)
      // branch, and applyMountIk uses the same handTargets shape, so the arms pin
      // to the steering wheel exactly as they pin to the reins on horseback.
      const mountLike = character.vehicle ?? character.mount;
      character.animationController.applyMountTorsoStabilizer(mountLike);
      character.animationController.applyMountIk(mountLike);

      // When armed + using locomotion legs (no active attack), heavily filter
      // the spine motion from the armed upper clip. This damps the per-stride
      // wobble/bob while keeping the overall armed posture (the "car without shocks"
      // rigid torso you want).
      if (armed && !override && !flinchLayered) {
        character.animationController.applyArmedSpineStabilizer?.();
      }

      this.applyWeaponLean({ delta, input, character });

      return;
    }

    if (this.state === 'brace') {
      applyBracePose(character, this.elapsed);
      return;
    }

    if (this.state === 'jog') {
      applyJogPose(character, this.elapsed, movement.speed);
      return;
    }

    applyIdlePose(character, this.elapsed);
  }

  snapshot() {
    return {
      status: this.status,
      state: this.state,
      playbackState: this.playbackState,
      locomotionSurface: this.locomotionSurface,
      elapsed: Number(this.elapsed.toFixed(3)),
      airborneElapsed: Number(this.airborneElapsed.toFixed(3)),
      jumpStartedMoving: this.jumpStartedMoving,
      jumpBigTimer: this.jumpBigTimer,
      landRollTimer: this.landRollTimer,
    };
  }

  // Upper-body reload clip for the equipped gun kind (crouch variant preferred
  // when crouched). Returns null if no reload clip is available.
  resolveReloadState(character) {
    const kind = normalizeWeaponLocoKind(character.combat?.weaponClass);
    if (!kind) return null;
    const ctrl = character.animationController;
    const crouch = character.combat?.stance === 'crouch';
    const candidates = crouch ? [`${kind}_crouch_reload`, `${kind}_reload`] : [`${kind}_reload`];
    for (const c of candidates) {
      if (ctrl?.hasState?.(c)) return c;
    }
    return null;
  }

  // Aim/ready idle used as the steady upper body during a feet-only turn. Only
  // rifles ship turn clips, so this resolves the rifle family (with fallbacks).
  resolveAimIdleState(character) {
    const ctrl = character.animationController;
    const crouch = character.combat?.stance === 'crouch';
    const aiming = Boolean(character.combat?.aiming);
    const candidates = crouch
      ? [aiming ? 'rifle_crouch_aim_idle' : null, 'rifle_crouch_idle', 'rifle_aim_idle', 'rifle_idle']
      : [aiming ? 'rifle_aim_idle' : null, 'rifle_idle'];
    for (const c of candidates) {
      if (c && ctrl?.hasState?.(c)) return c;
    }
    return 'rifle_idle';
  }

  // Procedural cover-peek lean (hold Q + A/D while a gun is out) applied as an
  // additive spine roll after the mixer write. Shared by first and third person;
  // the packs have no lean mocap. Rolls the camera-carrying neck for a real peek in FP.
  applyWeaponLean({ delta, input, character }) {
    const modelRoot = character.animationController?.modelRoot;
    if (!modelRoot) return;
    if (this._leanSpineRoot !== modelRoot) {
      this._leanSpineRoot = modelRoot;
      this._leanSpineBones = resolveSpineAimBones(modelRoot);
    }
    const armed = Boolean(character.combat?.weaponClass);
    const target = armed
      ? (input?.leanRightHeld ? 1 : 0) - (input?.leanLeftHeld ? 1 : 0)
      : 0;
    this.leanAmount += (target - this.leanAmount) * (1 - Math.exp(-LEAN_SMOOTHING * delta));
    if (Math.abs(this.leanAmount) > 0.001) {
      applyLeanRoll(this._leanSpineBones, this.leanAmount);
    }
  }

  resolveAnimationState({ input, movement, character, delta }) {
    // Ground dodge (flip) plays full-body and preempts everything while active.
    // Disabled behind flag (MovementSystem won't set the fields when disabled).
    if (GAME_CONFIG.character.enableDodge && character.dodgeOverride && (character.dodgeTimer ?? 0) > 0) {
      return character.dodgeOverride;
    }

    if (this.landRollTimer > 0 && !movement.airborne) {
      return 'landRoll';
    }

    // Combat owns attack / draw / sheathe clips: when it forces a state, play it
    // verbatim (attacks can only start from grounded, non-traversing states).
    // Flinch impact does not interrupt player actions, so combat override takes
    // precedence over hitReaction.
    if (character?.combat?.animationOverride) {
      return character.combat.animationOverride;
    }

    // Hit reactions (flinch impact) layer on the upper body while grounded; legs
    // keep locomotion (see flinchLayered in update). Airborne hits still play
    // full-body. Does not interrupt active player actions/overrides.
    // PlayerDamageSystem owns hitReaction / hitReactionTimer.
    if (character?.hitReaction && (character.hitReactionTimer ?? 0) > 0) {
      const isArmed = !!character?.combat?.armed;
      if (character.hitReaction === "heavy") {
        return isArmed ? "armedHitThrown" : "hitThrown";
      }
      return isArmed ? "armedHitBackward" : "hitBackward";
    }

    // Telekinesis magic states (Phase 2). High priority after combat override + hitReaction (they yield to those per design).
    // Support for teleGrab (cast on press), teleHold, teleThrow (on release edge).
    // When armed: resolve returns armedTele* so the armed branch in update() does setLayered(true) + play(lower loco) + setUpperBodyState(armedTele*).
    // Unarmed: returns tele* , full body play.
    // Short circuit before traversal/air/land/move so gesture plays; clears timers like other committed states.
    if (input?.telekinesisHeld || input?.telekinesisReleased) {
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      const isArmed = !!character?.combat?.armed;
      if (input?.telekinesisReleased) {
        return isArmed ? "armedTeleThrow" : "teleThrow";
      }
      if (input?.telekinesisPressed) {
        return isArmed ? "armedTeleGrab" : "teleGrab";
      }
      return isArmed ? "armedTeleHold" : "teleHold";
    }

    if (movement.mounting) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.mountState ?? 'ridingHorse';
    }

    // Driving reuses the horse's seated riding loop; the hands are pinned to the
    // steering wheel by applyMountIk via character.vehicle.handTargets.
    if (movement.driving) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.vehicleState ?? 'ridingHorse';
    }

    if (movement.hanging) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.hangState ?? 'freeHang';
    }

    if (movement.wallRunning) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.wallRunState ?? 'jog';
    }

    if (movement.wallClimbing) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      return movement.wallClimbState ?? 'freeHangIdleAlt2';
    }

    if (movement.ledgeTraversing) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      return movement.ledgeTraversalState ?? 'ledgeCoverIdle';
    }

    if (movement.rope) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      return movement.ropeState ?? 'freeHang';
    }

    if (movement.hookSwinging) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      return movement.hookSwingState ?? 'hookSwing';
    }

    if (movement.wingsuitFlying) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.wingsuitState ?? 'freeFall';
    }

    if (movement.vaulting) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.vaultState ?? 'runVault';
    }

    // M3 car-to-car leap — reuse vault takeoff / freeFall until dedicated clips land.
    if (movement.carLeaping) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return movement.carLeapState === 'land' ? 'land' : 'runVault';
    }

    if (movement.sliding) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      // Slide takes precedence; armed layering is disabled below so the full
      // slide clip (with its 'slide' drive root motion) plays for the whole body.
      return movement.slideState ?? 'runningSlide';
    }

    // Swim: a river's water surface triggers the swim locomotion domain. Preempts
    // jump/land/airborne/sprint/jog/idle but yields to the traversal + reaction
    // states above (you can still vault/grapple/dodge out of a river). Falls back
    // to idle until a dedicated swim clip is added to the manifest.
    if (movement.inWater) {
      this.airborneElapsed = 0;
      this.landingTimer = 0;
      this.landingArmed = false;
      this.jumpBigTimer = 0;
      this.landRollTimer = 0;
      return 'swim';
    }

    if (movement.justJumped) {
      this.airborneElapsed = 0;
      this.jumpStartedMoving = movement.wantsMove || movement.speed > 0.55;
      this.landingArmed = false;
      this.landingTimer = 0;
      this.landingState = movement.swingRelease
        ? SWING_LAND_STATES[Math.floor(Math.random() * SWING_LAND_STATES.length)]
        : (this.jumpStartedMoving ? 'landMoving' : 'land');
      this.landRollTimer = 0;
      character.airborneAnimationOverride = null;
      if (GAME_CONFIG.character.enableJumpBig && character.jumpBig) {
        this.jumpBigTimer = JUMP_BIG_HOLD_SECONDS;
        return 'jumpBig';
      }
      this.jumpBigTimer = 0;
      return this.jumpStartedMoving ? 'jumpMoving' : 'jump';
    }

    if (movement.justLanded) {
      this.airborneElapsed = 0;
      character.airborneAnimationOverride = null;
      character.jumpBig = false;
      this.jumpBigTimer = 0;

      // Hard landings roll out of it.
      if (GAME_CONFIG.character.enableLandRoll && character.justRollLanded) {
        this.landingArmed = false;
        this.landingTimer = 0;
        this.jumpBigTimer = 0;
        this.landRollTimer = LAND_ROLL_HOLD_SECONDS;
        return 'landRoll';
      }

      if ((character.traversalRecoveryTimer ?? 0) > 0) {
        this.landingArmed = false;
        this.landingTimer = 0;
        return movement.moving ? 'jog' : 'idle';
      }

      this.landingState = this.landingArmed ? this.landingState : this.jumpStartedMoving ? 'landMoving' : 'land';
      this.landingArmed = false;
      this.landingTimer = this.jumpStartedMoving ? 0.5 : 0.54;
      return this.landingState;
    }

    if (this.landingTimer > 0 && !movement.airborne) {
      this.landingTimer = Math.max(0, this.landingTimer - delta);
      return this.landingState;
    }

    if (movement.airborne) {
      this.landRollTimer = 0;
      this.airborneElapsed += delta;

      if ((character.forceFreeFallTimer ?? 0) > 0) {
        this.jumpStartedMoving = false;
        this.landingArmed = false;
        this.jumpBigTimer = 0;
        this.landRollTimer = 0;
        return 'freeFall';
      }

      if (this.landingArmed) {
        return this.landingState;
      }

      if (shouldLeadLanding({ movement, airborneElapsed: this.airborneElapsed })) {
        this.landingArmed = true;
        return this.landingState;
      }

      if (GAME_CONFIG.character.enableAirDash && character.airborneAnimationOverride) {
        return character.airborneAnimationOverride;
      }

      // Hold the big-jump launch clip through the ascent (set on a sprint-jump).
      if (this.jumpBigTimer > 0) {
        return 'jumpBig';
      }

      if (this.airborneElapsed > MIN_LAUNCH_SECONDS && movement.verticalVelocity <= FREE_FALL_VELOCITY) {
        return 'freeFall';
      }

      return this.jumpStartedMoving ? 'jumpMoving' : 'jump';
    }

    // Gun-armed grounded locomotion (shared FP/TP resolver). Fires in third
    // person when a gun is equipped (combat.weaponClass set); first person sets
    // combat.animationOverride which already short-circuits above. Melee (great
    // sword) uses combat.armed + mapArmedState and never sets weaponClass, so it
    // is unaffected. Falls through to the unarmed states if the clip is not
    // loaded yet (rich pack streams in after the core subset).
    const gunKind = character?.combat?.weaponClass;
    if (gunKind) {
      const aiming = Boolean(character.combat?.aiming);
      // Aim-facing (ADS): body faces the camera, so camera-relative axes select the
      // true 8-way strafe. Hip-carry: MovementSystem turns the body to face travel,
      // so locomotion is always forward (feeding raw axes here would moonwalk).
      const axes = aiming
        ? movementToLocomotionAxes(movement, input)
        : { forward: movement.wantsMove || movement.speed > 0.4 ? 1 : 0, strafe: 0 };
      const resolved = resolveWeaponLocomotionState({
        weaponKind: gunKind,
        stance: character.combat?.stance === 'crouch' ? 'crouch' : 'stand',
        aiming,
        forward: axes.forward,
        strafe: axes.strafe,
        sprinting: Boolean(movement.sprinting),
        grounded: true,
        turning: character.combat?.turning ?? null,
      });
      if (resolved && character.animationController?.hasState?.(resolved.state)) {
        character.airborneAnimationOverride = null;
        return resolved.state;
      }
    }

    if (movement.sprinting) {
      character.airborneAnimationOverride = null;
      return mapArmedState('sprint', character);
    }

    // Brace is the stationary stance only — while moving with Shift held but
    // sprint suppressed (e.g. firing), fall through to jog rather than brace.
    if (input.brace && !movement.wantsMove) {
      return mapArmedState('brace', character);
    }

    if (movement.wantsMove) {
      character.airborneAnimationOverride = null;
      // Armed: always use forward locomotion (jog/sprint) like unarmed.
      // No strafe or back states — side/back inputs just play the forward clip
      // while body yaws to face the actual velocity.
      if (character?.combat?.armed) {
        return mapArmedState('jog', character);
      }
      return 'jog';
    }

    character.airborneAnimationOverride = null;
    return mapArmedState('idle', character);
  }
}

export function resolveLocomotionSurface({ character, level }) {
  const position = character?.group?.position;
  if (!position || !level?.getRoadSurfaceAt) return null;
  return level.getRoadSurfaceAt(position.x, position.z) === 'mud' ? 'mud' : null;
}

export function resolveSurfacePlaybackState({ state, movement, surface, controller }) {
  if (surface !== 'mud') return state;

  let mudState = null;
  switch (state) {
    case 'idle':
      mudState = 'mudIdle';
      break;
    case 'walk':
      mudState = 'mudWalk';
      break;
    case 'jog':
      mudState = movement.speed < 3.4 ? 'mudWalk' : 'mudRun';
      break;
    case 'sprint':
      mudState = 'mudRun';
      break;
    case 'turnLeft':
      mudState = 'mudTurnLeft';
      break;
    case 'turnRight':
      mudState = 'mudTurnRight';
      break;
    case 'jump':
      mudState = 'mudStandingJump';
      break;
    case 'jumpMoving':
      mudState = 'mudRunJump';
      break;
    default:
      return state;
  }

  return controller?.hasState?.(mudState) ? mudState : state;
}

function resolveHitReactionUpper(character) {
  const isArmed = !!character?.combat?.armed;
  if (character.hitReaction === 'heavy') {
    return isArmed ? 'armedHitThrown' : 'hitThrown';
  }
  return isArmed ? 'armedHitBackward' : 'hitBackward';
}

// Lower-body locomotion state from movement (drives only the legs when armed).
// Mirrors the armed upper-body selection so legs and torso agree on direction.
function resolveLocomotionLower(input, movement) {
  if (movement.sprinting) {
    return 'sprint';
  }
  if (!movement.wantsMove) {
    return 'idle';
  }
  // Always forward jog for lower body when armed + moving (no strafe).
  return 'jog';
}

// When the great sword is drawn, swap the base locomotion states for their armed
// equivalents. Traversal / airborne states are unaffected (they short-circuit
// earlier in resolveAnimationState).
function mapArmedState(state, character) {
  if (!character?.combat?.armed) {
    return state;
  }

  switch (state) {
    case 'idle':
      return 'armedIdle';
    case 'jog':
      return 'armedJog';
    case 'sprint':
      return 'armedSprint';
    default:
      return state;
  }
}

function shouldLeadLanding({ movement, airborneElapsed }) {
  return (
    airborneElapsed > MIN_LAUNCH_SECONDS &&
    movement.height <= LANDING_LEAD_HEIGHT &&
    movement.verticalVelocity <= LANDING_LEAD_VELOCITY
  );
}

function applyIdlePose(character, time) {
  const rig = character.rig;
  const breath = Math.sin(time * 1.8);

  rig.root.position.y = 0;
  rig.torso.rotation.set(0.03 * breath, 0, 0.015 * breath);
  rig.head.rotation.set(-0.03 + 0.015 * breath, 0, 0);
  rig.leftArm.rotation.set(0.16 + 0.025 * breath, 0, 0.24);
  rig.rightArm.rotation.set(0.12 - 0.025 * breath, 0, -0.2);
  rig.leftLeg.rotation.set(-0.04, 0, 0.04);
  rig.rightLeg.rotation.set(0.04, 0, -0.04);
  rig.hook.rotation.set(-0.2, 0.08, -0.18);
}

function applyJogPose(character, time, speed) {
  const rig = character.rig;
  const cadence = time * (5.1 + speed * 0.35);
  const stride = Math.sin(cadence);
  const counterStride = Math.sin(cadence + Math.PI);
  const bob = Math.abs(Math.cos(cadence)) * 0.045;

  rig.root.position.y = bob;
  rig.torso.rotation.set(0.06 + bob * 0.4, 0, stride * 0.045);
  rig.head.rotation.set(-0.04, 0, -stride * 0.025);
  rig.leftArm.rotation.set(counterStride * 0.42, 0, 0.18);
  rig.rightArm.rotation.set(stride * 0.42, 0, -0.2);
  rig.leftLeg.rotation.set(stride * 0.48, 0, 0.035);
  rig.rightLeg.rotation.set(counterStride * 0.48, 0, -0.035);
  rig.hook.rotation.set(-0.12 + counterStride * 0.04, 0.08, -0.16);
}

function applyBracePose(character, time) {
  const rig = character.rig;
  const shake = Math.sin(time * 9) * 0.018;

  rig.root.position.y = -0.055;
  rig.torso.rotation.set(0.24 + shake, 0, shake);
  rig.head.rotation.set(-0.16, 0, 0);
  rig.leftArm.rotation.set(-0.55, 0.08, 0.12);
  rig.rightArm.rotation.set(-0.58, -0.08, -0.12);
  rig.leftLeg.rotation.set(-0.18, 0, 0.08);
  rig.rightLeg.rotation.set(-0.22, 0, -0.08);
  rig.hook.rotation.set(-0.48, 0.04, -0.08);
}
