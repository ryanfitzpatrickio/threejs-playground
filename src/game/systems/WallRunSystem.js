import * as THREE from 'three';

const WALL_RUN_SPEED = 6.05;
const WALL_RUN_ENTER_SECONDS = 0.42;
const WALL_RUN_EXIT_SECONDS = 0.41;
const WALL_RUN_MIN_LOOP_SECONDS = 0.42;
const WALL_RUN_ATTACH_COOLDOWN_SECONDS = 0.16;
const WALL_RUN_RELEASE_COOLDOWN_SECONDS = 0.18;
const WALL_RUN_EXIT_FREE_FALL_SECONDS = 0.28;
const WALL_RUN_EXIT_MOMENTUM_SECONDS = 0.42;
const WALL_RUN_ATTACH_BLEND_SECONDS = 0.2;
const WALL_RUN_JUMP_OUT_SPEED = 4.8;
const WALL_RUN_JUMP_UP_SPEED = 4.9;
const WALL_RUN_VERTICAL_SINK_SPEED = 0;
const WALL_RUN_INPUT_THRESHOLD = 0.12;
const WALL_RUN_LEAN_RADIANS = 0.3;
const WALL_RUN_MIN_AIRBORNE_HEIGHT = 0.36;
const WALL_RUN_UPPER_BODY_PROBE_OFFSET = 0.72;

const surfacePoint = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const candidateProbePosition = new THREE.Vector3();
const runDirection = new THREE.Vector3();
const releaseVelocity = new THREE.Vector3();
const inputDirection = new THREE.Vector3();
const horizontalVelocity = new THREE.Vector3();
const rootMotionMovement = new THREE.Vector3();
const facingRight = new THREE.Vector3();
const facingForward = new THREE.Vector3();
const handTarget = new THREE.Vector3();
const handSurfacePoint = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

export class WallRunSystem {
  constructor() {
    this.lastCandidate = null;
  }

  update({ delta, input, movement, character, level }) {
    character.wallRunCooldown = Math.max(0, (character.wallRunCooldown ?? 0) - delta);
    if (!input.jump) {
      character.wallRunReleaseRequired = false;
    }
    this.lastCandidate = null;

    if (character.wallRun?.active) {
      return this.updateActiveRun({ delta, input, movement, character, level });
    }

    // Another system owns the character's orientation right now (mount sets it via a
    // clean quaternion; traversal states set it via rotation.y). setLean below mutates
    // a single rotation.z Euler component, which resyncs the quaternion from the full
    // Euler and corrupts those orientations — notably it rolls the rider whenever the
    // horse faces the backward hemisphere (a clean rotY(yaw>90) decomposes to an Euler
    // with non-zero pitch/roll, and nudging .z bakes it in). Skip the lean reset while
    // any of those states is active.
    if (
      character.vehicle?.active ||
      character.mount?.active ||
      character.hang?.active ||
      character.wallClimb?.active ||
      character.rope?.active ||
      character.vault?.active ||
      character.slide?.active
    ) {
      return movement;
    }

    character.animationController?.setMirrorX?.(false);
    this.setLean(character, 0, delta);

    if (!canStartWallRun({ input, movement, character })) {
      return movement;
    }

    const candidate = findWallRunCandidate({ level, character });

    this.lastCandidate = candidate
      ? {
          name: candidate.name,
          u: Number(candidate.u.toFixed(3)),
          v: Number(candidate.v.toFixed(3)),
          faceDistance: Number(candidate.faceDistance.toFixed(3)),
          alongWall: candidate.alongWall === true,
          intoWall: candidate.intoWall === true,
        }
      : null;

    if (!candidate) {
      return movement;
    }

    const direction = resolveRunDirection({ candidate, movement, character });

    if (!direction) {
      return movement;
    }

    if (this.lastCandidate) {
      this.lastCandidate.direction = direction;
    }

    this.attach({ character, surface: candidate, direction });
    return this.overrideMovement({ movement, character });
  }

