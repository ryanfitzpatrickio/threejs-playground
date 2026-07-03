import * as THREE from 'three';

const WALL_CLIMB_SPEED = 1.35;
const WALL_BRACED_SPEED = 0.72;
const WALL_ROOT_MOTION_MIN_DELTA = 0.00004;
const WALL_HAND_REACH_FALLBACK = 0.76;
const WALL_TOP_LEDGE_REACH_MARGIN = 0.22;
const WALL_HAND_TARGET_SPACING = 0.26;
const WALL_HAND_TARGET_Y_OFFSET = -0.01;
const WALL_HAND_TARGET_NORMAL_OFFSET = 0.18;
const WALL_ATTACH_BLEND_SECONDS = 0.16;
const WALL_DETACH_COOLDOWN_SECONDS = 0.28;
const WALL_JUMP_OUT_SPEED = 3.25;
const WALL_JUMP_UP_SPEED = 4.6;
const WALL_INPUT_THRESHOLD = 0.12;

const inputDirection = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const facingDirection = new THREE.Vector3();
const rootMotionMovement = new THREE.Vector3();
const rootMotionSurfaceTangent = new THREE.Vector3();
const rootMotionSurfaceUp = new THREE.Vector3();
const leftGripPoint = new THREE.Vector3();
const rightGripPoint = new THREE.Vector3();

export class WallClimbSystem {
  constructor() {
    this.lastCandidate = null;
    this.lastTopLedgeHit = null;
  }

  update({ delta, input, movement, character, level, ledgeHangSystem }) {
    character.wallClimbCooldown = Math.max(0, (character.wallClimbCooldown ?? 0) - delta);
    this.lastCandidate = null;
    this.lastTopLedgeHit = null;

    if (character.hang?.active || character.wallRun?.active) {
      return movement;
    }

    if (character.wallClimb?.active) {
      return this.updateActiveClimb({ delta, input, movement, character, level, ledgeHangSystem });
    }

    if (!canAttachToWall({ input, movement, character })) {
      return movement;
    }

    const candidate = level.findClimbSurfaceCandidate({
      position: character.group.position,
    });

    this.lastCandidate = candidate
      ? {
          name: candidate.name,
          u: Number(candidate.u.toFixed(3)),
          v: Number(candidate.v.toFixed(3)),
          faceDistance: Number(candidate.faceDistance.toFixed(3)),
        }
      : null;

    if (!candidate || !isMovingIntoSurface({ input, surface: candidate, movement })) {
      return movement;
    }

    this.attach({ character, surface: candidate, input });
    return this.overrideMovement({ movement, character });
  }

  attach({ character, surface, input }) {
    character.wallClimb = {
      active: true,
      surface,
      u: surface.u,
      v: surface.v,
      animationState: input.brace ? 'bracedHang' : 'freeHangIdleAlt2',
      attachBlend: WALL_ATTACH_BLEND_SECONDS,
      attachBlendDuration: WALL_ATTACH_BLEND_SECONDS,
      attachStartPosition: character.group.position.clone(),
    };
    character.hang = null;
    character.wallRun = null;
    character.traversalAction = null;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    this.faceSurface(character, character.wallClimb);
  }

  snapActiveClimbToSurface(character) {
    if (!character.wallClimb?.active) {
      return;
    }

    character.wallClimb.attachBlend = 0;
    this.applyPosition({
      character,
      climb: character.wallClimb,
      delta: WALL_ATTACH_BLEND_SECONDS,
    });
  }

  resolveSurfaceRootPosition({ surface, u = surface.u, v = surface.v, target = new THREE.Vector3() }) {
    return pointOnClimbSurface({ surface, u, v, target })
      .addScaledVector(surface.normal, surface.rootOffset ?? 0.38);
  }

