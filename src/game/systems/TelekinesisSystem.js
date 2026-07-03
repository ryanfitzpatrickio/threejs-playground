import * as THREE from 'three';

const MAX_GRABBED = 12;
const MAX_RANGE = 10; // match doc "Max range: 10m" (e.g. 8-12)
const ORBIT_RADIUS = 1.1;
const ORBIT_CENTER_HEIGHT = 1.75; // overhead above player feet
const ORBIT_CENTER_LEFT = 0.65; // meters to the player's left
const ORBIT_CENTER_FORWARD = 0.1;
const GRAB_RATE_BASE = 1; // pieces/sec at hold start; +1/sec each second held
const PIECE_SIZE_REF = 0.55; // reference max dimension for cluster spacing
const LIFT_SPEED = 6;
const ORBIT_SPEED = 2.2;
const HOLD_FORCE = 12;
const DROP_RANGE = 12;

// Phase 3 throw constants (smallest addition)
const THROW_SPEED = 32;
const THROW_SPREAD = 0.22;
const THROW_SPIN = 18;
const THROW_BASE_DAMAGE = 24;
const THROW_MIN_DAMAGE_SPEED = 5;
const THROW_KILL_SIZE = 1.12; // normalized chunk size for lethal knockdown
const THROW_KILL_SPEED = 12;
const THROW_STAGGER_BASE = 0.55;
const THROW_KNOCKBACK_BASE = 7;

/**
 * TelekinesisSystem - Phase 1: basic grab + orbit (no animations).
 * Follows design: state machine, grab from cut chunks (loose dynamic), orbit around hand bone,
 * physics forces via setLinvel + gravityScale.
 * Works armed/unarmed (anim wiring later).
 */
export class TelekinesisSystem {
  constructor() {
    this.grabbed = []; // { owner, body, mesh, originalGravity }
    this.held = false;
    this.time = 0;
    this.status = 'idle';
    this.thrown = []; // for post-throw impact/damage (phase3)
    this._lastHighlight = null; // for basic targeting highlight (phase4)
    this.holdTime = 0;
    this.grabAccumulator = 0;
    this._wasTeleHeld = false;
    this._tmpBox = new THREE.Box3();
    this._tmpSize = new THREE.Vector3();
    this._tmpForward = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3(0, 1, 0);
    this._tmpHitCenter = new THREE.Vector3();
    this._tmpKnockDir = new THREE.Vector3();
  }

  update({ delta, input, character, physicsSystem, propSystem, enemyCutSystem, enemySystem, camera, enemies = [] }) {
    if (!physicsSystem?.world || !character?.animationController) {
      return;
    }

    this.time += delta;

    const teleHeld = !!input?.telekinesisHeld;
    const teleReleased = !!input?.telekinesisReleased;

    // Get hand position (right hand preferred, post-animation update)
    const handPos = this._getHandPosition(character.animationController);
    if (!handPos) {
      this._releaseAll(physicsSystem);
      this._clearTargetHighlight();
      return;
    }

    if (teleReleased && this.held) {
      if (this.grabbed.length > 0) {
        this._throwAll(physicsSystem, camera, handPos);
      } else {
        this._releaseAll(physicsSystem);
      }
      this.held = false;
      this.holdTime = 0;
      this.grabAccumulator = 0;
      this._wasTeleHeld = false;
      this.status = "idle";
      this._clearTargetHighlight();
      return;
    }

    if (!teleHeld) {
      this.holdTime = 0;
      this.grabAccumulator = 0;
      this._wasTeleHeld = false;
      if (this.held) {
        this._releaseAll(physicsSystem);
        this.held = false;
        this.status = "idle";
        this._clearTargetHighlight();
      }
      return;
    }

    this.held = true;
    this.status = 'holding';

    // Collect current grabbable loose chunks (dynamic bodies from cuts + future props)
    const candidates = this._collectGrabbables(propSystem, enemyCutSystem);
    const orbitFrame = this._getOrbitFrame(character, handPos);

    if (!this._wasTeleHeld) {
      this.holdTime = 0;
      this.grabAccumulator = 0;
      this._tryGrabNext(candidates, camera, handPos, orbitFrame, physicsSystem);
    }
    this._wasTeleHeld = true;
    this.holdTime += delta;

    // Ramp grab rate: 1/sec at start, +1/sec for each full second held
    const grabRate = GRAB_RATE_BASE + Math.floor(this.holdTime);
    this.grabAccumulator += grabRate * delta;
    while (this.grabAccumulator >= 1 && this.grabbed.length < MAX_GRABBED) {
      this.grabAccumulator -= 1;
      if (!this._tryGrabNext(candidates, camera, handPos, orbitFrame, physicsSystem)) {
        break;
      }
    }

    // Phase4: basic targeting highlight (reticle equiv via center aim) for grabbable not-yet-grabbed
    const targetCandidate = this._pickNearest(candidates, camera, handPos, physicsSystem);
    this._applyTargetHighlight(targetCandidate);

    // Clean dead / too far
    this._cleanup(physicsSystem);

    // Drive orbit cluster overhead-left of player (multi-chunk support)
    this._updateOrbit({ orbitFrame, delta, physicsSystem });
  }