  attach({ character, surface, direction }) {
    character.wallRun = {
      active: true,
      surface,
      u: surface.u,
      v: THREE.MathUtils.clamp(surface.v, surface.minV, surface.maxV),
      direction,
      phase: 'enter',
      phaseTimer: WALL_RUN_ENTER_SECONDS,
      loopTimer: 0,
      animationState: wallRunBookendState({ phase: 'enter', wallSide: 1 }),
      normalOffset: 0,
      exitVelocity: new THREE.Vector3(),
      attachBlend: WALL_RUN_ATTACH_BLEND_SECONDS,
      attachBlendDuration: WALL_RUN_ATTACH_BLEND_SECONDS,
      attachStartPosition: character.group.position.clone(),
      attachStartYaw: character.group.rotation.y,
      handTarget: new THREE.Vector3(),
      handSide: 'right',
      wallSide: 1,
    };
    character.hang = null;
    character.wallClimb = null;
    character.rope = null;
    character.vault = null;
    character.traversalAction = null;
    character.grounded = false;
    character.verticalVelocity = 0;
    this.applyPosition({ character, wallRun: character.wallRun, delta: 0 });
    this.faceRunDirection(character, character.wallRun);
    character.wallRun.animationState = wallRunBookendState({
      phase: 'enter',
      wallSide: character.wallRun.wallSide,
    });
  }

  updateActiveRun({ delta, input, movement, character, level }) {
    const wallRun = character.wallRun;

    if (!input.jump || input.jumpReleased) {
      this.startExit(character, wallRun);
    }

    const inputSign = resolveInputDirection({ input, wallRun, movement });

    if (inputSign !== 0 && wallRun.phase !== 'exit') {
      wallRun.direction = inputSign;
    }

    const nextU = wallRun.u + wallRun.direction * wallRunSpeedForPhase(wallRun) * delta;
    const hitRunEnd = nextU <= wallRun.surface.minU || nextU >= wallRun.surface.maxU;
    this.updatePhase(wallRun, delta);
    this.advanceRunCoordinates({ character, wallRun, delta, fallbackNextU: nextU });

    wallRun.u = THREE.MathUtils.clamp(wallRun.u, wallRun.surface.minU, wallRun.surface.maxU);
    wallRun.v = THREE.MathUtils.clamp(wallRun.v, wallRun.surface.minV, wallRun.surface.maxV);

    if (hitRunEnd && wallRun.phase === 'loop' && (wallRun.loopTimer ?? 0) <= 0) {
      if (!this.tryTransferSurface({ level, wallRun })) {
        this.startExit(character, wallRun);
      }
    }

    if (wallRun.phase === 'exit' && wallRun.phaseTimer <= 0) {
      this.applyPosition({ character, wallRun, delta });
      this.faceRunDirection(character, wallRun);
      this.finishExit({ character, wallRun });
      return wallRunFallMovement({ movement, character });
    }

    this.applyPosition({ character, wallRun, delta });
    this.faceRunDirection(character, wallRun);
    character.grounded = false;
    if (wallRun.phase === 'exit') {
      character.velocity.set(wallRun.exitVelocity.x, 0, wallRun.exitVelocity.z);
      character.verticalVelocity = wallRun.exitVelocity.y;
    } else {
      character.verticalVelocity = 0;
      character.velocity.copy(runDirection.copy(wallRun.surface.tangent).multiplyScalar(wallRun.direction * WALL_RUN_SPEED));
    }
    character.speed = WALL_RUN_SPEED;

    return this.overrideMovement({
      movement: {
        ...movement,
        moving: true,
        wantsMove: true,
        speed: WALL_RUN_SPEED,
        grounded: false,
        airborne: false,
        justJumped: false,
        justLanded: false,
        verticalVelocity: 0,
      },
      character,
    });
  }

