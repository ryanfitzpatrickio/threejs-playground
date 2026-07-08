import * as THREE from 'three';

export const BODYSHOP_REQUIRED_LOCATOR_NAMES = Object.freeze([
  'Locator_Steering',
  'Locator_Door_Hinge',
  'Locator_Seat',
  'Locator_Door_Spot',
]);

export const BODYSHOP_REQUIRED_WINDOW_COUNT = 1;
export const BODYSHOP_LOCATOR_HELPER_NAME = '__bodyshop_locator_helper__';

const WINDOW_PATTERN = /windshield|window(_driver|_passenger|_top)?|glass/i;
const DOOR_PATTERN = /(driver.*door|door.*driver|^door$)/i;
const STEERING_WHEEL_PATTERN = /steering[_ ]wheel|wheel.*steering|^steering$/i;
const INTERIOR_PATTERN = /interior/i;
const HELPER_PATTERN = /^__(?:builder|bodyshop|asset_manager)_/i;

function getNodeWorldCenter(root, node) {
  const box = new THREE.Box3().setFromObject(node);
  if (!box.isEmpty()) {
    return root.worldToLocal(box.getCenter(new THREE.Vector3()));
  }
  return root.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
}

function getNodeWorldBounds(node) {
  const box = new THREE.Box3().setFromObject(node);
  return box.isEmpty() ? null : box;
}

function collectRenderableBounds(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return null;
  return {
    box,
    center: box.getCenter(new THREE.Vector3()),
    size: box.getSize(new THREE.Vector3()),
  };
}

function getDescendantMeshCount(root) {
  let count = 0;
  root.traverse((child) => {
    if (child.isMesh && !child.userData.bodyshopHelper && !child.userData._builderHelper) {
      count += 1;
    }
  });
  return count;
}

function collectDistinctNamedNodes(root, pattern, options = {}) {
  const matches = [];
  root.traverse((child) => {
    if (
      child === root
      || child.userData.bodyshopHelper
      || child.userData._builderHelper
      || !child.name
      || HELPER_PATTERN.test(child.name)
    ) {
      return;
    }
    if (!pattern.test(child.name)) return;
    if (options.exclude && options.exclude.test(child.name)) return;
    if (options.meshLike && !child.isMesh && getDescendantMeshCount(child) === 0) return;
    matches.push(child);
  });
  return matches.filter((node) => !matches.some((other) => other !== node && other.children.includes(node)));
}

function collectLocatorPlacementHints(root) {
  const steeringWheelNodes = collectDistinctNamedNodes(root, STEERING_WHEEL_PATTERN, { meshLike: true });
  const seatNodes = collectDistinctNamedNodes(root, /seat/i, { meshLike: true });
  const interiorNodes = collectDistinctNamedNodes(root, INTERIOR_PATTERN, { meshLike: true });
  const doorNodes = collectDistinctNamedNodes(root, DOOR_PATTERN, { meshLike: true });
  const bounds = collectRenderableBounds(root);

  return {
    steeringWheel: steeringWheelNodes[0] ? getNodeWorldCenter(root, steeringWheelNodes[0]) : null,
    seat: seatNodes[0]
      ? getNodeWorldCenter(root, seatNodes[0])
      : interiorNodes[0]
        ? getNodeWorldCenter(root, interiorNodes[0])
        : bounds?.center?.clone() ?? null,
    doorNode: doorNodes[0] || null,
    bounds,
  };
}

function inferLocatorPositionFromParts(root, locatorName) {
  const hints = collectLocatorPlacementHints(root);

  if (locatorName === 'Locator_Steering' && hints.steeringWheel) {
    return hints.steeringWheel.clone();
  }

  if (locatorName === 'Locator_Seat' && hints.seat) {
    return hints.seat.clone();
  }

  if ((locatorName === 'Locator_Door_Hinge' || locatorName === 'Locator_Door_Spot') && hints.doorNode) {
    const doorBounds = getNodeWorldBounds(hints.doorNode);
    if (doorBounds) {
      const center = doorBounds.getCenter(new THREE.Vector3());
      const size = doorBounds.getSize(new THREE.Vector3());
      const sideSign = center.x < (hints.bounds?.center?.x ?? 0) ? -1 : 1;
      const hinge = root.worldToLocal(new THREE.Vector3(
        center.x + sideSign * size.x * 0.42,
        doorBounds.max.y - size.y * 0.12,
        doorBounds.max.z - size.z * 0.1,
      ));
      const doorSpot = root.worldToLocal(new THREE.Vector3(
        center.x + sideSign * size.x * 0.95,
        center.y,
        center.z,
      ));
      return locatorName === 'Locator_Door_Hinge' ? hinge : doorSpot;
    }
  }

  if (hints.bounds) {
    const { center, size } = hints.bounds;
    const defaults = {
      Locator_Steering: new THREE.Vector3(center.x, center.y + size.y * 0.08, center.z + size.z * 0.18),
      Locator_Seat: new THREE.Vector3(center.x, center.y - size.y * 0.05, center.z),
      Locator_Door_Hinge: new THREE.Vector3(center.x - size.x * 0.38, center.y + size.y * 0.02, center.z + size.z * 0.08),
      Locator_Door_Spot: new THREE.Vector3(center.x - size.x * 0.42, center.y, center.z + size.z * 0.12),
    };
    if (defaults[locatorName]) return defaults[locatorName];
  }

  return null;
}

