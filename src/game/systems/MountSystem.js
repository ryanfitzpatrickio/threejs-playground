import * as THREE from 'three';
import { HORSE_GROUND_OFFSET } from './HorseSystem.js';

const MOUNT_DISTANCE = 6.5;
const MOUNT_SOCKET_TARGET = 'saddle';
const MOUNT_GRIP_BONE = 'Spine_1';
const RIDER_ANCHOR_BONE = 'mixamorigHips';
const DEFAULT_RIDER_SOCKET = {
  boneName: 'Spine_1',
  offset: new THREE.Vector3(0, 0.1, -0.13),
  rotation: new THREE.Euler(0, 0, 0, 'XYZ'),
};
const DEFAULT_RIDER_GRIP = {
  boneName: MOUNT_GRIP_BONE,
  offset: new THREE.Vector3(0, 0.4, -0.1),
  rotation: new THREE.Euler(0, THREE.MathUtils.degToRad(270), 0, 'XYZ'),
  spacing: 0.12,
};
const DISMOUNT_WORLD_OFFSET = new THREE.Vector3(-1.35, 0, 0.25);
const DEFAULT_GET_ON_SECONDS = 1.35;
const DEFAULT_GET_OFF_SECONDS = 1.15;
const HORSE_WALK_SPEED = 4.8; // 2.4 * 2
const HORSE_RUN_SPEED = 18.6; // 6.2 * 3
const HORSE_REVERSE_SPEED = 2.3; // 1.15 * 2 (walk reverse)
const HORSE_TURN_RATE = 1.65;
const HORSE_RUN_TURN_RATE = 1.15;
const HORSE_TURN_IN_PLACE_RATE = 1.25;
const HORSE_INPUT_DEADZONE = 0.08;
const MOUNT_ENTER_START_YAW = THREE.MathUtils.degToRad(90);
const MOUNT_ENTER_STRAIGHTEN_START = 0.12;
const MOUNT_ENTER_STRAIGHTEN_END = 0.82;
const MOUNT_ENTER_SOCKET_BLEND_START = 0.08;
const MOUNT_ENTER_SOCKET_BLEND_END = 0.78;
const MOUNT_RIDE_SETTLE_SECONDS = 0.32;
const horsePosition = new THREE.Vector3();
const releasePosition = new THREE.Vector3();
const mountedMovement = new THREE.Vector3();
const mountedForward = new THREE.Vector3();
const mountedReleasePosition = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const riderSocketQuaternion = new THREE.Quaternion();
const riderTargetQuaternion = new THREE.Quaternion();
const riderUprightForward = new THREE.Vector3();
const riderUprightRight = new THREE.Vector3();
const riderUprightMatrix = new THREE.Matrix4();
const mountEnterYawQuaternion = new THREE.Quaternion();
const riderGripQuaternion = new THREE.Quaternion();
const riderGripFrameQuaternion = new THREE.Quaternion();
const gripLeftPosition = new THREE.Vector3();
const gripRightPosition = new THREE.Vector3();
const horseRight = new THREE.Vector3();
const horseForward = new THREE.Vector3();
const riderAnchorWorldPosition = new THREE.Vector3();
const riderAnchorOffset = new THREE.Vector3();
const riderAnchoredSocketPosition = new THREE.Vector3();

export class MountSystem {
  constructor() {
    this.state = 'idle';
    this.timer = 0;
    this.duration = 0;
    this.riderSocket = {
      boneName: DEFAULT_RIDER_SOCKET.boneName,
      offset: DEFAULT_RIDER_SOCKET.offset.clone(),
      rotation: DEFAULT_RIDER_SOCKET.rotation.clone(),
    };
    this.riderGrip = {
      boneName: DEFAULT_RIDER_GRIP.boneName,
      offset: DEFAULT_RIDER_GRIP.offset.clone(),
      rotation: DEFAULT_RIDER_GRIP.rotation.clone(),
      spacing: DEFAULT_RIDER_GRIP.spacing,
    };
    this.locomotion = {
      moving: false,
      running: false,
      speed: 0,
      throttle: 0,
      turn: 0,
    };
    this.transition = {
      startPosition: new THREE.Vector3(),
      startQuaternion: new THREE.Quaternion(),
      settleFromPosition: new THREE.Vector3(),
      settleFromQuaternion: new THREE.Quaternion(),
      settleTimer: 0,
      settleDuration: MOUNT_RIDE_SETTLE_SECONDS,
      exitStartPosition: new THREE.Vector3(),
      exitStartQuaternion: new THREE.Quaternion(),
      exitEndPosition: new THREE.Vector3(),
      exitEndQuaternion: new THREE.Quaternion(),
    };
  }

