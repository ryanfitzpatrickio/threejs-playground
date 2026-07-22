/**
 * Hero-dog ragdoll for mud flop.
 *
 * Flow:
 *   inactive → limp (pure physics, no springs) → hold until time up
 *   → capture bone locals → destroy physics → blend slerp into standing rest
 *   → inactive (procedural idle resumes)
 *
 * No pose-spring “recover” — that fought gravity and looked like a seizure.
 */

import * as THREE from 'three';

/**
 * Compact body graph. Torso half-extents are intentionally chunky so a side-
 * lying dog rests on the floor (bone centers sit high on a standing skeleton).
 */
export const DOG_RAGDOLL_PARTS = Object.freeze([
  { bone: 'Pelvis', parent: null, hx: 0.15, hy: 0.12, hz: 0.17, mass: 6.5 },
  { bone: 'Chest', parent: 'Pelvis', hx: 0.16, hy: 0.13, hz: 0.18, mass: 5.5 },
  { bone: 'Head', parent: 'Chest', hx: 0.08, hy: 0.07, hz: 0.1, mass: 1.4 },
  { bone: 'UpperArmL', parent: 'Chest', hx: 0.045, hy: 0.1, hz: 0.045, mass: 0.9 },
  { bone: 'ForearmL', parent: 'UpperArmL', hx: 0.04, hy: 0.11, hz: 0.04, mass: 0.55 },
  { bone: 'UpperArmR', parent: 'Chest', hx: 0.045, hy: 0.1, hz: 0.045, mass: 0.9 },
  { bone: 'ForearmR', parent: 'UpperArmR', hx: 0.04, hy: 0.11, hz: 0.04, mass: 0.55 },
  { bone: 'ThighL', parent: 'Pelvis', hx: 0.05, hy: 0.1, hz: 0.055, mass: 1.1 },
  { bone: 'ShinL', parent: 'ThighL', hx: 0.04, hy: 0.11, hz: 0.045, mass: 0.65 },
  { bone: 'ThighR', parent: 'Pelvis', hx: 0.05, hy: 0.1, hz: 0.055, mass: 1.1 },
  { bone: 'ShinR', parent: 'ThighR', hx: 0.04, hy: 0.11, hz: 0.045, mass: 0.65 },
]);

const LINEAR_DAMP = 2.2;
const ANGULAR_DAMP = 4.0;
const FRICTION = 1.25;
/** Extra downward accel while limp so the body settles onto the floor. */
const GROUND_PULL = 42;
/** Approx support radius factor from cuboid half-extents when on its side. */
const SUPPORT_RADIUS_SCALE = 0.95;
/** Membership = ragdoll group 2; filter = world group only (matches cut ragdolls). */
const DOG_RAGDOLL_MEMBERSHIP = 0x0002;
const DOG_RAGDOLL_FILTER = 0x0001;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _world = new THREE.Matrix4();
const _parentInv = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _boneScale = new THREE.Vector3();
const _current = new THREE.Quaternion();
const _impulse = new THREE.Vector3();
const _fromPos = new THREE.Vector3();
const _toPos = new THREE.Vector3();
const _fromQuat = new THREE.Quaternion();
const _toQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

/**
 * @param {object} dog createProceduralDog handle
 * @param {object} physicsSystem PhysicsSystem (needs .world, .RAPIER)
 */
export class DogActiveRagdoll {
  constructor(dog, physicsSystem) {
    this.dog = dog;
    this.physics = physicsSystem;
    /** @type {'inactive'|'limp'|'blend'} */
    this.mode = 'inactive';
    this.timer = 0;
    this.limpDuration = 1.8;
    this.blendDuration = 0.75;
    this.blendT = 0;
    /** @type {Array<object>} */
    this.records = [];
    /** @type {Array<object>} */
    this.joints = [];
    this._order = [];
    /** @type {Map<string, { pos: THREE.Vector3, quat: THREE.Quaternion }> | null} */
    this._blendFrom = null;
    this._sampleGround = null;
    /** Ground-plane facing locked for stand-up blend (rad). */
    this._recoveryYaw = 0;
  }

