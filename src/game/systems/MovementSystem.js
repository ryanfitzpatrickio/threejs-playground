import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';

const moveVector = new THREE.Vector3();
const desiredVelocity = new THREE.Vector3();
const desiredMovement = new THREE.Vector3();
const rootMotionMovement = new THREE.Vector3();
const rootMotionDirection = new THREE.Vector3();
const visualHandoffOffset = new THREE.Vector3();
const forward = new THREE.Vector3(0, 0, -1);
const right = new THREE.Vector3(1, 0, 0);
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const MIN_ROOT_MOTION_DISTANCE = 0.0001;
const MOVING_GROUND_SNAP_DOWN_LIMIT = 0.32;
const WALK_OFF_SUPPORT_DROP_LIMIT = 0.1;

export class MovementSystem {
  update({ delta, input, character, level, physics, cameraBasis }) {
    character.traversalRecoveryTimer = Math.max(0, (character.traversalRecoveryTimer ?? 0) - delta);
    character.forceFreeFallTimer = Math.max(0, (character.forceFreeFallTimer ?? 0) - delta);
    character.airMomentumLockTimer = Math.max(0, (character.airMomentumLockTimer ?? 0) - delta);
    character.groundSnapBlockTimer = Math.max(0, (character.groundSnapBlockTimer ?? 0) - delta);

    if (character.ledgeTraversal?.active && !character.ledgeStandSupport) {
      character.ledgeTraversal = null;
    }

    const ledgeTraversalActive = Boolean(character.ledgeTraversal?.active && character.ledgeStandSupport);

    if (character.vehicle?.active || character.mount?.active || character.hang?.active || character.wallRun?.active || character.wallClimb?.active || character.rope?.active || character.hookSwing?.active || character.vault?.active || character.slide?.active || character.wingsuit?.active || ledgeTraversalActive) {
      return {
        moving: false,
        wantsMove: false,
        speed: 0,
        direction: forward.clone(),
        grounded: false,
        airborne: false,
        mounting: Boolean(character.mount?.active),
        driving: Boolean(character.vehicle?.active),
        hanging: Boolean(character.hang?.active),
        wallRunning: Boolean(character.wallRun?.active),
        wallClimbing: Boolean(character.wallClimb?.active),
        ledgeTraversing: ledgeTraversalActive,
        rope: Boolean(character.rope?.active),
        hookSwinging: Boolean(character.hookSwing?.active),
        wingsuitFlying: Boolean(character.wingsuit?.active),
        vaulting: Boolean(character.vault?.active),
        sliding: Boolean(character.slide?.active),
        mountState: character.mount?.animationState ?? null,
        vehicleState: character.vehicle?.animationState ?? null,
        hangState: character.hang?.animationState ?? null,
        wallRunState: character.wallRun?.animationState ?? null,
        wallClimbState: character.wallClimb?.animationState ?? null,
        ledgeTraversalState: character.ledgeTraversal?.animationState ?? null,
        ropeState: character.rope?.animationState ?? null,
        hookSwingState: character.hookSwing?.animationState ?? null,
        vaultState: character.vault?.animationState ?? null,
        slideState: character.slide?.animationState ?? null,
        justJumped: false,
        justLanded: false,
        groundHeight: level?.getGroundHeightAt(character.group.position, GAME_CONFIG.character.footRadius) ?? 0,
        height: character.group.position.y,
        verticalVelocity: 0,
      };
    }

    // River water detection for the swim domain. When the character's feet drop
    // below the river's water surface they swim: buoyancy replaces gravity, motion
    // slows, and the swim animation plays. Hysteresis on the corridor weight avoids
    // shoreline flicker. The character is kinematic (no rigid-body forces), so swim
    // physics adjust verticalVelocity + horizontal scale directly.
    const wcfg = GAME_CONFIG.character.water;
    const waterSample = level?.getWaterHeightAt?.(character.group.position) ?? { waterY: 0, weight: 0 };
    const feetY = character.group.position.y;
    const submerged = waterSample.weight > 0 && feetY < waterSample.waterY - (wcfg?.surfaceOffset ?? 0.1);
    const inWater = submerged && (character.inWater
      ? waterSample.weight > (wcfg?.exitWeight ?? 0.2)
      : waterSample.weight > (wcfg?.enterWeight ?? 0.5));
    character.inWater = inWater;
    const swimSpeedScale = inWater ? (wcfg?.speedScale ?? 0.6) : 1;
    const swimAccelScale = inWater ? (wcfg?.accelScale ?? 0.6) : 1;

    resolveCameraRelativeMoveVector({ input, cameraBasis, target: moveVector });

    if (moveVector.lengthSq() > 1) {
      moveVector.normalize();
    }

    const isTryingToMove = moveVector.lengthSq() > 0.0001;
    const isGrounded = character.grounded !== false;
    const isBracing = input.brace && isGrounded && !isTryingToMove;
    const isSprinting = input.brace && isGrounded && isTryingToMove;
    const justJumped = input.jumpPressed && isGrounded && !isBracing && !inWater;
    const baseSpeed = (isBracing
      ? GAME_CONFIG.character.braceSpeed
      : isTryingToMove
        ? isSprinting
          ? GAME_CONFIG.character.sprintSpeed
          : GAME_CONFIG.character.jogSpeed
        : 0) * swimSpeedScale;
    const preserveAirMomentum = !isGrounded &&
      (character.airMomentumLockTimer ?? 0) > 0 &&
      !isTryingToMove;
    const acceleration = (isGrounded
      ? GAME_CONFIG.character.acceleration
      : preserveAirMomentum
        ? 0
        : GAME_CONFIG.character.airAcceleration) * swimAccelScale;

    desiredVelocity.copy(moveVector).multiplyScalar(baseSpeed);
    if (acceleration > 0) {
      character.velocity.lerp(desiredVelocity, 1 - Math.exp(-acceleration * delta));
    }

    if (justJumped) {
      // Sprint-jump = a big leap (jumpBig clip); otherwise a normal jump.
      const big = GAME_CONFIG.character.enableJumpBig && isSprinting;
      character.verticalVelocity = big
        ? GAME_CONFIG.character.jumpSpeed * GAME_CONFIG.character.jumpBigMultiplier
        : GAME_CONFIG.character.jumpSpeed;
      character.jumpBig = big;
      character.grounded = false;
    }

    // Paddle up toward the surface while swimming (jump input).
    if (inWater && input.jumpPressed) {
      character.verticalVelocity = Math.max(character.verticalVelocity, wcfg?.paddleUp ?? 3.5);
    }

    // Acrobatics: ground dodge (double-tap a direction) and air-dash (double-tap
    // jump in air — yields to wall-run via the animation cascade). Both grant
    // i-frames via iframeTimer (decayed by PlayerDamageSystem).
    // Disabled behind flags; re-enable one-by-one when ready.
    const enableDodge = GAME_CONFIG.character.enableDodge;
    const enableAirDash = GAME_CONFIG.character.enableAirDash;
    if (enableDodge && input.dodgeDirection && isGrounded && !justJumped && (character.dodgeTimer ?? 0) <= 0) {
      const dir = input.dodgeDirection;
      character.pendingImpulse.set(dir.x * GAME_CONFIG.character.dodgePower, 0, dir.z * GAME_CONFIG.character.dodgePower);
      character.invulnerable = true;
      character.iframeTimer = Math.max(character.iframeTimer ?? 0, GAME_CONFIG.character.dodgeIframeSeconds);
      character.dodgeOverride = dir.z < 0 ? 'frontFlip' : 'frontTwistFlip';
      character.dodgeTimer = GAME_CONFIG.character.dodgeDuration;
    } else if (enableAirDash && input.jumpDoubleTapped && !isGrounded && !character.airborneAnimationOverride) {
      let dx = input.moveX;
      let dz = input.moveZ;
      if (dx * dx + dz * dz < 1e-6) {
        const yaw = character.group.rotation.y ?? 0;
        dx = Math.sin(yaw);
        dz = Math.cos(yaw);
      }
      character.pendingImpulse.x += dx * GAME_CONFIG.character.airDashPower;
      character.pendingImpulse.z += dz * GAME_CONFIG.character.airDashPower;
      character.invulnerable = true;
      character.iframeTimer = Math.max(character.iframeTimer ?? 0, GAME_CONFIG.character.dodgeIframeSeconds);
      character.airborneAnimationOverride = 'aerialEvade';
      character.airDashTimer = 0.6; // cleared by AnimationStateSystem so free-fall resumes
    }

    if (inWater) {
      // Buoyancy: damped spring toward a rest depth below the surface, so the
      // character floats instead of sinking under full gravity.
      const target = waterSample.waterY - (wcfg?.floatDepth ?? 0.9);
      const k = wcfg?.buoyancy ?? 8;
      const damp = wcfg?.buoyancyDamp ?? 4;
      character.verticalVelocity += (target - feetY) * k * delta;
      character.verticalVelocity *= Math.exp(-damp * delta);
      const maxv = wcfg?.maxVerticalSpeed ?? 3;
      if (character.verticalVelocity > maxv) character.verticalVelocity = maxv;
      else if (character.verticalVelocity < -maxv) character.verticalVelocity = -maxv;
    } else if (!character.grounded) {
      character.verticalVelocity -= GAME_CONFIG.character.gravity * delta;
    }

    desiredMovement.set(
      character.velocity.x * delta,
      character.verticalVelocity * delta,
      character.velocity.z * delta,
    );
    applyRootMotion({
      character,
      desiredMovement,
      delta,
      inputDirection: moveVector,
      wantsMove: isTryingToMove,
    });

    // Knockback / dodge shove: apply the pending impulse as a positional offset
    // (so it survives the per-frame velocity lerp toward input above) and decay it.
    const pendingImpulse = character.pendingImpulse;
    if (pendingImpulse && pendingImpulse.lengthSq() > 1e-6) {
      desiredMovement.x += pendingImpulse.x * delta;
      desiredMovement.z += pendingImpulse.z * delta;
      pendingImpulse.multiplyScalar(Math.exp(-6 * delta));
    }

    const forceFreeFallActive = (character.forceFreeFallTimer ?? 0) > 0;
    // While submerged, block the analytic ground-snap so buoyancy holds the float
    // (otherwise the snap yanks position.y down to the river bed). The physics
    // controller still collides with the bed, so deep-water never falls through and
    // shallow water lets the bed arrest the sink.
    const groundSnapBlocked = forceFreeFallActive
      || (character.groundSnapBlockTimer ?? 0) > 0
      || submerged;
    const previousGroundedY = character.group.position.y;
    const physicsMovement = physics.moveCharacter({
      character,
      movement: desiredMovement,
      controllerOptions: {
        allowAutostep: isGrounded && !justJumped && !groundSnapBlocked,
        allowGroundSnap: isGrounded && !justJumped && !groundSnapBlocked,
      },
    });
    let groundedAfterMove = !groundSnapBlocked && physicsMovement.grounded && !justJumped && character.verticalVelocity <= 0;

    character.group.position.add(physicsMovement.movement);
    const physicsSnapDrop = previousGroundedY - character.group.position.y;

    const preGroundSnapY = character.group.position.y;
    const horizSpeed = Math.hypot(character.velocity.x, character.velocity.z);
    // On pitched bridges/roads the controller follows the slope vertically while
    // horizontal input stays flat — allow a larger per-frame downward snap at speed
    // so we don't reject the physics step and rubber-band against analytic decks.
    const movingSnapDownLimit = isTryingToMove
      ? Math.max(MOVING_GROUND_SNAP_DOWN_LIMIT, horizSpeed * delta * 0.85 + 0.06)
      : GAME_CONFIG.character.groundSnapDownHeight;
    const levelGroundHeight = level?.getGroundHeightAt(
      character.group.position,
      GAME_CONFIG.character.footRadius,
      {
        maxStepUp: GAME_CONFIG.character.groundSnapHeight + 0.08,
        maxSnapDown: movingSnapDownLimit,
        requiredInset: GAME_CONFIG.character.footRadius * 0.35,
      },
    ) ?? 0;
    const ledgeSupportHeight = getLedgeStandSupportHeight({
      support: character.ledgeStandSupport,
      position: character.group.position,
      radius: GAME_CONFIG.character.footRadius,
      maxStepUp: GAME_CONFIG.character.groundSnapHeight + 0.08,
      maxSnapDown: movingSnapDownLimit,
    });
    const analyticGroundHeight = Math.max(levelGroundHeight, ledgeSupportHeight ?? -Infinity);
    const analyticStepUpLimit = GAME_CONFIG.character.groundSnapHeight + 0.08;
    const analyticSupportDelta = analyticGroundHeight - preGroundSnapY;
    const hasAnalyticSupport = !groundSnapBlocked &&
      Number.isFinite(analyticGroundHeight) &&
      analyticSupportDelta <= analyticStepUpLimit &&
      analyticSupportDelta >= -movingSnapDownLimit;

    if (
      groundedAfterMove &&
      isGrounded &&
      isTryingToMove &&
      !hasAnalyticSupport &&
      physicsSnapDrop > movingSnapDownLimit
    ) {
      character.group.position.y = previousGroundedY + desiredMovement.y;
      groundedAfterMove = false;
    }

    // Pitched bridge decks / platforms expose a smooth analytic surfaceHeightAt;
    // prefer that over the capsule controller height so fast travel doesn't
    // oscillate between physics snap rejection and analytic re-snap. Mesh roofs
    // still fall through to physics when the analytic query is out of window.
    const groundHeight = !groundSnapBlocked && hasAnalyticSupport
      ? analyticGroundHeight
      : physicsMovement.grounded && !groundSnapBlocked
        ? preGroundSnapY
        : analyticGroundHeight;

    if (
      !isGrounded &&
      !justJumped &&
      !groundSnapBlocked &&
      character.verticalVelocity <= 0 &&
      desiredMovement.y < 0
    ) {
      const ballisticY = previousGroundedY + desiredMovement.y;

      if (ballisticY <= groundHeight + 0.015) {
        character.group.position.y = groundHeight;
        groundedAfterMove = true;
      } else if (!groundedAfterMove && physicsMovement.movement.y > desiredMovement.y + 0.001) {
        character.group.position.y = ballisticY;
      }
    }

    const walkedOffSupport = isGrounded &&
      isTryingToMove &&
      !justJumped &&
      !groundSnapBlocked &&
      character.verticalVelocity <= 0 &&
      !hasAnalyticSupport &&
      previousGroundedY - groundHeight > WALK_OFF_SUPPORT_DROP_LIMIT;

    if (walkedOffSupport) {
      character.group.position.y = previousGroundedY + Math.min(desiredMovement.y, 0);
      character.verticalVelocity = Math.min(character.verticalVelocity, -0.2);
      character.forceFreeFallTimer = Math.max(character.forceFreeFallTimer ?? 0, 0.28);
      groundedAfterMove = false;
    }

    const snapDownLimit = isTryingToMove
      ? movingSnapDownLimit
      : GAME_CONFIG.character.groundSnapDownHeight;
    const snapToGround = isGrounded &&
      !groundedAfterMove &&
      !walkedOffSupport &&
      !groundSnapBlocked &&
      !justJumped &&
      character.verticalVelocity <= 0 &&
      hasAnalyticSupport &&
      groundHeight - character.group.position.y <= analyticStepUpLimit &&
      character.group.position.y - groundHeight <= snapDownLimit;

    let landingImpact = 0;
    if (groundedAfterMove || snapToGround) {
      const snapDrop = preGroundSnapY - groundHeight;

      if (snapDrop > 0 && !isGrounded) {
        character.animationController?.addLandingVisualOffset?.(snapDrop);
      }

      landingImpact = Math.abs(character.verticalVelocity);
      character.group.position.y = groundHeight;
      character.verticalVelocity = 0;
      character.grounded = true;
    } else {
      // A transient controller miss is not proof that support was lost. Only the
      // explicit walk-off path above arms forced free fall; jumps and traversal
      // launches remain governed by their existing snap blockers/vertical speed.
      character.grounded = false;
    }

    const justLanded = !isGrounded && character.grounded;
    // Hard landings roll out of it (landRoll clip); soft landings use land/landMoving.
    // Disabled behind flag.
    character.justRollLanded = GAME_CONFIG.character.enableLandRoll && justLanded
      && landingImpact > GAME_CONFIG.character.landRollImpactThreshold;

    applyPendingVisualHandoff(character);

    if (!justJumped && !physicsMovement.grounded && desiredMovement.y > 0 && physicsMovement.movement.y < desiredMovement.y - 0.001) {
      character.verticalVelocity = Math.min(0, character.verticalVelocity);
    }

    character.speed = character.velocity.length();

    if (character.speed > 0.04) {
      const targetYaw = Math.atan2(character.velocity.x, character.velocity.z);
      character.group.rotation.y = dampAngle(
        character.group.rotation.y,
        targetYaw,
        GAME_CONFIG.character.rotationSmoothing,
        delta,
      );
    }

    character.stamina = Math.max(0, Math.min(GAME_CONFIG.character.maxStamina, character.stamina + delta * 0.05));

    return {
      moving: character.speed > 0.08,
      wantsMove: isTryingToMove,
      sprinting: isSprinting,
      speed: character.speed,
      direction: isTryingToMove ? moveVector.clone() : forward.clone(),
      grounded: character.grounded,
      airborne: !character.grounded,
      inWater,
      justJumped,
      justLanded,
      groundHeight,
      height: character.group.position.y,
      verticalVelocity: character.verticalVelocity,
    };
  }
}