  updateThrownImpacts({ enemies, physicsSystem, enemySystem, enemyCutSystem, propSystem }) {
    this._updateThrownImpacts({ enemies, physicsSystem, enemySystem, enemyCutSystem, propSystem });
  }

  _getHandPosition(animationController) {
    const modelRoot = animationController?.modelRoot;
    if (!modelRoot) return null;
    modelRoot.updateMatrixWorld(true);
    // Prefer right hand for casting consistency with sword/grab
    let bone = modelRoot.getObjectByName('mixamorigRightHand');
    if (!bone) bone = modelRoot.getObjectByName('mixamorigLeftHand');
    if (!bone) return null;
    const pos = new THREE.Vector3();
    bone.getWorldPosition(pos);
    return pos;
  }

  _getOrbitFrame(character, handFallback) {
    const group = character?.group;
    if (!group) {
      const center = handFallback ? handFallback.clone() : new THREE.Vector3();
      return {
        center,
        right: new THREE.Vector3(1, 0, 0),
        forward: new THREE.Vector3(0, 0, -1),
      };
    }

    group.updateMatrixWorld(true);
    const center = new THREE.Vector3();
    group.getWorldPosition(center);
    center.y += ORBIT_CENTER_HEIGHT;

    group.getWorldDirection(this._tmpForward);
    this._tmpForward.y = 0;
    if (this._tmpForward.lengthSq() < 1e-6) {
      this._tmpForward.set(0, 0, -1);
    } else {
      this._tmpForward.normalize();
    }

    this._tmpRight.crossVectors(this._tmpForward, this._tmpUp).normalize();
    center.addScaledVector(this._tmpRight, -ORBIT_CENTER_LEFT);
    center.addScaledVector(this._tmpForward, ORBIT_CENTER_FORWARD);

    return {
      center,
      right: this._tmpRight.clone(),
      forward: this._tmpForward.clone(),
    };
  }

  _getPieceSizeNorm(entry) {
    let maxDim = PIECE_SIZE_REF;
    if (entry?.mesh) {
      this._tmpBox.setFromObject(entry.mesh);
      this._tmpBox.getSize(this._tmpSize);
      maxDim = Math.max(this._tmpSize.x, this._tmpSize.y, this._tmpSize.z, 0.08);
    }
    return THREE.MathUtils.clamp(maxDim / PIECE_SIZE_REF, 0.35, 2.4);
  }