  tryTransferSurface({ level, wallRun }) {
    const nextSurfaceName = wallRun.direction >= 0
      ? wallRun.surface.nextSurfaceName
      : wallRun.surface.previousSurfaceName;

    if (!nextSurfaceName) {
      return false;
    }

    const nextSurface = findWallRunSurfaceByName({ level, name: nextSurfaceName });

    if (!nextSurface) {
      return false;
    }

    wallRun.surface = nextSurface;
    wallRun.u = wallRun.direction >= 0
      ? nextSurface.minU
      : nextSurface.maxU;
    wallRun.v = THREE.MathUtils.clamp(wallRun.v, nextSurface.minV, nextSurface.maxV);
    wallRun.phase = 'loop';
    wallRun.phaseTimer = Infinity;
    wallRun.loopTimer = 0;
    wallRun.animationState = 'jog';
    wallRun.attachBlend = 0;
    return true;
  }

  updatePhase(wallRun, delta) {
    wallRun.phaseTimer = Math.max(0, (wallRun.phaseTimer ?? 0) - delta);

    if (wallRun.phase === 'enter' && wallRun.phaseTimer <= 0) {
      wallRun.phase = 'loop';
      wallRun.phaseTimer = Infinity;
      wallRun.loopTimer = WALL_RUN_MIN_LOOP_SECONDS;
      wallRun.animationState = 'jog';
      return;
    }

    if (wallRun.phase === 'exit') {
      wallRun.animationState = wallRunBookendState({ phase: 'exit', wallSide: wallRun.wallSide });
      return;
    }

    if (wallRun.phase === 'loop') {
      wallRun.loopTimer = Math.max(0, (wallRun.loopTimer ?? 0) - delta);
    }

    wallRun.animationState = wallRun.phase === 'enter'
      ? wallRunBookendState({ phase: 'enter', wallSide: wallRun.wallSide })
      : 'jog';
  }

  advanceRunCoordinates({ character, wallRun, delta, fallbackNextU }) {
    const rootMotion = sampleWallRunRootMotion({ character, wallRun, delta });

    if (rootMotion) {
      wallRun.u += rootMotion.u;
      wallRun.v += rootMotion.v;
      wallRun.normalOffset = Math.max(0, (wallRun.normalOffset ?? 0) + rootMotion.normal);
      wallRun.exitVelocity.copy(rootMotion.velocity);
      character.lastRootMotion = {
        mode: 'wall-run',
        drive: rootMotion.source.drive ?? 'wallRun',
        applied: {
          u: Number(rootMotion.u.toFixed(4)),
          v: Number(rootMotion.v.toFixed(4)),
          n: Number(rootMotion.normal.toFixed(4)),
        },
      };
      return;
    }

    wallRun.u = fallbackNextU;
    wallRun.v -= WALL_RUN_VERTICAL_SINK_SPEED * delta;
    character.lastRootMotion = null;
  }

  startExit(character, wallRun) {
    if (!wallRun || wallRun.phase === 'exit') {
      return;
    }

    wallRun.phase = 'exit';
    wallRun.phaseTimer = WALL_RUN_EXIT_SECONDS;
    wallRun.animationState = wallRunBookendState({ phase: 'exit', wallSide: wallRun.wallSide });
    wallRun.attachBlend = 0;
  }

