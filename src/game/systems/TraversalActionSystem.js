import * as THREE from 'three';
import { getTraversalActionDefinition } from './TraversalActionDefinitions.js';

const warpedPosition = new THREE.Vector3();
const actionRootMotionMovement = new THREE.Vector3();
const actionRootMotionTotal = new THREE.Vector3();
const actionRootMotionTargetDelta = new THREE.Vector3();
const actionRootMotionScale = new THREE.Vector3();
const facing = new THREE.Vector3();
const ledgeClimbNormal = new THREE.Vector3();
const ledgeClimbDelta = new THREE.Vector3();
const ledgeClimbParallelDelta = new THREE.Vector3();

export class TraversalActionSystem {
  start({
    character,
    type,
    animationState,
    targetPosition,
    context = {},
    duration,
    exitProgress,
    motionWarp,
  }) {
    const definition = getTraversalActionDefinition(type);

    if (!definition) {
      throw new Error(`Unknown traversal action: ${type}`);
    }

    const resolvedDuration = duration ?? definition.duration;

    const action = {
      type,
      animationState,
      drive: definition.drive,
      elapsed: 0,
      duration: resolvedDuration,
      maxDuration: resolvedDuration * 1.25,
      exitProgress: exitProgress ?? definition.exitProgress,
      recoverySeconds: definition.recoverySeconds ?? 0,
      progress: 0,
      startPosition: character.group.position.clone(),
      targetPosition: targetPosition?.clone?.() ?? null,
      motionWarp: motionWarp === false ? null : motionWarp ?? definition.motionWarp ?? null,
      context,
    };

    character.traversalAction = action;
    return action;
  }

  update({ character, delta }) {
    const action = character.traversalAction;

    if (!action) {
      return null;
    }

    const rootMotion = character.animationController?.sampleRootMotionDelta?.(delta);
    action.elapsed += delta;
    action.progress = Math.max(
      action.progress,
      this.resolveActionProgress({ character, action, rootMotion }),
    );

    this.applyActionRootMotion({ character, action, rootMotion });
    this.applyActionMotion({ character, action });
    this.applyActionFacing({ character, action });

    character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;

    return action;
  }

  canFinish(action) {
    if (!action) {
      return true;
    }

    return action.progress >= action.exitProgress || action.elapsed >= action.maxDuration;
  }

  finish(character) {
    const action = character.traversalAction ?? null;
    character.traversalAction = null;
    return action;
  }

  snapshot(character) {
    const action = character?.traversalAction;

    if (!action) {
      return null;
    }

    return {
      type: action.type,
      animationState: action.animationState,
      drive: action.drive,
      elapsed: Number(action.elapsed.toFixed(3)),
      progress: Number(action.progress.toFixed(3)),
      warpAlpha: action.motionWarp
        ? Number(resolveMotionWarpAlpha({
            progress: action.progress,
            motionWarp: action.motionWarp,
          }).toFixed(3))
        : null,
      exitProgress: Number(action.exitProgress.toFixed(3)),
    };
  }

  resolveActionProgress({ character, action, rootMotion }) {
    const controller = character.animationController;
    const controllerState = controller?.currentState;
    const animationProgress = controller?.getCurrentActionNormalizedTime?.() ?? 0;

    if (controllerState === action.animationState && (!action.drive || rootMotion?.drive === action.drive)) {
      return Math.max(
        action.progress,
        rootMotion?.normalizedEndTime ?? animationProgress,
      );
    }

    return action.progress;
  }

