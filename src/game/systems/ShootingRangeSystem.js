/**
 * Shooting Range training: 60s breach course timer, hostile/friendly targets,
 * scoring, restart, and per-gun best scores in localStorage.
 */

import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import {
  getShootingRangeBest,
  recordShootingRangeScore,
} from '../config/shootingRangeScores.js';

export const RANGE_DURATION_SEC = 60;
export const RANGE_COUNTDOWN_SEC = 3;

const SCORE_HOSTILE_BODY = 100;
const SCORE_HOSTILE_HEAD = 150;
const SCORE_FRIENDLY_PENALTY = -200;
const SCORE_CLEAR_BONUS = 250;

const TARGET_HEIGHT = 1.72;
const TARGET_RADIUS = 0.32;

// ── Knockable breach doors ─────────────────────────────────────────────────
// Tall single-leaf proportion (narrower than the old double-door look).
// Keep in sync with doorway clear height / widths in createShootingRangeLevel.
const DOOR_HEIGHT = 2.65;
const DOOR_THICKNESS = 0.11;
/** Doorway leaf is a touch narrower than the wall gap so it swings clean. */
const DOOR_LEAF_INSET = 0.08;
/** How close (m) the player must be to a doorway to breach it. */
const DOOR_REACH_SIDE = 0.85;
const DOOR_REACH_DEPTH = 2.6;
/** Tip-over physics: effective gravity torque, initial kick, floor bounce. */
const DOOR_GRAVITY_TORQUE = 11.0;
const DOOR_KICK = 2.3;
const DOOR_RESTITUTION = 0.3;
const DOOR_SETTLE_SPEED = 0.7;
const DOOR_AIR_DRAG = 0.6;
const HALF_PI = Math.PI * 0.5;

const doorLeafMat = new THREE.MeshStandardMaterial({
  color: 0x6b4a2c,
  roughness: 0.82,
  metalness: 0.05,
});
const doorPanelMat = new THREE.MeshStandardMaterial({
  color: 0x513521,
  roughness: 0.86,
  metalness: 0.04,
});
const doorHingeMat = new THREE.MeshStandardMaterial({
  color: 0x2c2e32,
  roughness: 0.5,
  metalness: 0.7,
});
const doorHandleMat = new THREE.MeshStandardMaterial({
  color: 0xb9a15a,
  roughness: 0.4,
  metalness: 0.8,
});

const hostileBodyMat = new THREE.MeshStandardMaterial({
  color: 0x8a3030,
  roughness: 0.7,
  metalness: 0.08,
  emissive: 0x401010,
  emissiveIntensity: 0.15,
});
const hostileHeadMat = new THREE.MeshStandardMaterial({
  color: 0xc04040,
  roughness: 0.65,
  metalness: 0.05,
  emissive: 0x500808,
  emissiveIntensity: 0.2,
});
const friendlyBodyMat = new THREE.MeshStandardMaterial({
  color: 0x2a5a8a,
  roughness: 0.7,
  metalness: 0.08,
  emissive: 0x0a2038,
  emissiveIntensity: 0.15,
});
const friendlyHeadMat = new THREE.MeshStandardMaterial({
  color: 0x3a8acc,
  roughness: 0.65,
  metalness: 0.05,
  emissive: 0x0a3050,
  emissiveIntensity: 0.2,
});
const standMat = new THREE.MeshStandardMaterial({
  color: 0x3a3a38,
  roughness: 0.85,
  metalness: 0.1,
});
const hitHostileMat = new THREE.MeshStandardMaterial({
  color: 0x2a1818,
  roughness: 0.9,
  metalness: 0.05,
  transparent: true,
  opacity: 0.45,
});
const hitFriendlyMat = new THREE.MeshStandardMaterial({
  color: 0x5a2020,
  roughness: 0.85,
  metalness: 0.05,
  emissive: 0x880000,
  emissiveIntensity: 0.6,
});