  get active() {
    return this.mode !== 'inactive';
  }

  /**
   * Rebind dog handle (after breed rebuild) without losing the physics system ref.
   * @param {object} dog
   */
  setDog(dog) {
    if (this.active) this.deactivate({ snapRoot: false, skipBlend: true });
    this.dog = dog;
  }

  /**
   * Begin physical flop. Call at puddle impact (or hit).
   * @param {{
   *   headingX?: number,
   *   headingZ?: number,
   *   impulse?: number,
   *   limpDuration?: number,
   *   blendDuration?: number,
   *   recoverDuration?: number,
   * }} [opts]
   */
  activate(opts = {}) {
    if (!this.physics?.world || !this.physics?.RAPIER || !this.dog?.rig) {
      return false;
    }
    if (this.active) this.deactivate({ snapRoot: false, skipBlend: true });

    const RAPIER = this.physics.RAPIER;
    const world = this.physics.world;
    const bones = this.dog.rig.bonesByName;
    const scale = this.dog.phenotype?.skeleton?.scale ?? 1;

    this.dog.root?.updateMatrixWorld?.(true);
    this.dog.rig.root.updateMatrixWorld(true);
    this.records = [];
    this.joints = [];
    this._order = [];
    this._blendFrom = null;
    this.blendT = 0;

    const byName = new Map();

    for (const part of DOG_RAGDOLL_PARTS) {
      const bone = bones.get(part.bone);
      if (!bone) continue;
      bone.updateMatrixWorld(true);
      bone.matrixWorld.decompose(_pos, _quat, _scale);

      const hx = part.hx * scale * 0.9;
      const hy = part.hy * scale * 0.9;
      const hz = part.hz * scale * 0.9;
      // Support radius ≈ half body thickness when rolled onto a side.
      const supportR = Math.max(hx, hy, hz) * SUPPORT_RADIUS_SCALE;

      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(_pos.x, _pos.y, _pos.z)
        .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w })
        .setLinearDamping(LINEAR_DAMP)
        .setAngularDamping(ANGULAR_DAMP)
        .setCanSleep(true);
      if (typeof bodyDesc.setGravityScale === 'function') {
        // Slightly heavy so the flop lands; ground pin still owns rest height.
        bodyDesc.setGravityScale(1.55);
      }
      if (typeof bodyDesc.setCcdEnabled === 'function') {
        bodyDesc.setCcdEnabled(true);
      }
      const body = world.createRigidBody(bodyDesc);

      const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setMass(part.mass * scale)
        .setFriction(FRICTION)
        .setRestitution(0);
      const groups = (DOG_RAGDOLL_MEMBERSHIP << 16) | DOG_RAGDOLL_FILTER;
      if (typeof colliderDesc.setCollisionGroups === 'function') {
        colliderDesc.setCollisionGroups(groups);
      }
      if (typeof colliderDesc.setSolverGroups === 'function') {
        colliderDesc.setSolverGroups(groups);
      }
      world.createCollider(colliderDesc, body);