  updateActiveClimb({ delta, input, movement, character, level, ledgeHangSystem }) {
    const climb = character.wallClimb;

    const ignoreJumpPressed = climb.ignoreJumpPressed === true;
    climb.ignoreJumpPressed = false;

    if (input.jumpPressed && !ignoreJumpPressed) {
      this.release({ character, jumpAway: true });
      return {
        ...movement,
        wallClimbing: false,
        airborne: true,
        grounded: false,
        justJumped: true,
        verticalVelocity: character.verticalVelocity,
      };
    }

    climb.inputSettleTimer = Math.max(0, (climb.inputSettleTimer ?? 0) - delta);
    const settling = climb.inputSettleTimer > 0;
    const horizontal = !settling && Math.abs(input.moveX) > WALL_INPUT_THRESHOLD ? input.moveX : 0;
    climb.forceClimbUpTimer = Math.max(0, (climb.forceClimbUpTimer ?? 0) - delta);
    const forcedVertical = !settling && (climb.forceClimbUpTimer ?? 0) > 0 ? 1 : 0;
    const vertical = forcedVertical || (!settling && Math.abs(input.moveZ) > WALL_INPUT_THRESHOLD ? -input.moveZ : 0);
    const moving = horizontal !== 0 || vertical !== 0;
    const speed = input.brace ? WALL_BRACED_SPEED : WALL_CLIMB_SPEED;

    climb.animationState = resolveWallClimbAnimationState({ input, horizontal, vertical, moving });
    this.advanceSurfaceCoordinates({ character, climb, horizontal, vertical, speed, delta });

    this.applyPosition({ character, climb, delta });
    this.faceSurface(character, climb);
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;

    if (this.tryEnterTopLedgeHang({ character, climb, input, vertical, level, ledgeHangSystem })) {
      return {
        ...movement,
        moving: false,
        wantsMove: false,
        speed: 0,
        grounded: false,
        airborne: false,
        hanging: true,
        wallClimbing: false,
        hangState: character.hang?.animationState ?? null,
        wallClimbState: null,
        justJumped: false,
        justLanded: false,
        height: character.group.position.y,
        verticalVelocity: 0,
      };
    }

    return this.overrideMovement({
      movement: {
        ...movement,
        moving,
        wantsMove: moving,
        speed: moving ? speed : 0,
        grounded: false,
        airborne: false,
        justJumped: false,
        justLanded: false,
        verticalVelocity: 0,
      },
      character,
    });
  }

  applyPosition({ character, climb, delta }) {
    pointOnClimbSurface({
      surface: climb.surface,
      u: climb.u,
      v: climb.v,
      target: targetPosition,
    }).addScaledVector(climb.surface.normal, climb.surface.rootOffset ?? 0.38);

    if ((climb.attachBlend ?? 0) > 0) {
      climb.attachBlend = Math.max(0, climb.attachBlend - delta);
      const duration = climb.attachBlendDuration || WALL_ATTACH_BLEND_SECONDS;
      const alpha = 1 - climb.attachBlend / duration;
      character.group.position.lerpVectors(
        climb.attachStartPosition,
        targetPosition,
        easeOutCubic(THREE.MathUtils.clamp(alpha, 0, 1)),
      );
      return;
    }

    character.group.position.copy(targetPosition);
  }

  advanceSurfaceCoordinates({ character, climb, horizontal, vertical, speed, delta }) {
    if (horizontal === 0 && vertical === 0) {
      character.lastRootMotion = null;
      return;
    }

    const rootMotion = sampleWallRootMotion({
      character,
      state: climb.animationState,
      surface: climb.surface,
      horizontal,
      vertical,
      delta,
    });

    if (rootMotion) {
      climb.u = THREE.MathUtils.clamp(
        climb.u + rootMotion.u,
        climb.surface.minU,
        climb.surface.maxU,
      );
      climb.v = THREE.MathUtils.clamp(
        climb.v + rootMotion.v,
        climb.surface.minV,
        climb.surface.maxV,
      );
      character.lastRootMotion = rootMotionSnapshot({
        rootMotion: rootMotion.source,
        applied: rootMotionMovement.set(rootMotion.u, rootMotion.v, 0),
        mode: 'wall-surface',
      });
      return;
    }

    climb.u = THREE.MathUtils.clamp(
      climb.u + horizontal * speed * delta,
      climb.surface.minU,
      climb.surface.maxU,
    );
    climb.v = THREE.MathUtils.clamp(
      climb.v + vertical * speed * delta,
      climb.surface.minV,
      climb.surface.maxV,
    );
    character.lastRootMotion = {
      mode: 'wall-fallback',
      applied: {
        u: Number((horizontal * speed * delta).toFixed(4)),
        v: Number((vertical * speed * delta).toFixed(4)),
      },
    };
  }