/**
 * @typedef {'idle'|'countdown'|'running'|'finished'} RangePhase
 */

export class ShootingRangeSystem {
  constructor() {
    this.enabled = false;
    this.group = new THREE.Group();
    this.group.name = 'Shooting Range Targets';
    /** @type {RangeTarget[]} */
    this.targets = [];
    /** @type {RangePhase} */
    this.phase = 'idle';
    this.timeLeft = RANGE_DURATION_SEC;
    this.countdownLeft = RANGE_COUNTDOWN_SEC;
    this.score = 0;
    this.hostileHits = 0;
    this.friendlyHits = 0;
    this.hostilesTotal = 0;
    this.friendliesTotal = 0;
    this.gunId = null;
    this.bestForGun = 0;
    this.lastResult = null;
    this._hitFlash = 0;
    this._lastHitKind = null;
    this._spawnDefs = [];

    // Knockable doors
    this.doorGroup = new THREE.Group();
    this.doorGroup.name = 'Shooting Range Doors';
    /** @type {RangeDoor[]} */
    this.doors = [];
    this._doorDefs = [];
    this._level = null;
    this._nearDoorId = null;
  }

  /**
   * @param {THREE.Scene} scene
   * @param {{ spawns?: Array<object>, doors?: Array<object>, level?: object }} [options]
   */
  start(scene, { spawns = [], doors = [], level = null } = {}) {
    this.enabled = true;
    this._spawnDefs = Array.isArray(spawns) ? spawns : [];
    this._doorDefs = Array.isArray(doors) ? doors : [];
    this._level = level;
    scene.add(this.group);
    scene.add(this.doorGroup);
    this._rebuildTargets();
    this._buildDoors();
    this.resetRound({ countdown: true });
  }

  _rebuildTargets() {
    while (this.group.children.length) {
      const child = this.group.children[0];
      this.group.remove(child);
      disposeObject3D(child);
    }
    this.targets = [];
    this.hostilesTotal = 0;
    this.friendliesTotal = 0;

    for (const def of this._spawnDefs) {
      const target = createRangeTarget(def);
      this.group.add(target.root);
      this.targets.push(target);
      if (target.friendly) this.friendliesTotal += 1;
      else this.hostilesTotal += 1;
    }
  }

  // ── Doors ─────────────────────────────────────────────────────────────────