  update({ delta, input, character, horseSystem, level }) {
    if (!character || horseSystem?.status !== 'ready') {
      return;
    }

    if (input.mountPressed) {
      if (this.state === 'idle' && this.canMount({ character, horseSystem })) {
        this.startMount(character);
      } else if (this.state === 'mounted') {
        this.startDismount({ character, horseSystem, level });
      }
    }

    if (this.state === 'idle') {
      horseSystem.setLocomotion?.({ moving: false, running: false, speed: 0 });
      snapHorseToGround(horseSystem, level);
      return;
    }

    this.timer += delta;
    this.updateMountedHorseLocomotion({ delta, input, horseSystem, level });
    this.alignCharacterToHorse({ delta, character, horseSystem });

    if (this.state === 'mounting' && this.timer >= this.duration) {
      this.state = 'mounted';
      this.timer = 0;
      this.transition.settleFromPosition.copy(character.group.position);
      this.transition.settleFromQuaternion.copy(character.group.quaternion);
      this.transition.settleTimer = MOUNT_RIDE_SETTLE_SECONDS;
      character.mount.animationState = 'ridingHorse';
      character.mount.refreshAnchorOffset = true;
      character.animationController?.play?.('ridingHorse', 0.08);
      return;
    }

    if (this.state === 'dismounting' && this.timer >= this.duration) {
      this.finishDismount({ character, horseSystem, level });
    }
  }

  snapshot() {
    return {
      state: this.state,
      timer: Number(this.timer.toFixed(3)),
      duration: Number(this.duration.toFixed(3)),
      riderSocket: riderSocketSnapshot(this.riderSocket),
      riderGrip: riderGripSnapshot(this.riderGrip),
      locomotion: {
        moving: this.locomotion.moving,
        running: this.locomotion.running,
        speed: Number(this.locomotion.speed.toFixed(3)),
        throttle: Number(this.locomotion.throttle.toFixed(3)),
        turn: Number(this.locomotion.turn.toFixed(3)),
      },
    };
  }

  dispose() {
    this.state = 'idle';
    this.timer = 0;
    this.duration = 0;
    this.transition.settleTimer = 0;
  }

  setRiderSocket({ boneName, offset, position, rotation, rotationDegrees } = {}) {
    if (boneName) {
      this.riderSocket.boneName = boneName;
    }

    applyPosition(this.riderSocket.offset, offset ?? position);
    applyRotation(this.riderSocket.rotation, rotationDegrees ?? rotation);

    return this.snapshot();
  }

  adjustRiderSocket({ boneName, offset, position, rotation, rotationDegrees } = {}) {
    if (boneName) {
      this.riderSocket.boneName = boneName;
    }

    applyPositionDelta(this.riderSocket.offset, offset ?? position);
    applyRotationDelta(this.riderSocket.rotation, rotationDegrees ?? rotation);

    return this.snapshot();
  }

  resetRiderSocket() {
    this.riderSocket.boneName = DEFAULT_RIDER_SOCKET.boneName;
    this.riderSocket.offset.copy(DEFAULT_RIDER_SOCKET.offset);
    this.riderSocket.rotation.copy(DEFAULT_RIDER_SOCKET.rotation);
    return this.snapshot();
  }

  setRiderGrip({ boneName, offset, position, rotation, rotationDegrees, spacing } = {}) {
    if (boneName) {
      this.riderGrip.boneName = boneName;
    }

    applyPosition(this.riderGrip.offset, offset ?? position);
    applyRotation(this.riderGrip.rotation, rotationDegrees ?? rotation);
    applySpacing(this.riderGrip, spacing);
    return this.snapshot();
  }

