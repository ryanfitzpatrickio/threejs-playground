/**
 * RemotePlayerSystem (M3 + M6 polish) — third-person opponent puppets.
 *
 * M3: capsule silhouette + weapon stub (node-safe, always available).
 * M6: async upgrade to skinned player shell (shared Mara/player template) with
 *     locomotion mixer + real gun GLB on the right hand. Capsule remains the
 *     fallback when assets fail or under headless node verifiers.
 *
 * No Rapier bodies (no body-blocking). Pose from RemotePlayerBuffer only.
 */

import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createRemotePlayerBuffer } from '../net/remotePlayerBuffer.js';
import {
  ensureRemoteShellTemplate,
  createRemoteShellInstance,
  mapLocomotionToClip,
  canLoadRemoteShells,
} from '../net/remotePlayerShellCache.js';
import { applyMixamoRightHandGunRest } from '../weapons/gunHandSocket.js';
import { GUN_CATALOG } from '../weapons/gunProfile.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import {
  flattenObjectForWebGPU,
  sanitizeWebGPUVertexBuffers,
} from '../geometry/prepareWebGPUGeometry.js';
import { ROOM_CONFIG } from '../config/deathmatch/deathmatchRules.js';

/** Shared GLTF loader for remote TP guns (lighter than full loadGunView). */
const remoteGunLoader = typeof document !== 'undefined' ? createGltfLoader() : null;
/** @type {Map<string, Promise<THREE.Object3D>>} */
const remoteGunTemplateCache = new Map();

const CAPACITY = ROOM_CONFIG.capacity;

const BODY_COLORS = [
  0x3d8bfd, 0xe85d4c, 0x5dce8a, 0xf0c14b,
  0xc77dff, 0x4ecdc4, 0xff8c42, 0xa0aec0,
];