  _buildDoors() {
    // Tear down any previous doors (and their gating colliders).
    while (this.doorGroup.children.length) {
      const child = this.doorGroup.children[0];
      this.doorGroup.remove(child);
      disposeObject3D(child);
    }
    if (this._level?.colliders && this.doors.length) {
      const list = this._level.colliders;
      for (const door of this.doors) {
        const idx = list.indexOf(door.collider);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    this.doors = [];

    for (const def of this._doorDefs) {
      const door = createRangeDoor(def);
      this.doorGroup.add(door.pivot);
      this.doors.push(door);
      // Gate the doorway: block movement until the leaf is knocked down.
      if (this._level?.colliders) this._level.colliders.push(door.collider);
    }
  }

  _resetDoors() {
    for (const door of this.doors) {
      door.state = 'closed';
      door.angle = 0;
      door.angVel = 0;
      door.pivot.rotation.x = 0;
      door.pivot.rotation.z = 0;
      door.collider.disabled = false;
    }
    this._nearDoorId = null;
  }

  /**
   * Integrate tip-over physics and (when allowed) resolve interact-to-breach.
   * @param {number} dt
   * @param {object|null} character
   * @param {object|null} input
   * @param {boolean} allowInteract only true while the round is running
   */
  _updateDoors(dt, character, input, allowInteract) {
    // Physics: a knocked leaf tips about its bottom edge and slams flat, with a
    // damped bounce so it settles believably.
    for (const door of this.doors) {
      if (door.state !== 'falling') continue;
      door.angVel += DOOR_GRAVITY_TORQUE * door.fallSign * dt;
      door.angVel *= Math.max(0, 1 - DOOR_AIR_DRAG * dt);
      door.angle += door.angVel * dt;
      if (Math.abs(door.angle) >= HALF_PI) {
        door.angle = HALF_PI * door.fallSign;
        if (Math.abs(door.angVel) > DOOR_SETTLE_SPEED) {
          door.angVel = -door.angVel * DOOR_RESTITUTION;
        } else {
          door.angVel = 0;
          door.state = 'down';
        }
      }
      door.pivot.rotation[door.axis] = door.angle;
    }

    // Interaction: find the nearest closed door the player is standing at.
    this._nearDoorId = null;
    if (!allowInteract) return;
    const pos = character?.group?.position;
    if (!pos) return;
    let best = null;
    let bestDist = Infinity;
    for (const door of this.doors) {
      if (door.state !== 'closed') continue;
      const dx = pos.x - door.x;
      const dz = pos.z - door.z;
      const halfW = door.leafWidth * 0.5 + DOOR_REACH_SIDE;
      const along = door.axis === 'x' ? Math.abs(dx) : Math.abs(dz);
      const depth = door.axis === 'x' ? Math.abs(dz) : Math.abs(dx);
      if (along > halfW || depth > DOOR_REACH_DEPTH) continue;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = door;
      }
    }
    if (!best) return;
    this._nearDoorId = best.id;

    if (input?.mountPressed) this._knockDoor(best, pos);
  }

  /**
   * Kick a closed door flat, away from the player, and open its doorway.
   * @param {RangeDoor} door
   * @param {{ x: number, z: number }} playerPos
   */
  _knockDoor(door, playerPos) {
    if (door.state !== 'closed') return;
    // Fall away from the player. For an X-axis leaf a +X-axis rotation tips it
    // toward +Z; for a Z-axis leaf a +Z-axis rotation tips it toward −X.
    if (door.axis === 'x') {
      door.fallSign = Math.sign(door.z - playerPos.z) || 1;
    } else {
      door.fallSign = -Math.sign(door.x - playerPos.x) || 1;
    }
    door.state = 'falling';
    door.angVel = DOOR_KICK * door.fallSign;
    door.collider.disabled = true;
  }

  /**
   * Entities for WeaponSystem capsule hitscan (same shape as enemies).
   */
  getHitEntities() {
    if (!this.enabled || this.phase !== 'running') return [];
    const list = [];
    for (const t of this.targets) {
      if (!t.alive) continue;
      list.push(t.hitEntity);
    }
    return list;
  }

  /**
   * Called from WeaponSystem when a range target is hit.
   * @param {object} entity hitEntity from getHitEntities
   * @param {{ region?: string, damage?: number }} [info]
   */
  onTargetHit(entity, info = {}) {
    if (!this.enabled || this.phase !== 'running') return;
    const target = entity?.rangeTargetRef;
    if (!target || !target.alive) return;

    target.alive = false;
    target.hitEntity.health = 0;
    target.hitEntity.pendingCorpse = true;

    const region = info.region || 'body';
    let delta = 0;
    if (target.friendly) {
      delta = SCORE_FRIENDLY_PENALTY;
      this.friendlyHits += 1;
      this._lastHitKind = 'friendly';
      applyHitLook(target, true);
    } else {
      delta = region === 'head' ? SCORE_HOSTILE_HEAD : SCORE_HOSTILE_BODY;
      this.hostileHits += 1;
      this._lastHitKind = region === 'head' ? 'head' : 'hostile';
      applyHitLook(target, false);
      // Fall backward
      target.root.rotation.x = -1.15;
    }

    this.score += delta;
    this._hitFlash = 0.55;

    // All hostiles cleared early → bonus once
    if (
      !target.friendly
      && !this._clearBonusAwarded
      && this.hostilesTotal > 0
      && this.hostileHits >= this.hostilesTotal
    ) {
      this.score += SCORE_CLEAR_BONUS;
      this._clearBonusAwarded = true;
    }
  }

  /**
   * @param {{ delta: number, input?: object, gunId?: string|null, character?: object, level?: object, cameraSystem?: object }} ctx
   */
  update({ delta, input, gunId, character, level, cameraSystem }) {
    if (!this.enabled) return;

    if (gunId && gunId !== this.gunId) {
      this.gunId = gunId;
      this.bestForGun = getShootingRangeBest(gunId);
    } else if (!this.gunId && gunId) {
      this.gunId = gunId;
      this.bestForGun = getShootingRangeBest(gunId);
    }

    const dt = Math.max(0, Number(delta) || 0);
    if (this._hitFlash > 0) this._hitFlash = Math.max(0, this._hitFlash - dt);

    // Doors animate in every phase; breaching (E) is only armed while running.
    this._updateDoors(dt, character, input, this.phase === 'running');

    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.phase = 'running';
        this.timeLeft = RANGE_DURATION_SEC;
      }
      return;
    }