  _computeOrbitOffset(index, count, sizeNorm, time) {
    const clusterScale = 1 + Math.max(0, count - 1) * 0.1;
    const personalRadius = ORBIT_RADIUS * clusterScale * (0.7 + sizeNorm * 0.45);
    const angle = time * ORBIT_SPEED + (index * (Math.PI * 2 / Math.max(1, count)));
    const bob = Math.sin(time * 0.5 + index * 0.4) * 0.22 * sizeNorm;
    const verticalLift = 0.12 + sizeNorm * 0.18 + (index % 3) * 0.1 * sizeNorm;
    return new THREE.Vector3(
      Math.cos(angle) * personalRadius,
      bob + verticalLift,
      Math.sin(angle) * personalRadius * 0.62,
    );
  }

  _localOffsetToWorld(localOffset, orbitFrame) {
    const { center, right, forward } = orbitFrame;
    return center.clone()
      .addScaledVector(right, localOffset.x)
      .addScaledVector(this._tmpUp, localOffset.y)
      .addScaledVector(forward, localOffset.z);
  }

  _tryGrabNext(candidates, camera, handPos, orbitFrame, physicsSystem) {
    if (this.grabbed.length >= MAX_GRABBED) return false;
    const available = candidates.filter((c) => c?.handle != null && !this._isGrabbed(c.handle));
    if (!available.length) return false;
    const picked = this._pickNearest(available, camera, handPos, physicsSystem);
    if (!picked) return false;
    this._grab(picked, orbitFrame, physicsSystem);
    return true;
  }

  _getFreshBody(physicsSystem, bodyOrHandle) {
    if (!physicsSystem) return null;
    // Delegate to PhysicsSystem helper when present (central fresh + alias guards)
    if (typeof physicsSystem.getFreshBody === 'function') {
      try {
        const f = physicsSystem.getFreshBody(bodyOrHandle);
        if (f) return f;
      } catch {}
    }
    if (!physicsSystem.world) return null;
    let handle = bodyOrHandle;
    if (handle != null && typeof handle !== 'number') {
      handle = handle.handle;
    }
    if (typeof handle !== 'number') return null;
    try {
      return physicsSystem.world.bodies.get(handle);
    } catch {
      return null;
    }
  }

  _collectGrabbables(propSystem, enemyCutSystem) {
    const out = [];
    // Loose cut chunks (main source for phase 1: dynamic .body)
    const chunks = enemyCutSystem?.props ?? [];
    for (const chunk of chunks) {
      if (!chunk || !chunk.body || !chunk.mesh || !chunk.mesh.visible) continue;
      if (chunk.type !== 'staticChunk' && !chunk.recuttable) continue;
      // Only dynamic bodies (not kinematic)
      // Rapier bodies from createDynamic are dynamic.
      // Store handle (not the body wrapper) to avoid stale ref aliasing issues.
      out.push({ owner: chunk, handle: chunk.body.handle, mesh: chunk.mesh });
    }
    // Future: whole loose destructible props that are dynamic (isDestructibleProp + body)
    // For phase1 focus on chunks as they are the cut loose pieces.
    return out;
  }