  adjustRiderGrip({ boneName, offset, position, rotation, rotationDegrees, spacing } = {}) {
    if (boneName) {
      this.riderGrip.boneName = boneName;
    }

    applyPositionDelta(this.riderGrip.offset, offset ?? position);
    applyRotationDelta(this.riderGrip.rotation, rotationDegrees ?? rotation);
    applySpacingDelta(this.riderGrip, spacing);
    return this.snapshot();
  }

  resetRiderGrip() {
    this.riderGrip.boneName = DEFAULT_RIDER_GRIP.boneName;
    this.riderGrip.offset.copy(DEFAULT_RIDER_GRIP.offset);
    this.riderGrip.rotation.copy(DEFAULT_RIDER_GRIP.rotation);
    this.riderGrip.spacing = DEFAULT_RIDER_GRIP.spacing;
    return this.snapshot();
  }

  updateMountedHorseLocomotion({ delta, input, horseSystem, level }) {
    if (this.state !== 'mounted' || !horseSystem?.group) {
      this.locomotion.moving = false;
      this.locomotion.running = false;
      this.locomotion.speed = 0;
      this.locomotion.throttle = 0;
      this.locomotion.turn = 0;
      horseSystem?.setLocomotion?.({ moving: false, running: false, speed: 0 });
      return;
    }

    const throttle = Math.abs(input.moveZ) > HORSE_INPUT_DEADZONE ? THREE.MathUtils.clamp(-input.moveZ, -1, 1) : 0;
    const turn = Math.abs(input.moveX) > HORSE_INPUT_DEADZONE ? THREE.MathUtils.clamp(input.moveX, -1, 1) : 0;
    const forward = throttle > HORSE_INPUT_DEADZONE;
    const reverse = throttle < -HORSE_INPUT_DEADZONE;
    const turning = Math.abs(turn) > HORSE_INPUT_DEADZONE;
    const running = forward && input.brace === true;
    const speed = running
      ? HORSE_RUN_SPEED
      : reverse
        ? HORSE_REVERSE_SPEED
        : forward
          ? HORSE_WALK_SPEED
          : 0;
    const turnRate = speed > 0
      ? running ? HORSE_RUN_TURN_RATE : HORSE_TURN_RATE
      : HORSE_TURN_IN_PLACE_RATE;

    if (turning) {
      horseSystem.group.rotation.y -= turn * turnRate * delta;
    }

    if (speed > 0) {
      mountedForward.set(0, 0, 1).applyQuaternion(horseSystem.group.quaternion).setY(0);

      if (mountedForward.lengthSq() > 0.0001) {
        mountedForward.normalize();
        mountedMovement.copy(mountedForward).multiplyScalar(throttle * speed * delta);
        horseSystem.group.position.add(mountedMovement);
      }
    }

    snapHorseToGround(horseSystem, level);

    this.locomotion.moving = speed > 0 || turning;
    this.locomotion.running = running;
    this.locomotion.speed = speed;
    this.locomotion.throttle = throttle;
    this.locomotion.turn = turn;

    horseSystem.setLocomotion?.({
      moving: this.locomotion.moving,
      running,
      speed,
      reverse,
    });
  }

  canMount({ character, horseSystem }) {
    if (!character.grounded) {
      return false;
    }

    horseSystem.group.getWorldPosition(horsePosition);
    return character.group.position.distanceTo(horsePosition) <= MOUNT_DISTANCE;
  }

  startMount(character) {
    this.state = 'mounting';
    this.timer = 0;
    this.duration = character.animationController?.durationFor?.('getOnHorse') ?? DEFAULT_GET_ON_SECONDS;
    this.transition.startPosition.copy(character.group.position);
    this.transition.startQuaternion.copy(character.group.quaternion);
    this.transition.settleTimer = 0;
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.mount = {
      active: true,
      state: this.state,
      animationState: 'getOnHorse',
      socketBone: this.riderSocket.boneName,
      anchorBone: RIDER_ANCHOR_BONE,
      anchorOffset: getRiderAnchorOffset(character),
    };
    character.animationController?.play?.('getOnHorse', 0.08);
  }

