import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { TraversalActionSystem } from './TraversalActionSystem.js';

const RUN_VAULT_STATES = ['runVault', 'runButtVault'];
const PLAYER_HEIGHT = GAME_CONFIG.character.collisionHeight;
const QUARTER_HEIGHT = PLAYER_HEIGHT * 0.25;
const MAX_VAULT_HEIGHT = PLAYER_HEIGHT * 0.67;
const MIN_VAULT_HEIGHT = PLAYER_HEIGHT * 0.58;
const VAULT_SCAN_DISTANCE = 1.15;
const VAULT_LANDING_CLEARANCE = 0.62;
const VAULT_LATERAL_PADDING = 0.34;
const MAX_SHALLOW_DEPTH = 0.95;
const IDLE_SMALL_SPEED = 2.6;
const VAULT_COOLDOWN_SECONDS = 0.35;
const MIN_FACE_ON_DOT = 0.68;
const VAULT_HAND_SPACING = 0.32;
const VAULT_HAND_NARROW_SPACING = 0.16;
const VAULT_HAND_MID_SPACING = 0.24;
const VAULT_HAND_FORWARD_OFFSET = 0.08;
const VAULT_HAND_Y_OFFSET = 0.055;

const vaultDirection = new THREE.Vector3();
const vaultTarget = new THREE.Vector3();
const vaultFacing = new THREE.Vector3();
const vaultApproachDirection = new THREE.Vector3();
const vaultFinishDelta = new THREE.Vector3();
const vaultHandCenter = new THREE.Vector3();
const vaultHandTangent = new THREE.Vector3();

export class VaultSystem {
  constructor() {
    this.traversalActionSystem = new TraversalActionSystem();
    this.lastVault = null;
  }

  update({ delta, input, movement, character, level }) {
    character.vaultCooldown = Math.max(0, (character.vaultCooldown ?? 0) - delta);

    if (character.vault?.active) {
      return this.updateActiveVault({ delta, movement, character });
    }

    if (!canStartVault({ input, movement, character })) {
      return movement;
    }

    const candidate = findVaultCandidate({
      level: level.level,
      character,
      movement,
    });

    if (!candidate) {
      return movement;
    }

    this.startVault({ character, candidate, movement });
    return this.overrideMovement({ movement, character });
  }

  startVault({ character, candidate, movement }) {
    const animationState = resolveVaultAnimation({ candidate, movement });
    const action = this.traversalActionSystem.start({
      character,
      type: 'vault',
      animationState,
      targetPosition: candidate.targetPosition,
      duration: animationState === 'idleSmallVault' ? 2.45 : 1.16,
      exitProgress: animationState === 'idleSmallVault' ? 0.96 : 0.92,
      motionWarp: false,
    });

    character.vault = {
      active: true,
      animationState,
      candidate,
      action,
      timer: action.duration,
      handTargets: {
        center: new THREE.Vector3(),
        innerLeft: new THREE.Vector3(),
        innerRight: new THREE.Vector3(),
        midLeft: new THREE.Vector3(),
        midRight: new THREE.Vector3(),
        left: new THREE.Vector3(),
        right: new THREE.Vector3(),
      },
    };
    updateVaultHandTargets(character.vault);
    character.grounded = false;
    character.verticalVelocity = 0;
    character.velocity.copy(candidate.direction).multiplyScalar(GAME_CONFIG.character.jogSpeed);
    character.group.rotation.y = Math.atan2(candidate.direction.x, candidate.direction.z);
    this.lastVault = vaultSnapshot({ character });
  }

  updateActiveVault({ delta, movement, character }) {
    const vault = character.vault;
    const action = this.traversalActionSystem.update({ character, delta });

    if (!action || this.traversalActionSystem.canFinish(action)) {
      this.finishVault(character);
      return {
        ...movement,
        vaulting: false,
        vaultState: null,
        grounded: character.grounded,
        airborne: !character.grounded,
        height: character.group.position.y,
        verticalVelocity: character.verticalVelocity,
      };
    }

    vault.action = action;
    vault.timer = Math.max(0, action.duration - action.elapsed);
    updateVaultHandTargets(vault);
    this.lastVault = vaultSnapshot({ character });

    return this.overrideMovement({ movement, character });
  }

  finishVault(character) {
    const vault = character.vault;
    const finishedAction = this.traversalActionSystem.finish(character);
    const targetPosition = vault?.candidate?.targetPosition;

    if (targetPosition && vault?.candidate?.direction && vault?.action?.startPosition) {
      resolveVaultFinishPosition({ character, vault, targetPosition });
    }

    character.verticalVelocity = 0;
    character.grounded = true;
    character.traversalRecoveryTimer = finishedAction?.recoverySeconds ?? 0.12;
    character.vaultCooldown = VAULT_COOLDOWN_SECONDS;
    character.vault = null;
    this.lastVault = null;
  }

