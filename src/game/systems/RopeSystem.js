import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';

const ROPE_ATTACH_HAND_HEIGHT = 1.28;
const ROPE_ATTACH_BLEND_SECONDS = 0.12;
const ROPE_ATTACH_COOLDOWN_SECONDS = 0.24;
const ROPE_CLIMB_SPEED = 1.45;
const ROPE_SWING_PUMP = 4.8;
const ROPE_SWING_DAMPING = 0.34;
const ROPE_MAX_ANGLE = 1.08;
const ROPE_MAX_ANGULAR_VELOCITY = 3.25;
const ROPE_RELEASE_BASE_UP = 1.1;
const ROPE_RELEASE_ARC_UP = 3.15;
const ROPE_RELEASE_MIN_UP = 5.6;
const ROPE_RELEASE_BASE_OUT = 2.45;
const ROPE_RELEASE_ARC_OUT = 3.35;
const ROPE_RELEASE_MOMENTUM_SECONDS = 0.55;
const ROPE_RELEASE_FREE_FALL_SECONDS = 0.38;
const ROPE_INPUT_THRESHOLD = 0.12;
const ROPE_SOCKET_FALLOFF_ABOVE = 0.42;
const ROPE_SOCKET_FALLOFF_BELOW = 0.34;

const probePosition = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const rootPosition = new THREE.Vector3();
const socketDirection = new THREE.Vector3();
const handMidpoint = new THREE.Vector3();
const handLeft = new THREE.Vector3();
const handRight = new THREE.Vector3();
const handSocketDelta = new THREE.Vector3();
const releaseVelocity = new THREE.Vector3();
const ropeDown = new THREE.Vector3(0, -1, 0);
const ropeUp = new THREE.Vector3(0, 1, 0);
const facingDirection = new THREE.Vector3();
const ribbonPoint = new THREE.Vector3();
const ribbonNext = new THREE.Vector3();
const ribbonPrevious = new THREE.Vector3();
const ribbonTangent = new THREE.Vector3();
const ribbonSide = new THREE.Vector3();
const cardAxisX = new THREE.Vector3(1, 0, 0);
const cardAxisZ = new THREE.Vector3(0, 0, 1);
const cardWorldUp = new THREE.Vector3(0, 1, 0);
const socketedRopePoint = new THREE.Vector3();
const socketBasePoint = new THREE.Vector3();
const socketDelta = new THREE.Vector3();

export class RopeSystem {
  constructor() {
    this.lastCandidate = null;
  }

  update({ delta, input, movement, character, level, physics }) {
    character.ropeCooldown = Math.max(0, (character.ropeCooldown ?? 0) - delta);
    this.lastCandidate = null;

    if (character.hang?.active || character.wallRun?.active || character.wallClimb?.active || character.hookSwing?.active) {
      return movement;
    }

    if (character.rope?.active) {
      return this.updateActiveRope({ delta, input, movement, character, physics });
    }

    if (!canAttachToRope({ input, movement, character })) {
      return movement;
    }

    probePosition
      .copy(character.group.position)
      .addScaledVector(ropeUp, ROPE_ATTACH_HAND_HEIGHT);

    const candidate = level.findRopeCandidate({
      position: probePosition,
      maxDistance: movement.airborne ? 0.92 : 0.72,
    });

    this.lastCandidate = candidate
      ? {
          name: candidate.name,
          distance: Number(candidate.distance.toFixed(3)),
          grabDistance: Number(candidate.grabDistance.toFixed(3)),
        }
      : null;

    if (!candidate) {
      return movement;
    }

    this.attach({ character, rope: candidate });
    return this.overrideMovement({ movement, character, moving: false });
  }