  startDismount({ character, horseSystem, level }) {
    this.state = 'dismounting';
    this.timer = 0;
    this.duration = character.animationController?.durationFor?.('getOffHorse') ?? DEFAULT_GET_OFF_SECONDS;
    this.transition.settleTimer = 0;
    this.transition.exitStartPosition.copy(character.group.position);
    this.transition.exitStartQuaternion.copy(character.group.quaternion);
    getDismountReleasePosition({ horseSystem, level, target: this.transition.exitEndPosition });
    this.transition.exitEndQuaternion.copy(character.group.quaternion);
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.mount = {
      active: true,
      state: this.state,
      animationState: 'getOffHorse',
      socketBone: this.riderSocket.boneName,
      anchorBone: RIDER_ANCHOR_BONE,
      anchorOffset: getRiderAnchorOffset(character),
    };
    character.animationController?.play?.('getOffHorse', 0.08);
  }

  alignCharacterToHorse({ delta, character, horseSystem }) {
    const socket = horseSystem.getSocketTransform({
      boneName: this.riderSocket.boneName,
      offset: this.riderSocket.offset,
    });

    if (!socket) {
      return;
    }

    if (character.mount?.refreshAnchorOffset) {
      character.mount.anchorOffset = getRiderAnchorOffset(character);
      character.mount.refreshAnchorOffset = false;
    }

    setUprightRiderTargetQuaternion({
      horseSystem,
      riderSocket: this.riderSocket,
      target: riderTargetQuaternion,
    });

    getAnchoredRiderPosition({
      character,
      socketPosition: socket.position,
      targetQuaternion: riderTargetQuaternion,
      target: riderAnchoredSocketPosition,
    });

    this.applyAlignedRiderTransform({ delta, character, socketPosition: riderAnchoredSocketPosition, targetQuaternion: riderTargetQuaternion });
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;

    if (character.mount) {
      character.mount.state = this.state;
      character.mount.animationState = this.state === 'mounted' ? 'ridingHorse' : character.mount.animationState;
      character.mount.socketBone = this.riderSocket.boneName;
      character.mount.locomotion = {
        moving: this.locomotion.moving,
        running: this.locomotion.running,
        speed: this.locomotion.speed,
        throttle: this.locomotion.throttle,
        turn: this.locomotion.turn,
      };
      this.updateRiderGripTargets({ character, horseSystem });
    }
  }

  applyAlignedRiderTransform({ delta, character, socketPosition, targetQuaternion }) {
    if (this.state === 'mounting' && this.duration > 0) {
      const progress = THREE.MathUtils.clamp(this.timer / this.duration, 0, 1);
      const blend = smoothStep(THREE.MathUtils.clamp(
        (progress - MOUNT_ENTER_SOCKET_BLEND_START) / (MOUNT_ENTER_SOCKET_BLEND_END - MOUNT_ENTER_SOCKET_BLEND_START),
        0,
        1,
      ));

      character.group.position.copy(this.transition.startPosition).lerp(socketPosition, blend);
      character.group.quaternion.copy(this.transition.startQuaternion).slerp(targetQuaternion, blend);
      this.applyMountEnterYaw(character);
      return;
    }

    if (this.state === 'mounted' && this.transition.settleTimer > 0) {
      const remaining = THREE.MathUtils.clamp(this.transition.settleTimer / this.transition.settleDuration, 0, 1);
      const blend = smoothStep(1 - remaining);
      this.transition.settleTimer = Math.max(0, this.transition.settleTimer - delta);
      character.group.position.copy(this.transition.settleFromPosition).lerp(socketPosition, blend);
      character.group.quaternion.copy(this.transition.settleFromQuaternion).slerp(targetQuaternion, blend);
      return;
    }

    if (this.state === 'dismounting' && this.duration > 0) {
      const progress = THREE.MathUtils.clamp(this.timer / this.duration, 0, 1);
      const blend = smoothStep(progress);
      character.group.position.copy(this.transition.exitStartPosition).lerp(this.transition.exitEndPosition, blend);
      character.group.quaternion.copy(this.transition.exitStartQuaternion).slerp(this.transition.exitEndQuaternion, blend);
      return;
    }

    character.group.position.copy(socketPosition);
    character.group.quaternion.copy(targetQuaternion);
  }

