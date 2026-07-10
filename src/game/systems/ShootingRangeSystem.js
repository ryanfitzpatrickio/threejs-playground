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
  }

  /**
   * @param {THREE.Scene} scene
   * @param {{ spawns?: Array<object> }} [options]
   */
  start(scene, { spawns = [] } = {}) {
    this.enabled = true;
    this._spawnDefs = Array.isArray(spawns) ? spawns : [];
    scene.add(this.group);
    this._rebuildTargets();
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
    };
  }

  dispose() {
    this.enabled = false;
    if (this.group.parent) this.group.parent.remove(this.group);
    disposeObject3D(this.group);
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