export class RemotePlayerSystem {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'RemotePlayers';
    this.buffer = createRemotePlayerBuffer();
    /** @type {Map<string, Puppet>} */
    this.puppets = new Map();
    this._localPlayerId = null;
    this._scene = null;
    this._colorCursor = 0;
    this._disposed = false;
    /** @type {Promise<object|null>|null} */
    this._shellTemplatePromise = null;
    this._shellTemplate = null;
    this._shellLoadAttempted = false;
  }

  /** Attach the puppet root to the scene (idempotent). */
  attach(scene) {
    if (!scene || this._scene === scene) return;
    this._scene = scene;
    if (!this.group.parent) scene.add(this.group);
    // Kick shell template load once we have a live scene (browser only).
    this._ensureShellTemplate();
  }

  setLocalPlayerId(playerId) {
    this._localPlayerId = playerId ?? null;
    if (this._localPlayerId && this.puppets.has(this._localPlayerId)) {
      this._destroyPuppet(this._localPlayerId);
    }
  }

  /**
   * Ingest a full/partial player list from a network snapshot.
   * @param {object[]} players
   * @param {number} serverTime
   * @param {{ localPlayerId?: string|null }} [opts]
   */
  ingestPlayers(players, serverTime, opts = {}) {
    if (opts.localPlayerId !== undefined) this.setLocalPlayerId(opts.localPlayerId);
    if (!Array.isArray(players)) return;

    const live = [];
    for (const p of players) {
      if (!p?.playerId) continue;
      if (p.playerId === this._localPlayerId) continue;
      if (p.connected === false) continue;
      live.push(p.playerId);
      this.buffer.pushSample(p, serverTime, { displayName: p.displayName });
      if (!this.puppets.has(p.playerId)) {
        this._spawnPuppet(p);
      } else {
        const puppet = this.puppets.get(p.playerId);
        if (p.displayName) puppet.displayName = p.displayName;
      }
    }
    this.buffer.retainOnly(live);
    for (const id of [...this.puppets.keys()]) {
      if (!live.includes(id)) this._destroyPuppet(id);
    }
  }

  removePlayer(playerId) {
    if (!playerId || playerId === this._localPlayerId) return;
    this.buffer.remove(playerId);
    this._destroyPuppet(playerId);
  }

  /**
   * Brief hit flash on a remote puppet (M4 damage event).
   * @param {string} playerId
   */
  flashHit(playerId) {
    const puppet = this.puppets.get(playerId);
    if (!puppet) return;
    puppet._hitFlash = 0.18;
    if (puppet.bodyMat?.emissiveIntensity != null) {
      puppet.bodyMat.emissiveIntensity = (puppet.baseEmissiveIntensity ?? 0.55) * 2.2;
    }
    // Skinned shells: pulse materials under the model root.
    if (puppet.shell?.root) {
      puppet.shell.root.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.emissiveIntensity != null) {
            m.userData._baseEmissive = m.userData._baseEmissive ?? m.emissiveIntensity;
            m.emissiveIntensity = Math.min(2.5, m.userData._baseEmissive + 1.2);
          }
        }
      });
    }
  }

  /**
   * Cosmetic fire kick on remote (M6) when they deal damage / we observe hits.
   * @param {string} playerId
   */
  playFire(playerId) {
    const puppet = this.puppets.get(playerId);
    if (!puppet) return;
    puppet._fireKick = 0.12;
  }

  /**
   * Advance visual poses from the interpolation buffer.
   * @param {{ delta: number, serverTime: number }} opts
   */
  update({ delta = 0, serverTime = 0 } = {}) {
    if (this._disposed) return;
    const dt = Math.max(0, delta);

    for (const [id, puppet] of this.puppets) {
      const pose = this.buffer.sampleAt(id, serverTime);
      // Match-only: hide lobby / pre-spawn / dead.
      if (!pose || pose.alive === false) {
        puppet.root.visible = false;
        if (puppet._hitFlash > 0) puppet._hitFlash = Math.max(0, puppet._hitFlash - dt);
        if (puppet.shell) puppet.shell.update(dt * 0.25); // slow idle while hidden optional
        continue;
      }
      puppet.root.visible = true;

      // Horizontal displacement this frame — a synced-pose-independent speed source
      // so the shell animates whenever the puppet visibly moves, even if the
      // authored velocity/locomotionState arrive stuck (server defaults to idle).
      const prevX = puppet.root.position.x;
      const prevZ = puppet.root.position.z;
      puppet.root.position.set(pose.position[0], pose.position[1], pose.position[2]);
      puppet.root.rotation.y = pose.yaw;

      const dispSpeed = dt > 1e-4
        // Clamp so a teleporter / respawn jump can't flash a one-frame sprint.
        ? Math.min(12, Math.hypot(pose.position[0] - prevX, pose.position[2] - prevZ) / dt)
        : 0;
      const speed = Math.max(Math.hypot(pose.velocity[0], pose.velocity[2]), dispSpeed);
      puppet.locomotionState = pose.locomotionState;
      puppet.animationState = pose.animation?.base ?? null;

      if (puppet.shell) {
        this._updateShell(puppet, pose, speed, dt);
      } else {
        this._updateCapsule(puppet, pose, speed, dt);
      }

      this._setWeapon(puppet, pose.currentWeapon);

      // Hit flash decay.
      if (puppet._hitFlash > 0) {
        puppet._hitFlash = Math.max(0, puppet._hitFlash - dt);
        if (puppet.bodyMat?.emissiveIntensity != null) {
          const base = puppet.baseEmissiveIntensity ?? 0.55;
          const t = puppet._hitFlash / 0.18;
          puppet.bodyMat.emissiveIntensity = base + base * 1.2 * t;
        }
        if (puppet.shell?.root && puppet._hitFlash === 0) {
          puppet.shell.root.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
              if (m.userData._baseEmissive != null) m.emissiveIntensity = m.userData._baseEmissive;
            }
          });
        }
      }

      // Fire kick: nudge gun / stub forward briefly.
      if (puppet._fireKick > 0) {
        puppet._fireKick = Math.max(0, puppet._fireKick - dt);
        const kick = (puppet._fireKick / 0.12) * 0.04;
        if (puppet.gunRoot) puppet.gunRoot.position.z = (puppet._gunBaseZ ?? 0) - kick;
        else if (puppet.weapon) puppet.weapon.position.z = (puppet._stubBaseZ ?? 0.28) - kick;
      } else if (puppet.gunRoot && puppet._gunBaseZ != null) {
        puppet.gunRoot.position.z = puppet._gunBaseZ;
      }
    }
  }

  snapshot() {
    return {
      puppetCount: this.puppets.size,
      localPlayerId: this._localPlayerId,
      shellMode: this._shellTemplate ? 'skinned' : (this._shellLoadAttempted ? 'capsule-fallback' : 'pending'),
      buffer: this.buffer.snapshot(),
      puppets: [...this.puppets.values()].map((p) => ({
        playerId: p.playerId,
        displayName: p.displayName,
        weaponId: p.weaponId,
        locomotionState: p.locomotionState,
        animationState: p.animationState,
        clip: p.shell?.currentState ?? null,
        shell: Boolean(p.shell),
        visible: p.root.visible,
        x: p.root.position.x,
        y: p.root.position.y,
        z: p.root.position.z,
        yaw: p.root.rotation.y,
      })),
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const id of [...this.puppets.keys()]) this._destroyPuppet(id);
    this.buffer.clear();
    this.group.parent?.remove(this.group);
    disposeObject3D(this.group);
    this._scene = null;
    this._shellTemplate = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _ensureShellTemplate() {
    if (this._shellLoadAttempted || !canLoadRemoteShells()) return;
    this._shellLoadAttempted = true;
    this._shellTemplatePromise = ensureRemoteShellTemplate().then((tpl) => {
      if (this._disposed) return null;
      this._shellTemplate = tpl;
      if (tpl) {
        for (const puppet of this.puppets.values()) {
          this._upgradeToShell(puppet);
        }
      }
      return tpl;
    });
  }

  _spawnPuppet(player) {
    if (this.puppets.size >= CAPACITY) return;
    const color = BODY_COLORS[this._colorCursor % BODY_COLORS.length];
    this._colorCursor += 1;

    const root = new THREE.Group();
    root.name = `RemotePlayer:${player.playerId}`;
    root.userData.skipLevelRaycast = true;
    root.userData.noStaticMerge = true;

    // Capsule placeholder (always available; replaced when shell loads).
    const bodyMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.55,
      roughness: 0.55,
      metalness: 0.12,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1e,
      emissive: 0x222228,
      emissiveIntensity: 0.2,
      roughness: 0.85,
      metalness: 0.05,
    });

    const placeholder = new THREE.Group();
    placeholder.name = 'CapsulePlaceholder';
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 1.05, 6, 12), bodyMat);
    body.position.y = 1.0;
    body.castShadow = true;
    body.receiveShadow = true;
    placeholder.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), bodyMat);
    head.position.y = 1.72;
    head.castShadow = true;
    placeholder.add(head);
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.42), accentMat);
    weapon.position.set(0.32, 1.2, 0.28);
    weapon.rotation.x = -0.15;
    placeholder.add(weapon);
    root.add(placeholder);

    if (Array.isArray(player.position)) {
      root.position.set(player.position[0], player.position[1], player.position[2]);
    }
    if (Number.isFinite(player.yaw)) root.rotation.y = player.yaw;

    this.group.add(root);

    /** @type {Puppet} */
    const puppet = {
      playerId: player.playerId,
      displayName: player.displayName ?? 'Player',
      root,
      placeholder,
      body,
      head,
      weapon,
      bodyMat,
      accentMat,
      baseEmissiveIntensity: 0.55,
      weaponId: null,
      locomotionState: 'idle',
      animationState: null,
      shell: null,
      gunView: null,
      gunRoot: null,
      _gunBaseZ: 0,
      _stubBaseZ: 0.28,
      _weaponLoadId: 0,
      _weaponPendingId: null,
      _hitFlash: 0,
      _fireKick: 0,
      _bobPhase: Math.random() * Math.PI * 2,
      _bodyBaseY: body.position.y,
      _headBaseY: head.position.y,
    };
    this.puppets.set(player.playerId, puppet);
    this._setWeapon(puppet, player.currentWeapon ?? null);
    puppet.root.visible = player.alive !== false;

    if (this._shellTemplate) this._upgradeToShell(puppet);
    else this._ensureShellTemplate();
  }

  _upgradeToShell(puppet) {
    if (!this._shellTemplate || puppet.shell || this._disposed) return;
    try {
      const shell = createRemoteShellInstance(this._shellTemplate);
      shell.root.userData.skipLevelRaycast = true;
      shell.root.userData.noStaticMerge = true;
      puppet.root.add(shell.root);
      // Hide capsule once skinned body is present.
      if (puppet.placeholder) puppet.placeholder.visible = false;
      puppet.shell = shell;
      // Re-attach weapon onto the real hand if already loaded.
      if (puppet.gunRoot && shell.rightHand) {
        shell.rightHand.add(puppet.gunRoot);
        applyMixamoRightHandGunRest(puppet.gunRoot);
        puppet._gunBaseZ = puppet.gunRoot.position.z;
      } else if (puppet.weaponId && !puppet.gunRoot) {
        // Shell arrived before gun finished loading — kick attach.
        this._setWeapon(puppet, puppet.weaponId, { force: true });
      }
    } catch (err) {
      // Keep capsule; do not rethrow into the frame loop.
      console.warn(
        '[RemotePlayer] shell upgrade failed',
        puppet.playerId,
        err?.message || err,
        err?.stack?.split?.('\n')?.slice?.(0, 3)?.join?.(' | '),
      );
      puppet._shellFailed = true;
    }
  }

  _updateCapsule(puppet, pose, speed, dt) {
    puppet._bobPhase += dt * (4 + Math.min(8, speed * 2));
    const bob = Math.sin(puppet._bobPhase) * Math.min(0.06, speed * 0.012);
    if (puppet.body) puppet.body.position.y = puppet._bodyBaseY + bob;
    if (puppet.head) {
      puppet.head.position.y = puppet._headBaseY + bob;
      puppet.head.rotation.x = THREE.MathUtils.clamp(pose.pitch, -0.6, 0.6) * 0.35;
    }
    if (puppet.weapon) puppet.weapon.visible = Boolean(puppet.weaponId);
    const run = /run|sprint|jog/i.test(pose.locomotionState || '');
    puppet.root.scale.setScalar(run ? 1.02 : 1);
  }

  _updateShell(puppet, pose, speed, dt) {
    const shell = puppet.shell;
    if (!shell) return;
    const desired = mapLocomotionToClip(pose.locomotionState, {
      armed: Boolean(puppet.weaponId),
      speed,
    });
    // Replay the local controller's resolved full-body/layered graph. Older
    // servers/initial welcome snapshots fall back to coarse locomotion.
    shell.applyAnimation(pose.animation, desired, 0.14);
    // Distant remotes: half-rate mixer beyond 40 m.
    let animDt = dt;
    if (puppet.root?.parent) {
      // Cheap distance from origin of puppet group parent (arena centre) if no local pos.
      const dx = pose.position[0];
      const dz = pose.position[2];
      if (dx * dx + dz * dz > 45 * 45) animDt = dt * 0.5;
    }
    shell.update(animDt);
  }

  /**
   * @param {Puppet} puppet
   * @param {string|null} weaponId
   * @param {{ force?: boolean }} [opts]
   */
  _setWeapon(puppet, weaponId, opts = {}) {
    const id = weaponId || null;
    if (!opts.force
      && puppet.weaponId === id
      && (puppet.gunRoot || puppet._weaponPendingId === id || id === null)) return;
    puppet.weaponId = id;

    // Capsule stub always available as fallback presentation.
    if (puppet.weapon && !puppet.shell) {
      this._setStubWeapon(puppet, id);
    }

    const loadToken = (puppet._weaponLoadId = (puppet._weaponLoadId || 0) + 1);
    puppet._weaponPendingId = id;
    // Clear previous gun mesh.
    if (puppet.gunRoot) {
      puppet.gunRoot.parent?.remove(puppet.gunRoot);
      disposeObject3D(puppet.gunRoot);
      puppet.gunRoot = null;
    }
    puppet.gunView = null;

    if (!id || !canLoadRemoteShells() || !remoteGunLoader) {
      puppet._weaponPendingId = null;
      if (puppet.weapon) {
        puppet.weapon.visible = Boolean(id);
        this._setStubWeapon(puppet, id);
      }
      return;
    }

    loadRemoteGunMesh(id).then((gunRoot) => {
      if (this._disposed || puppet._weaponLoadId !== loadToken) {
        disposeObject3D(gunRoot);
        return;
      }
      if (!this.puppets.has(puppet.playerId)) {
        disposeObject3D(gunRoot);
        return;
      }
      puppet.gunRoot = gunRoot;
      puppet._weaponPendingId = null;
      const hand = puppet.shell?.rightHand
        || puppet.root.getObjectByName('mixamorigRightHand');
      if (hand) {
        hand.add(gunRoot);
        applyMixamoRightHandGunRest(gunRoot);
      } else {
        // Shell not ready — park on capsule root until upgrade reparents.
        puppet.root.add(gunRoot);
        gunRoot.position.set(0.28, 1.15, 0.25);
      }
      puppet._gunBaseZ = gunRoot.position.z;
      if (puppet.weapon) puppet.weapon.visible = false;
      if (puppet.placeholder && puppet.shell) puppet.placeholder.visible = false;
    }).catch((err) => {
      if (puppet._weaponLoadId === loadToken) puppet._weaponPendingId = null;
      console.warn('[RemotePlayer] gun load failed', id, err?.message || err);
      if (puppet.weapon) {
        puppet.weapon.visible = true;
        this._setStubWeapon(puppet, id);
      }
    });
  }

  _setStubWeapon(puppet, weaponId) {
    if (!puppet.weapon) return;
    const id = weaponId || '';
    let length = 0.42;
    let color = 0x1a1a1e;
    if (id.includes('shotgun')) { length = 0.55; color = 0x5a4632; }
    else if (id.includes('ar15') || id.includes('rifle')) { length = 0.62; color = 0x2f3d2f; }
    else if (id.includes('sentinel') || id.includes('sniper')) { length = 0.78; color = 0x3a3a48; }
    else if (id.includes('glock') || id.includes('pistol')) { length = 0.28; color = 0x222228; }
    puppet.weapon.geometry?.dispose?.();
    puppet.weapon.geometry = new THREE.BoxGeometry(0.08, 0.1, length);
    puppet.weapon.position.z = length * 0.45;
    puppet._stubBaseZ = puppet.weapon.position.z;
    puppet.accentMat.color.setHex(color);
    puppet.weapon.visible = Boolean(weaponId);
  }

  _destroyPuppet(playerId) {
    const puppet = this.puppets.get(playerId);
    if (!puppet) return;
    this.puppets.delete(playerId);
    if (puppet.gunRoot) {
      puppet.gunRoot.parent?.remove(puppet.gunRoot);
      disposeObject3D(puppet.gunRoot);
      puppet.gunRoot = null;
    }
    puppet.gunView = null;
    if (puppet.shell) {
      puppet.shell.root?.parent?.remove(puppet.shell.root);
      try { puppet.shell.dispose(); } catch { /* ignore */ }
      puppet.shell = null;
    }
    puppet.root.parent?.remove(puppet.root);
    disposeObject3D(puppet.root);
  }
}