      const record = {
        name: part.bone,
        parentName: part.parent,
        bone,
        body,
        supportR,
        isCore: part.bone === 'Pelvis' || part.bone === 'Chest',
        initialPosition: new THREE.Vector3(_pos.x, _pos.y, _pos.z),
        initialQuaternion: _quat.clone(),
        parentRecord: null,
      };
      this.records.push(record);
      byName.set(part.bone, record);
    }

    if (!this.records.length) return false;

    // Procedural flop leaves bone centers high (~torso height). Drop the whole
    // articulated graph so the lowest support sphere rests on the floor —
    // relative pose and joint anchors stay valid.
    this._settleBodiesOntoGround();

    for (const record of this.records) {
      if (!record.parentName) continue;
      const parent = byName.get(record.parentName);
      if (!parent) continue;
      record.parentRecord = parent;

      const parentAnchor = worldPointToBodyLocal(
        record.initialPosition,
        parent.initialPosition,
        parent.initialQuaternion,
      );
      const childAnchor = worldPointToBodyLocal(
        record.initialPosition,
        record.initialPosition,
        record.initialQuaternion,
      );
      try {
        const jointData = RAPIER.JointData.spherical(parentAnchor, childAnchor);
        const joint = world.createImpulseJoint(jointData, parent.body, record.body, true);
        this.joints.push(joint);
      } catch (err) {
        console.warn('[dog-ragdoll] joint failed', record.name, err);
      }
    }

    this._order = [...this.records].sort((a, b) => boneDepth(a.bone) - boneDepth(b.bone));

    // Soft settle — procedural pose already rolled the dog. Prefer lateral tip
    // over upward bounce so we don't launch off the ground.
    const hx = Number(opts.headingX) || 0;
    const hz = Number(opts.headingZ) || 1;
    const hLen = Math.hypot(hx, hz) || 1;
    const impulse = Number.isFinite(opts.impulse) ? opts.impulse : 1.4 * scale;
    _impulse.set((hx / hLen) * impulse * 0.35, Math.min(impulse * 0.04, 0.35), (hz / hLen) * impulse * 0.35);
    const pelvis = byName.get('Pelvis');
    const chest = byName.get('Chest');
    try {
      pelvis?.body.applyImpulse(_impulse, true);
      chest?.body.applyImpulse({
        x: _impulse.x * 0.35,
        y: _impulse.y * 0.35,
        z: _impulse.z * 0.35,
      }, true);
      pelvis?.body.applyTorqueImpulse({
        x: (hz / hLen) * 0.4 * scale,
        y: 0,
        z: (-hx / hLen) * 0.4 * scale,
      }, true);
    } catch (err) {
      console.warn('[dog-ragdoll] impulse failed', err);
    }

    this.limpDuration = opts.limpDuration ?? 1.85;
    this.blendDuration = opts.blendDuration
      ?? opts.recoverDuration
      ?? 0.8;
    this.timer = this.limpDuration;
    this.mode = 'limp';

    this.dog.animation?.clearFlop?.();
    this.dog.animation?.setClipDriven?.(false);
    this.dog.animation?.setExternalRootMotion?.(false);
    return true;
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    if (!this.active) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);

    if (this.mode === 'limp') {
      this.timer -= dt;

      // Soften residual spin; stay limp (no springs). Sink the whole graph if
      // the torso is still hovering, then pin individuals for contact.
      for (const record of this.records) {
        this._capAngularVelocity(record.body, 3.5);
      }
      this._sinkFloatingGraph(dt);
      for (const record of this.records) {
        this._pinBodyToGround(record, dt);
      }

      // Root first, then bone world→local. Moving root *after* sync re-lifts the
      // mesh above the physics bodies (the float the player sees).
      this._alignRootUnderPelvis();
      syncBonesFromBodies(this._order);
      this.dog?.rig?.root?.updateMatrixWorld?.(true);
      this.dog?.rig?.skeleton?.update?.();

      if (this.timer <= 0) {
        this._beginBlendFromCurrentPose();
      }
      return;
    }

    if (this.mode === 'blend') {
      this.blendT = Math.min(1, this.blendT + dt / Math.max(0.15, this.blendDuration));
      // Keep facing locked while bones slerp upright — otherwise desiredDir /
      // stale rootYaw can drift the stand-up mid-blend.
      this._applyRecoveryFacing(this._recoveryYaw);
      // Smoothstep for a soft settle into stand.
      const u = this.blendT;
      const s = u * u * (3 - 2 * u);
      this._applyPoseBlend(s);

      if (this.blendT >= 1) {
        this._finishBlend();
      }
    }
  }

  /**
   * Capture flopped locals, snap root, kill physics, start slerp to rest.
   */
  _beginBlendFromCurrentPose() {
    // Sample facing from the limp body *before* we rewrite root yaw. Euler-Y
    // of a side-rolled pelvis is wrong; spine / bone +Z on XZ match locomotion.
    const yaw = this._extractLimpHeading()
      ?? this.dog?.animation?.getRootYaw?.()
      ?? 0;
    this._recoveryYaw = yaw;

    this._alignRootUnderPelvis();
    this._applyRecoveryFacing(yaw);
    // Bone locals must be captured under the recovery root yaw so the stand-up
    // rest pose (also under that yaw) doesn't twist at the end of the blend.
    syncBonesFromBodies(this._order);
    this.dog?.rig?.root?.updateMatrixWorld?.(true);

    // Capture every bone's local TRS after snap (world→local may shift slightly).
    this.dog.root?.updateMatrixWorld?.(true);
    this.dog.rig.root.updateMatrixWorld(true);
    this._blendFrom = new Map();
    for (const bone of this.dog.rig.bonesByName.values()) {
      this._blendFrom.set(bone.name, {
        pos: bone.position.clone(),
        quat: bone.quaternion.clone(),
      });
    }

    // Destroy physics — pose is frozen in _blendFrom / current bones.
    this._destroyPhysics();
    this.mode = 'blend';
    this.blendT = 0;
    this.timer = 0;
  }

  /**
   * Ground-plane heading of the limp torso (rad). Prefers pelvis→chest spine
   * projected onto XZ; falls back to pelvis bone-forward (+Z) projected.
   * @returns {number | null}
   */
  _extractLimpHeading() {
    const pelvis = this.records.find((r) => r.name === 'Pelvis');
    const chest = this.records.find((r) => r.name === 'Chest');
    if (!pelvis?.body) return null;

    try {
      if (chest?.body) {
        const p = pelvis.body.translation();
        const c = chest.body.translation();
        const dx = c.x - p.x;
        const dz = c.z - p.z;
        if (dx * dx + dz * dz > 1e-5) {
          return Math.atan2(dx, dz);
        }
      }
      const rot = pelvis.body.rotation();
      return headingFromBodyForward(rot);
    } catch {
      return null;
    }
  }

  /**
   * Lock animation root yaw + aim dir so stand-up and post-recover locomotion
   * share one ground heading.
   * @param {number} yaw
   */
  _applyRecoveryFacing(yaw) {
    if (!Number.isFinite(yaw)) return;
    this._recoveryYaw = yaw;
    this.dog?.animation?.setRootYaw?.(yaw);
    // Keep steer target aligned — otherwise first gait frame turns toward the
    // pre-flop desiredDir and the finish facing disagrees with the get-up.
    this.dog?.animation?.setDesiredDirection?.(Math.sin(yaw), Math.cos(yaw));
  }

  /**
   * @param {number} s 0..1 smoothstep blend toward rest pose
   */
  _applyPoseBlend(s) {
    const rig = this.dog?.rig;
    if (!rig || !this._blendFrom) return;
    const restQ = rig.restQuaternions;
    const restP = rig.restPositions;

    for (const [name, from] of this._blendFrom) {
      const bone = rig.bonesByName.get(name);
      if (!bone) continue;
      const toQ = restQ.get(name);
      const toP = restP.get(name);
      if (toQ) {
        bone.quaternion.copy(from.quat).slerp(toQ, s);
      }
      if (toP) {
        bone.position.lerpVectors(from.pos, toP, s);
      }
    }
    rig.root.updateMatrixWorld(true);
    rig.skeleton?.update?.();
  }

  _finishBlend() {
    this._blendFrom = null;
    this.blendT = 0;
    this.mode = 'inactive';
    // Hand control back to procedural idle, facing the locked recovery heading.
    this.dog.animation?.clearFlop?.();
    this.dog.animation?.setBehavior?.('idle');
    this.dog.animation?.setExternalRootMotion?.(true);
    this.dog.animation?.setClipDriven?.(false);
    this._applyRecoveryFacing(this._recoveryYaw);
    // Ensure rest pose is clean for the next gait frame.
    const rig = this.dog?.rig;
    if (rig) {
      for (const bone of rig.bonesByName.values()) {
        const q = rig.restQuaternions.get(bone.name);
        const p = rig.restPositions.get(bone.name);
        if (q) bone.quaternion.copy(q);
        if (p) bone.position.copy(p);
      }
      // Clear flop root drop so plant/cam sit on dog.root only.
      if (typeof this.dog.animation?.setRootPosition === 'function') {
        this.dog.animation.setRootPosition(0, 0, 0);
      } else {
        rig.root.position.set(0, 0, 0);
      }
      this._applyRecoveryFacing(this._recoveryYaw);
      rig.root.updateMatrixWorld(true);
      rig.skeleton?.update?.();
    }
  }

  _destroyPhysics() {
    const world = this.physics?.world;
    for (const joint of this.joints) {
      try { world?.removeImpulseJoint?.(joint, true); } catch { /* ignore */ }
    }
    for (const record of this.records) {
      try { world?.removeRigidBody?.(record.body); } catch { /* ignore */ }
    }
    this.joints = [];
    this.records = [];
    this._order = [];
  }

  /**
   * @param {(x: number, z: number) => number} fn
   */
  setGroundSampler(fn) {
    this._sampleGround = typeof fn === 'function' ? fn : null;
  }

  /**
   * Drop every body by the same ΔY so the pelvis rests on the floor.
   * Using the global lowest limb is wrong for standing/half-tip poses — feet
   * already touch the floor while Pelvis/Chest float at standing height.
   * Call before joints so anchors match the settled pose.
   */
  _settleBodiesOntoGround() {
    if (!this.records.length) return;
    const pelvis = this.records.find((r) => r.name === 'Pelvis')
      ?? this.records.find((r) => r.isCore)
      ?? this.records[0];

    let t;
    try {
      t = pelvis.body.translation();
    } catch {
      return;
    }
    const gy = this._sampleGround?.(t.x, t.z);
    const floorY = Number.isFinite(gy) ? gy : 0;
    const supportR = pelvis.supportR ?? 0.12;
    // Clearance so cuboids don't start deeply penetrating the floor plane.
    const targetY = floorY + supportR + 0.008;
    const deltaY = targetY - t.y;
    if (Math.abs(deltaY) < 0.006) return;

    this._translateAllBodies(deltaY);
  }

  /**
   * Rigid Y shift of the whole body graph (preserves joint rest distances).
   * @param {number} deltaY
   * @param {{ updateInitial?: boolean, killVel?: boolean }} [opts]
   */
  _translateAllBodies(deltaY, opts = {}) {
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 1e-5) return;
    const updateInitial = opts.updateInitial !== false;
    const killVel = opts.killVel !== false;
    for (const record of this.records) {
      let t;
      try {
        t = record.body.translation();
      } catch {
        continue;
      }
      const ny = t.y + deltaY;
      try {
        record.body.setTranslation({ x: t.x, y: ny, z: t.z }, true);
      } catch { /* ignore */ }
      if (updateInitial && record.initialPosition) {
        record.initialPosition.y = ny;
      }
      if (killVel) {
        this._setLinvelSafe(record.body, { x: 0, y: 0, z: 0 });
      }
    }
  }

  /**
   * If the torso still hovers as a unit, sink the whole graph together.
   * Per-body pin alone fights spherical joints and leaves a floating pile.
   */
  _sinkFloatingGraph(dt) {
    const cores = this.records.filter((r) => r.isCore);
    if (!cores.length) return;

    let floorY = 0;
    let maxGap = -Infinity;
    let refSupport = 0.12;
    for (const record of cores) {
      let t;
      try {
        t = record.body.translation();
      } catch {
        continue;
      }
      const gy = this._sampleGround?.(t.x, t.z);
      const f = Number.isFinite(gy) ? gy : 0;
      floorY = f;
      const supportR = record.supportR ?? 0.12;
      refSupport = supportR;
      const gap = (t.y - supportR) - f;
      if (gap > maxGap) maxGap = gap;
    }
    if (!Number.isFinite(maxGap) || maxGap < 0.04) return;

    // Soft sink: don't slam; pin will finish contact.
    const step = Math.min(maxGap * Math.min(1, dt * 14), maxGap - 0.01, 0.12);
    if (step > 0.002) {
      this._translateAllBodies(-step, { updateInitial: false, killVel: false });
    }

    // Hard snap if still badly elevated (e.g. missed first frames).
    if (maxGap > 0.2) {
      const pelvis = this.records.find((r) => r.name === 'Pelvis') ?? cores[0];
      let t;
      try {
        t = pelvis.body.translation();
      } catch {
        return;
      }
      const targetY = floorY + (pelvis.supportR ?? refSupport) + 0.01;
      this._translateAllBodies(targetY - t.y, { updateInitial: false, killVel: true });
    }
  }

  /**
   * Outer group under pelvis, ground Y for cam/plant. Clears flop root drop so
   * bone world→local is computed against a stable parent.
   */
  _alignRootUnderPelvis() {
    const pelvis = this.records.find((r) => r.name === 'Pelvis');
    if (!pelvis || !this.dog?.root) return;
    let t;
    try {
      t = pelvis.body.translation();
    } catch {
      return;
    }
    const groundY = this._sampleGround?.(t.x, t.z);
    this.dog.root.position.x = t.x;
    this.dog.root.position.z = t.z;
    this.dog.root.position.y = Number.isFinite(groundY) ? groundY : this.dog.root.position.y;
    // Flop animation may have offset rig.root.y; zero it so skinning matches physics.
    if (this.dog.rig?.root) {
      this.dog.rig.root.position.set(0, 0, 0);
    }
    this.dog.root.updateMatrixWorld?.(true);
  }

  /**
   * Keep a body from floating. Bone centers sit high; cuboids alone often
   * hover. Pin the support sphere onto the sampled ground plane each tick.
   * @param {object} record
   * @param {number} dt
   */
  _pinBodyToGround(record, dt) {
    const body = record.body;
    if (!body) return;
    let t;
    try {
      t = body.translation();
    } catch {
      return;
    }
    const groundY = this._sampleGround?.(t.x, t.z);
    const floorY = Number.isFinite(groundY) ? groundY : 0;
    const supportR = record.supportR ?? 0.14;
    const bottom = t.y - supportR;
    const gap = bottom - floorY;
    const targetY = floorY + supportR;

    // Resting / slight hover: clamp onto surface.
    if (gap < 0.05) {
      if (Math.abs(t.y - targetY) > 0.003) {
        try {
          body.setTranslation({ x: t.x, y: targetY, z: t.z }, true);
        } catch { /* ignore */ }
      }
      const lv = this._getLinvel(body);
      if (lv && (lv.y < 0 || gap < 0)) {
        this._setLinvelSafe(body, { x: lv.x * 0.75, y: 0, z: lv.z * 0.75 });
      }
      return;
    }

    // Floating: pull down hard. Core bodies snap if still badly elevated —
    // joints alone often leave the torso hovering after a high-center flop.
    const mass = (typeof body.mass === 'function' ? body.mass() : 1) || 1;
    const pull = Math.min(gap * GROUND_PULL, 70) * mass * Math.max(dt, 1 / 120);
    try {
      body.applyImpulse({ x: 0, y: -pull, z: 0 }, true);
    } catch { /* ignore */ }

    const lv = this._getLinvel(body);
    if (lv) {
      this._setLinvelSafe(body, {
        x: lv.x * 0.88,
        y: Math.min(lv.y, -2.4),
        z: lv.z * 0.88,
      });
    }

    const snapGap = record.isCore ? 0.12 : 0.28;
    if (gap > snapGap) {
      try {
        body.setTranslation({ x: t.x, y: targetY + 0.01, z: t.z }, true);
      } catch { /* ignore */ }
      if (lv) {
        this._setLinvelSafe(body, { x: lv.x * 0.35, y: 0, z: lv.z * 0.35 });
      } else {
        this._setLinvelSafe(body, { x: 0, y: 0, z: 0 });
      }
    }
  }

  /** @param {object} body @param {number} maxMag */
  _capAngularVelocity(body, maxMag) {
    if (!body || typeof body.angvel !== 'function' || typeof body.setAngvel !== 'function') {
      return;
    }
    try {
      const av = body.angvel();
      const mag = Math.hypot(av.x, av.y, av.z);
      if (mag > maxMag) {
        const s = maxMag / mag;
        body.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, true);
      }
    } catch { /* ignore */ }
  }

  /** @param {object} body */
  _getLinvel(body) {
    if (!body || typeof body.linvel !== 'function') return null;
    try {
      return body.linvel();
    } catch {
      return null;
    }
  }

  /** @param {object} body @param {{x:number,y:number,z:number}} v */
  _setLinvelSafe(body, v) {
    if (!body || typeof body.setLinvel !== 'function') return;
    try {
      body.setLinvel(v, true);
    } catch { /* ignore */ }
  }

  /**
   * @param {{ snapRoot?: boolean, skipBlend?: boolean }} [opts]
   */
  deactivate(opts = {}) {
    if (this.mode === 'inactive' && !this.records.length && !this._blendFrom) return;

    if (this.mode === 'limp' && opts.skipBlend !== true) {
      // Interrupt limp → still blend out cleanly.
      this._beginBlendFromCurrentPose();
      return;
    }

    if (this.mode === 'blend' && opts.skipBlend !== true) {
      this._finishBlend();
      return;
    }

    this._destroyPhysics();
    this._blendFrom = null;
    this.blendT = 0;
    this.mode = 'inactive';
    this.timer = 0;
    this.dog.animation?.setExternalRootMotion?.(true);
    this.dog.animation?.setClipDriven?.(false);
  }

  snapshot() {
    return {
      active: this.active,
      mode: this.mode,
      timer: Number(this.timer.toFixed(2)),
      blendT: Number(this.blendT.toFixed(3)),
      bodies: this.records.length,
      joints: this.joints.length,
    };
  }

  dispose() {
    this.deactivate({ snapRoot: false, skipBlend: true });
    this.dog = null;
    this.physics = null;
  }
}