function applyPendingVisualHandoff(character) {
  const handoff = character.pendingVisualHandoff;

  if (!handoff?.from) {
    return;
  }

  visualHandoffOffset.subVectors(handoff.from, character.group.position);
  character.pendingVisualHandoff = null;

  if (visualHandoffOffset.lengthSq() <= 0.0001) {
    return;
  }

  character.animationController?.addTraversalVisualOffset?.(visualHandoffOffset);
}

function getLedgeStandSupportHeight({ support, position, radius, maxStepUp, maxSnapDown }) {
  if (!support || !position) {
    return null;
  }

  if (Number.isFinite(maxStepUp) && support.y > position.y + maxStepUp) {
    return null;
  }

  if (Number.isFinite(maxSnapDown) && support.y < position.y - maxSnapDown) {
    return null;
  }

  const along = support.axis === 'x' ? position.x : position.z;
  if (along + radius < support.min || along - radius > support.max) {
    return null;
  }

  const fixed = support.axis === 'x' ? position.z : position.x;
  const normalSign = support.axis === 'x'
    ? Math.sign(support.normal?.z ?? 0)
    : Math.sign(support.normal?.x ?? 0);
  const inwardDistance = (support.fixed - fixed) * (normalSign || 1);

  if (inwardDistance + radius < support.inwardMin || inwardDistance - radius > support.inwardMax) {
    return null;
  }

  return support.y;
}

