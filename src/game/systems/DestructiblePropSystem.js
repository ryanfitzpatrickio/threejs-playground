import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';

const PROP_COUNT = 0;

const PROP_ARCHETYPES = {
  car: {
    url: '/assets/models/car-prop.glb',
    targetLength: 4.4,
    groundOffset: 0,
    boneScheme: 'creature',
  },
  van: {
    url: '/assets/models/van-prop.glb',
    targetLength: 5.4,
    groundOffset: 0,
    boneScheme: 'creature',
  },
};

const STREET_SPAWN_RULES = [
  { axis: 'x', sign: 1, crossMin: -7, crossMax: 7, alongMin: 16, alongMax: 54 },
  { axis: 'x', sign: -1, crossMin: -7, crossMax: 7, alongMin: 16, alongMax: 54 },
  { axis: 'z', sign: 1, crossMin: -7, crossMax: 7, alongMin: 16, alongMax: 54 },
  { axis: 'z', sign: -1, crossMin: -7, crossMax: 7, alongMin: 16, alongMax: 54 },
];

const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();

export class DestructiblePropSystem {
  constructor({ cutPieceLifetime = 45 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'Destructible Props';
    this.props = [];
    this.status = 'idle';
    this.error = null;
    this.cutPieceLifetime = cutPieceLifetime;
  }

  async load(scene, { playerPosition = new THREE.Vector3(), level } = {}) {
    this.status = 'loading';
    this.error = null;
    scene.add(this.group);

    if (PROP_COUNT <= 0) {
      this.status = 'ready';
      return;
    }

    try {
      const loader = createGltfLoader();

      const assets = new Map();
      for (const [key, config] of Object.entries(PROP_ARCHETYPES)) {
        const gltf = await loader.loadAsync(config.url);
        assets.set(key, gltf.scene);
      }

      const spawnPlans = pickStreetSpawnPlans(PROP_COUNT);
      for (let index = 0; index < spawnPlans.length; index += 1) {
        const plan = spawnPlans[index];
        const archetype = plan.archetype;
        const config = PROP_ARCHETYPES[archetype];
        const source = assets.get(archetype);
        if (!source) {
          continue;
        }

        const inner = source.clone(true);
        inner.name = `${archetype} ${index + 1} Model`;
        inner.updateMatrixWorld(true);

        const renderObjects = preparePropAsset(inner);
        flattenObjectForWebGPU(inner);
        normalizeToLength(inner, config.targetLength);
        alignModelToGround(inner, config.groundOffset);

        const collision = measureCollisionBounds(inner);
        const model = new THREE.Group();
        model.name = `${archetype} ${index + 1}`;
        model.add(inner);

        const spawnPosition = resolvePropSpawnPosition({
          plan,
          playerPosition,
          level,
          groundOffset: config.groundOffset,
        });

        const prop = {
          id: `prop-${archetype}-${index + 1}`,
          archetype,
          boneScheme: config.boneScheme,
          isDestructibleProp: true,
          cutPieceLifetime: this.cutPieceLifetime,
          model,
          collisionHeight: collision.height,
          collisionRadius: collision.radius,
          groundOffset: config.groundOffset,
          health: 1,
          maxHealth: 1,
          staggerTimer: 0,
          renderObjects,
        };

        model.position.copy(spawnPosition);
        model.rotation.y = plan.yaw;
        this.group.add(model);
        this.props.push(prop);
      }

      this.status = 'ready';
    } catch (error) {
      this.status = 'error';
      this.error = error;
      console.warn('Destructible prop models failed to load.', error);
    }
  }

  removeProp(prop) {
    const index = this.props.indexOf(prop);
    if (index === -1) {
      return false;
    }

    this.group.remove(prop.model);
    disposeObject3D(prop.model);
    this.props.splice(index, 1);
    return true;
  }

  dispose() {
    for (const prop of this.props) {
      disposeObject3D(prop.model);
    }
    this.group.removeFromParent();
    this.props = [];
    this.status = 'disposed';
  }
}

function pickStreetSpawnPlans(count) {
  const archetypes = Object.keys(PROP_ARCHETYPES);
  const plans = [];
  const used = new Set();

  for (let attempt = 0; attempt < count * 8 && plans.length < count; attempt += 1) {
    const rule = STREET_SPAWN_RULES[Math.floor(Math.random() * STREET_SPAWN_RULES.length)];
    const along = rule.alongMin + Math.random() * (rule.alongMax - rule.alongMin);
    const cross = rule.crossMin + Math.random() * (rule.crossMax - rule.crossMin);
    const key = `${rule.axis}:${rule.sign}:${along.toFixed(1)}:${cross.toFixed(1)}`;
    if (used.has(key)) {
      continue;
    }
    used.add(key);

    const yaw = rule.axis === 'x'
      ? (Math.random() > 0.5 ? Math.PI * 0.5 : -Math.PI * 0.5)
      : (Math.random() > 0.5 ? 0 : Math.PI);

    plans.push({
      archetype: archetypes[Math.floor(Math.random() * archetypes.length)],
      axis: rule.axis,
      sign: rule.sign,
      along,
      cross,
      yaw,
    });
  }

  return plans;
}

function resolvePropSpawnPosition({ plan, playerPosition, level, groundOffset = 0 }) {
  const originX = playerPosition?.x ?? 0;
  const originZ = playerPosition?.z ?? 0;
  const position = new THREE.Vector3(
    plan.axis === 'x' ? originX + plan.sign * plan.along : originX + plan.cross,
    playerPosition?.y ?? 0,
    plan.axis === 'z' ? originZ + plan.sign * plan.along : originZ + plan.cross,
  );

  const ground = level?.getGroundHeightAt?.(position, 0.5);
  if (Number.isFinite(ground)) {
    position.y = ground + groundOffset;
  }

  return position;
}

function preparePropAsset(root) {
  const renderObjects = [];
  root.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      renderObjects.push(child);
      child.castShadow = true;
      child.receiveShadow = true;
      // default frustumCulled=true: distant props should not cost draw calls
    }
  });
  return renderObjects;
}

function normalizeToLength(root, targetLength) {
  root.updateMatrixWorld(true);
  tempBox.setFromObject(root);
  tempBox.getSize(tempSize);
  const horizontal = Math.max(tempSize.x, tempSize.z, 0.001);
  const scale = targetLength / horizontal;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
}

function alignModelToGround(root, groundOffset = 0) {
  root.updateMatrixWorld(true);
  tempBox.setFromObject(root);
  root.position.y -= tempBox.min.y;
  root.position.y += groundOffset;
  root.updateMatrixWorld(true);
}

function measureCollisionBounds(root) {
  root.updateMatrixWorld(true);
  tempBox.setFromObject(root);
  tempBox.getSize(tempSize);
  return {
    height: Math.max(tempSize.y, 1.2),
    radius: Math.max(tempSize.x, tempSize.z) * 0.5,
  };
}