    if (this.phase === 'running') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this._finishRound();
      }
      return;
    }

    if (this.phase === 'finished' || this.phase === 'idle') {
      // Space / F restart — avoid mouse-primary (shares cutCommit) so a leftover
      // click after the timer does not instantly re-queue the round.
      const wantRestart = Boolean(input?.jumpPressed || input?.mountPressed);
      if (wantRestart) {
        this.resetRound({ countdown: true, character, level, cameraSystem });
      }
    }
  }

  _finishRound() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';

    if (this._clearBonusAwarded && this.hostileHits >= this.hostilesTotal) {
      // already applied during run
    }

    const gunId = this.gunId || 'unknown';
    const { best, isNewBest } = recordShootingRangeScore(gunId, this.score);
    this.bestForGun = best;
    this.lastResult = {
      score: this.score,
      best,
      isNewBest,
      hostileHits: this.hostileHits,
      friendlyHits: this.friendlyHits,
      hostilesTotal: this.hostilesTotal,
      friendliesTotal: this.friendliesTotal,
      gunId,
      clearBonus: this._clearBonusAwarded === true,
    };
  }

  /**
   * @param {{ countdown?: boolean, character?: object, level?: object, cameraSystem?: object }} [opts]
   */
  resetRound({ countdown = true, character = null, level = null, cameraSystem = null } = {}) {
    this.score = 0;
    this.hostileHits = 0;
    this.friendlyHits = 0;
    this.timeLeft = RANGE_DURATION_SEC;
    this.countdownLeft = RANGE_COUNTDOWN_SEC;
    this.lastResult = null;
    this._clearBonusAwarded = false;
    this._hitFlash = 0;
    this._lastHitKind = null;
    this.phase = countdown ? 'countdown' : 'running';

    for (const t of this.targets) {
      t.alive = true;
      t.hitEntity.health = 100;
      t.hitEntity.pendingCorpse = false;
      t.root.rotation.x = 0;
      t.root.rotation.y = t.yaw;
      restoreTargetLook(t);
    }

    this._resetDoors();

    if (character?.group && level?.spawnPoint) {
      character.group.position.copy(level.spawnPoint);
      if (character.velocity) character.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
      if (Number.isFinite(level.spawnYaw)) {
        character.group.rotation.y = level.spawnYaw;
        if (cameraSystem) {
          cameraSystem.yaw = level.spawnYaw;
          cameraSystem.pitch = 0;
        }
      }
    }
  }

  snapshot() {
    if (!this.enabled) {
      return { active: false };
    }
    return {
      active: true,
      phase: this.phase,
      timeLeft: Number(this.timeLeft.toFixed(2)),
      countdownLeft: Number(Math.max(0, this.countdownLeft).toFixed(2)),
      score: this.score,
      hostileHits: this.hostileHits,
      friendlyHits: this.friendlyHits,
      hostilesTotal: this.hostilesTotal,
      friendliesTotal: this.friendliesTotal,
      gunId: this.gunId,
      bestForGun: this.bestForGun,
      hitFlash: Number(this._hitFlash.toFixed(3)),
      lastHitKind: this._lastHitKind,
      result: this.lastResult,
      duration: RANGE_DURATION_SEC,
      // HUD breach prompt: a closed door is within reach during the run.
      breachPrompt: this.phase === 'running' && this._nearDoorId != null,
      doorsDown: this.doors.reduce((n, d) => n + (d.state !== 'closed' ? 1 : 0), 0),
      doorsTotal: this.doors.length,
    };
  }

  dispose() {
    this.enabled = false;
    // Drop door gating colliders from the shared level array before teardown.
    if (this._level?.colliders && this.doors.length) {
      const list = this._level.colliders;
      for (const door of this.doors) {
        const idx = list.indexOf(door.collider);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    this.doors = [];
    this._level = null;
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.doorGroup.parent) this.doorGroup.parent.remove(this.doorGroup);
    disposeObject3D(this.group);
    disposeObject3D(this.doorGroup);
    this.targets = [];
    this.phase = 'idle';
  }
}