  tryEnterTopLedgeHang({ character, climb, input, vertical, level, ledgeHangSystem }) {
    if (vertical <= 0 || !level?.findTopLedgeForClimbSurface || !ledgeHangSystem?.snapToLedgeHang) {
      return false;
    }

    const ledge = level.findTopLedgeForClimbSurface({
      surface: climb.surface,
      u: climb.u,
    });

    if (!ledge) {
      return false;
    }

    const gripHit = measureClosestGripHit({ character, ledge });
    const reachedHeight = gripHit.highestHandY >= ledge.y - WALL_TOP_LEDGE_REACH_MARGIN;
    const handHit = reachedHeight;

    this.lastTopLedgeHit = {
      ledge: ledge.name,
      hand: gripHit.hand,
      distance: Number(gripHit.distance.toFixed(3)),
      highestHandY: Number(gripHit.highestHandY.toFixed(3)),
      ledgeY: Number(ledge.y.toFixed(3)),
      reachedHeight,
      handHit,
    };

    if (!handHit) {
      return false;
    }

    ledgeHangSystem.snapToLedgeHang({
      character,
      ledge,
      mode: resolveHangModeForLedge(ledge),
    });
    return true;
  }

  release({ character, jumpAway = false }) {
    const climb = character.wallClimb;
    const normal = climb?.surface?.normal ?? new THREE.Vector3(0, 0, 1);

    character.wallClimbCooldown = WALL_DETACH_COOLDOWN_SECONDS;
    character.wallClimb = null;
    character.grounded = false;

    if (jumpAway) {
      character.velocity.set(
        normal.x * WALL_JUMP_OUT_SPEED,
        0,
        normal.z * WALL_JUMP_OUT_SPEED,
      );
      character.verticalVelocity = WALL_JUMP_UP_SPEED;
      character.forceFreeFallTimer = 0.18;
      return;
    }

    character.velocity.set(0, 0, 0);
    character.verticalVelocity = -0.8;
  }

  faceSurface(character, climb) {
    facingDirection
      .copy(climb.surface.normal)
      .multiplyScalar(-1)
      .setY(0);

    if (facingDirection.lengthSq() <= 0.0001) {
      return;
    }

    facingDirection.normalize();
    character.group.rotation.y = Math.atan2(facingDirection.x, facingDirection.z);
  }