/**
 * Lightweight TP gun mesh for remotes — no Gunsmith TSL materials (those require
 * UVs and were cascading WebGPU AttributeNode / pipeline errors on swap).
 * @param {string} gunId
 * @returns {Promise<THREE.Object3D>}
 */
function loadRemoteGunMesh(gunId) {
  const entry = GUN_CATALOG.find((g) => g.id === gunId)
    || { id: gunId, glbUrl: `/assets/guns/${gunId}.glb` };
  const url = entry.glbUrl || `/assets/guns/${gunId}.glb`;
  let pending = remoteGunTemplateCache.get(url);
  if (!pending) {
    pending = remoteGunLoader.loadAsync(url).then((gltf) => {
      const src = gltf.scene || gltf;
      flattenObjectForWebGPU(src);
      sanitizeWebGPUVertexBuffers(src, { warn: () => {} });
      return src;
    }).catch((err) => {
      remoteGunTemplateCache.delete(url);
      throw err;
    });
    remoteGunTemplateCache.set(url, pending);
  }
  return pending.then((template) => {
    const root = new THREE.Group();
    root.name = `RemoteGun_${gunId}`;
    const mesh = template.clone(true);
    // Simple standard materials — avoids node-material UV hard-fails.
    mesh.traverse((obj) => {
      if (!obj.isMesh) return;
      const color = obj.material?.color?.isColor ? obj.material.color.getHex() : 0x3a3a42;
      obj.material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.45,
        metalness: 0.55,
        map: obj.material?.map ?? null,
      });
      obj.castShadow = true;
      if (obj.geometry && !obj.geometry.getAttribute('uv') && obj.geometry.getAttribute('position')) {
        const n = obj.geometry.getAttribute('position').count;
        obj.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      }
    });
    flattenObjectForWebGPU(mesh);
    sanitizeWebGPUVertexBuffers(mesh, { warn: () => {} });
    root.add(mesh);
    // Reasonable TP scale if the source is first-person sized.
    root.scale.setScalar(1);
    return root;
  });
}

/**
 * @typedef {object} Puppet
 */