/**
 * @typedef {object} RangeTarget
 * @property {string} id
 * @property {boolean} friendly
 * @property {boolean} alive
 * @property {number} yaw
 * @property {THREE.Group} root
 * @property {THREE.Mesh} body
 * @property {THREE.Mesh} head
 * @property {object} hitEntity
 */

function createRangeTarget(def) {
  const friendly = def.friendly === true;
  const yaw = Number(def.yaw) || 0;
  const root = new THREE.Group();
  root.name = `RangeTarget_${def.id}`;
  root.position.set(def.x, 0, def.z);
  root.rotation.y = yaw;

  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.55), standMat);
  stand.position.y = 0.06;
  stand.castShadow = true;
  stand.receiveShadow = true;
  root.add(stand);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.9, 6), standMat);
  pole.position.y = 0.55;
  root.add(pole);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.95, 0.18),
    friendly ? friendlyBodyMat : hostileBodyMat,
  );
  body.position.y = 1.05;
  body.castShadow = true;
  root.add(body);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.32, 0.22),
    friendly ? friendlyHeadMat : hostileHeadMat,
  );
  head.position.y = 1.68;
  head.castShadow = true;
  root.add(head);

  // Small badge so friendlies read clearly at a glance
  if (friendly) {
    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.12, 0.04),
      friendlyHeadMat,
    );
    badge.position.set(0, 1.15, 0.12);
    root.add(badge);
  } else {
    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.04),
      hostileHeadMat,
    );
    badge.position.set(0, 1.15, 0.12);
    root.add(badge);
  }

  /** @type {RangeTarget} */
  const target = {
    id: def.id,
    friendly,
    alive: true,
    yaw,
    root,
    body,
    head,
    hitEntity: null,
  };

  // Capsule proxy for existing hitscan (feet at root.position.y)
  target.hitEntity = {
    id: `range:${def.id}`,
    model: root,
    health: 100,
    pendingCorpse: false,
    collisionHeight: TARGET_HEIGHT,
    collisionRadius: TARGET_RADIUS,
    rangeTarget: true,
    surfaceClass: 'metal',
    friendly,
    rangeTargetRef: target,
  };

  return target;
}

function applyHitLook(target, friendlyHit) {
  const mat = friendlyHit ? hitFriendlyMat : hitHostileMat;
  target.body.material = mat;
  target.head.material = mat;
}

function restoreTargetLook(target) {
  target.body.material = target.friendly ? friendlyBodyMat : hostileBodyMat;
  target.head.material = target.friendly ? friendlyHeadMat : hostileHeadMat;
}