  finishExit({ character, wallRun }) {
    releaseVelocity.copy(wallRun.exitVelocity ?? runDirection.set(0, 0, 0));
    if (releaseVelocity.lengthSq() < 0.0001) {
      releaseVelocity
        .copy(wallRun.surface.tangent)
        .multiplyScalar(wallRun.direction * 1.2);
    }
    character.velocity.set(releaseVelocity.x, 0, releaseVelocity.z);
    character.verticalVelocity = releaseVelocity.y;
    character.wallRunCooldown = WALL_RUN_ATTACH_COOLDOWN_SECONDS;
    character.wallRunReleaseRequired = true;
    character.pendingVisualHandoff = {
      from: character.group.position.clone(),
      source: 'wallRunExit',
    };
    character.wallRun = null;
    character.grounded = false;
    character.forceFreeFallTimer = WALL_RUN_EXIT_FREE_FALL_SECONDS;
    character.airMomentumLockTimer = WALL_RUN_EXIT_MOMENTUM_SECONDS;
    character.groundSnapBlockTimer = WALL_RUN_EXIT_MOMENTUM_SECONDS;
    character.airborneAnimationOverride = 'freeFall';
    character.animationController?.setMirrorX?.(false);
  }

  applyPosition({ character, wallRun, delta }) {
    pointOnWallRunSurface({
      surface: wallRun.surface,
      u: wallRun.u,
      v: wallRun.v,
      target: surfacePoint,
    });

    targetPosition
      .copy(surfacePoint)
      .addScaledVector(wallRun.surface.normal, (wallRun.surface.rootOffset ?? 0.42) + (wallRun.normalOffset ?? 0));

    if ((wallRun.attachBlend ?? 0) > 0) {
      wallRun.attachBlend = Math.max(0, wallRun.attachBlend - delta);
      const duration = wallRun.attachBlendDuration || WALL_RUN_ATTACH_BLEND_SECONDS;
      const alpha = easeOutCubic(THREE.MathUtils.clamp(1 - wallRun.attachBlend / duration, 0, 1));
      character.group.position.lerpVectors(wallRun.attachStartPosition, targetPosition, alpha);
    } else {
      character.group.position.copy(targetPosition);
    }

    updateHandTarget(wallRun);
  }

  faceRunDirection(character, wallRun) {
    runDirection.copy(wallRun.surface.tangent).multiplyScalar(wallRun.direction).normalize();
    const targetYaw = Math.atan2(runDirection.x, runDirection.z);

    if ((wallRun.attachBlend ?? 0) > 0) {
      const duration = wallRun.attachBlendDuration || WALL_RUN_ATTACH_BLEND_SECONDS;
      const alpha = easeOutCubic(THREE.MathUtils.clamp(1 - wallRun.attachBlend / duration, 0, 1));
      character.group.rotation.y = lerpAngle(wallRun.attachStartYaw ?? character.group.rotation.y, targetYaw, alpha);
    } else {
      character.group.rotation.y = targetYaw;
    }

    facingRight.set(runDirection.z, 0, -runDirection.x);
    wallRun.wallSide = wallRun.surface.normal.dot(facingRight) >= 0 ? 1 : -1;
    wallRun.handSide = wallRun.wallSide > 0 ? 'right' : 'left';
    this.setLean(character, -wallRun.wallSide * WALL_RUN_LEAN_RADIANS, 0.12);
  }

  setLean(character, lean, delta) {
    if (!character?.group) {
      return;
    }

    const alpha = delta >= 1 ? 1 : 1 - Math.exp(-18 * Math.max(delta, 0));
    character.group.rotation.z = THREE.MathUtils.lerp(character.group.rotation.z, lean, alpha);
  }