  _pickNearest(candidates, camera, handPos, physicsSystem = null) {
    if (!camera || !candidates.length) return null;
    const raycaster = new THREE.Raycaster();
    // Use screen center for "aim" (simple, free look camera)
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    // Collect meshes for intersect
    const meshes = [];
    const meshToEntry = new Map();
    for (const c of candidates) {
      if (c.mesh) {
        meshes.push(c.mesh);
        meshToEntry.set(c.mesh, c);
      }
    }
    const intersects = raycaster.intersectObjects(meshes, true);
    for (const hit of intersects) {
      let obj = hit.object;
      while (obj && !meshToEntry.has(obj)) obj = obj.parent;
      const entry = meshToEntry.get(obj);
      if (entry) {
        const t = this._safeEntryTranslation(entry, physicsSystem);
        const p = t ? new THREE.Vector3(t.x, t.y, t.z) : (entry.mesh ? entry.mesh.position : new THREE.Vector3());
        if (handPos.distanceTo(p) <= MAX_RANGE) {
          return entry;
        }
      }
    }
    // Fallback: nearest by distance if no direct ray hit (e.g. small chunk) -- use body pos to avoid mesh/body desync
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const t = this._safeEntryTranslation(c, physicsSystem);
      const p = t ? new THREE.Vector3(t.x, t.y, t.z) : (c.mesh ? c.mesh.position : new THREE.Vector3());
      const d = handPos.distanceTo(p);
      if (d < bestDist && d <= MAX_RANGE) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  _safeEntryTranslation(entry, physicsSystem) {
    if (!entry) return null;
    if (entry.handle != null) {
      const f = this._getFreshBody(physicsSystem, entry.handle);
      if (f) {
        try {
          const t = f.translation();
          return { x: t.x, y: t.y, z: t.z };
        } catch {}
      }
    }
    if (entry.body) {
      try {
        const t = entry.body.translation();
        return { x: t.x, y: t.y, z: t.z };
      } catch {}
    }
    return null;
  }

  _isGrabbed(handleOrBody) {
    if (handleOrBody == null) return false;
    const h = (typeof handleOrBody === 'number') ? handleOrBody : handleOrBody.handle;
    return this.grabbed.some(g => g.handle === h);
  }

  _grab(entry, orbitFrame, physicsSystem) {
    if (!entry.handle || !entry.owner || this.grabbed.length >= MAX_GRABBED) return;
    const sizeNorm = this._getPieceSizeNorm(entry);
    // Use fresh for gravityScale read if available (fall back safe)
    let originalGravity = 1;
    const initBody = this._getFreshBody(physicsSystem, entry.handle);
    if (initBody) {
      try { originalGravity = initBody.gravityScale ? initBody.gravityScale() : 1; } catch {}
    }
    // pause lifetime on owner to avoid race/dispose while grabbed (restore on release)
    const owner = entry.owner;
    if (owner && owner.lifetime !== undefined) {
      owner._tkLifetime = owner.lifetime;
      owner.lifetime = 999999;
    }
    const body = this._getFreshBody(physicsSystem, entry.handle);
    if (!body) return;
    if (typeof physicsSystem?.safeSetGravityScale === 'function') {
      physicsSystem.safeSetGravityScale(entry.handle, 0.0, true);
    } else {
      try { body.setGravityScale(0.0, true); } catch {}
    }
    const indexAtGrab = this.grabbed.length;
    this.grabbed.push({
      owner: entry.owner,
      handle: entry.handle,
      mesh: entry.mesh,
      originalGravity,
      grabTime: this.time,
      sizeNorm,
    });
    // Initial lift impulse toward orbit cluster
    let pos;
    try {
      pos = body.translation();
    } catch { return; }
    const cur = new THREE.Vector3(pos.x, pos.y, pos.z);
    const localOffset = this._computeOrbitOffset(
      indexAtGrab,
      indexAtGrab + 1,
      sizeNorm,
      this.time,
    );
    const target = this._localOffsetToWorld(localOffset, orbitFrame);
    const vel = target.sub(cur).normalize().multiplyScalar(LIFT_SPEED);
    if (typeof physicsSystem?.safeSetLinvel === 'function') {
      physicsSystem.safeSetLinvel(entry.handle, { x: vel.x, y: vel.y, z: vel.z }, true);
    } else {
      try { body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true); } catch {}
    }
  }

  _cleanup(physicsSystem) {
    const still = [];
    for (const g of [...this.grabbed]) {
      if (!g.handle || !g.owner) {
        this._releaseOne(g, physicsSystem);
        continue;
      }
      const fresh = this._getFreshBody(physicsSystem, g.handle);
      if (!fresh) {
        this._releaseOne(g, physicsSystem);
        continue;
      }
      let p;
      try {
        p = fresh.translation();
      } catch (e) {
        this._releaseOne(g, physicsSystem);
        continue;
      }
      const pos = new THREE.Vector3(p.x, p.y, p.z);
      // Drop if too far from origin or invalid
      if (pos.length() > 200 || !Number.isFinite(p.x)) {
        this._releaseOne(g, physicsSystem);
        continue;
      }
      still.push(g);
    }
    this.grabbed = still;
  }

