import * as THREE from 'three';

const LEDGE_TRAVERSAL_SPEED = 1.18;
const LEDGE_TRAVERSAL_INPUT_THRESHOLD = 0.12;
const LEDGE_TRAVERSAL_EDGE_PADDING = 0.28;
const LEDGE_TO_CLIMB_ROOT_OFFSET = 0.42;
const LEDGE_TO_CLIMB_VERTICAL_PROBES = [0.18, 0.55, 0.95, 1.35, 1.75, -0.12];
const LEDGE_TO_CLIMB_MIN_ORIGIN_DROP = 0.15;
const LEDGE_TO_CLIMB_MIN_TOP_CLEARANCE = 0.45;
// Tolerances for matching a climb surface above the current ledge. These are
// deliberately generous: the surface's own rootOffset re-positions the climber
// after selection, so a wide search tolerance only affects discovery, not snap.
// blockName + face + minNormalDot keep the search on the same wall of the same
// building, so widening here cannot pull in a neighbour's surface.
//
// MAX_FACE_DISTANCE must absorb inter-tier setbacks: the probe sits at the
// current ledge face + rootOffset (0.42), and an upper wall set back S metres
// inward reads as faceDist ≈ 0.42 + S. Gothic towers have been observed with
// ~0.85 m setbacks (faceDist ≈ 1.27), so 1.5 gives headroom. verticalDistance
// still isolates the single tier directly above, so this stays unambiguous.
const LEDGE_TO_CLIMB_MAX_FACE_DISTANCE = 1.5;
const LEDGE_TO_CLIMB_MIN_FACE_DISTANCE = -0.6;
const LEDGE_TO_CLIMB_MAX_EDGE_DISTANCE = 1.2;
const LEDGE_TO_CLIMB_MAX_VERTICAL_DISTANCE = 1.6;

const supportNormal = new THREE.Vector3();
const supportTangent = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const desiredMove = new THREE.Vector3();
const facing = new THREE.Vector3();
const climbProbePosition = new THREE.Vector3();

export class LedgeTraversalSystem {
  update({ delta, input, movement, character, cameraBasis }) {
    const support = character.ledgeStandSupport;
    let traversal = character.ledgeTraversal;

    if (traversal?.active && !support) {
      this.release(character);
      return {
        ...movement,
        ledgeTraversing: false,
        ledgeTraversalState: null,
        ledgeTraversalMirror: false,
      };
    }

    if (!traversal?.active && support && character.grounded && !character.hang?.active && !character.wallClimb?.active) {
      this.enter(character, support);
      traversal = character.ledgeTraversal;
    }

    if (!traversal?.active || !support) {
      return movement;
    }

    setSupportVectors(support);

    const direction = resolveTraversalDirection({ input, cameraBasis });
    const currentAlong = support.axis === 'x' ? character.group.position.x : character.group.position.z;
    const nextAlong = THREE.MathUtils.clamp(
      currentAlong + direction * LEDGE_TRAVERSAL_SPEED * delta,
      support.min + LEDGE_TRAVERSAL_EDGE_PADDING,
      support.max - LEDGE_TRAVERSAL_EDGE_PADDING,
    );
    const inwardOffset = THREE.MathUtils.clamp(
      support.inwardOffset ?? 0.58,
      support.inwardMin ?? 0.05,
      support.inwardMax ?? 1.35,
    );

    if (support.axis === 'x') {
      character.group.position.set(
        nextAlong,
        support.y,
        support.fixed - supportNormal.z * inwardOffset,
      );
    } else {
      character.group.position.set(
        support.fixed - supportNormal.x * inwardOffset,
        support.y,
        nextAlong,
      );
    }

    traversal.along = nextAlong;
    traversal.direction = direction;
    traversal.mirrorX = direction < 0;
    traversal.animationState = direction < 0
      ? 'ledgeCoverSneakLeft'
      : direction > 0
        ? 'ledgeCoverSneakLeft'
        : 'ledgeCoverIdle';

    faceSupport(character);
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;

    return {
      ...movement,
      moving: direction !== 0,
      wantsMove: direction !== 0,
      speed: Math.abs(direction) * LEDGE_TRAVERSAL_SPEED,
      direction: supportTangent.clone().multiplyScalar(direction || 1),
      grounded: true,
      airborne: false,
      ledgeTraversing: true,
      ledgeTraversalState: traversal.animationState,
      ledgeTraversalMirror: traversal.mirrorX,
      justJumped: false,
      justLanded: false,
      groundHeight: support.y,
      height: support.y,
      verticalVelocity: 0,
    };
  }

  enter(character, support = character.ledgeStandSupport) {
    if (!support) {
      return;
    }

    setSupportVectors(support);
    const along = THREE.MathUtils.clamp(
      support.axis === 'x' ? character.group.position.x : character.group.position.z,
      support.min + LEDGE_TRAVERSAL_EDGE_PADDING,
      support.max - LEDGE_TRAVERSAL_EDGE_PADDING,
    );

    character.ledgeStandSupport = support;
    character.ledgeTraversal = {
      active: true,
      support,
      along,
      direction: 0,
      mirrorX: false,
      animationState: 'ledgeCoverIdle',
    };
    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    faceSupport(character);
  }