  overrideMovement({ movement, character }) {
    return {
      ...movement,
      moving: false,
      wantsMove: false,
      speed: 0,
      grounded: false,
      airborne: false,
      vaulting: true,
      vaultState: character.vault?.animationState ?? 'runVault',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }

  snapshot(character) {
    return character?.vault?.active
      ? vaultSnapshot({ character })
      : this.lastVault;
  }

  dispose() {
    this.lastVault = null;
  }
}

function updateVaultHandTargets(vault) {
  const collider = vault?.candidate?.collider;
  const direction = vault?.candidate?.direction;
  const handTargets = vault?.handTargets;

  if (
    !collider
    || !direction
    || !handTargets?.center
    || !handTargets?.innerLeft
    || !handTargets?.innerRight
    || !handTargets?.midLeft
    || !handTargets?.midRight
    || !handTargets?.left
    || !handTargets?.right
  ) {
    return;
  }

  vaultHandCenter.set(
    (collider.minX + collider.maxX) * 0.5,
    collider.topY + VAULT_HAND_Y_OFFSET,
    (collider.minZ + collider.maxZ) * 0.5,
  );

  if (Math.abs(direction.x) > Math.abs(direction.z)) {
    vaultHandCenter.x = direction.x > 0
      ? collider.minX + VAULT_HAND_FORWARD_OFFSET
      : collider.maxX - VAULT_HAND_FORWARD_OFFSET;
  } else {
    vaultHandCenter.z = direction.z > 0
      ? collider.minZ + VAULT_HAND_FORWARD_OFFSET
      : collider.maxZ - VAULT_HAND_FORWARD_OFFSET;
  }

  vaultHandTangent.set(direction.z, 0, -direction.x);
  if (vaultHandTangent.lengthSq() <= 0.0001) {
    vaultHandTangent.set(1, 0, 0);
  } else {
    vaultHandTangent.normalize();
  }

  handTargets.left
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, -VAULT_HAND_SPACING);
  handTargets.right
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, VAULT_HAND_SPACING);
  handTargets.innerLeft
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, -VAULT_HAND_NARROW_SPACING);
  handTargets.innerRight
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, VAULT_HAND_NARROW_SPACING);
  handTargets.midLeft
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, -VAULT_HAND_MID_SPACING);
  handTargets.midRight
    .copy(vaultHandCenter)
    .addScaledVector(vaultHandTangent, VAULT_HAND_MID_SPACING);
  handTargets.center.copy(vaultHandCenter);
}

function canStartVault({ input, movement, character }) {
  return character.grounded === true
    && !movement.airborne
    && !input.brace
    && !input.jumpPressed
    && movement.wantsMove
    && (character.vaultCooldown ?? 0) <= 0
    && !character.hang?.active
    && !character.wallRun?.active
    && !character.wallClimb?.active
    && !character.rope?.active
    && !character.slide?.active;
}

function findVaultCandidate({ level, character, movement }) {
  const colliders = level?.colliders ?? [];
  vaultDirection.copy(movement.direction ?? character.velocity);

  if (vaultDirection.lengthSq() <= 0.0001) {
    return null;
  }

  vaultDirection.setY(0).normalize();
  const origin = character.group.position;
  const groundY = level?.getGroundHeightAt?.(origin, GAME_CONFIG.character.footRadius) ?? origin.y;
  let best = null;

  for (const collider of colliders) {
    const obstacleHeight = collider.topY - groundY;

    if (obstacleHeight < MIN_VAULT_HEIGHT || obstacleHeight > MAX_VAULT_HEIGHT + 0.04) {
      continue;
    }

    const depthAlongDirection = colliderDepthAlongDirection({ collider, direction: vaultDirection });

    if (depthAlongDirection > MAX_SHALLOW_DEPTH && !collider.vaultable) {
      continue;
    }

    const approach = resolveFaceOnApproach({
      collider,
      direction: vaultDirection,
    });

    if (!approach) {
      continue;
    }

    const hit = raycastCollider2D({
      origin,
      direction: vaultDirection,
      collider,
      padding: VAULT_LATERAL_PADDING,
      maxDistance: VAULT_SCAN_DISTANCE,
    });

    if (!hit) {
      continue;
    }

    const straightHit = raycastCollider2D({
      origin,
      direction: approach.direction,
      collider,
      padding: VAULT_LATERAL_PADDING,
      maxDistance: VAULT_SCAN_DISTANCE + 0.45,
    }) ?? hit;
    const landingDistance = straightHit.exitDistance + VAULT_LANDING_CLEARANCE;
    vaultTarget
      .copy(origin)
      .addScaledVector(approach.direction, landingDistance);
    vaultTarget.y = level?.getGroundHeightAt?.(vaultTarget, GAME_CONFIG.character.footRadius, {
      maxStepUp: MAX_VAULT_HEIGHT + 0.12,
      maxSnapDown: MAX_VAULT_HEIGHT + 0.35,
      requiredInset: GAME_CONFIG.character.footRadius * 0.4,
    }) ?? groundY;

    const score = hit.entryDistance + obstacleHeight * 0.2;

    if (!best || score < best.score) {
      best = {
        collider,
        obstacleHeight,
        targetPosition: vaultTarget.clone(),
        direction: approach.direction.clone(),
        entryDistance: hit.entryDistance,
        score: score - approach.dot * 0.12,
        approachDot: approach.dot,
        small: obstacleHeight <= QUARTER_HEIGHT + 0.05,
      };
    }
  }

  return best;
}

