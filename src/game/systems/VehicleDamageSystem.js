import * as THREE from 'three';
import {
  clipGeometryPairByPlane,
  getPlaneInObjectSpace,
  isViableCutGeometry,
} from '../geometry/clipGeometryByPlane.js';
import {
  classifyVehicleOverlayMesh,
  VEHICLE_OVERLAY_PART,
} from '../materials/createVehicleOverlayMaterials.js';
import { applyCrumple, restoreCrumple } from '../vehicles/vehicleDeformation.js';

const _point = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _inward = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _inverse = new THREE.Matrix4();
const _relative = new THREE.Matrix4();
const _position = new THREE.Vector3();

function zoneState() {
  return { crumpleDepth: 0, health: 1 };
}

export function createVehicleDamageState() {
  return {
    zones: {
      front: zoneState(),
      rear: zoneState(),
      left: zoneState(),
      right: zoneState(),
    },
    engineHealth: 1,
    bumpers: { front: 'intact', rear: 'intact' },
    brokenLights: { front: false, rear: false },
    impactCount: 0,
    lastImpact: null,
  };
}

export class VehicleDamageSystem {
  constructor() {
    this.physics = null;
    this.scene = null;
    this.detachedBumpers = [];
  }

  initialize({ physics, scene }) {
    this.physics = physics;
    this.scene = scene;
  }

  update({ delta, vehicles = [] } = {}) {
    const liveVehicles = new Set(vehicles);
    for (const vehicle of vehicles) {
      this.ensureDamageState(vehicle);
      const impacts = vehicle.pendingDamageImpacts?.splice(0) ?? [];
      for (const impact of impacts) this.applyImpact(vehicle, impact);
    }
    this._updateDetachedBumpers(Math.max(0, delta || 0), liveVehicles);
  }

  ensureDamageState(vehicle) {
    if (!vehicle.damage) vehicle.damage = createVehicleDamageState();
    return vehicle.damage;
  }