  release(character) {
    character.ledgeTraversal = null;
    character.ledgeStandSupport = null;
  }

  snapshot(character) {
    return character?.ledgeTraversal?.active
      ? {
          active: true,
          ledge: character.ledgeTraversal.support?.ledgeName ?? null,
          along: Number((character.ledgeTraversal.along ?? 0).toFixed(3)),
          direction: character.ledgeTraversal.direction ?? 0,
          mirrorX: character.ledgeTraversal.mirrorX === true,
          state: character.ledgeTraversal.animationState ?? 'ledgeCoverIdle',
        }
      : { active: false };
  }
}

function resolveTraversalDirection({ input, cameraBasis }) {
  desiredMove.set(0, 0, 0);

  if (Math.abs(input.moveX) > LEDGE_TRAVERSAL_INPUT_THRESHOLD || Math.abs(input.moveZ) > LEDGE_TRAVERSAL_INPUT_THRESHOLD) {
    cameraForward.copy(cameraBasis?.forward ?? new THREE.Vector3(0, 0, -1)).setY(0);
    cameraRight.copy(cameraBasis?.right ?? new THREE.Vector3(1, 0, 0)).setY(0);

    if (cameraForward.lengthSq() > 0.0001) {
      cameraForward.normalize();
    }

    if (cameraRight.lengthSq() > 0.0001) {
      cameraRight.normalize();
    }

    desiredMove
      .addScaledVector(cameraRight, input.moveX)
      .addScaledVector(cameraForward, -input.moveZ);
  }

  if (desiredMove.lengthSq() <= 0.0001) {
    return 0;
  }

  const along = desiredMove.normalize().dot(supportTangent);
  return Math.abs(along) > LEDGE_TRAVERSAL_INPUT_THRESHOLD ? Math.sign(along) : 0;
}

function setSupportVectors(support) {
  supportNormal.set(support.normal?.x ?? 0, 0, support.normal?.z ?? 0);
  if (supportNormal.lengthSq() <= 0.0001) {
    supportNormal.set(0, 0, 1);
  } else {
    supportNormal.normalize();
  }

  supportTangent.set(support.tangent?.x ?? 0, 0, support.tangent?.z ?? 0);
  if (supportTangent.lengthSq() <= 0.0001) {
    supportTangent.set(support.axis === 'x' ? 1 : 0, 0, support.axis === 'z' ? 1 : 0);
  } else {
    supportTangent.normalize();
  }
}

function faceSupport(character) {
  facing.copy(supportNormal);
  character.group.rotation.y = Math.atan2(facing.x, facing.z);
}

export function findLedgeTraversalClimbCandidate({ level, character, support }) {
  if (!level?.findClimbSurfaceCandidate || !support) {
    return { candidate: null, trace: [], probe: null };
  }

  setSupportVectors(support);
  climbProbePosition
    .copy(character.group.position)
    .addScaledVector(supportNormal, (support.inwardOffset ?? 0.58) + LEDGE_TO_CLIMB_ROOT_OFFSET);

  const probe = {
    x: climbProbePosition.x,
    y: support.y,
    z: climbProbePosition.z,
    yOffsetsTried: [],
  };
  const trace = [];
  let candidate = null;

  // Probe every height even after a hit so the diagnostic trace is complete;
  // the first hit wins (preserves the previous "lowest probe" selection).
  for (const verticalProbe of LEDGE_TO_CLIMB_VERTICAL_PROBES) {
    climbProbePosition.y = support.y + verticalProbe;
    probe.yOffsetsTried.push(verticalProbe);

    const probed = level.findClimbSurfaceCandidate({
      position: climbProbePosition,
      maxFaceDistance: LEDGE_TO_CLIMB_MAX_FACE_DISTANCE,
      minFaceDistance: LEDGE_TO_CLIMB_MIN_FACE_DISTANCE,
      maxEdgeDistance: LEDGE_TO_CLIMB_MAX_EDGE_DISTANCE,
      maxVerticalDistance: LEDGE_TO_CLIMB_MAX_VERTICAL_DISTANCE,
      edgePadding: 0.04,
      verticalPadding: 0.02,
      blockName: support.blockName ?? null,
      face: support.face ?? null,
      normalHint: supportNormal,
      minNormalDot: 0.92,
      minOriginY: support.y - LEDGE_TO_CLIMB_MIN_ORIGIN_DROP,
      minTopY: support.y + LEDGE_TO_CLIMB_MIN_TOP_CLEARANCE,
      trace,
    });

    if (probed && !candidate) {
      candidate = probed;
    }
  }

  return { candidate, trace, probe };
}