function resolveVaultAnimation({ candidate, movement }) {
  if (candidate.small && movement.speed < IDLE_SMALL_SPEED) {
    return 'idleSmallVault';
  }

  return RUN_VAULT_STATES[Math.floor(Math.random() * RUN_VAULT_STATES.length)];
}

function resolveVaultFinishPosition({ character, vault, targetPosition }) {
  const direction = vault.candidate.direction;
  const startPosition = vault.action.startPosition;
  const requiredDistance = vaultFinishDelta
    .subVectors(targetPosition, startPosition)
    .dot(direction);
  const currentDistance = vaultFinishDelta
    .subVectors(character.group.position, startPosition)
    .dot(direction);

  if (currentDistance < requiredDistance) {
    character.group.position.addScaledVector(direction, requiredDistance - currentDistance);
  }

  character.group.position.y = targetPosition.y;
}

function raycastCollider2D({ origin, direction, collider, padding, maxDistance }) {
  const minX = collider.minX - padding;
  const maxX = collider.maxX + padding;
  const minZ = collider.minZ - padding;
  const maxZ = collider.maxZ + padding;
  const xRange = slabRange({
    origin: origin.x,
    direction: direction.x,
    min: minX,
    max: maxX,
  });
  const zRange = slabRange({
    origin: origin.z,
    direction: direction.z,
    min: minZ,
    max: maxZ,
  });

  if (!xRange || !zRange) {
    return null;
  }

  const entryDistance = Math.max(xRange.enter, zRange.enter, 0);
  const exitDistance = Math.min(xRange.exit, zRange.exit);

  if (exitDistance < 0 || entryDistance > exitDistance || entryDistance > maxDistance) {
    return null;
  }

  return { entryDistance, exitDistance };
}

function slabRange({ origin, direction, min, max }) {
  if (Math.abs(direction) <= 0.0001) {
    return origin >= min && origin <= max
      ? { enter: -Infinity, exit: Infinity }
      : null;
  }

  const a = (min - origin) / direction;
  const b = (max - origin) / direction;

  return {
    enter: Math.min(a, b),
    exit: Math.max(a, b),
  };
}

function colliderDepthAlongDirection({ collider, direction }) {
  const width = collider.width ?? collider.maxX - collider.minX;
  const depth = collider.depth ?? collider.maxZ - collider.minZ;

  return Math.abs(direction.x) * width + Math.abs(direction.z) * depth;
}

function resolveFaceOnApproach({ collider, direction }) {
  const width = collider.width ?? collider.maxX - collider.minX;
  const depth = collider.depth ?? collider.maxZ - collider.minZ;
  const normalAxis = depth <= width ? 'z' : 'x';
  const dot = normalAxis === 'z'
    ? Math.abs(direction.z)
    : Math.abs(direction.x);

  if (dot < MIN_FACE_ON_DOT) {
    return null;
  }

  vaultApproachDirection.set(0, 0, 0);

  if (normalAxis === 'z') {
    vaultApproachDirection.z = Math.sign(direction.z) || -1;
  } else {
    vaultApproachDirection.x = Math.sign(direction.x) || 1;
  }

  return {
    direction: vaultApproachDirection.clone(),
    dot,
  };
}

function vaultSnapshot({ character }) {
  const vault = character.vault;

  if (!vault) {
    return null;
  }

  vaultFacing.copy(vault.candidate?.direction ?? { x: 0, y: 0, z: -1 });

  return {
    active: vault.active === true,
    state: vault.animationState,
    obstacle: vault.candidate?.collider?.name ?? null,
    progress: Number((vault.action?.progress ?? 0).toFixed(3)),
    target: vault.candidate?.targetPosition
      ? {
          x: Number(vault.candidate.targetPosition.x.toFixed(3)),
          y: Number(vault.candidate.targetPosition.y.toFixed(3)),
          z: Number(vault.candidate.targetPosition.z.toFixed(3)),
        }
      : null,
    direction: {
      x: Number(vaultFacing.x.toFixed(3)),
      z: Number(vaultFacing.z.toFixed(3)),
    },
    handTargets: vault.handTargets
        ? {
          center: vectorSnapshot(vault.handTargets.center),
          innerLeft: vectorSnapshot(vault.handTargets.innerLeft),
          innerRight: vectorSnapshot(vault.handTargets.innerRight),
          midLeft: vectorSnapshot(vault.handTargets.midLeft),
          midRight: vectorSnapshot(vault.handTargets.midRight),
          left: vectorSnapshot(vault.handTargets.left),
          right: vectorSnapshot(vault.handTargets.right),
        }
      : null,
  };
}

function vectorSnapshot(vector) {
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}