function boneDepth(bone) {
  let d = 0;
  let p = bone?.parent;
  while (p) {
    d += 1;
    p = p.parent;
  }
  return d;
}

/**
 * Project rigid-body local +Z onto the ground plane → locomotion yaw.
 * Stable under side-roll (unlike extracting euler Y from the full quat).
 * @param {{ x: number, y: number, z: number, w: number }} rot
 * @returns {number | null}
 */
export function headingFromBodyForward(rot) {
  if (!rot) return null;
  _quat.set(rot.x, rot.y, rot.z, rot.w);
  _fwd.set(0, 0, 1).applyQuaternion(_quat);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-8) return null;
  _fwd.normalize();
  return Math.atan2(_fwd.x, _fwd.z);
}

function worldPointToBodyLocal(point, bodyPosition, bodyQuaternion) {
  return point.clone()
    .sub(bodyPosition)
    .applyQuaternion(bodyQuaternion.clone().invert());
}

function syncBonesFromBodies(order) {
  for (const record of order) {
    const t = record.body.translation();
    const r = record.body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    setBoneWorldTransform(record.bone, _pos, _quat);
  }
}

function setBoneWorldTransform(bone, position, quaternion) {
  const parent = bone.parent;
  parent?.updateMatrixWorld(true);
  bone.updateMatrixWorld(true);
  _boneScale.copy(bone.scale);
  bone.matrixWorld.decompose(_pos, _current, _scale);
  _world.compose(position, quaternion, _scale);
  if (parent) {
    _parentInv.copy(parent.matrixWorld).invert();
    _local.multiplyMatrices(_parentInv, _world);
  } else {
    _local.copy(_world);
  }
  _local.decompose(bone.position, bone.quaternion, _scale);
  bone.scale.copy(_boneScale);
  bone.updateMatrixWorld(true);
}

export function dogRagdollPartCount() {
  return DOG_RAGDOLL_PARTS.length;
}