/**
 * @typedef {object} RangeDoor
 * @property {string} id
 * @property {'x'|'z'} axis rotation axis; also the leaf's span axis
 * @property {number} x world doorway centre X
 * @property {number} z world doorway centre Z
 * @property {number} leafWidth
 * @property {'closed'|'falling'|'down'} state
 * @property {number} angle current tip angle (rad)
 * @property {number} angVel angular velocity (rad/s)
 * @property {number} fallSign rotation direction (+1/−1), set at knock time
 * @property {THREE.Group} pivot pivot at the bottom edge of the doorway
 * @property {object} collider AABB gating collider (level.colliders entry)
 */

/**
 * Build a knockable door: a detailed leaf on a pivot at its bottom edge, plus a
 * gating AABB collider that blocks the doorway until the leaf is tipped over.
 * The leaf is authored canonically (width along +X, thickness along +Z); Z-axis
 * doors rotate the leaf 90° about Y so the same builder serves both wall runs.
 * @param {{ id: string, x: number, z: number, width: number, axis: 'x'|'z' }} def
 * @returns {RangeDoor}
 */
function createRangeDoor(def) {
  const axis = def.axis === 'z' ? 'z' : 'x';
  const x = Number(def.x) || 0;
  const z = Number(def.z) || 0;
  const leafWidth = Math.max(0.6, (Number(def.width) || 2.4) - DOOR_LEAF_INSET);
  const h = DOOR_HEIGHT;
  const t = DOOR_THICKNESS;

  const pivot = new THREE.Group();
  pivot.name = `RangeDoor_${def.id}`;
  pivot.position.set(x, 0, z);

  // Canonical leaf orientation (spans local X); Z-axis doors turn to span Z.
  const leaf = new THREE.Group();
  leaf.name = 'DoorLeaf';
  if (axis === 'z') leaf.rotation.y = HALF_PI;
  pivot.add(leaf);

  const slab = new THREE.Mesh(new THREE.BoxGeometry(leafWidth, h, t), doorLeafMat);
  slab.position.y = h * 0.5;
  slab.castShadow = true;
  slab.receiveShadow = true;
  leaf.add(slab);

  // Recessed panels for a bit of relief.
  for (const py of [h * 0.3, h * 0.68]) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(leafWidth * 0.7, h * 0.24, 0.03),
      doorPanelMat,
    );
    panel.position.set(0, py, t * 0.5 + 0.008);
    panel.castShadow = false;
    leaf.add(panel);
    const panelBack = panel.clone();
    panelBack.position.z = -t * 0.5 - 0.008;
    leaf.add(panelBack);
  }

  // Hinge plates on one vertical edge + a handle on the other.
  for (const hy of [h * 0.2, h * 0.8]) {
    const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, t + 0.05), doorHingeMat);
    hinge.position.set(-leafWidth * 0.5 + 0.06, hy, 0);
    hinge.castShadow = true;
    leaf.add(hinge);
  }
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.22), doorHandleMat);
  handle.position.set(leafWidth * 0.5 - 0.18, h * 0.46, t * 0.5 + 0.05);
  leaf.add(handle);
  const handleBack = handle.clone();
  handleBack.position.z = -t * 0.5 - 0.05;
  leaf.add(handleBack);

  // Gating collider: thin box filling the doorway, disabled once knocked.
  const halfLeaf = leafWidth * 0.5;
  const halfT = t + 0.05;
  const collider = axis === 'x'
    ? {
      name: `RangeDoor ${def.id}`,
      minX: x - halfLeaf, maxX: x + halfLeaf,
      minZ: z - halfT, maxZ: z + halfT,
      bottomY: 0, topY: h,
      noGroundSnap: true,
      disabled: false,
    }
    : {
      name: `RangeDoor ${def.id}`,
      minX: x - halfT, maxX: x + halfT,
      minZ: z - halfLeaf, maxZ: z + halfLeaf,
      bottomY: 0, topY: h,
      noGroundSnap: true,
      disabled: false,
    };

  return {
    id: def.id,
    axis,
    x,
    z,
    leafWidth,
    state: 'closed',
    angle: 0,
    angVel: 0,
    fallSign: 1,
    pivot,
    collider,
  };
}