  repair(vehicle) {
    if (!vehicle) return false;
    for (let index = this.detachedBumpers.length - 1; index >= 0; index -= 1) {
      const item = this.detachedBumpers[index];
      if (item.vehicle === vehicle) this._removeDetachedRecord(item, index);
    }
    const restore = (root) => root?.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const repairGeometry = mesh.userData.vehicleDamageRepairGeometry;
      if (repairGeometry) {
        mesh.geometry?.dispose?.();
        mesh.geometry = repairGeometry;
        delete mesh.userData.vehicleDamageRepairGeometry;
        delete mesh.userData.vehicleDamageBasePositions;
      } else {
        restoreCrumple(mesh);
      }
      if (mesh.userData.vehicleDamageRepairMaterial) {
        mesh.material = mesh.userData.vehicleDamageRepairMaterial;
        delete mesh.userData.vehicleDamageRepairMaterial;
      }
      mesh.visible = mesh.userData.vehicleOverlayInitialVisible !== false;
    });
    restore(vehicle.frameVisual);
    restore(vehicle.chassisOverlay);
    vehicle.damage = createVehicleDamageState();
    vehicle.enginePowerScale = 1;
    vehicle.maxSpeedScale = 1;
    vehicle.damageSteerBias = 0;
    if (vehicle.headlightRig) {
      vehicle.headlightRig.visible = vehicle._headlightVisibleBeforeDamage ?? vehicle.headlightRig.visible;
    }
    delete vehicle._headlightVisibleBeforeDamage;
    vehicle.pendingDamageImpacts?.splice(0);
    return true;
  }

  applyImpact(vehicle, impact) {
    const cfg = vehicle.config?.damage;
    if (!cfg?.enabled || !impact) return null;
    const damage = this.ensureDamageState(vehicle);
    const depth = Math.max(0, impact.deltaV) * (cfg.depthPerDeltaV ?? 0.035);
    const maxDepth = cfg.maxCrumpleDepth ?? {};

    for (const [zone, weight] of Object.entries(impact.weights ?? { [impact.zone]: 1 })) {
      if (!(weight > 0) || !damage.zones[zone]) continue;
      const limit = zone === 'front'
        ? maxDepth.front ?? 0.55
        : zone === 'rear'
          ? maxDepth.rear ?? 0.5
          : maxDepth.side ?? 0.3;
      const state = damage.zones[zone];
      state.crumpleDepth = Math.min(limit, state.crumpleDepth + depth * weight);
      state.health = THREE.MathUtils.clamp(1 - state.crumpleDepth / Math.max(0.001, limit), 0, 1);
    }

    const frontWeight = impact.weights?.front ?? (impact.zone === 'front' ? 1 : 0);
    const rearWeight = impact.weights?.rear ?? (impact.zone === 'rear' ? 1 : 0);
    const engineLoss = impact.deltaV * (cfg.engineDamagePerDeltaV ?? 0.045)
      * (frontWeight + rearWeight * 0.4);
    damage.engineHealth = THREE.MathUtils.clamp(damage.engineHealth - engineLoss, 0, 1);
    damage.impactCount += 1;
    damage.lastImpact = { ...impact };

    const powerFloor = cfg.limpPowerFloor ?? 0.3;
    const speedFloor = cfg.limpSpeedFloor ?? 0.4;
    vehicle.enginePowerScale = THREE.MathUtils.lerp(powerFloor, 1, damage.engineHealth);
    vehicle.maxSpeedScale = THREE.MathUtils.lerp(speedFloor, 1, damage.engineHealth);
    vehicle.damageSteerBias = THREE.MathUtils.clamp(
      (damage.zones.left.health - damage.zones.right.health) * 0.14,
      -0.14,
      0.14,
    );
    if (damage.zones.front.health < 0.35) {
      if (!damage.brokenLights.front) {
        vehicle._headlightVisibleBeforeDamage = vehicle.headlightRig?.visible ?? false;
      }
      damage.brokenLights.front = true;
      if (vehicle.headlightRig) vehicle.headlightRig.visible = false;
    }
    if (damage.zones.rear.health < 0.35) damage.brokenLights.rear = true;

    this._deformVehicle(vehicle, impact, depth);
    if (impact.zone === 'front' || impact.zone === 'rear') {
      const bumperState = damage.bumpers[impact.zone];
      if (bumperState === 'dangling') {
        this._releaseBumper(vehicle, impact.zone);
      } else if (
        bumperState === 'intact'
        && vehicle.chassisOverlay
        && (impact.tier === 'severe'
          || damage.zones[impact.zone].crumpleDepth >= (cfg.bumperDetachDepth ?? 0.35))
      ) {
        this._detachBumper(vehicle, impact.zone, impact);
      }
    }
    if (
      vehicle.chassisOverlay
      && (impact.tier === 'severe' || impact.deltaV > (cfg.debrisDetachDeltaV ?? 6))
    ) {
      this._detachOverlayPieces(vehicle, impact);
    }
    return damage;
  }

  _deformVehicle(vehicle, impact, depth) {
    if (!vehicle.group) return;
    vehicle.group.updateMatrixWorld(true);
    _point.copy(impact.localPoint).applyMatrix4(vehicle.group.matrixWorld);
    _direction.copy(impact.localDirection).transformDirection(vehicle.group.matrixWorld);
    _inward.copy(_direction).multiplyScalar(-1);
    const cfg = vehicle.config.damage;
    const limit = impact.zone === 'front'
      ? cfg.maxCrumpleDepth.front
      : impact.zone === 'rear'
        ? cfg.maxCrumpleDepth.rear
        : cfg.maxCrumpleDepth.side;
    const visualDepth = Math.min(depth, limit);
    const radius = (cfg.deformRadius ?? 1.1) * (impact.tier === 'fender' ? 0.72 : 1.25);
    const bendUp = impact.tier === 'fender' ? cfg.bendUp ?? 0.45 : (cfg.bendUp ?? 0.45) * 0.35;

    const deform = (root, { frame = false } = {}) => root?.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
      if (!frame) {
        const kind = classifyVehicleOverlayMesh(mesh, vehicle.chassisOverlayOptions?.profileId);
        if (kind !== VEHICLE_OVERLAY_PART.CHASSIS
          && kind !== VEHICLE_OVERLAY_PART.DETAIL
          && kind !== VEHICLE_OVERLAY_PART.DEBRIS) return;
      }
      applyCrumple(mesh, {
        point: _point,
        dir: _inward,
        radius: frame ? radius * 1.25 : radius,
        depth: frame ? visualDepth * 0.38 : visualDepth,
        bendUp: frame ? bendUp * 0.35 : bendUp,
        noise: frame ? 0 : 0.18,
        maxDepth: frame ? limit * 0.45 : limit,
      });
    });
    deform(vehicle.frameVisual, { frame: true });
    deform(vehicle.chassisOverlay);
  }

  _detachOverlayPieces(vehicle, impact) {
    const overlay = vehicle.chassisOverlay;
    if (!overlay || !this.physics?.world || !this.scene) return false;
    vehicle.group.updateMatrixWorld(true);
    _inverse.copy(vehicle.group.matrixWorld).invert();
    const [, , length] = vehicle.config.body.size;
    let detachedAny = false;

    overlay.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.visible || !mesh.userData.vehicleOverlayDetachable) return;
      _box.setFromObject(mesh).applyMatrix4(_inverse);
      _box.getCenter(_center);
      const inZone = impact.zone === 'front'
        ? _center.z < -length * 0.06
        : impact.zone === 'rear'
          ? _center.z > length * 0.06
          : Math.abs(_center.x) > vehicle.config.body.size[0] * 0.18;
      if (!inZone) return;
      if (this._spawnDetachedMeshPiece(vehicle, mesh, impact, `${mesh.parent?.name ?? 'debris'}`)) {
        mesh.visible = false;
        detachedAny = true;
      }
    });
    return detachedAny;
  }

  _spawnDetachedMeshPiece(vehicle, mesh, impact, label) {
    const chassisBody = this.physics.getFreshBody(vehicle.bodyHandle);
    if (!chassisBody) return false;
    const pieceGroup = new THREE.Group();
    pieceGroup.name = `${vehicle.name} ${label}`;
    const piece = new THREE.Mesh(mesh.geometry, mesh.material);
    piece.castShadow = mesh.castShadow;
    piece.receiveShadow = mesh.receiveShadow;
    _inverse.copy(vehicle.group.matrixWorld).invert();
    _relative.multiplyMatrices(_inverse, mesh.matrixWorld).decompose(piece.position, piece.quaternion, piece.scale);
    pieceGroup.add(piece);

    const RAPIER = this.physics.RAPIER;
    const translation = chassisBody.translation();
    const rotation = chassisBody.rotation();
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(translation.x, translation.y, translation.z)
        .setRotation(rotation)
        .setLinearDamping(0.2)
        .setAngularDamping(0.3),
    );
    const impulse = impact.deltaV * 0.35;
    body.applyImpulse({
      x: impact.localDirection.x * impulse,
      y: 0.35 + Math.random() * 0.25,
      z: impact.localDirection.z * impulse,
    }, true);
    body.setAngvel({
      x: (Math.random() - 0.5) * 4,
      y: (Math.random() - 0.5) * 4,
      z: (Math.random() - 0.5) * 4,
    }, true);
    const vertices = collectGroupVertices(pieceGroup, 420);
    const colliderDesc = vertices.length >= 12 ? RAPIER.ColliderDesc.convexHull(vertices) : null;
    if (colliderDesc) this.physics.world.createCollider(colliderDesc.setDensity(0.28).setFriction(0.7), body);
    pieceGroup.position.set(translation.x, translation.y, translation.z);
    pieceGroup.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.scene.add(pieceGroup);
    this.detachedBumpers.push({
      vehicle,
      zone: 'debris',
      group: pieceGroup,
      bodyHandle: body.handle,
      joint: null,
      age: 0,
      released: true,
    });
    return true;
  }

  _detachBumper(vehicle, zone, impact) {
    const overlay = vehicle.chassisOverlay;
    if (!overlay || !this.physics?.world || !this.scene) return false;
    vehicle.group.updateMatrixWorld(true);
    _box.setFromObject(overlay).applyMatrix4(_inverse.copy(vehicle.group.matrixWorld).invert());
    _box.getSize(_size);
    const cutZ = zone === 'front'
      ? _box.min.z + _size.z * 0.14
      : _box.max.z - _size.z * 0.14;
    const localPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -cutZ);
    const worldPlane = localPlane.clone().applyMatrix4(vehicle.group.matrixWorld);
    const keepPositive = zone === 'front';
    const bumperGroup = new THREE.Group();
    bumperGroup.name = `${vehicle.name} ${zone} detached bumper`;
    _inverse.copy(vehicle.group.matrixWorld).invert();
    let pieces = 0;

    const meshes = [];
    overlay.traverse((mesh) => { if (mesh.isMesh && mesh.geometry) meshes.push(mesh); });
    for (const mesh of meshes) {
      _box.setFromObject(mesh).applyMatrix4(_inverse);
      _box.getCenter(_center);
      const reachesBumper = zone === 'front' ? _box.min.z <= cutZ : _box.max.z >= cutZ;
      if (!reachesBumper || _center.y > 0.65) continue;
      const pair = clipGeometryPairByPlane(mesh.geometry, getPlaneInObjectSpace(worldPlane, mesh), {
        includeCap: true,
        minVertexCount: 9,
        minDimension: 0.015,
      });
      if (!pair) continue;
      const keep = keepPositive ? pair.positive : pair.negative;
      const detached = keepPositive ? pair.negative : pair.positive;
      if (!detached || !isViableCutGeometry(detached, { minVertexCount: 9, minDimension: 0.015 })) {
        keep?.dispose();
        detached?.dispose();
        continue;
      }
      if (keep) {
        if (!mesh.userData.vehicleDamageRepairGeometry) {
          const repairGeometry = mesh.geometry.clone();
          const base = mesh.userData.vehicleDamageBasePositions;
          const repairPosition = repairGeometry.getAttribute('position');
          if (base?.length === repairPosition?.array?.length) {
            repairPosition.array.set(base);
            repairPosition.needsUpdate = true;
            repairGeometry.computeVertexNormals();
            repairGeometry.computeBoundingBox();
            repairGeometry.computeBoundingSphere();
          }
          mesh.userData.vehicleDamageRepairGeometry = repairGeometry;
          mesh.userData.vehicleDamageRepairMaterial = mesh.material;
        }
        mesh.geometry.dispose();
        mesh.geometry = keep;
        // The cut changes vertex count/topology; future hits need a fresh damage
        // baseline or the pre-cut snapshot indexes past the new position buffer.
        delete mesh.userData.vehicleDamageBasePositions;
        mesh.userData.vehicleDamageGeometryUnique = true;
        if (!Array.isArray(mesh.material)) mesh.material = [mesh.material, mesh.material];
      } else {
        if (!mesh.userData.vehicleDamageRepairGeometry) {
          const repairGeometry = mesh.geometry.clone();
          const base = mesh.userData.vehicleDamageBasePositions;
          const repairPosition = repairGeometry.getAttribute('position');
          if (base?.length === repairPosition?.array?.length) {
            repairPosition.array.set(base);
            repairPosition.needsUpdate = true;
            repairGeometry.computeVertexNormals();
            repairGeometry.computeBoundingBox();
            repairGeometry.computeBoundingSphere();
          }
          mesh.userData.vehicleDamageRepairGeometry = repairGeometry;
        }
        mesh.visible = false;
      }
      const piece = new THREE.Mesh(detached, Array.isArray(mesh.material) ? mesh.material : [mesh.material, mesh.material]);
      piece.castShadow = mesh.castShadow;
      piece.receiveShadow = mesh.receiveShadow;
      _relative.multiplyMatrices(_inverse, mesh.matrixWorld).decompose(piece.position, piece.quaternion, piece.scale);
      bumperGroup.add(piece);
      pieces += 1;
    }
    if (!pieces) return false;

    const chassisBody = this.physics.getFreshBody(vehicle.bodyHandle);
    if (!chassisBody) return false;
    const translation = chassisBody.translation();
    const rotation = chassisBody.rotation();
    const RAPIER = this.physics.RAPIER;
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(translation.x, translation.y, translation.z)
        .setRotation(rotation)
        .setLinearDamping(0.25)
        .setAngularDamping(0.35),
    );
    body.setLinvel(chassisBody.linvel(), false);
    body.setAngvel(chassisBody.angvel(), false);
    const vertices = collectGroupVertices(bumperGroup, 900);
    const colliderDesc = vertices.length >= 12 ? RAPIER.ColliderDesc.convexHull(vertices) : null;
    if (colliderDesc) this.physics.world.createCollider(colliderDesc.setDensity(0.35).setFriction(0.65), body);
    bumperGroup.position.set(translation.x, translation.y, translation.z);
    bumperGroup.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.scene.add(bumperGroup);

    const [width, , length] = vehicle.config.body.size;
    const impactSide = Math.sign(impact.localDirection.x) || 1;
    const anchor = {
      x: -impactSide * width * 0.42,
      y: -0.2,
      z: zone === 'front' ? -length * 0.45 : length * 0.45,
    };
    const joint = this.physics.world.createImpulseJoint(
      RAPIER.JointData.spherical(anchor, anchor),
      chassisBody,
      body,
      true,
    );
    vehicle.damage.bumpers[zone] = 'dangling';
    this.detachedBumpers.push({ vehicle, zone, group: bumperGroup, bodyHandle: body.handle, joint, age: 0, released: false });
    return true;
  }

  _releaseBumper(vehicle, zone) {
    const record = this.detachedBumpers.find((item) => item.vehicle === vehicle && item.zone === zone && !item.released);
    if (!record) return false;
    try { this.physics.world.removeImpulseJoint(record.joint, true); } catch { /* stale joint */ }
    record.joint = null;
    record.released = true;
    record.age = 0;
    vehicle.damage.bumpers[zone] = 'gone';
    return true;
  }

  _updateDetachedBumpers(delta, liveVehicles) {
    for (let index = this.detachedBumpers.length - 1; index >= 0; index -= 1) {
      const item = this.detachedBumpers[index];
      item.age += delta;
      const body = this.physics?.getFreshBody(item.bodyHandle);
      if (body) {
        const p = body.translation();
        const q = body.rotation();
        item.group.position.set(p.x, p.y, p.z);
        item.group.quaternion.set(q.x, q.y, q.z, q.w);
      }
      const speed = item.vehicle?.linearVelocity?.length?.() ?? 0;
      if (!item.released && (item.age > 4 || speed > (item.vehicle.config.damage.bumperDropSpeed ?? 22))) {
        this._releaseBumper(item.vehicle, item.zone);
      }
      const life = item.vehicle?.config?.damage?.bumperLifeSeconds ?? 15;
      if (!liveVehicles.has(item.vehicle) || !body || (item.released && item.age > life)) {
        this._removeDetachedRecord(item, index, body);
      }
    }
  }

  _removeDetachedRecord(item, index, body = this.physics?.getFreshBody(item.bodyHandle)) {
    if (item.joint) {
      try { this.physics.world.removeImpulseJoint(item.joint, true); } catch { /* stale */ }
    }
    if (body) {
      try { this.physics.world.removeRigidBody(body); } catch { /* stale */ }
    }
    item.group.removeFromParent();
    item.group.traverse((node) => node.geometry?.dispose?.());
    this.detachedBumpers.splice(index, 1);
  }

  dispose() {
    this._updateDetachedBumpers(Infinity, new Set());
    this.detachedBumpers.length = 0;
  }
}

function collectGroupVertices(group, maxVertices) {
  const values = [];
  group.updateMatrixWorld(true);
  group.traverse((mesh) => {
    const position = mesh.geometry?.getAttribute?.('position');
    if (!mesh.isMesh || !position) return;
    const step = Math.max(1, Math.ceil(position.count / Math.max(12, maxVertices - values.length)));
    for (let index = 0; index < position.count && values.length < maxVertices * 3; index += step) {
      _position.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      values.push(_position.x, _position.y, _position.z);
    }
  });
  return new Float32Array(values);
}