  applyActionMotion({ character, action }) {
    if (!action.motionWarp || !action.targetPosition) {
      return;
    }

    if (action.motionWarp.position !== 'startToTarget') {
      return;
    }

    const alpha = resolveMotionWarpAlpha({
      progress: action.progress,
      motionWarp: action.motionWarp,
    });

    action.warpAlpha = alpha;
    if (action.motionWarp.curve === 'attachArc') {
      applyAttachArcPosition({
        start: action.startPosition,
        target: action.targetPosition,
        alpha,
        arcHeight: action.context?.attachArcHeight,
        output: warpedPosition,
      });
    } else if (action.motionWarp.curve === 'ledgeClimb') {
      applyLedgeClimbPosition({
        start: action.startPosition,
        target: action.targetPosition,
        progress: action.progress,
        motionWarp: action.motionWarp,
        ledge: action.context?.ledge,
        output: warpedPosition,
      });
    } else if (action.motionWarp.curve === 'ledgeClimbDown') {
      applyLedgeClimbDownPosition({
        start: action.startPosition,
        target: action.targetPosition,
        progress: action.progress,
        motionWarp: action.motionWarp,
        ledge: action.context?.ledge,
        output: warpedPosition,
      });
    } else if (action.motionWarp.curve === 'vaultArc') {
      applyVaultArcPosition({
        start: action.startPosition,
        target: action.targetPosition,
        alpha,
        obstacleTopY: action.context?.obstacleTopY,
        output: warpedPosition,
      });
    } else {
      warpedPosition.lerpVectors(action.startPosition, action.targetPosition, alpha);
    }

    character.group.position.copy(warpedPosition);
  }

  applyActionRootMotion({ character, action, rootMotion }) {
    if (action.motionWarp || !action.drive || rootMotion?.drive !== action.drive) {
      return;
    }

    actionRootMotionMovement.copy(rootMotion.delta).applyQuaternion(character.group.quaternion);
    if (action.context?.matchRootMotionToTarget === true && action.targetPosition) {
      scaleRootMotionToTarget({
        character,
        action,
        rootMotion,
        movement: actionRootMotionMovement,
      });
    }

    character.group.position.add(actionRootMotionMovement);
    character.lastRootMotion = rootMotionSnapshot({
      rootMotion,
      applied: actionRootMotionMovement,
      mode: action.type,
    });
  }

  applyActionFacing({ character, action }) {
    const ledge = action.context?.ledge;

    if (!ledge?.normal) {
      return;
    }

    facing.set(-ledge.normal.x, 0, -ledge.normal.z);
    character.group.rotation.y = Math.atan2(facing.x, facing.z);
  }
}

function smoothStep(value) {
  const alpha = THREE.MathUtils.clamp(value, 0, 1);
  return alpha * alpha * (3 - 2 * alpha);
}

function rootMotionSnapshot({ rootMotion, applied, mode }) {
  return {
    mode,
    drive: rootMotion.drive ?? 'raw',
    blend: Number((rootMotion.blend ?? 0).toFixed(3)),
    raw: {
      x: Number(rootMotion.delta.x.toFixed(4)),
      y: Number(rootMotion.delta.y.toFixed(4)),
      z: Number(rootMotion.delta.z.toFixed(4)),
    },
    applied: {
      x: Number(applied.x.toFixed(4)),
      y: Number(applied.y.toFixed(4)),
      z: Number(applied.z.toFixed(4)),
    },
  };
}

function scaleRootMotionToTarget({ character, action, rootMotion, movement }) {
  actionRootMotionTotal.copy(rootMotion.totalDelta).applyQuaternion(character.group.quaternion);
  actionRootMotionTargetDelta.subVectors(action.targetPosition, action.startPosition);

  actionRootMotionScale.set(
    resolveAxisScale(actionRootMotionTargetDelta.x, actionRootMotionTotal.x),
    resolveAxisScale(actionRootMotionTargetDelta.y, actionRootMotionTotal.y),
    resolveAxisScale(actionRootMotionTargetDelta.z, actionRootMotionTotal.z),
  );

  movement.x *= actionRootMotionScale.x;
  movement.y *= actionRootMotionScale.y;
  movement.z *= actionRootMotionScale.z;
}

function resolveAxisScale(targetDelta, rootMotionDelta) {
  if (Math.abs(rootMotionDelta) <= 0.00001) {
    return Math.abs(targetDelta) <= 0.00001 ? 1 : 0;
  }

  return targetDelta / rootMotionDelta;
}

function applyAttachArcPosition({ start, target, alpha, arcHeight, output }) {
  output.lerpVectors(start, target, alpha);

  const resolvedArcHeight = Number.isFinite(arcHeight)
    ? arcHeight
    : computeAttachArcHeight(start, target);

  output.y += Math.sin(alpha * Math.PI) * resolvedArcHeight;
}

