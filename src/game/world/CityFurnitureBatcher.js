import * as THREE from 'three';
import { CITY_FURNITURE_LAYER } from '../render/renderLayers.js';
import { quantizeCarPaint } from '../../three-addons/generators/CityGenerator.js';

/**
 * Merges streamed chunk furniture into city-wide InstancedMesh pools (one draw per
 * furniture material signature). Mirrors blueprint Phase-B batching: geometry +
 * material are shared; only instance matrices vary.
 */
export function createCityFurnitureBatcher(cityRoot) {
  const group = new THREE.Group();
  group.name = 'Global City Furniture';
  group.layers.set(CITY_FURNITURE_LAYER);

  /** @type {Map<string, { geometry: THREE.BufferGeometry, material: THREE.Material, instances: { matrix: THREE.Matrix4, chunkKey: string }[] }>} */
  const pools = new Map();
  /** @type {Map<string, THREE.InstancedMesh>} */
  const meshes = new Map();

  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();

  cityRoot.add(group);

  function poolKeyFromMesh(mesh) {
    const role = mesh.userData?.materialRole;
    if (!role?.startsWith('furniture')) return null;
    if (role === 'furnitureCar') {
      const paint = quantizeCarPaint(mesh.userData.furniturePaint ?? 0x74787c);
      const bodyType = mesh.userData.furnitureBodyType ?? 'sedan';
      return `${role}:${bodyType}:${paint}`;
    }
    return role;
  }

  function adoptChunkFurniture(chunkGroup, chunkKey) {
    const toRemove = [];
    // Worker payloads flatten meshes onto the chunk root (no StreetFurniture group).
    chunkGroup.traverse((object) => {
      if (!object.isInstancedMesh || object.count <= 0) return;
      const key = poolKeyFromMesh(object);
      if (!key) return;

      object.updateMatrixWorld(true);
      let pool = pools.get(key);
      if (!pool) {
        pool = {
          geometry: object.geometry,
          material: object.material,
          instances: [],
        };
        pools.set(key, pool);
      }

      for (let index = 0; index < object.count; index += 1) {
        object.getMatrixAt(index, instanceMatrix);
        worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
        pool.instances.push({ matrix: worldMatrix.clone(), chunkKey });
      }

      toRemove.push(object);
    });

    for (const mesh of toRemove) {
      mesh.removeFromParent();
    }

    chunkGroup.getObjectByName('StreetFurniture')?.removeFromParent();

    const touched = new Set(toRemove.map((mesh) => poolKeyFromMesh(mesh)).filter(Boolean));
    for (const key of touched) {
      rebuildPool(key);
    }

    return toRemove.length;
  }

  function releaseChunk(chunkKey) {
    let changed = false;
    for (const [key, pool] of pools) {
      const before = pool.instances.length;
      if (before === 0) continue;
      pool.instances = pool.instances.filter((entry) => entry.chunkKey !== chunkKey);
      if (pool.instances.length !== before) {
        changed = true;
        rebuildPool(key);
      }
    }
    return changed;
  }

  function rebuildPool(key) {
    const pool = pools.get(key);
    const count = pool?.instances.length ?? 0;
    const existing = meshes.get(key);

    if (!pool || count === 0) {
      existing?.removeFromParent();
      meshes.delete(key);
      if (pool && pool.instances.length === 0) pools.delete(key);
      return;
    }

    let mesh = existing;
    const needsRecreate = !mesh
      || mesh.count !== count
      || mesh.geometry !== pool.geometry
      || mesh.material !== pool.material;

    if (needsRecreate) {
      existing?.removeFromParent();
      mesh = new THREE.InstancedMesh(pool.geometry, pool.material, count);
      mesh.name = key.startsWith('furnitureCar') ? 'Car' : key.replace(/^furniture/, '');
      mesh.userData.materialRole = key.startsWith('furnitureCar') ? 'furnitureCar' : key;
      if (key.startsWith('furnitureCar:')) {
        const [, bodyType, paintHex] = key.split(':');
        mesh.userData.furnitureBodyType = bodyType;
        mesh.userData.furniturePaint = Number(paintHex);
      }
      mesh.userData.skipLevelRaycast = true;
      mesh.layers.set(CITY_FURNITURE_LAYER);
      mesh.castShadow = key.includes('Car') || key.includes('StreetTrees');
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.static = true;
      meshes.set(key, mesh);
      group.add(mesh);
    }

    for (let index = 0; index < count; index += 1) {
      mesh.setMatrixAt(index, pool.instances[index].matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  return {
    group,
    adoptChunkFurniture,
    releaseChunk,
    snapshot: () => ({
      pools: pools.size,
      meshes: meshes.size,
      instances: [...pools.values()].reduce((sum, pool) => sum + pool.instances.length, 0),
      drawCalls: meshes.size,
    }),
    dispose: () => {
      for (const mesh of meshes.values()) {
        mesh.removeFromParent();
      }
      meshes.clear();
      pools.clear();
      group.removeFromParent();
    },
  };
}
