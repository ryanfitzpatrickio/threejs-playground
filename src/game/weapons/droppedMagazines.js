/**
 * Dropped-magazine physics props (docs/advanced-reload-system-plan.md, AR2).
 *
 * On the reload `mag_drop` event the spent magazine becomes a short-lived Rapier
 * dynamic body that falls and tumbles to the floor, mirroring the EnemyCutSystem
 * rigid-prop lifecycle/budget (cap concurrent, per-frame interpolated visual
 * sync, lifetime despawn with a scale fade). The dropped mag is a geometry clone
 * that shares the gun's material — no new GLB, so no WebGPU vertex-format or
 * sampler risk (see [[webgpu-interleaved-vertex-format]]).
 *
 * The manager owns only presentation + body lifetime; the Rapier world steps the
 * bodies in the fixed-step sim like any other dynamic body.
 */

import * as THREE from 'three';
import { createDynamicMeshColliderDesc } from '../physics/createDynamicMeshColliderDesc.js';

const DEFAULT_CAPACITY = 8;
const DEFAULT_LIFETIME = 6;
const FADE_DURATION = 0.6;
const DROP_MIN_HALF_EXTENT = 0.01;
const DROP_DENSITY = 1.4;
const DROP_FRICTION = 0.85;
const DROP_RESTITUTION = 0.12;
const DROP_LINEAR_DAMPING = 0.12;
const DROP_ANGULAR_DAMPING = 0.18;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _samplePos = new THREE.Vector3();
const _sampleQuat = new THREE.Quaternion();

/**
 * @param {THREE.Object3D} scene
 * @param {{ capacity?: number, lifetime?: number, fadeDuration?: number }} [opts]
 */