  attach({ character, rope }) {
    const swingTangent = rope.swingTangent.clone().setY(0);

    if (swingTangent.lengthSq() <= 0.0001) {
      swingTangent.set(1, 0, 0);
    } else {
      swingTangent.normalize();
    }

    const rootHangOffset = rope.rootHangOffset ?? 1.18;
    const pivotLength = Math.max(1.1, rope.grabDistance + rootHangOffset);
    const offsetAlong = character.group.position.clone().sub(rope.anchor).dot(swingTangent);
    const angle = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(offsetAlong / pivotLength, -0.82, 0.82)), -0.62, 0.62);

    character.rope = {
      active: true,
      rope,
      anchor: rope.anchor.clone(),
      swingTangent,
      grabDistance: rope.grabDistance,
      rootHangOffset,
      angle,
      angularVelocity: THREE.MathUtils.clamp(character.velocity.dot(swingTangent) / pivotLength, -1.8, 1.8),
      climbVelocity: 0,
      socketPoint: new THREE.Vector3(),
      ropeDirection: new THREE.Vector3(),
      handSocketError: 0,
      animationState: 'freeHang',
      attachBlend: ROPE_ATTACH_BLEND_SECONDS,
      attachBlendDuration: ROPE_ATTACH_BLEND_SECONDS,
      attachStartPosition: character.group.position.clone(),
    };
    character.hang = null;
    character.wallRun = null;
    character.wallClimb = null;
    character.traversalAction = null;
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;
    this.applyPosition({ character, ropeState: character.rope, delta: ROPE_ATTACH_BLEND_SECONDS });
  }

  updateActiveRope({ delta, input, movement, character, physics }) {
    const ropeState = character.rope;

    if (input.jumpPressed) {
      this.release({ character });
      return {
        ...movement,
        moving: true,
        wantsMove: true,
        speed: character.velocity.length(),
        grounded: false,
        airborne: true,
        hanging: false,
        wallClimbing: false,
        rope: false,
        ropeState: null,
        justJumped: true,
        justLanded: false,
        height: character.group.position.y,
        verticalVelocity: character.verticalVelocity,
      };
    }

    const climbInput = Math.abs(input.moveZ) > ROPE_INPUT_THRESHOLD ? -input.moveZ : 0;
    const pumpInput = Math.abs(input.moveX) > ROPE_INPUT_THRESHOLD ? input.moveX : 0;
    const pivotLength = this.getPivotLength(ropeState);
    const gravityAcceleration = -(GAME_CONFIG.character.gravity / pivotLength) * Math.sin(ropeState.angle);
    const pumpAcceleration = pumpInput * ROPE_SWING_PUMP / Math.max(1.2, pivotLength);

    ropeState.angularVelocity += (gravityAcceleration + pumpAcceleration) * delta;
    ropeState.angularVelocity *= Math.exp(-ROPE_SWING_DAMPING * delta);
    ropeState.angularVelocity = THREE.MathUtils.clamp(
      ropeState.angularVelocity,
      -ROPE_MAX_ANGULAR_VELOCITY,
      ROPE_MAX_ANGULAR_VELOCITY,
    );
    ropeState.angle = THREE.MathUtils.clamp(
      ropeState.angle + ropeState.angularVelocity * delta,
      -ROPE_MAX_ANGLE,
      ROPE_MAX_ANGLE,
    );
    ropeState.climbVelocity = climbInput * ROPE_CLIMB_SPEED;
    ropeState.grabDistance = THREE.MathUtils.clamp(
      ropeState.grabDistance - ropeState.climbVelocity * delta,
      ropeState.rope.minGrabDistance ?? 1,
      ropeState.rope.maxGrabDistance ?? ropeState.rope.length,
    );
    ropeState.animationState = resolveRopeAnimationState({ climbInput, ropeState });
    physics?.driveRope?.({
      ropeName: ropeState.rope.name,
      angle: ropeState.angle,
      angularVelocity: ropeState.angularVelocity,
      grabDistance: ropeState.grabDistance,
    });

    this.applyPosition({ character, ropeState, delta });
    this.faceSwingDirection({ character, ropeState, pumpInput });
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = false;

    return this.overrideMovement({
      movement: {
        ...movement,
        moving: Math.abs(climbInput) > 0 || Math.abs(pumpInput) > 0,
        wantsMove: Math.abs(climbInput) > 0 || Math.abs(pumpInput) > 0,
        speed: Math.abs(ropeState.angularVelocity) * pivotLength,
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

  release({ character }) {
    const ropeState = character.rope;
    const pivotLength = this.getPivotLength(ropeState);
    const angle = ropeState.angle;
    const angularVelocity = ropeState.angularVelocity;
    const arcAmount = THREE.MathUtils.clamp((Math.abs(angle) - 0.34) / 0.48, 0, 1);
    const arcDirection = Math.sign(angle || angularVelocity || 1);

    releaseVelocity
      .copy(ropeState.swingTangent)
      .multiplyScalar(Math.cos(angle) * angularVelocity * pivotLength)
      .addScaledVector(ropeUp, Math.sin(angle) * angularVelocity * pivotLength);

    releaseVelocity
      .addScaledVector(ropeState.swingTangent, arcDirection * (ROPE_RELEASE_BASE_OUT + ROPE_RELEASE_ARC_OUT * arcAmount))
      .addScaledVector(ropeUp, ROPE_RELEASE_BASE_UP + ROPE_RELEASE_ARC_UP * arcAmount);

    character.velocity.set(releaseVelocity.x, 0, releaseVelocity.z);
    character.verticalVelocity = Math.max(ROPE_RELEASE_MIN_UP, releaseVelocity.y);
    character.grounded = false;
    character.forceFreeFallTimer = ROPE_RELEASE_FREE_FALL_SECONDS;
    character.airMomentumLockTimer = ROPE_RELEASE_MOMENTUM_SECONDS;
    character.groundSnapBlockTimer = ROPE_RELEASE_MOMENTUM_SECONDS;
    character.ropeCooldown = ROPE_ATTACH_COOLDOWN_SECONDS;
    character.rope = null;
  }

  applyPosition({ character, ropeState, delta }) {
    this.updateSocket(ropeState);
    rootPosition
      .copy(ropeState.socketPoint)
      .addScaledVector(ropeState.ropeDirection, ropeState.rootHangOffset);

    if ((ropeState.attachBlend ?? 0) > 0) {
      ropeState.attachBlend = Math.max(0, ropeState.attachBlend - delta);
      const duration = ropeState.attachBlendDuration || ROPE_ATTACH_BLEND_SECONDS;
      const alpha = 1 - ropeState.attachBlend / duration;
      targetPosition.lerpVectors(
        ropeState.attachStartPosition,
        rootPosition,
        easeOutCubic(THREE.MathUtils.clamp(alpha, 0, 1)),
      );
      character.group.position.copy(targetPosition);
      return;
    }

    character.group.position.copy(rootPosition);
  }

  faceSwingDirection({ character, ropeState, pumpInput }) {
    const sign = Math.sign(pumpInput || ropeState.angularVelocity || ropeState.angle || 1);
    facingDirection.copy(ropeState.swingTangent).multiplyScalar(sign);
    character.group.rotation.y = Math.atan2(facingDirection.x, facingDirection.z);
  }

  getPivotLength(ropeState) {
    return Math.max(1.1, ropeState.grabDistance + ropeState.rootHangOffset);
  }

  updateSocket(ropeState) {
    socketDirection
      .copy(ropeState.swingTangent)
      .multiplyScalar(Math.sin(ropeState.angle))
      .addScaledVector(ropeDown, Math.cos(ropeState.angle));

    if (socketDirection.lengthSq() <= 0.0001) {
      socketDirection.copy(ropeDown);
    } else {
      socketDirection.normalize();
    }

    ropeState.ropeDirection.copy(socketDirection);
    ropeState.socketPoint
      .copy(ropeState.anchor)
      .addScaledVector(ropeState.ropeDirection, ropeState.grabDistance);

    return ropeState.socketPoint;
  }

  alignCharacterHandsToSocket({ character }) {
    const ropeState = character?.rope;
    const controller = character?.animationController;

    if (!ropeState?.active || !controller?.handBones?.length || !ropeState.socketPoint) {
      return;
    }

    const leftHand = controller.handBones.find((bone) => bone && /left/i.test(bone.name));
    const rightHand = controller.handBones.find((bone) => bone && /right/i.test(bone.name));

    if (!leftHand || !rightHand) {
      return;
    }

    character.group.updateMatrixWorld(true);
    leftHand.getWorldPosition(handLeft);
    rightHand.getWorldPosition(handRight);
    handMidpoint.copy(handLeft).add(handRight).multiplyScalar(0.5);
    handSocketDelta.subVectors(ropeState.socketPoint, handMidpoint);

    if (!Number.isFinite(handSocketDelta.x) || !Number.isFinite(handSocketDelta.y) || !Number.isFinite(handSocketDelta.z)) {
      return;
    }

    character.group.position.add(handSocketDelta);
    character.group.updateMatrixWorld(true);
    leftHand.getWorldPosition(handLeft);
    rightHand.getWorldPosition(handRight);
    handMidpoint.copy(handLeft).add(handRight).multiplyScalar(0.5);
    ropeState.handSocketError = handMidpoint.distanceTo(ropeState.socketPoint);
  }

  overrideMovement({ movement, character, moving }) {
    return {
      ...movement,
      moving,
      wantsMove: moving,
      speed: character.rope ? Math.abs(character.rope.angularVelocity) * this.getPivotLength(character.rope) : 0,
      direction: character.rope?.swingTangent?.clone?.() ?? movement.direction,
      grounded: false,
      airborne: false,
      hanging: false,
      wallClimbing: false,
      rope: true,
      ropeState: character.rope?.animationState ?? 'freeHang',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }

  snapshot(character) {
    const rope = character?.rope;

    return {
      candidate: this.lastCandidate,
      active: Boolean(rope?.active),
      state: rope?.animationState ?? null,
      rope: rope?.rope?.name ?? null,
      grabDistance: Number((rope?.grabDistance ?? 0).toFixed(3)),
      angle: Number((rope?.angle ?? 0).toFixed(3)),
      angularVelocity: Number((rope?.angularVelocity ?? 0).toFixed(3)),
      handSocketError: Number((rope?.handSocketError ?? 0).toFixed(3)),
      socket: rope?.socketPoint
        ? {
            x: Number(rope.socketPoint.x.toFixed(3)),
            y: Number(rope.socketPoint.y.toFixed(3)),
            z: Number(rope.socketPoint.z.toFixed(3)),
          }
        : null,
    };
  }

  syncRopeVisuals({ level, physics, character }) {
    for (const rope of level.level?.ropes ?? []) {
      const physicsPoints = physics.getRopePoints?.(rope.name, physics.interpolationAlpha);

      if (!physicsPoints?.length || !rope.visual || physicsPoints.some((point) => !isFinitePoint(point))) {
        continue;
      }

      const points = character?.rope?.active && character.rope.rope?.name === rope.name
        ? createSocketedRopePoints({
            points: physicsPoints,
            ropeState: character.rope,
            ropeLength: rope.length,
          })
        : physicsPoints;

      updateRopeCard({
        mesh: rope.visual.cardA,
        points,
        width: rope.visual.width,
        sideHint: cardAxisX,
      });
      updateRopeCard({
        mesh: rope.visual.cardB,
        points,
        width: rope.visual.width,
        sideHint: cardAxisZ,
      });
    }
  }
}

function canAttachToRope({ input, movement, character }) {
  if ((character.ropeCooldown ?? 0) > 0) {
    return false;
  }

  if (character.hang?.active || character.wallRun?.active || character.wallClimb?.active || character.rope?.active || character.hookSwing?.active) {
    return false;
  }

  return input.jumpPressed || movement.airborne;
}

function resolveRopeAnimationState({ climbInput, ropeState }) {
  if (climbInput > 0) {
    return 'wallClimbUp';
  }

  if (climbInput < 0) {
    return 'wallClimbDown';
  }

  if (Math.abs(ropeState.angularVelocity) > 0.62 || Math.abs(ropeState.angle) > 0.24) {
    return 'freeHangIdleAlt';
  }

  return 'freeHang';
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3;
}

function createSocketedRopePoints({ points, ropeState, ropeLength }) {
  const grabT = THREE.MathUtils.clamp(ropeState.grabDistance / ropeLength, 0.001, 0.999);
  samplePoint(points, grabT, socketBasePoint);
  socketDelta.subVectors(ropeState.socketPoint, socketBasePoint);
  const deformedPoints = points.map((point, index) => {
    const t = points.length <= 1 ? 0 : index / (points.length - 1);
    const weight = socketFalloffWeight({ t, grabT });

    socketedRopePoint
      .set(point.x, point.y, point.z)
      .addScaledVector(socketDelta, weight);

    return {
      ...vectorSnapshot(socketedRopePoint),
      t,
    };
  });

  deformedPoints.push({
    x: ropeState.socketPoint.x,
    y: ropeState.socketPoint.y,
    z: ropeState.socketPoint.z,
    t: grabT,
  });
  deformedPoints.sort((a, b) => a.t - b.t);

  return deformedPoints;
}

function socketFalloffWeight({ t, grabT }) {
  if (Math.abs(t - grabT) <= 0.0001) {
    return 1;
  }

  const isAboveSocket = t < grabT;
  const distance = Math.abs(t - grabT);
  const falloff = isAboveSocket ? ROPE_SOCKET_FALLOFF_ABOVE : ROPE_SOCKET_FALLOFF_BELOW;
  const normalized = Math.min(1, distance / Math.max(0.001, falloff));
  const endpointFade = isAboveSocket
    ? THREE.MathUtils.smoothstep(t, 0, Math.max(0.001, grabT))
    : 1 - THREE.MathUtils.smoothstep(t, grabT, 1);

  return Math.max(0, (1 - normalized) ** 2 * endpointFade);
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

function isFinitePoint(point) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function vectorSnapshot(vector) {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}
