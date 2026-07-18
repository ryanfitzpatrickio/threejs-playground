/**
 * Aquarium face shatter: impact-centered CSG fracture from the final bullet
 * hit, then Rapier dynamic shards (cut-prop / dropped-mag path).
 *
 * Fracture pattern:
 *   1. Radial planes through the impact point (spider cracks)
 *   2. Secondary chord planes offset from the impact (irregular big shards)
 * Not a regular grid of squares.
 *
 * Falls back to kinematic CPU integration if physics is unavailable.
 */

import * as THREE from 'three';
import { clipGeometryByPlane } from '../geometry/clipGeometryByPlane.js';
import { createDynamicMeshColliderDesc } from '../physics/createDynamicMeshColliderDesc.js';

const MAX_CHUNKS = 56;
const LIFETIME = 12;
const FADE_DURATION = 2.2;
const DENSITY = 1.8;
const FRICTION = 0.55;
const RESTITUTION = 0.14;
const MIN_HALF = 0.03;
const GRAVITY = 9.81;
/** Primary radial cuts from impact (spider arms). */
const RADIAL_CUTS = 7;
/** Extra irregular chord cuts for non-uniform shards. */
const CHORD_CUTS = 4;

const _samplePos = new THREE.Vector3();
const _sampleQuat = new THREE.Quaternion();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _plane = new THREE.Plane();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _impact = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _e = new THREE.Euler();
const _tmp = new THREE.Vector3();

/**
 * @param {object} [opts]
 * @param {THREE.Object3D} [opts.parent]
 * @param {number} [opts.floorY]
 * @param {string} [opts.name]
 */