function resolveCameraRelativeMoveVector({ input, cameraBasis, target }) {
  cameraForward.copy(cameraBasis?.forward ?? forward).setY(0);
  cameraRight.copy(cameraBasis?.right ?? right).setY(0);

  if (cameraForward.lengthSq() <= 0.0001) {
    cameraForward.copy(forward);
  } else {
    cameraForward.normalize();
  }

  if (cameraRight.lengthSq() <= 0.0001) {
    cameraRight.set(1, 0, 0);
  } else {
    cameraRight.normalize();
  }

  return target
    .set(0, 0, 0)
    .addScaledVector(cameraRight, input.moveX)
    .addScaledVector(cameraForward, -input.moveZ);
}

function dampAngle(current, target, smoothing, delta) {
  const deltaAngle = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + deltaAngle * (1 - Math.exp(-smoothing * delta));
}

function applyRootMotion({ character, desiredMovement, delta, inputDirection, wantsMove }) {
  const rootMotion = character.animationController?.sampleRootMotionDelta?.(delta);

  if (!rootMotion) {
    character.lastRootMotion = null;
    return;
  }

  if (rootMotion.drive === 'locomotion') {
    applyLocomotionRootMotion({ character, desiredMovement, inputDirection, wantsMove, rootMotion });
    return;
  }

  rootMotionMovement.copy(rootMotion.delta).applyQuaternion(character.group.quaternion);
  desiredMovement.x = THREE.MathUtils.lerp(desiredMovement.x, rootMotionMovement.x, rootMotion.blend);
  desiredMovement.z = THREE.MathUtils.lerp(desiredMovement.z, rootMotionMovement.z, rootMotion.blend);
  character.lastRootMotion = rootMotionSnapshot({
    rootMotion,
    applied: rootMotionMovement,
    mode: 'raw',
  });
}