  _updateOrbit({ orbitFrame, delta, physicsSystem }) {
    if (this.grabbed.length === 0) return;

    const count = this.grabbed.length;

    // First pass: collect what to drop and what velocities to apply.
    // Separate all reads from any body mutations to avoid Rapier aliasing when many dynamic chunks exist.
    // Use fresh reads too.
    const toRelease = [];
    const mutations = [];

    for (let i = this.grabbed.length - 1; i >= 0; i -= 1) {
      const g = this.grabbed[i];
      if (!g.handle || !g.owner) {
        toRelease.push(g);
        continue;
      }

      const freshRead = this._getFreshBody(physicsSystem, g.handle);
      if (!freshRead) {
        toRelease.push(g);
        continue;
      }
      let trans;
      try {
        trans = freshRead.translation();
      } catch (e) {
        toRelease.push(g);
        continue;
      }
      const cur = new THREE.Vector3(trans.x, trans.y, trans.z);
      const sizeNorm = g.sizeNorm ?? 1;
      const localOffset = this._computeOrbitOffset(i, count, sizeNorm, this.time);
      const desired = this._localOffsetToWorld(localOffset, orbitFrame);

      const toDesired = desired.sub(cur);
      const dist = toDesired.length();
      if (dist > DROP_RANGE) {
        toRelease.push(g);
        continue;
      }

      const speed = Math.min(HOLD_FORCE, dist * 8 + 2);
      const vel = toDesired.normalize().multiplyScalar(speed);
      vel.y += Math.sin(this.time + i) * 0.8;

      const ang = {
        x: Math.cos(this.time * 1.7 + i) * 1.5,
        y: (i % 2 ? 1 : -1) * 2.2,
        z: Math.sin(this.time * 2.1 + i * 0.5) * 1.8,
      };

      mutations.push({ handle: g.handle, vel, ang, g });
    }

    // Release first (these do safe gravity/linvel sets)
    for (const g of toRelease) {
      this._releaseOne(g, physicsSystem);
    }

    // Then apply orbit sets (all writes after reads) using fresh body to avoid aliasing
    for (const m of mutations) {
      let ok = false;
      if (typeof physicsSystem?.safeSetLinvel === 'function') {
        ok = physicsSystem.safeSetLinvel(m.handle, { x: m.vel.x, y: m.vel.y, z: m.vel.z }, true);
        if (ok) physicsSystem.safeSetAngvel(m.handle, m.ang, true);
      } else {
        const fresh = this._getFreshBody(physicsSystem, m.handle);
        if (fresh) {
          try {
            fresh.setLinvel({ x: m.vel.x, y: m.vel.y, z: m.vel.z }, true);
            fresh.setAngvel(m.ang, true);
            ok = true;
          } catch (e) {
            ok = false;
          }
        }
      }
      if (!ok) {
        this._releaseOne(m.g, physicsSystem);
      }
    }
  }