function applyVaultArcPosition({ start, target, alpha, obstacleTopY, output }) {
  output.lerpVectors(start, target, alpha);

  const clearance = Number.isFinite(obstacleTopY)
    ? Math.max(0, obstacleTopY - Math.min(start.y, target.y)) + 0.24
    : 0.42;

  output.y += Math.sin(alpha * Math.PI) * THREE.MathUtils.clamp(clearance, 0.32, 0.88);
}

function applyLedgeClimbPosition({ start, target, progress, motionWarp, ledge, output }) {
  if (!ledge?.normal) {
    output.lerpVectors(start, target, resolveMotionWarpAlpha({ progress, motionWarp }));
    return;
  }

  ledgeClimbNormal.set(ledge.normal.x, 0, ledge.normal.z);

  if (ledgeClimbNormal.lengthSq() <= 0.000001) {
    output.lerpVectors(start, target, resolveMotionWarpAlpha({ progress, motionWarp }));
    return;
  }

  ledgeClimbNormal.normalize();
  ledgeClimbDelta.subVectors(target, start);
  const normalDelta = ledgeClimbDelta.dot(ledgeClimbNormal);
  ledgeClimbParallelDelta
    .copy(ledgeClimbDelta)
    .addScaledVector(ledgeClimbNormal, -normalDelta);

  const verticalAlpha = smoothStepWindow({
    progress,
    start: motionWarp.verticalStartProgress ?? 0,
    end: motionWarp.verticalEndProgress ?? 0.72,
  });
  const inwardAlpha = smoothStepWindow({
    progress,
    start: motionWarp.inwardStartProgress ?? 0.68,
    end: motionWarp.inwardEndProgress ?? 0.98,
  });

  output
    .copy(start)
    .addScaledVector(ledgeClimbParallelDelta, verticalAlpha)
    .addScaledVector(ledgeClimbNormal, normalDelta * inwardAlpha);
}

function applyLedgeClimbDownPosition({ start, target, progress, motionWarp, ledge, output }) {
  if (!ledge?.normal) {
    output.lerpVectors(start, target, resolveMotionWarpAlpha({ progress, motionWarp }));
    return;
  }

  ledgeClimbNormal.set(ledge.normal.x, 0, ledge.normal.z);

  if (ledgeClimbNormal.lengthSq() <= 0.000001) {
    output.lerpVectors(start, target, resolveMotionWarpAlpha({ progress, motionWarp }));
    return;
  }

  ledgeClimbNormal.normalize();
  ledgeClimbDelta.subVectors(target, start);
  const normalDelta = ledgeClimbDelta.dot(ledgeClimbNormal);
  ledgeClimbParallelDelta
    .copy(ledgeClimbDelta)
    .addScaledVector(ledgeClimbNormal, -normalDelta);

  const outwardAlpha = smoothStepWindow({
    progress,
    start: motionWarp.outwardStartProgress ?? 0.04,
    end: motionWarp.outwardEndProgress ?? 0.36,
  });
  const dropAlpha = smoothStepWindow({
    progress,
    start: motionWarp.dropStartProgress ?? 0.34,
    end: motionWarp.dropEndProgress ?? 0.98,
  });

  output
    .copy(start)
    .addScaledVector(ledgeClimbNormal, normalDelta * outwardAlpha)
    .addScaledVector(ledgeClimbParallelDelta, dropAlpha);
}

function computeAttachArcHeight(start, target) {
  const horizontal = Math.hypot(target.x - start.x, target.z - start.z);
  const verticalDrop = start.y - target.y;

  return THREE.MathUtils.clamp(
    horizontal * 0.24 + Math.max(0, verticalDrop) * 0.42 + 0.16,
    0.18,
    0.82,
  );
}

function resolveMotionWarpAlpha({ progress, motionWarp }) {
  const start = motionWarp.startProgress ?? 0;
  const end = motionWarp.endProgress ?? 1;
  const windowedProgress = THREE.MathUtils.clamp((progress - start) / (end - start || 1), 0, 1);

  if (motionWarp.curve === 'smoothStep' || motionWarp.curve === 'attachArc') {
    return smoothStep(windowedProgress);
  }

  return windowedProgress;
}

function smoothStepWindow({ progress, start, end }) {
  return smoothStep(THREE.MathUtils.clamp((progress - start) / (end - start || 1), 0, 1));
}