  overrideMovement({ movement, character }) {
    const climb = character.wallClimb;

    return {
      ...movement,
      moving: false,
      wantsMove: false,
      speed: 0,
      grounded: false,
      airborne: false,
      wallClimbing: true,
      wallClimbState: climb?.animationState ?? 'freeHangIdleAlt2',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }

  snapshot() {
    return {
      candidate: this.lastCandidate,
      topLedgeHit: this.lastTopLedgeHit,
    };
  }
}

function resolveHangModeForLedge(ledge) {
  return ledge?.hangMode === 'free'
    ? 'free'
    : 'braced';
}

function canAttachToWall({ input, movement, character }) {
  if ((character.wallClimbCooldown ?? 0) > 0) {
    return false;
  }

  if (character.traversalAction || character.hang?.active || character.wallRun?.active || character.rope?.active) {
    return false;
  }

  return movement.airborne || movement.moving || input.bracePressed;
}

function isMovingIntoSurface({ input, surface, movement }) {
  inputDirection.set(input.moveX, 0, input.moveZ);

  if (inputDirection.lengthSq() > 0.0001) {
    inputDirection.normalize();
    if (inputDirection.dot(surface.normal) < -0.32) {
      return true;
    }
  }

  return movement.airborne && surface.faceDistance <= (surface.rootOffset ?? 0.38) + 0.18;
}

function resolveWallClimbAnimationState({ input, horizontal, vertical, moving }) {
  if (input.brace && !moving) {
    return 'bracedHang';
  }

  if (input.brace && moving) {
    if (Math.abs(vertical) > Math.abs(horizontal) * 0.65) {
      return vertical > 0 ? 'wallClimbUp' : 'wallClimbDown';
    }

    return horizontal < 0 ? 'bracedHangShimmyLeft' : horizontal > 0 ? 'bracedHangShimmyRight' : 'bracedHangShimmyAlt';
  }

  if (!moving) {
    return 'freeHangIdleAlt2';
  }

  if (Math.abs(horizontal) > Math.abs(vertical) * 0.65) {
    return horizontal < 0 ? 'leftShimmy' : 'rightShimmy';
  }

  return vertical > 0 ? 'wallClimbUp' : 'wallClimbDown';
}

function pointOnClimbSurface({ surface, u, v, target }) {
  return target
    .copy(surface.origin)
    .addScaledVector(surface.tangent, u)
    .addScaledVector(surface.up, v);
}

function sampleWallRootMotion({ character, state, surface, horizontal, vertical, delta }) {
  const controller = character.animationController;

  if (!controller?.sampleRootMotionDelta) {
    return null;
  }

  controller.play?.(state);
  const rootMotion = controller.sampleRootMotionDelta(delta);

  if (!rootMotion || (rootMotion.drive !== 'wall' && rootMotion.drive !== 'hang')) {
    return null;
  }

  rootMotionMovement.copy(rootMotion.delta).applyQuaternion(character.group.quaternion);
  rootMotionSurfaceTangent.copy(surface.tangent);
  rootMotionSurfaceUp.copy(surface.up);

  let u = rootMotionMovement.dot(rootMotionSurfaceTangent);
  let v = rootMotionMovement.dot(rootMotionSurfaceUp);

  if (Math.abs(horizontal) >= Math.abs(vertical)) {
    u = Math.sign(horizontal || u) * Math.abs(u);
    v = 0;
  } else {
    v = Math.sign(vertical || v) * Math.abs(v);
    u = 0;
  }

  if (Math.abs(u) < WALL_ROOT_MOTION_MIN_DELTA && Math.abs(v) < WALL_ROOT_MOTION_MIN_DELTA) {
    return null;
  }

  return {
    u,
    v,
    source: rootMotion,
  };
}

function rootMotionSnapshot({ rootMotion, applied, mode }) {
  return {
    mode,
    drive: rootMotion.drive ?? 'raw',
    blend: Number((rootMotion.blend ?? 0).toFixed(3)),
    delta: {
      x: Number(rootMotion.delta.x.toFixed(4)),
      y: Number(rootMotion.delta.y.toFixed(4)),
      z: Number(rootMotion.delta.z.toFixed(4)),
    },
    applied: {
      u: Number(applied.x.toFixed(4)),
      v: Number(applied.y.toFixed(4)),
    },
  };
}

function measureClosestGripHit({ character, ledge }) {
  const anchors = character.animationController?.measureHandAnchors?.();
  const ledgePointX = ledge.axis === 'x' ? ledge.along : ledge.x;
  const ledgePointZ = ledge.axis === 'z' ? ledge.along : ledge.z;
  leftGripPoint
    .set(ledgePointX, ledge.y + WALL_HAND_TARGET_Y_OFFSET, ledgePointZ)
    .addScaledVector(ledge.tangent, -WALL_HAND_TARGET_SPACING)
    .addScaledVector(ledge.normal, WALL_HAND_TARGET_NORMAL_OFFSET);
  rightGripPoint
    .set(ledgePointX, ledge.y + WALL_HAND_TARGET_Y_OFFSET, ledgePointZ)
    .addScaledVector(ledge.tangent, WALL_HAND_TARGET_SPACING)
    .addScaledVector(ledge.normal, WALL_HAND_TARGET_NORMAL_OFFSET);
  let highest = -Infinity;
  let closestDistance = Infinity;
  let closestHand = null;

  if (Array.isArray(anchors)) {
    for (const anchor of anchors) {
      if (Number.isFinite(anchor.y)) {
        highest = Math.max(highest, anchor.y);
      }

      const target = anchor.name?.includes('Left') ? leftGripPoint : rightGripPoint;
      const distance = Math.hypot(
        (anchor.x ?? 0) - target.x,
        (anchor.y ?? 0) - target.y,
        (anchor.z ?? 0) - target.z,
      );

      if (distance < closestDistance) {
        closestDistance = distance;
        closestHand = anchor.name ?? 'hand';
      }
    }
  }

  if (Number.isFinite(closestDistance)) {
    return {
      hand: closestHand,
      distance: closestDistance,
      highestHandY: Number.isFinite(highest) ? highest : character.group.position.y + WALL_HAND_REACH_FALLBACK,
    };
  }

  return {
    hand: 'fallback',
    distance: Math.abs((character.group.position.y + WALL_HAND_REACH_FALLBACK) - ledge.y),
    highestHandY: character.group.position.y + WALL_HAND_REACH_FALLBACK,
  };
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}