  overrideMovement({ movement, character }) {
    const wallRun = character.wallRun;

    return {
      ...movement,
      moving: true,
      wantsMove: true,
      speed: WALL_RUN_SPEED,
      grounded: false,
      airborne: false,
      wallRunning: true,
      wallRunState: wallRun?.animationState ?? 'jog',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }

  snapshot(character) {
    return {
      candidate: this.lastCandidate,
      active: character?.wallRun?.active ?? false,
      surface: character?.wallRun?.surface?.name ?? null,
      u: Number((character?.wallRun?.u ?? 0).toFixed(3)),
      v: Number((character?.wallRun?.v ?? 0).toFixed(3)),
      direction: character?.wallRun?.direction ?? 0,
      phase: character?.wallRun?.phase ?? null,
      handSide: character?.wallRun?.handSide ?? null,
    };
  }
}

function canStartWallRun({ input, movement, character }) {
  if (!input.wallRunJump) {
    return false;
  }

  if ((character.wallRunCooldown ?? 0) > 0) {
    return false;
  }

  if (character.wallRunReleaseRequired) {
    return false;
  }

  if (character.traversalAction || character.hang?.active || character.wallClimb?.active || character.rope?.active || character.vault?.active) {
    return false;
  }

  return movement.airborne && (movement.justJumped || movement.height >= WALL_RUN_MIN_AIRBORNE_HEIGHT);
}

function wallRunJumpMovement({ movement, character }) {
  runDirection.copy(character.velocity).setY(0);

  return {
    ...movement,
    moving: true,
    wantsMove: true,
    speed: runDirection.length(),
    direction: runDirection.lengthSq() > 0.0001 ? runDirection.normalize().clone() : movement.direction,
    wallRunning: false,
    airborne: true,
    grounded: false,
    justJumped: true,
    justLanded: false,
    verticalVelocity: character.verticalVelocity,
    height: character.group.position.y,
  };
}

function wallRunFallMovement({ movement, character }) {
  runDirection.copy(character.velocity).setY(0);

  return {
    ...movement,
    moving: true,
    wantsMove: true,
    speed: runDirection.length(),
    direction: runDirection.lengthSq() > 0.0001 ? runDirection.normalize().clone() : movement.direction,
    wallRunning: false,
    airborne: true,
    grounded: false,
    justJumped: false,
    justLanded: false,
    verticalVelocity: character.verticalVelocity,
    height: character.group.position.y,
  };
}

function wallRunSpeedForPhase(wallRun) {
  return wallRun.phase === 'exit'
    ? WALL_RUN_SPEED * 0.65
    : WALL_RUN_SPEED;
}

function wallRunBookendState({ phase, wallSide }) {
  const useRightSideClip = wallSide > 0;

  if (phase === 'exit') {
    return useRightSideClip
      ? 'wallRunDiagonalExitOpposite'
      : 'wallRunDiagonalExit';
  }

  return useRightSideClip
    ? 'wallRunDiagonalEnterOpposite'
    : 'wallRunDiagonalEnter';
}

function sampleWallRunRootMotion({ character, wallRun, delta }) {
  const controller = character.animationController;

  if (!controller?.sampleRootMotionDelta || wallRun.phase === 'loop') {
    return null;
  }

  controller.play?.(wallRun.animationState);
  const rootMotion = controller.sampleRootMotionDelta(delta);

  if (!rootMotion || rootMotion.drive !== 'wallRun') {
    return null;
  }

  rootMotionMovement.copy(rootMotion.delta).applyQuaternion(character.group.quaternion);
  const along = Math.abs(rootMotionMovement.dot(wallRun.surface.tangent)) * wallRun.direction;
  const vertical = rootMotionMovement.y;
  const normal = Math.max(0, rootMotionMovement.dot(wallRun.surface.normal));

  if (Math.abs(along) < 0.0001 && Math.abs(vertical) < 0.0001 && Math.abs(normal) < 0.0001) {
    return null;
  }

  return {
    u: along,
    v: vertical,
    normal,
    velocity: rootMotionMovement.clone().divideScalar(Math.max(delta, 0.0001)),
    source: rootMotion,
  };
}

function findWallRunSurfaceByName({ level, name }) {
  const surface = level.level?.wallRunSurfaces?.find((entry) => entry.name === name);

  if (!surface) {
    return null;
  }

  return {
    ...surface,
    origin: vectorFromObject(surface.origin),
    normal: vectorFromObject(surface.normal),
    tangent: vectorFromObject(surface.tangent),
    up: vectorFromObject(surface.up),
  };
}

function findWallRunCandidate({ level, character }) {
  const rootCandidate = level.findWallRunCandidate?.({
    position: character.group.position,
    velocity: character.velocity,
  });

  if (rootCandidate) {
    return rootCandidate;
  }

  candidateProbePosition
    .copy(character.group.position)
    .addScaledVector(worldUp, WALL_RUN_UPPER_BODY_PROBE_OFFSET);
  const upperBodyCandidate = level.findWallRunCandidate?.({
    position: candidateProbePosition,
    velocity: character.velocity,
  });

  if (!upperBodyCandidate) {
    return null;
  }

  return {
    ...upperBodyCandidate,
    v: THREE.MathUtils.clamp(
      upperBodyCandidate.v - WALL_RUN_UPPER_BODY_PROBE_OFFSET,
      upperBodyCandidate.minV,
      upperBodyCandidate.maxV,
    ),
    upperBodyProbe: true,
  };
}

function vectorFromObject(source) {
  return new THREE.Vector3(source.x, source.y, source.z);
}

function resolveRunDirection({ candidate, movement, character }) {
  horizontalVelocity.copy(character.velocity ?? inputDirection).setY(0);
  const velocityAlong = horizontalVelocity.lengthSq() > 0.0001
    ? horizontalVelocity.normalize().dot(candidate.tangent)
    : 0;
  const inputAlong = movement.direction?.lengthSq?.() > 0.0001
    ? movement.direction.clone().setY(0).normalize().dot(candidate.tangent)
    : 0;
  facingForward.set(
    Math.sin(character.group.rotation.y),
    0,
    Math.cos(character.group.rotation.y),
  );
  const facingAlong = facingForward.dot(candidate.tangent);
  const along = firstUsableSigned([
    { value: inputAlong, threshold: 0.06 },
    { value: facingAlong, threshold: 0.04 },
    { value: velocityAlong, threshold: 0.06 },
  ]);

  if (Math.abs(along) <= 0.001) {
    return 1;
  }

  return Math.sign(along);
}

function firstUsableSigned(entries) {
  for (const entry of entries) {
    if (Math.abs(entry.value) >= entry.threshold) {
      return entry.value;
    }
  }

  return 0;
}

function resolveInputDirection({ input, wallRun, movement }) {
  inputDirection.copy(movement.direction ?? wallRun.surface.tangent).setY(0);

  if (Math.abs(input.moveX) <= WALL_RUN_INPUT_THRESHOLD && Math.abs(input.moveZ) <= WALL_RUN_INPUT_THRESHOLD) {
    return 0;
  }

  if (inputDirection.lengthSq() <= 0.0001) {
    return 0;
  }

  const along = inputDirection.normalize().dot(wallRun.surface.tangent);
  return Math.abs(along) > 0.08 ? Math.sign(along) : 0;
}

function pointOnWallRunSurface({ surface, u, v, target }) {
  return target
    .copy(surface.origin)
    .addScaledVector(surface.tangent, u)
    .addScaledVector(surface.up, v);
}

function updateHandTarget(wallRun) {
  const sideOffset = wallRun.handSide === 'right' ? 0.02 : -0.02;
  pointOnWallRunSurface({
    surface: wallRun.surface,
    u: THREE.MathUtils.clamp(
      wallRun.u + wallRun.direction * (wallRun.surface.handForwardOffset ?? 0.18) + sideOffset,
      wallRun.surface.minU,
      wallRun.surface.maxU,
    ),
    v: THREE.MathUtils.clamp(
      wallRun.v + (wallRun.surface.handYOffset ?? 0.92),
      wallRun.surface.minV,
      wallRun.surface.maxV,
    ),
    target: handSurfacePoint,
  });
  handTarget
    .copy(handSurfacePoint)
    .addScaledVector(wallRun.surface.normal, wallRun.surface.handNormalOffset ?? 0.08);
  wallRun.handTarget.copy(handTarget);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function lerpAngle(from, to, alpha) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}