  applyMountEnterYaw(character) {
    if (this.state !== 'mounting' || this.duration <= 0) {
      return;
    }

    const progress = THREE.MathUtils.clamp(this.timer / this.duration, 0, 1);
    const straightenAlpha = smoothStep(THREE.MathUtils.clamp(
      (progress - MOUNT_ENTER_STRAIGHTEN_START) / (MOUNT_ENTER_STRAIGHTEN_END - MOUNT_ENTER_STRAIGHTEN_START),
      0,
      1,
    ));
    const yaw = THREE.MathUtils.lerp(MOUNT_ENTER_START_YAW, 0, straightenAlpha);
    mountEnterYawQuaternion.setFromAxisAngle(worldUp, yaw);
    character.group.quaternion.multiply(mountEnterYawQuaternion);
  }

  updateRiderGripTargets({ character, horseSystem }) {
    const gripSocket = horseSystem.getSocketTransform({
      boneName: this.riderGrip.boneName,
      offset: this.riderGrip.offset,
    });

    if (!gripSocket) {
      character.mount.handTargets = null;
      return;
    }

    riderGripQuaternion.setFromEuler(this.riderGrip.rotation);
    riderGripFrameQuaternion.copy(horseSystem.group.quaternion).multiply(riderGripQuaternion);
    horseRight.set(1, 0, 0).applyQuaternion(riderGripFrameQuaternion).normalize();
    horseForward.set(0, 0, -1).applyQuaternion(riderGripFrameQuaternion).normalize();
    gripLeftPosition.copy(gripSocket.position).addScaledVector(horseRight, -this.riderGrip.spacing * 0.5);
    gripRightPosition.copy(gripSocket.position).addScaledVector(horseRight, this.riderGrip.spacing * 0.5);

    character.mount.handTargets = {
      center: gripSocket.position.clone(),
      left: gripLeftPosition.clone(),
      right: gripRightPosition.clone(),
      tangent: horseRight.clone(),
      normal: horseForward.clone(),
    };
    character.mount.gripBone = this.riderGrip.boneName;
    character.mount.gripSpacing = this.riderGrip.spacing;
  }

  finishDismount({ character, horseSystem, level }) {
    getDismountReleasePosition({ horseSystem, level, target: releasePosition });
    character.group.position.copy(releasePosition);
    character.group.rotation.set(0, horseSystem.group.rotation.y, 0);
    character.velocity?.set(0, 0, 0);
    character.verticalVelocity = 0;
    character.grounded = true;
    character.mount = null;
    horseSystem.setLocomotion?.({ moving: false, running: false, speed: 0 });
    this.state = 'idle';
    this.timer = 0;
    this.duration = 0;
    character.animationController?.play?.('idle', 0.12);
  }
}

function snapHorseToGround(horseSystem, level) {
  const ground = level?.getGroundHeightAt?.(horseSystem.group.position, 0.7, {
    maxStepUp: 0.65,
    maxSnapDown: 8,
    requiredInset: 0.12,
  });
  if (Number.isFinite(ground)) {
    horseSystem.group.position.y = ground + (horseSystem.groundOffset ?? HORSE_GROUND_OFFSET);
  }
}

function getDismountReleasePosition({ horseSystem, level, target }) {
  horseSystem.group.getWorldPosition(horsePosition);
  target.copy(DISMOUNT_WORLD_OFFSET).applyQuaternion(horseSystem.group.quaternion).add(horsePosition);

  const ground = level?.getGroundHeightAt?.(target, 0.5);
  if (Number.isFinite(ground)) {
    target.y = ground;
  }

  return target;
}

function applyPosition(target, source) {
  if (!source) {
    return;
  }

  target.set(
    Number.isFinite(source.x) ? source.x : target.x,
    Number.isFinite(source.y) ? source.y : target.y,
    Number.isFinite(source.z) ? source.z : target.z,
  );
}

function applyPositionDelta(target, source) {
  if (!source) {
    return;
  }

  if (Number.isFinite(source.x)) target.x += source.x;
  if (Number.isFinite(source.y)) target.y += source.y;
  if (Number.isFinite(source.z)) target.z += source.z;
}

function applySpacing(target, source) {
  if (Number.isFinite(source)) {
    target.spacing = Math.max(0, source);
  }
}