export function createDroppedMagazineManager(scene, {
  capacity = DEFAULT_CAPACITY,
  lifetime = DEFAULT_LIFETIME,
  fadeDuration = FADE_DURATION,
} = {}) {
  /** @type {Array<object>} */
  const props = [];

  /**
   * Spawn a falling clone of `magMesh` at its current world transform.
   * @param {{ magMesh: THREE.Object3D, physicsSystem: object, velocity?: {x,y,z} }} params
   * @returns {object|null} the prop record, or null if physics is unavailable
   */
  function drop({ magMesh, physicsSystem, velocity = null } = {}) {
    const world = physicsSystem?.world;
    const RAPIER = physicsSystem?.RAPIER;
    if (!magMesh?.geometry || !world || !RAPIER || !scene) return null;

    magMesh.updateWorldMatrix(true, false);
    magMesh.matrixWorld.decompose(_pos, _quat, _scale);
    if (!Number.isFinite(_pos.x) || !Number.isFinite(_pos.y) || !Number.isFinite(_pos.z)) return null;

    // Clone the geometry and bake world scale so the collider bounds match the
    // rendered size (the FP gun root may be scaled). Material is shared.
    const geometry = magMesh.geometry.clone();
    geometry.scale(_scale.x, _scale.y, _scale.z);
    geometry.computeBoundingBox();

    const mesh = new THREE.Mesh(geometry, magMesh.material);
    mesh.name = `DroppedMag_${props.length}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.position.copy(_pos);
    mesh.quaternion.copy(_quat);
    scene.add(mesh);

    // Downward-biased ejection with a little outward jitter + tumble.
    const linvel = velocity ?? {
      x: (Math.random() * 2 - 1) * 0.45,
      y: -1.0 - Math.random() * 0.6,
      z: (Math.random() * 2 - 1) * 0.45,
    };
    const angvel = {
      x: (Math.random() * 2 - 1) * 5,
      y: (Math.random() * 2 - 1) * 5,
      z: (Math.random() * 2 - 1) * 5,
    };

    let body = null;
    try {
      body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(_pos.x, _pos.y, _pos.z)
          .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w })
          .setLinvel(linvel.x, linvel.y, linvel.z)
          .setAngvel(angvel)
          .setLinearDamping(DROP_LINEAR_DAMPING)
          .setAngularDamping(DROP_ANGULAR_DAMPING),
      );
    } catch (err) {
      console.warn('[droppedMagazines] rigid body creation failed', err);
      cleanupMesh(mesh);
      return null;
    }

    // Cuboid sized to the mag bounds (hull fallback for odd geometry).
    let colliderType = 'none';
    try {
      const result = createDynamicMeshColliderDesc({
        RAPIER,
        geometry,
        minHalfExtent: DROP_MIN_HALF_EXTENT,
        mode: 'containment',
      });
      const descs = (result?.descs ?? []).filter(Boolean);
      for (const desc of descs) {
        world.createCollider(
          desc.setDensity(DROP_DENSITY).setFriction(DROP_FRICTION).setRestitution(DROP_RESTITUTION),
          body,
        );
      }
      colliderType = descs.length ? (result.type ?? 'unknown') : 'none';
    } catch (err) {
      console.warn('[droppedMagazines] collider creation failed', err);
    }

    const prop = {
      mesh,
      geometry,
      body,
      world,
      colliderType,
      age: 0,
      lifetime,
      fadeDuration,
    };

    props.push(prop);
    // Budget: retire the oldest when over capacity.
    while (props.length > capacity) {
      despawn(props.shift());
    }
    return prop;
  }

  /**
   * Per-frame visual sync + aging. Uses the body's interpolated pose so the
   * dropped mag rides smoothly between fixed steps, like cut props.
   * @param {{ delta: number, physicsSystem: object }} params
   */
  function update({ delta, physicsSystem } = {}) {
    const dt = Math.max(0, Number(delta) || 0);
    const alpha = physicsSystem?.interpolationAlpha ?? 1;

    for (let i = props.length - 1; i >= 0; i -= 1) {
      const prop = props[i];
      if (prop.body) syncMeshToBody(prop, physicsSystem, alpha);

      prop.age += dt;
      if (prop.age >= prop.lifetime) {
        despawn(prop);
        props.splice(i, 1);
        continue;
      }
      // Shrink-fade over the tail of the lifetime (leaves the shared material
      // untouched, unlike an opacity fade).
      const fadeStart = prop.lifetime - prop.fadeDuration;
      if (prop.age > fadeStart) {
        const k = 1 - (prop.age - fadeStart) / prop.fadeDuration;
        prop.mesh.scale.setScalar(Math.max(0.001, k));
      }
    }
  }

  function syncMeshToBody(prop, physicsSystem, alpha) {
    const sampled = physicsSystem?.sampleInterpolatedPose?.(prop.body, alpha, _samplePos, _sampleQuat);
    if (sampled) {
      prop.mesh.position.copy(sampled.position);
      prop.mesh.quaternion.copy(sampled.rotation);
      return;
    }
    try {
      const t = prop.body.translation();
      const r = prop.body.rotation();
      prop.mesh.position.set(t.x, t.y, t.z);
      prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    } catch {
      // Transient Rapier wrapper aliasing — keep last visual pose this frame.
    }
  }

  function despawn(prop) {
    if (!prop) return;
    cleanupMesh(prop.mesh);
    prop.geometry?.dispose?.();
    if (prop.body && prop.world) {
      try { prop.world.removeRigidBody(prop.body); } catch { /* already gone */ }
    }
    prop.body = null;
  }

  function dispose() {
    for (const prop of props) despawn(prop);
    props.length = 0;
  }

  function snapshot() {
    return {
      count: props.length,
      oldestAge: props.length ? Number(Math.max(...props.map((p) => p.age)).toFixed(2)) : 0,
    };
  }

  return { drop, update, despawn, dispose, snapshot, props };
}

function cleanupMesh(mesh) {
  if (!mesh) return;
  mesh.removeFromParent();
}