  _releaseOne(g, physicsSystem) {
    if (!g || !g.handle) return;
    // restore lifetime if paused
    if (g.owner && g.owner._tkLifetime !== undefined) {
      g.owner.lifetime = g.owner._tkLifetime;
      delete g.owner._tkLifetime;
    }
    if (typeof physicsSystem?.safeSetGravityScale === 'function' && typeof physicsSystem?.safeGetLinvel === 'function' && typeof physicsSystem?.safeSetLinvel === 'function') {
      const didG = physicsSystem.safeSetGravityScale(g.handle, g.originalGravity ?? 1.0, true);
      const lv = physicsSystem.safeGetLinvel(g.handle) || { x: 0, y: 0, z: 0 };
      const vx = lv.x;
      const vy = lv.y;
      const vz = lv.z;
      physicsSystem.safeSetLinvel(g.handle, { x: vx * 0.3, y: vy - 1.5, z: vz * 0.3 }, true);
      if (!didG) {
        // still remove
      }
    } else {
      const fresh = this._getFreshBody(physicsSystem, g.handle);
      if (!fresh) {
        const idx = this.grabbed.indexOf(g);
        if (idx !== -1) this.grabbed.splice(idx, 1);
        return;
      }
      try {
        fresh.setGravityScale(g.originalGravity ?? 1.0, true);
        const lv = fresh.linvel();
        const vx = lv.x;
        const vy = lv.y;
        const vz = lv.z;
        fresh.setLinvel({ x: vx * 0.3, y: vy - 1.5, z: vz * 0.3 }, true);
      } catch {}
    }
    const idx = this.grabbed.indexOf(g);
    if (idx !== -1) this.grabbed.splice(idx, 1);
  }

  _releaseAll(physicsSystem) {
    for (const g of [...this.grabbed]) {
      this._releaseOne(g, physicsSystem);
    }
    this.grabbed = [];
    this._clearTargetHighlight();
  }


  _getThrowDirection(camera) {
    if (camera) {
      const d = new THREE.Vector3();
      camera.getWorldDirection(d);
      return d;
    }
    return new THREE.Vector3(0, 0, -1);
  }

  _throwAll(physicsSystem, camera, handPos) {
    if (this.grabbed.length === 0) {
      this._releaseAll(physicsSystem);
      return;
    }
    const baseDir = this._getThrowDirection(camera);
    for (let i = this.grabbed.length - 1; i >= 0; i -= 1) {
      const g = this.grabbed[i];
      if (!g.handle) {
        this.grabbed.splice(i, 1);
        continue;
      }
      // restore lifetime (paused during grab)
      if (g.owner && g.owner._tkLifetime !== undefined) {
        g.owner.lifetime = g.owner._tkLifetime;
        delete g.owner._tkLifetime;
      }
      const fresh = this._getFreshBody(physicsSystem, g.handle);
      if (!fresh) {
        this.grabbed.splice(i, 1);
        continue;
      }
      if (typeof physicsSystem?.safeSetGravityScale === 'function') {
        physicsSystem.safeSetGravityScale(g.handle, g.originalGravity ?? 1.0, true);
      } else {
        try { fresh.setGravityScale(g.originalGravity ?? 1.0, true); } catch {}
      }
      // direction + per-chunk spread + slight up for arc
      const spread = THROW_SPREAD;
      const ox = ((i % 3) - 1) * spread + (Math.random() - 0.5) * 0.08;
      const oy = (Math.random() - 0.5) * 0.15 + 0.1;
      const oz = ((i % 2) - 0.5) * spread * 0.8;
      const dir = baseDir.clone().add(new THREE.Vector3(ox, oy, oz)).normalize();
      const speed = THROW_SPEED * (0.9 + Math.random() * 0.2);
      const v = {
        x: dir.x * speed,
        y: dir.y * speed + 2.5,
        z: dir.z * speed,
      };
      if (typeof physicsSystem?.safeSetLinvel === 'function') {
        physicsSystem.safeSetLinvel(g.handle, v, true);
      } else {
        try { fresh.setLinvel(v, true); } catch {}
      }
      // spin for visual
      const spinScale = THROW_SPIN;
      const ang = {
        x: (Math.random() - 0.5) * spinScale * 2,
        y: (i % 2 ? 1 : -1) * spinScale * 1.2,
        z: (Math.random() - 0.5) * spinScale * 1.8,
      };
      if (typeof physicsSystem?.safeSetAngvel === 'function') {
        physicsSystem.safeSetAngvel(g.handle, ang, true);
      } else {
        try { fresh.setAngvel(ang, true); } catch {}
      }
      // track for impacts/damage (phase3)
      this.thrown.push({
        handle: g.handle,
        owner: g.owner,
        mesh: g.mesh,
        throwTime: this.time,
        sizeNorm: g.sizeNorm ?? this._getPieceSizeNorm({ mesh: g.mesh, owner: g.owner }),
        hitEnemies: new Set(),
      });
      this.grabbed.splice(i, 1);
    }
  }