function applySpacingDelta(target, source) {
  if (Number.isFinite(source)) {
    target.spacing = Math.max(0, target.spacing + source);
  }
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

function setUprightRiderTargetQuaternion({ horseSystem, riderSocket, target }) {
  riderUprightForward.set(0, 0, 1).applyQuaternion(horseSystem.group.quaternion).setY(0);

  if (riderUprightForward.lengthSq() <= 0.0001) {
    riderUprightForward.set(0, 0, 1);
  } else {
    riderUprightForward.normalize();
  }

  riderUprightRight.crossVectors(worldUp, riderUprightForward);
  if (riderUprightRight.lengthSq() <= 0.0001) {
    riderUprightRight.set(1, 0, 0);
  } else {
    riderUprightRight.normalize();
  }

  riderUprightForward.crossVectors(riderUprightRight, worldUp).normalize();
  riderUprightMatrix.makeBasis(riderUprightRight, worldUp, riderUprightForward);
  target.setFromRotationMatrix(riderUprightMatrix);

  riderSocketQuaternion.setFromAxisAngle(worldUp, riderSocket.rotation.y);
  target.multiply(riderSocketQuaternion).normalize();
}

function getRiderAnchorOffset(character) {
  const anchorBone = character.group.getObjectByName(RIDER_ANCHOR_BONE);

  if (!anchorBone) {
    return new THREE.Vector3();
  }

  character.group.updateWorldMatrix(true, true);
  anchorBone.getWorldPosition(riderAnchorWorldPosition);
  riderAnchorOffset.copy(riderAnchorWorldPosition);
  character.group.worldToLocal(riderAnchorOffset);

  return riderAnchorOffset.clone();
}

function getAnchoredRiderPosition({ character, socketPosition, targetQuaternion, target }) {
  const anchorOffset = character.mount?.anchorOffset;

  if (!anchorOffset) {
    return target.copy(socketPosition);
  }

  riderAnchorOffset.copy(anchorOffset).applyQuaternion(targetQuaternion);
  return target.copy(socketPosition).sub(riderAnchorOffset);
}

function applyRotation(target, source) {
  if (!source) {
    return;
  }

  target.set(
    Number.isFinite(source.x) ? THREE.MathUtils.degToRad(source.x) : target.x,
    Number.isFinite(source.y) ? THREE.MathUtils.degToRad(source.y) : target.y,
    Number.isFinite(source.z) ? THREE.MathUtils.degToRad(source.z) : target.z,
    target.order,
  );
}

function applyRotationDelta(target, source) {
  if (!source) {
    return;
  }

  if (Number.isFinite(source.x)) target.x += THREE.MathUtils.degToRad(source.x);
  if (Number.isFinite(source.y)) target.y += THREE.MathUtils.degToRad(source.y);
  if (Number.isFinite(source.z)) target.z += THREE.MathUtils.degToRad(source.z);
}

function riderSocketSnapshot(socket) {
  return {
    boneName: socket.boneName,
    offset: {
      x: Number(socket.offset.x.toFixed(4)),
      y: Number(socket.offset.y.toFixed(4)),
      z: Number(socket.offset.z.toFixed(4)),
    },
    rotationDegrees: {
      x: Number(THREE.MathUtils.radToDeg(socket.rotation.x).toFixed(2)),
      y: Number(THREE.MathUtils.radToDeg(socket.rotation.y).toFixed(2)),
      z: Number(THREE.MathUtils.radToDeg(socket.rotation.z).toFixed(2)),
    },
  };
}

function riderGripSnapshot(grip) {
  return {
    boneName: grip.boneName,
    offset: {
      x: Number(grip.offset.x.toFixed(4)),
      y: Number(grip.offset.y.toFixed(4)),
      z: Number(grip.offset.z.toFixed(4)),
    },
    rotationDegrees: {
      x: Number(THREE.MathUtils.radToDeg(grip.rotation.x).toFixed(2)),
      y: Number(THREE.MathUtils.radToDeg(grip.rotation.y).toFixed(2)),
      z: Number(THREE.MathUtils.radToDeg(grip.rotation.z).toFixed(2)),
    },
    spacing: Number(grip.spacing.toFixed(4)),
  };
}
