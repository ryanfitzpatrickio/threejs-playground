import * as THREE from 'three';

const DOOR_PATTERN = /(driver.*door|door.*driver|^door$)/i;
const STEERING_PATTERN = /steering[_ ]wheel|wheel.*steering|^steering$/i;
const DRIVER_WINDOW_PATTERN = /window.*driver|driver.*window/i;

function findNamedObject(rootObject, pattern) {
  let match = null;
  rootObject.traverse((child) => {
    if (!match && child.name && pattern.test(child.name)) {
      match = child;
    }
  });
  return match;
}

function findDoorObject(rootObject) {
  let match = null;
  rootObject.traverse((child) => {
    if (match || !child.name) return;
    if ((child.isMesh || child.children.length > 0) && DOOR_PATTERN.test(child.name)) {
      match = child;
    }
  });
  return match;
}

export function createAuthoredDoorRig(rootObject) {
  rootObject.updateMatrixWorld(true);
  const hinge =
    rootObject.getObjectByName('Locator_Door_Hinge')
    || findNamedObject(rootObject, /locator.*door.*hinge|door.*hinge|hinge.*door/i);
  const door = findDoorObject(rootObject);
  const driverWindow = findNamedObject(rootObject, DRIVER_WINDOW_PATTERN);

  if (!hinge || !door || !door.parent) return null;

  const originalParent = door.parent;
  const pivot = new THREE.Group();
  pivot.name = 'door-hinge-pivot';
  pivot.position.copy(originalParent.worldToLocal(hinge.getWorldPosition(new THREE.Vector3())));
  originalParent.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(door);
  if (driverWindow) pivot.attach(driverWindow);
  pivot.userData.closedQuaternion = pivot.quaternion.clone();

  const hingeWorld = hinge.getWorldPosition(new THREE.Vector3());
  const doorWorldCenter = door.getWorldPosition(new THREE.Vector3());
  const openDirection = doorWorldCenter.x < hingeWorld.x ? -1 : 1;

  return {
    pivot,
    openDirection,
    maxAngle: Math.PI * 0.5,
    angle: 0,
  };
}

export function attachAuthoredSteeringRig(rootObject, vehicle) {
  const anchor = rootObject.getObjectByName('Locator_Steering');
  const wheel = findNamedObject(rootObject, STEERING_PATTERN);
  if (!anchor || !wheel) return null;

  anchor.updateMatrixWorld(true);
  wheel.updateMatrixWorld(true);
  anchor.attach(wheel);
  vehicle.steerWheelMesh = wheel;
  return { anchor, wheel };
}

export function attachAuthoredVehicleRig(vehicle, overlay) {
  if (!vehicle || !overlay) return null;

  const doorRig = createAuthoredDoorRig(overlay);
  const steeringRig = attachAuthoredSteeringRig(overlay, vehicle);
  if (!doorRig && !steeringRig) return null;

  vehicle.authoredVehicleRig = {
    doorRig,
    steeringRig,
  };
  vehicle.doorRig = doorRig;
  return vehicle.authoredVehicleRig;
}

export function setAuthoredDoorOpen(vehicle, openAmount = 0) {
  const doorRig = vehicle?.doorRig;
  if (!doorRig?.pivot?.userData?.closedQuaternion) return;
  const amount = THREE.MathUtils.clamp(openAmount, 0, 1);
  doorRig.angle = amount * doorRig.maxAngle;
  doorRig.pivot.quaternion.copy(doorRig.pivot.userData.closedQuaternion);
  doorRig.pivot.rotateY(doorRig.angle * doorRig.openDirection);
}
