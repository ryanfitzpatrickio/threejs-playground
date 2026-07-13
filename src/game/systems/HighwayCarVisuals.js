/**
 * HighwayCarVisuals — city-style TSL InstancedMesh fleet for traffic.
 *
 * Full BaseVehicle meshes (hundreds of geos/draws each) are the dominant highway
 * submission cost. Traffic keeps a physics-only chassis for leap/hijack, while
 * this layer draws the fleet as a handful of TSL InstancedMeshes (CarGenerator
 * path — sedan + semi shells).
 */

import * as THREE from 'three';
import {
  createCarMaterialForType,
  buildCarGeometryForType,
} from '../../three-addons/generators/city/CarGenerator.js';
import { quantizeCarPaint } from '../../three-addons/generators/CityGenerator.js';
import { TRAFFIC_COLORS } from '../config/highwayRunManifest.js';

/** CarGenerator shell faces +Z; highway chassis faces −Z at rotationY=0. */
const NOSE_CORRECTION = new THREE.Matrix4().makeRotationY(Math.PI);

/** Drop shell so wheels sit near the deck relative to chassis COM. */
const VISUAL_Y_OFFSET = {
  sedan: -0.55,
  semi: -0.35,
  semiCab: -0.35,
  semiTrailer: -0.15,
};

/** Default body types when initializing a full highway fleet. */
const BODY_TYPES = Object.freeze(['sedan', 'semiCab', 'semiTrailer']);

function yOffsetForType(type) {
  return VISUAL_Y_OFFSET[type] ?? VISUAL_Y_OFFSET.sedan;
}

function bucketKey(type, paint) {
  return `${type}|${paint}`;
}

function normalizeBodyType(type) {
  if (type === 'semiCab' || type === 'semi') return 'semiCab';
  if (type === 'semiTrailer') return 'semiTrailer';
  return 'sedan';
}

export class HighwayCarVisuals {
  /**
   * @param {{ scene?: object|null, capacity?: number }} [opts]
   */
  constructor({ scene = null, capacity = 24 } = {}) {
    this.scene = scene;
    this.capacity = Math.max(1, capacity | 0);
    this.group = new THREE.Group();
    this.group.name = 'Highway Traffic Fleet (TSL)';
    /** @type {Map<string, { mesh: THREE.InstancedMesh, paint: number, type: string, free: number[], used: Map<object, number> }>} */
    this.buckets = new Map();
    /** @type {Map<object, { paint: number, slot: number, bucketKey: string, type: string }>} */
    this.assignments = new Map();
    this._scratch = new THREE.Matrix4();
    this._offset = new THREE.Matrix4();
    this._dummy = new THREE.Object3D();
    /** @type {Map<string, THREE.BufferGeometry>} */
    this._geometries = new Map();
    this.status = 'idle';
  }