  _getThrownImpactSpeed(physicsSystem, handle) {
    let lv = null;
    if (typeof physicsSystem?.safeGetLinvel === 'function') {
      lv = physicsSystem.safeGetLinvel(handle);
    } else {
      const fresh = this._getFreshBody(physicsSystem, handle);
      if (fresh) {
        try { lv = fresh.linvel(); } catch {}
      }
    }
    if (!lv) return 0;
    return Math.hypot(lv.x, lv.y, lv.z);
  }

  _enemyHitRadius(enemy, sizeNorm = 1) {
    const bodyRadius = enemy?.collisionRadius ?? 0.6;
    const height = enemy?.collisionHeight ?? 1.5;
    return Math.max(bodyRadius, height * 0.22) + 0.25 * sizeNorm + 0.35;
  }

  _applyTelekineticHit({
    enemy,
    chunkPos,
    sizeNorm,
    impactSpeed,
    physicsSystem,
    enemySystem,
    enemyCutSystem,
    propSystem,
  }) {
    this._tmpKnockDir.set(
      enemy.model.position.x - chunkPos.x,
      0,
      enemy.model.position.z - chunkPos.z,
    );
    if (this._tmpKnockDir.lengthSq() < 1e-6) {
      this._tmpKnockDir.set(0, 0, 1);
    } else {
      this._tmpKnockDir.normalize();
    }

    const canInstaKill = sizeNorm >= THROW_KILL_SIZE && impactSpeed >= THROW_KILL_SPEED;
    if (canInstaKill) {
      enemy.health = 0;
      const ep = enemy.model.position;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        this._tmpKnockDir.clone(),
        this._tmpHitCenter.set(
          ep.x,
          ep.y + (enemy.collisionHeight ?? 2) * 0.5,
          ep.z,
        ),
      );
      enemyCutSystem?.applyDirectCut?.({
        enemy,
        plane,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: enemyCutSystem,
      });
      return;
    }

    const speedFactor = THREE.MathUtils.clamp((impactSpeed - THROW_MIN_DAMAGE_SPEED) / 16, 0.3, 1.75);
    const damage = Math.round(THROW_BASE_DAMAGE * sizeNorm * speedFactor);
    enemy.health = Math.max(0, (enemy.health ?? 100) - damage);
    enemy.staggerTimer = Math.max(
      enemy.staggerTimer ?? 0,
      THROW_STAGGER_BASE + sizeNorm * 0.25,
    );
    enemySystem?.applyKnockback?.(enemy, {
      direction: { x: this._tmpKnockDir.x, z: this._tmpKnockDir.z },
      power: THROW_KNOCKBACK_BASE + sizeNorm * 4 + impactSpeed * 0.12,
    });