export function createLocatorHelper(locator) {
  const existing = locator.children.find((child) => child.userData.bodyshopHelper === true);
  if (existing) return existing;

  const helper = new THREE.Group();
  helper.name = BODYSHOP_LOCATOR_HELPER_NAME;
  helper.userData.bodyshopHelper = true;
  helper.userData._builderHelper = true;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 18, 12),
    new THREE.MeshBasicMaterial({ color: '#f97316' }),
  );
  sphere.userData.bodyshopHelper = true;
  sphere.userData._builderHelper = true;

  const axes = new THREE.AxesHelper(0.22);
  axes.userData.bodyshopHelper = true;
  axes.userData._builderHelper = true;

  helper.add(sphere, axes);
  locator.add(helper);
  return helper;
}

export function ensureLocatorHelpers(root) {
  for (const locatorName of BODYSHOP_REQUIRED_LOCATOR_NAMES) {
    const locator = root.getObjectByName(locatorName);
    if (locator) createLocatorHelper(locator);
  }
}

export function stripBodyshopEditorHelpers(root) {
  const doomed = [];
  root.traverse((child) => {
    if (
      child.userData.bodyshopHelper === true
      || child.userData.assetManagerHelper === true
      || child.name === BODYSHOP_LOCATOR_HELPER_NAME
    ) {
      doomed.push(child);
    }
  });
  for (const child of doomed) {
    child.parent?.remove(child);
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}

export function addMissingBodyshopLocators(root) {
  const added = [];
  for (const locatorName of BODYSHOP_REQUIRED_LOCATOR_NAMES) {
    if (root.getObjectByName(locatorName)) continue;
    const estimatedPosition = inferLocatorPositionFromParts(root, locatorName);
    if (!estimatedPosition) continue;
    const locator = new THREE.Group();
    locator.name = locatorName;
    locator.position.copy(estimatedPosition);
    createLocatorHelper(locator);
    root.add(locator);
    added.push(locator);
  }
  return added;
}

export function analyzeBodyshopScene(root) {
  const requiredLocators = BODYSHOP_REQUIRED_LOCATOR_NAMES.map((locatorName) => ({
    name: locatorName,
    object: root.getObjectByName(locatorName) || null,
  }));

  const windowNodes = collectDistinctNamedNodes(root, WINDOW_PATTERN, { meshLike: true });
  const interiorNodes = collectDistinctNamedNodes(root, INTERIOR_PATTERN, { meshLike: true });
  const doorNodes = collectDistinctNamedNodes(root, DOOR_PATTERN, { meshLike: true });
  const steeringWheelNodes = collectDistinctNamedNodes(root, STEERING_WHEEL_PATTERN, { meshLike: true });

  const missingLocators = requiredLocators.filter((entry) => !entry.object).map((entry) => entry.name);
  const hasDoor = doorNodes.length > 0;
  const hasSteering = steeringWheelNodes.length > 0;

  return {
    approved: missingLocators.length === 0 && hasDoor && hasSteering,
    requiredLocators,
    missingLocators,
    optionalParts: {
      windows: {
        present: windowNodes.length >= BODYSHOP_REQUIRED_WINDOW_COUNT,
        count: windowNodes.length,
        expected: BODYSHOP_REQUIRED_WINDOW_COUNT,
      },
      interior: {
        present: interiorNodes.length > 0,
        count: interiorNodes.length,
      },
      door: {
        present: hasDoor,
        count: doorNodes.length,
      },
      steeringWheel: {
        present: hasSteering,
        count: steeringWheelNodes.length,
      },
    },
  };
}

export function inferBodyshopForwardYawRadians(rootObject) {
  if (!rootObject?.isObject3D) return 0;
  rootObject.updateMatrixWorld(true);
  const bounds = collectRenderableBounds(rootObject);
  if (!bounds) return 0;
  const { size } = bounds;
  if (size.z >= size.x) return 0;
  return size.x > size.z ? Math.PI * 0.5 : -Math.PI * 0.5;
}