  /**
   * Build fixed-capacity instanced batches (paint × body type).
   * @param {{ scene?: object|null, capacity?: number, types?: string[] }} [opts]
   */
  initialize({
    scene = this.scene,
    capacity = this.capacity,
    types = BODY_TYPES,
  } = {}) {
    this.disposeMeshes();
    this.scene = scene ?? this.scene;
    this.capacity = Math.max(1, capacity | 0);
    // Expand archetype 'semi' into cab + trailer shells.
    const rawTypes = types?.length ? types : BODY_TYPES;
    const expanded = [];
    for (const t of rawTypes) {
      if (t === 'semi') {
        expanded.push('semiCab', 'semiTrailer');
      } else {
        expanded.push(normalizeBodyType(t));
      }
    }
    const bodyTypes = expanded.filter((t, i, arr) => arr.indexOf(t) === i);

    for (const type of bodyTypes) {
      if (!this._geometries.has(type)) {
        this._geometries.set(type, buildCarGeometryForType(type));
      }
    }

    const paints = new Set();
    for (const c of TRAFFIC_COLORS) paints.add(quantizeCarPaint(c));
    if (paints.size === 0) paints.add(0x74787c);

    const identity = new THREE.Matrix4();
    // Each (type, paint) bucket holds the full capacity so recycle thrash cannot
    // starve attach when quantise collapses paints.
    const perBucket = this.capacity + 2;
    for (const type of bodyTypes) {
      const geo = this._geometries.get(type);
      for (const paint of paints) {
        const key = bucketKey(type, paint);
        const material = createCarMaterialForType(paint, type);
        const mesh = new THREE.InstancedMesh(geo, material, perBucket);
        mesh.count = 0;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        // Fleet meshes sit at origin; instances live on the multi-km ribbon.
        mesh.frustumCulled = false;
        mesh.name = `Highway_${type}_${paint.toString(16)}`;
        mesh.userData.furniturePaint = paint;
        mesh.userData.furnitureBodyType = type;
        for (let i = 0; i < perBucket; i += 1) {
          mesh.setMatrixAt(i, identity);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.group.add(mesh);

        const free = [];
        for (let i = 0; i < perBucket; i += 1) free.push(i);
        this.buckets.set(key, {
          mesh,
          paint,
          type,
          free,
          used: new Map(),
        });
      }
    }

    this.scene?.add?.(this.group);
    this.status = 'ready';
    return this;
  }

  /**
   * Show a traffic vehicle as a TSL instance (vehicle.group stays invisible).
   * @param {object} vehicle
   * @param {number} [colorHex]
   * @param {string} [bodyType]
   */
  attach(vehicle, colorHex = 0x3a4a5c, bodyType = null) {
    if (!vehicle || this.status !== 'ready') return false;
    if (this.assignments.has(vehicle)) {
      this.syncOne(vehicle);
      return true;
    }
    const type = normalizeBodyType(
      bodyType
      ?? vehicle.userData?.highwayArchetype
      ?? vehicle.userData?.highwayBodyType
      ?? 'sedan',
    );
    const paint = quantizeCarPaint(colorHex);
    let key = bucketKey(type, paint);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.free.length === 0) {
      for (const [k, b] of this.buckets) {
        if (b.type === type && b.free.length > 0) {
          key = k;
          bucket = b;
          break;
        }
      }
    }
    if (!bucket || bucket.free.length === 0) {
      for (const [k, b] of this.buckets) {
        if (b.free.length > 0) {
          key = k;
          bucket = b;
          break;
        }
      }
    }
    if (!bucket || bucket.free.length === 0) return false;

    const slot = bucket.free.pop();
    bucket.used.set(vehicle, slot);
    this.assignments.set(vehicle, {
      paint: bucket.paint,
      slot,
      bucketKey: key,
      type: bucket.type,
    });
    if (vehicle.group) vehicle.group.visible = false;
    this._writeMatrix(bucket.mesh, slot, vehicle, bucket.type);
    bucket.mesh.count = Math.max(bucket.mesh.count, slot + 1);
    bucket.mesh.instanceMatrix.needsUpdate = true;
    this._compactCount(bucket);
    return true;
  }

  /** @param {object} vehicle */
  detach(vehicle) {
    const asg = this.assignments.get(vehicle);
    if (!asg) return;
    const b = this.buckets.get(asg.bucketKey);
    if (b) {
      this._dummy.position.set(0, -500, 0);
      this._dummy.quaternion.identity();
      this._dummy.scale.set(1, 1, 1);
      this._dummy.updateMatrix();
      b.mesh.setMatrixAt(asg.slot, this._dummy.matrix);
      b.mesh.instanceMatrix.needsUpdate = true;
      b.used.delete(vehicle);
      b.free.push(asg.slot);
      this._compactCount(b);
    }
    this.assignments.delete(vehicle);
  }