    if ((enemy.health ?? 0) <= 0) {
      enemy.health = 0;
      const ep = enemy.model.position;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        this._tmpKnockDir.clone(),
        this._tmpHitCenter.set(
          ep.x,
          ep.y + (enemy.collisionHeight ?? 2) * 0.5,
          ep.z,
        ),
      );
      enemyCutSystem?.applyDirectCut?.({
        enemy,
        plane,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: enemyCutSystem,
      });
    }
  }

  _updateThrownImpacts({ enemies = [], physicsSystem, enemySystem, enemyCutSystem, propSystem }) {
    if (!this.thrown || this.thrown.length === 0) return;
    const now = this.time;
    const MAX_AGE = 4.0;
    const keep = [];
    for (const t of this.thrown) {
      if (now - (t.throwTime || 0) > MAX_AGE) continue;
      const h = t.handle != null ? t.handle : (t.body ? t.body.handle : null);
      if (h == null) continue;
      const fresh = this._getFreshBody(physicsSystem, h);
      if (!fresh) continue;
      let trans;
      try { trans = fresh.translation(); } catch { continue; }
      const p = new THREE.Vector3(trans.x, trans.y, trans.z);
      const impactSpeed = this._getThrownImpactSpeed(physicsSystem, h);
      const sizeNorm = t.sizeNorm ?? 1;
      const hitsForThis = [];
      for (const enemy of enemies) {
        if (!enemy?.model?.visible || enemy.isDestructibleProp || enemy.pendingCorpse) continue;
        if (t.hitEnemies?.has(enemy)) continue;
        const ep = enemy.model.position;
        const cy = ep.y + ((enemy.collisionHeight ?? 1.5) * 0.6);
        this._tmpHitCenter.set(ep.x, cy, ep.z);
        const hitRadius = this._enemyHitRadius(enemy, sizeNorm);
        const d = p.distanceTo(this._tmpHitCenter);
        if (d < hitRadius && impactSpeed >= THROW_MIN_DAMAGE_SPEED) {
          if (!t.hitEnemies) t.hitEnemies = new Set();
          t.hitEnemies.add(enemy);
          hitsForThis.push(enemy);
        }
      }
      for (const enemy of hitsForThis) {
        this._applyTelekineticHit({
          enemy,
          chunkPos: p,
          sizeNorm,
          impactSpeed,
          physicsSystem,
          enemySystem,
          enemyCutSystem,
          propSystem,
        });
      }
      if (hitsForThis.length > 0) {
        // damp chunk vel on hit — do the body read+set after the enemy loop
        const fresh2 = this._getFreshBody(physicsSystem, h);
        if (fresh2) {
          if (typeof physicsSystem?.safeGetLinvel === 'function' && typeof physicsSystem?.safeSetLinvel === 'function') {
            const lv2 = physicsSystem.safeGetLinvel(h) || { x: 0, y: 0, z: 0 };
            physicsSystem.safeSetLinvel(h, { x: lv2.x * 0.5, y: lv2.y * 0.7, z: lv2.z * 0.5 }, true);
          } else {
            try {
              const lv = fresh2.linvel();
              const vx = lv.x;
              const vy = lv.y;
              const vz = lv.z;
              fresh2.setLinvel({ x: vx * 0.5, y: vy * 0.7, z: vz * 0.5 }, true);
            } catch {}
          }
        }
      }
      keep.push(t);
    }
    this.thrown = keep;
  }

  _applyTargetHighlight(entry) {
    if (this._lastHighlight && (!entry || this._lastHighlight !== entry.mesh)) {
      try {
        if (this._lastHighlight.scale) this._lastHighlight.scale.set(1, 1, 1);
      } catch {}
      this._lastHighlight = null;
    }
    if (entry && entry.mesh && entry.mesh.scale) {
      const isG = this.grabbed.some((g) => g.mesh === entry.mesh);
      if (!isG) {
        entry.mesh.scale.set(1.06, 1.06, 1.06);
        this._lastHighlight = entry.mesh;
      }
    }
  }

  _clearTargetHighlight() {
    if (this._lastHighlight && this._lastHighlight.scale) {
      try { this._lastHighlight.scale.set(1, 1, 1); } catch {}
    }
    this._lastHighlight = null;
  }


  // For debug / future snapshot
  snapshot() {
    return {
      held: this.held,
      grabbedCount: this.grabbed.length,
      thrownCount: this.thrown ? this.thrown.length : 0,
      status: this.status,
    };
  }
}