export function createGlassPaneShatter({
  parent = null,
  floorY = 0,
  name = 'Aquarium Glass Chunks',
} = {}) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.noStaticMerge = true;
  if (parent) parent.add(group);

  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xc5eef4,
    transparent: true,
    opacity: 0.58,
    roughness: 0.06,
    metalness: 0.04,
    transmission: 0.42,
    thickness: 0.05,
    ior: 1.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  /** @type {Array<object>} */
  const props = [];
  let active = 0;

  function faceBasis(face) {
    // Outward normal + in-plane tangents (u along width, v along height ≈ +Y).
    if (face === '+x') {
      return {
        n: new THREE.Vector3(1, 0, 0),
        u: new THREE.Vector3(0, 0, 1),
        v: new THREE.Vector3(0, 1, 0),
      };
    }
    if (face === '-x') {
      return {
        n: new THREE.Vector3(-1, 0, 0),
        u: new THREE.Vector3(0, 0, -1),
        v: new THREE.Vector3(0, 1, 0),
      };
    }
    if (face === '+z') {
      return {
        n: new THREE.Vector3(0, 0, 1),
        u: new THREE.Vector3(-1, 0, 0),
        v: new THREE.Vector3(0, 1, 0),
      };
    }
    return {
      n: new THREE.Vector3(0, 0, -1),
      u: new THREE.Vector3(1, 0, 0),
      v: new THREE.Vector3(0, 1, 0),
    };
  }

  function buildFaceGeometry({ face, cx, cz, halfSize, bottomY, topY }) {
    const height = Math.max(0.4, topY - bottomY);
    const width = halfSize * 2;
    const thickness = 0.055;
    let geom;
    if (face === '+x' || face === '-x') {
      geom = new THREE.BoxGeometry(thickness, height, width);
      const sign = face === '+x' ? 1 : -1;
      geom.translate(cx + sign * (halfSize - thickness * 0.5), (bottomY + topY) * 0.5, cz);
    } else {
      geom = new THREE.BoxGeometry(width, height, thickness);
      const sign = face === '+z' ? 1 : -1;
      geom.translate(cx, (bottomY + topY) * 0.5, cz + sign * (halfSize - thickness * 0.5));
    }
    geom.computeBoundingBox();
    geom.computeVertexNormals();
    return geom;
  }

  /**
   * Project a world point onto the pane plane (keeps shatter centered on glass).
   */
  function projectToFace(point, face, cx, cz, halfSize, bottomY, topY) {
    const basis = faceBasis(face);
    const planeX = face === '+x' || face === '-x'
      ? cx + (face === '+x' ? 1 : -1) * halfSize
      : THREE.MathUtils.clamp(point?.x ?? cx, cx - halfSize, cx + halfSize);
    const planeZ = face === '+z' || face === '-z'
      ? cz + (face === '+z' ? 1 : -1) * halfSize
      : THREE.MathUtils.clamp(point?.z ?? cz, cz - halfSize, cz + halfSize);
    const y = THREE.MathUtils.clamp(
      Number(point?.y) || (bottomY + topY) * 0.5,
      bottomY + 0.05,
      topY - 0.05,
    );
    if (face === '+x' || face === '-x') {
      return {
        point: new THREE.Vector3(planeX, y, THREE.MathUtils.clamp(point?.z ?? cz, cz - halfSize * 0.92, cz + halfSize * 0.92)),
        basis,
      };
    }
    return {
      point: new THREE.Vector3(THREE.MathUtils.clamp(point?.x ?? cx, cx - halfSize * 0.92, cx + halfSize * 0.92), y, planeZ),
      basis,
    };
  }

  /**
   * Split every piece that a plane cuts into two half-spaces.
   * @param {THREE.BufferGeometry[]} pieces
   * @param {THREE.Plane} plane
   * @param {THREE.BufferGeometry} [rootSource] never dispose this
   */
  function splitPiecesByPlane(pieces, plane, rootSource = null) {
    const next = [];
    for (const geom of pieces) {
      if (!geom?.getAttribute('position') || geom.getAttribute('position').count < 3) {
        if (geom && geom !== rootSource) geom.dispose?.();
        continue;
      }
      const pos = clipGeometryByPlane(geom, plane, 1, { includeCap: true });
      const neg = clipGeometryByPlane(geom, plane, -1, { includeCap: true });
      if (geom !== rootSource) geom.dispose?.();

      let kept = 0;
      if (pos && pos.getAttribute('position')?.count >= 9) {
        next.push(pos);
        kept += 1;
      } else {
        pos?.dispose?.();
      }
      if (neg && neg.getAttribute('position')?.count >= 9) {
        next.push(neg);
        kept += 1;
      } else {
        neg?.dispose?.();
      }
      // If both sides failed, drop the piece (degenerate).
      void kept;
    }
    return next;
  }

  /**
   * Impact spider fracture: radial planes through the hit, then irregular chords.
   * @returns {THREE.BufferGeometry[]}
   */
  function impactFracture(source, impactPoint, basis, halfSize) {
    let pieces = [source];
    const { u, v } = basis;

    // 1) Radial cracks — irregular angular spacing for organic look.
    let angle = Math.random() * Math.PI * 0.15;
    for (let i = 0; i < RADIAL_CUTS; i += 1) {
      const step = (Math.PI * 2) / RADIAL_CUTS;
      angle += step * (0.72 + Math.random() * 0.55);
      // Plane through impact, perpendicular to the face, oriented by angle in-plane.
      _pn.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle)).normalize();
      _plane.setFromNormalAndCoplanarPoint(_pn, impactPoint);
      pieces = splitPiecesByPlane(pieces, _plane, source);
      if (pieces.length >= MAX_CHUNKS - 4) break;
    }

    // 2) Chord cuts — planes that miss the impact so shards aren't pure pie slices.
    //    Offset along a random in-plane direction by a fraction of pane size.
    for (let i = 0; i < CHORD_CUTS && pieces.length < MAX_CHUNKS - 2; i += 1) {
      const a = Math.random() * Math.PI * 2;
      _pn.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)).normalize();
      const offset = (0.18 + Math.random() * 0.55) * halfSize * (Math.random() < 0.5 ? 1 : -1);
      _tmp.copy(impactPoint).addScaledVector(_pn, offset);
      // Chord plane roughly parallel to a radial, offset from impact.
      const a2 = a + Math.PI * 0.5 + (Math.random() - 0.5) * 0.6;
      _t.copy(u).multiplyScalar(Math.cos(a2)).addScaledVector(v, Math.sin(a2)).normalize();
      _plane.setFromNormalAndCoplanarPoint(_t, _tmp);
      pieces = splitPiecesByPlane(pieces, _plane, source);
    }

    // Don't leave the original unsplit source as the only piece without ownership transfer.
    return pieces.filter((g) => g && g.getAttribute('position')?.count >= 9);
  }

  /**
   * Shatter one tank face from the final bullet impact.
   * @param {object} opts
   * @param {{ x:number, y:number, z:number }} [opts.impactPoint]
   * @param {object} [opts.physicsSystem]
   * @param {THREE.Mesh} [opts.faceMesh]
   */
  function shatterFace({
    face,
    cx,
    cz,
    halfSize,
    bottomY,
    topY,
    impactPoint = null,
    physicsSystem = null,
    faceMesh = null,
  }) {
    const n = face === '+x' ? { x: 1, z: 0 }
      : face === '-x' ? { x: -1, z: 0 }
        : face === '+z' ? { x: 0, z: 1 }
          : { x: 0, z: -1 };

    let source = null;
    if (faceMesh?.geometry) {
      faceMesh.updateWorldMatrix(true, false);
      source = faceMesh.geometry.clone();
      source.applyMatrix4(faceMesh.matrixWorld);
      source.computeBoundingBox();
      source.computeVertexNormals();
    } else {
      source = buildFaceGeometry({ face, cx, cz, halfSize, bottomY, topY });
    }

    const projected = projectToFace(impactPoint, face, cx, cz, halfSize, bottomY, topY);
    _impact.copy(projected.point);

    let shards = impactFracture(source, _impact, projected.basis, halfSize);
    // If fracture failed, fall back to whole pane as one shard.
    if (!shards.length) {
      shards = [source];
    } else if (!shards.includes(source)) {
      source.dispose?.();
    }

    const world = physicsSystem?.world ?? null;
    const RAPIER = physicsSystem?.RAPIER ?? null;
    const useRapier = Boolean(world && RAPIER);

    for (const geom of shards) {
      if (!geom?.getAttribute('position') || geom.getAttribute('position').count < 3) {
        geom?.dispose?.();
        continue;
      }
      if (props.length >= MAX_CHUNKS) {
        despawn(props.shift());
      }

      geom.computeBoundingBox();
      const box = geom.boundingBox;
      if (!box) {
        geom.dispose();
        continue;
      }
      box.getCenter(_center);
      box.getSize(_size);

      // Reject tiny dust fragments — keep big impact shards.
      const maxDim = Math.max(_size.x, _size.y, _size.z);
      if (maxDim < 0.12) {
        geom.dispose();
        continue;
      }

      geom.translate(-_center.x, -_center.y, -_center.z);
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      geom.computeVertexNormals();

      const mesh = new THREE.Mesh(geom, glassMaterial);
      mesh.position.copy(_center);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.userData.noStaticMerge = true;
      mesh.userData.skipLevelRaycast = true;
      mesh.renderOrder = 7;
      group.add(mesh);

      // Impulse stronger near the impact (closer shards fly harder).
      const dist = _center.distanceTo(_impact);
      const near = THREE.MathUtils.clamp(1.35 - dist / (halfSize * 2.2), 0.45, 1.35);
      const burst = (2.8 + Math.random() * 3.4) * near;
      // Slight bias away from impact along face plane + strong outward normal.
      _tmp.copy(_center).sub(_impact);
      _tmp.y *= 0.6;
      if (_tmp.lengthSq() < 1e-6) _tmp.set(n.x, 0.2, n.z);
      else _tmp.normalize();

      const linvel = {
        x: n.x * burst * 0.85 + _tmp.x * burst * 0.55 + (Math.random() - 0.5) * 1.2,
        y: 1.4 + Math.random() * 2.8 * near + Math.max(0, _tmp.y) * 1.2,
        z: n.z * burst * 0.85 + _tmp.z * burst * 0.55 + (Math.random() - 0.5) * 1.2,
      };
      const angvel = {
        x: (Math.random() - 0.5) * 12 * near,
        y: (Math.random() - 0.5) * 14 * near,
        z: (Math.random() - 0.5) * 12 * near,
      };

      let body = null;
      let colliderType = 'cpu';
      if (useRapier) {
        try {
          body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
              .setTranslation(_center.x, _center.y, _center.z)
              .setLinvel(linvel.x, linvel.y, linvel.z)
              .setAngvel(angvel)
              .setLinearDamping(0.1)
              .setAngularDamping(0.18),
          );
          const result = createDynamicMeshColliderDesc({
            RAPIER,
            geometry: geom,
            fallbackSize: _size,
            minHalfExtent: MIN_HALF,
            mode: 'containment',
          });
          for (const desc of result?.descs ?? []) {
            world.createCollider(
              desc.setDensity(DENSITY).setFriction(FRICTION).setRestitution(RESTITUTION),
              body,
            );
          }
          colliderType = result?.type ?? 'containment';
        } catch (err) {
          console.warn('[aquarium-glass] Rapier shard failed; CPU fallback', err);
          body = null;
          colliderType = 'cpu';
        }
      }

      props.push({
        mesh,
        geometry: geom,
        body,
        world: body ? world : null,
        colliderType,
        x: _center.x,
        y: _center.y,
        z: _center.z,
        vx: linvel.x,
        vy: linvel.y,
        vz: linvel.z,
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI,
        rz: Math.random() * Math.PI,
        wrx: angvel.x,
        wry: angvel.y,
        wrz: angvel.z,
        age: 0,
        lifetime: LIFETIME,
        fadeDuration: FADE_DURATION,
        settled: false,
      });
    }

    active = props.length;
  }

  function syncMeshToBody(prop, physicsSystem, alpha) {
    const sampled = physicsSystem?.sampleInterpolatedPose?.(
      prop.body,
      alpha,
      _samplePos,
      _sampleQuat,
    );
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
      // keep last pose
    }
  }

  function updateCpu(prop, step) {
    if (prop.settled) return;
    prop.vy -= GRAVITY * step;
    prop.x += prop.vx * step;
    prop.y += prop.vy * step;
    prop.z += prop.vz * step;
    prop.rx += prop.wrx * step;
    prop.ry += prop.wry * step;
    prop.rz += prop.wrz * step;
    prop.vx *= 0.992;
    prop.vz *= 0.992;
    if (prop.y <= floorY + 0.04) {
      prop.y = floorY + 0.04;
      prop.vy *= -0.12;
      prop.vx *= 0.5;
      prop.vz *= 0.5;
      if (Math.abs(prop.vy) < 0.35 && Math.hypot(prop.vx, prop.vz) < 0.3) {
        prop.settled = true;
        prop.vx = prop.vy = prop.vz = 0;
        prop.wrx = prop.wry = prop.wrz = 0;
      }
    }
    _e.set(prop.rx, prop.ry, prop.rz);
    prop.mesh.position.set(prop.x, prop.y, prop.z);
    prop.mesh.quaternion.setFromEuler(_e);
  }

  function despawn(prop) {
    if (!prop) return;
    if (prop.mesh) {
      prop.mesh.parent?.remove(prop.mesh);
      prop.geometry?.dispose?.();
    }
    if (prop.body && prop.world) {
      try { prop.world.removeRigidBody(prop.body); } catch { /* gone */ }
    }
    prop.body = null;
  }

  function update(dt = 0, physicsSystem = null) {
    const step = Math.max(0, Math.min(0.05, dt));
    const alpha = physicsSystem?.interpolationAlpha ?? 1;
    for (let i = props.length - 1; i >= 0; i -= 1) {
      const prop = props[i];
      prop.age += step;
      if (prop.age >= prop.lifetime) {
        despawn(prop);
        props.splice(i, 1);
        continue;
      }
      if (prop.body) syncMeshToBody(prop, physicsSystem, alpha);
      else updateCpu(prop, step);

      const fadeStart = prop.lifetime - prop.fadeDuration;
      if (prop.age > fadeStart) {
        const k = 1 - (prop.age - fadeStart) / prop.fadeDuration;
        prop.mesh.scale.setScalar(Math.max(0.001, k));
      }
    }
    active = props.length;
  }

  function snapshot() {
    return {
      activeChunks: active,
      poolSize: MAX_CHUNKS,
      mode: props.some((p) => p.body) ? 'rapier+impact-csg' : (props.length ? 'cpu+impact-csg' : 'idle'),
      rapierCount: props.filter((p) => p.body).length,
      cpuCount: props.filter((p) => !p.body).length,
      fracture: 'radial+chord',
    };
  }

  function dispose() {
    while (props.length) despawn(props.pop());
    group.parent?.remove(group);
    glassMaterial.dispose();
    active = 0;
  }

  return {
    group,
    mesh: group,
    shatterFace,
    update,
    snapshot,
    dispose,
    get activeChunks() { return active; },
  };
}