  /** @param {object} vehicle */
  promoteToOwned(vehicle) {
    if (!vehicle?.group) {
      this.detach(vehicle);
      return;
    }
    const asg = this.assignments.get(vehicle);
    const type = normalizeBodyType(
      asg?.type ?? vehicle.userData?.highwayArchetype ?? 'sedan',
    );
    const paint = asg?.paint ?? quantizeCarPaint(vehicle.userData?.highwayColor ?? 0x3a4a5c);
    this.detach(vehicle);

    const geo = this._geometries.get(type);
    if (!geo) return;
    const material = createCarMaterialForType(paint, type);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'Highway Owned Car Shell';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.y = Math.PI;
    mesh.position.y = yOffsetForType(type);
    const prev = vehicle.group.getObjectByName('Highway Owned Car Shell');
    if (prev) {
      vehicle.group.remove(prev);
      prev.material?.dispose?.();
    }
    vehicle.group.add(mesh);
    vehicle.group.visible = true;
    vehicle.userData = {
      ...(vehicle.userData ?? {}),
      highwayTslShell: mesh,
      highwayProxyVisual: false,
      highwayArchetype: type,
    };
  }

  syncAll() {
    if (this.status !== 'ready') return;
    const dirty = new Set();
    for (const [vehicle, asg] of this.assignments) {
      const b = this.buckets.get(asg.bucketKey);
      if (!b) continue;
      this._writeMatrix(b.mesh, asg.slot, vehicle, asg.type ?? b.type);
      dirty.add(b);
    }
    for (const b of dirty) {
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  syncOne(vehicle) {
    const asg = this.assignments.get(vehicle);
    if (!asg) return;
    const b = this.buckets.get(asg.bucketKey);
    if (!b) return;
    this._writeMatrix(b.mesh, asg.slot, vehicle, asg.type ?? b.type);
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  snapshot() {
    let instances = 0;
    let draws = 0;
    const byType = { sedan: 0, semiCab: 0, semiTrailer: 0 };
    for (const b of this.buckets.values()) {
      instances += b.used.size;
      byType[b.type] = (byType[b.type] ?? 0) + b.used.size;
      if (b.mesh.count > 0) draws += 1;
    }
    return {
      status: this.status,
      capacity: this.capacity,
      liveInstances: instances,
      drawBuckets: draws,
      bucketCount: this.buckets.size,
      byType,
    };
  }

  disposeMeshes() {
    for (const b of this.buckets.values()) {
      b.mesh.parent?.remove?.(b.mesh);
      b.mesh.material?.dispose?.();
    }
    this.buckets.clear();
    this.assignments.clear();
    this.group.clear();
    for (const geo of this._geometries.values()) {
      geo.dispose?.();
    }
    this._geometries.clear();
  }

  dispose() {
    this.disposeMeshes();
    this.group.parent?.remove?.(this.group);
    this.scene = null;
    this.status = 'idle';
  }

  _writeMatrix(mesh, slot, vehicle, type = 'sedan') {
    const g = vehicle?.group;
    if (!g) return;
    if (g.matrixAutoUpdate === false) {
      g.updateMatrix();
      g.matrixWorld.copy(g.matrix);
    } else {
      g.updateMatrixWorld?.(true);
    }
    this._scratch.copy(g.matrixWorld);
    this._offset.makeTranslation(0, yOffsetForType(type), 0);
    this._scratch.multiply(this._offset);
    this._scratch.multiply(NOSE_CORRECTION);
    mesh.setMatrixAt(slot, this._scratch);
  }

  _compactCount(bucket) {
    let max = -1;
    for (const slot of bucket.used.values()) {
      if (slot > max) max = slot;
    }
    bucket.mesh.count = max + 1;
    if (bucket.mesh.count < 0) bucket.mesh.count = 0;
  }
}

/**
 * Empty group used as BaseVehicle.providedModel so traffic skips buildMesh().
 */
export function createHighwayProxyModel() {
  const g = new THREE.Group();
  g.name = 'Highway Proxy Chassis';
  g.visible = false;
  g.matrixAutoUpdate = false;
  g.matrixWorldAutoUpdate = false;
  return g;
}