function applyLocomotionRootMotion({ character, desiredMovement, inputDirection, wantsMove, rootMotion }) {
  if (!wantsMove || !inputDirection || inputDirection.lengthSq() <= 0.0001) {
    character.lastRootMotion = rootMotionSnapshot({
      rootMotion,
      applied: rootMotionMovement.set(0, 0, 0),
      mode: 'locomotion-idle',
    });
    return;
  }

  const strideDistance = Math.hypot(rootMotion.delta.x, rootMotion.delta.z);

  if (strideDistance < MIN_ROOT_MOTION_DISTANCE) {
    character.lastRootMotion = rootMotionSnapshot({
      rootMotion,
      applied: rootMotionMovement.set(0, 0, 0),
      mode: 'locomotion-zero',
    });
    return;
  }

  rootMotionDirection.copy(inputDirection).normalize();
  rootMotionMovement.copy(rootMotionDirection).multiplyScalar(strideDistance);
  desiredMovement.x = THREE.MathUtils.lerp(desiredMovement.x, rootMotionMovement.x, rootMotion.blend);
  desiredMovement.z = THREE.MathUtils.lerp(desiredMovement.z, rootMotionMovement.z, rootMotion.blend);
  character.lastRootMotion = rootMotionSnapshot({
    rootMotion,
    applied: rootMotionMovement,
    mode: 'locomotion',
  });
}

function rootMotionSnapshot({ rootMotion, applied, mode }) {
  return {
    mode,
    drive: rootMotion.drive ?? 'raw',
    blend: Number((rootMotion.blend ?? 0).toFixed(3)),
    localDelta: {
      x: Number(rootMotion.delta.x.toFixed(4)),
      y: Number(rootMotion.delta.y.toFixed(4)),
      z: Number(rootMotion.delta.z.toFixed(4)),
    },
    appliedDelta: {
      x: Number(applied.x.toFixed(4)),
      y: Number(applied.y.toFixed(4)),
      z: Number(applied.z.toFixed(4)),
    },
  };
}
