/**
 * WeaponSystem (M5–M7) — loadout + perf-conscious fire path.
 *
 * Owns the unified weapon list (great sword first, then guns). Hotkeys:
 * 1 = sword/melee, 2 = pistol, 3 = random non-pistol gun. Z holsters / draws
 * the equipped weapon. Scroll is left for camera zoom (no weapon cycling).
 * Fire path only runs when a gun is drawn in first person.
 *
 * Hitscan prefers cheap enemy capsules; world Rapier rays are optional (expensive
 * against city heightfields). No PointLight flash, no per-shot layout force,
 * audio is throttled / pooled.
 */

import * as THREE from 'three';
import {
  getGunSound,
  getWeaponPresentationSound,
  getWeaponPresentationSoundVariants,
} from '../weapons/gunSoundLibrary.js';
import {
  buildPelletDirections,
  resolvePelletHit,
} from '../weapons/weaponHitscan.js';
import {
  DEFAULT_WEAPON_ID,
  SWORD_WEAPON_ID,
  WEAPON_CATALOG,
  findWeapon,
  isGunWeaponId,
  isSwordWeaponId,
  weaponIndex,
} from '../weapons/weaponCatalog.js';
import { GUN_CATALOG } from '../weapons/gunProfile.js';
import { findMagazineMeshes } from '../weapons/magazineParts.js';
import { createDroppedMagazineManager } from '../weapons/droppedMagazines.js';
import { WeaponPresentationSystem } from './WeaponPresentationSystem.js';
import {
  buildLimbSeverPlane,
  canGunSeverRegion,
  classifyGunHitLimbRegion,
} from './soldierPartialCut.js';

const TRACER_POOL = 12;
const TRACER_LIFE = 0.055;
const SHELL_POOL = 8;
const SHELL_LIFE = 0.7;
const RECOIL_RECOVER = 9;
const INSPECT_BLEND_SPEED = 8;
/** World physics ray is costly on streamed city colliders — off by default. */
const USE_WORLD_RAY = false;
const AUDIO_MIN_INTERVAL_MS = 45;

const _muzzle = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _hitPoint = new THREE.Vector3();

/**
 * Resolve number-key loadout (0-based gunSlotPressed → key 1/2/3).
 * 1 sword, 2 pistol, 3 random from the other catalog guns (rifles + shotgun).
 * @param {number} slot
 * @returns {string|null}
 */
function resolveLoadoutHotkeyId(slot) {
  if (slot === 0) return SWORD_WEAPON_ID;
  if (slot === 1) {
    return GUN_CATALOG.find((g) => g.weaponKind === 'pistol')?.id ?? null;
  }
  if (slot === 2) {
    const pool = GUN_CATALOG.filter((g) => g.weaponKind !== 'pistol');
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)].id;
  }
  return null;
}

export class WeaponSystem {
  constructor() {
    this.scene = null;
    this.enabled = true;
    this.lastShots = [];
    this.totalShots = 0;
    this.totalHits = 0;
    this.totalKills = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.gunKick = 0;
    this.inspectBlend = 0;
    /** Equipped loadout id (sword first by default). */
    this.equippedId = DEFAULT_WEAPON_ID;
    this.switchIndex = weaponIndex(this.equippedId);
    /** When true, equipped weapon is put away (Z toggles). Sword starts drawn. */
    this.holstered = false;
    this._tracers = [];
    this._tracerMat = null;
    this._shells = [];
    this._shellGeo = null;
    this._shellMat = null;
    this._audioCtx = null;
    this._shotGain = null;
    this._sampleGain = null;
    this._sampleCompressor = null;
    this._audioBuffers = new Map();
    this._audioLoads = new Map();
    this._audioVoices = new Map();
    this._audioGeneration = 0;
    this._preloadedGun = null;
    this._preloadedPresentationSounds = false;
    this._lastAudioMs = 0;
    this._lastDryClick = 0;
    this._reloadAnimTimer = 0;
    this._pendingRagdolls = [];
    this._fwdScratch = { x: 0, y: 0, z: -1 };
    this._originScratch = { x: 0, y: 0, z: 0 };
    this.presentationSystem = new WeaponPresentationSystem();
    this._gunRoot = null;
    /**
     * Optional deathmatch combat interceptor (M4).
     * When set and returns true for a fire event, local enemy hitscan is skipped
     * (server owns damage). Cosmetics still play. Null in offline modes.
     * @type {null|((payload: object) => boolean)}
     */
    this._combatInterceptor = null;
    /**
     * Optional reload interceptor for networked deathmatch (sends RELOAD intent).
     * @type {null|((payload: object) => boolean)}
     */
    this._reloadInterceptor = null;
    /**
     * Optional fire gate: when it returns true, local tryFire is suppressed
     * (dead / countdown) so the mag is not burned without a SHOT_RESULT.
     * @type {null|(() => boolean)}
     */
    this._combatFireGate = null;
    /** Spent-magazine physics props (AR2). */
    this._droppedMags = null;
  }

  initialize(scene) {
    this.scene = scene ?? null;
    if (!scene) return;
    this.presentationSystem.initialize(scene);
    this._droppedMags = createDroppedMagazineManager(scene);

    this._tracerMat = new THREE.LineBasicMaterial({
      color: 0xffe0a0,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    for (let i = 0; i < TRACER_POOL; i += 1) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, this._tracerMat);
      line.visible = false;
      line.frustumCulled = false;
      line.renderOrder = 40;
      // Skip bounds recompute — short-lived FX
      line.matrixAutoUpdate = false;
      scene.add(line);
      this._tracers.push({
        line,
        life: 0,
        pos: geo.attributes.position,
        originAnchor: null,
      });
    }

    // Cheap unlit shells (no lighting cost)
    this._shellGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.022, 4);
    this._shellMat = new THREE.MeshBasicMaterial({ color: 0xc9a227 });
    for (let i = 0; i < SHELL_POOL; i += 1) {
      const mesh = new THREE.Mesh(this._shellGeo, this._shellMat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this._shells.push({ mesh, life: 0, vx: 0, vy: 0, vz: 0 });
    }
  }

  isSwordEquipped() {
    return isSwordWeaponId(this.equippedId);
  }

  isGunEquipped() {
    return isGunWeaponId(this.equippedId);
  }

  /** Drawn = equipped and not holstered. */
  isDrawn() {
    return !this.holstered;
  }

  isGunDrawn() {
    return this.isGunEquipped() && this.isDrawn();
  }

  isSwordDrawn() {
    return this.isSwordEquipped() && this.isDrawn();
  }

  getEquippedEntry() {
    return findWeapon(this.equippedId);
  }

  /**
   * Select a catalog weapon by id. Does not force draw — call applyLoadoutVisuals
   * (or processLoadout) after if the character should match the new selection.
   * @param {string} weaponId
   * @returns {string} equipped id
   */
  equip(weaponId) {
    const entry = findWeapon(weaponId);
    if (!entry) return this.equippedId;
    this.equippedId = entry.id;
    this.switchIndex = weaponIndex(entry.id);
    return this.equippedId;
  }

  /**
   * Cycle loadout by direction (+1 / -1). Kept for debug/API; not bound to scroll.
   * @param {number} dir
   * @returns {string}
   */
  cycle(dir = 1) {
    if (WEAPON_CATALOG.length === 0) return this.equippedId;
    const step = dir > 0 ? 1 : -1;
    this.switchIndex = (this.switchIndex + step + WEAPON_CATALOG.length) % WEAPON_CATALOG.length;
    this.equippedId = WEAPON_CATALOG[this.switchIndex]?.id ?? DEFAULT_WEAPON_ID;
    return this.equippedId;
  }

  /**
   * Early-frame loadout: Z holster/draw, 1/2/3 weapon hotkeys.
   * Call before combat/FP consume the frame so sword and gun stance stay in sync.
   * Scroll is not used for weapons (camera zoom keeps zoomDelta).
   *
   * @returns {object} patched input (drawSheathe / gunSlot consumed when handled)
   */
  processLoadout({
    input,
    character,
    combatSystem = null,
    firstPersonWeaponSystem = null,
  } = {}) {
    if (!input) return input;

    let nextInput = input;
    const combat = character?.combat;
    const busy = Boolean(
      combat?.attack
      || combat?.weapon === 'drawing'
      || combat?.weapon === 'sheathing',
    );
    const reloading = Boolean(firstPersonWeaponSystem?.gunView?.gun?.isReloading);

    // 1 = sword/melee, 2 = pistol, 3 = random rifle/shotgun from the other 9.
    // Keys 4–0 are ignored for loadout (elevators still use floor bindings).
    const slot = Number.isInteger(input.gunSlotPressed) ? input.gunSlotPressed : -1;
    if (slot >= 0 && !busy && !reloading) {
      const weaponId = resolveLoadoutHotkeyId(slot);
      if (weaponId) {
        const prevId = this.equippedId;
        const sameWeapon = prevId === weaponId;
        this.equip(weaponId);
        // Hotkey always draws the chosen weapon (press again while drawn is a no-op).
        // Slot 3 re-rolls each press, so sameWeapon is rare unless RNG repeats.
        if (sameWeapon && !this.holstered) {
          // Already holding this weapon — leave state alone.
        } else {
          this.holstered = false;
          this._onEquippedChanged({ character, combatSystem, firstPersonWeaponSystem });
          this._applyDrawnState({
            character,
            combatSystem,
            firstPersonWeaponSystem,
            animated: false,
          });
        }
      }
      nextInput = { ...nextInput, gunSlotPressed: null };
    }

    // Z: holster put-away / draw the equipped weapon (sword first by default).
    if (nextInput.drawSheathePressed && !busy && canToggleHolster(character)) {
      this.holstered = !this.holstered;
      this._applyDrawnState({ character, combatSystem, firstPersonWeaponSystem, animated: true });
      nextInput = {
        ...nextInput,
        drawSheathePressed: false,
        // Don't also treat this edge as a held inspect.
        inspectHeld: false,
      };
    }

    // Keep gun mesh / sword visibility coherent every frame.
    this._syncVisuals({ character, firstPersonWeaponSystem });

    return nextInput;
  }

  /**
   * Force a specific weapon out (e.g. shooting range).
   * @param {string} weaponId
   */
  equipAndDraw(weaponId, { character, combatSystem, firstPersonWeaponSystem } = {}) {
    this.equip(weaponId);
    this.holstered = false;
    this._onEquippedChanged({ character, combatSystem, firstPersonWeaponSystem });
    this._applyDrawnState({ character, combatSystem, firstPersonWeaponSystem, animated: false });
  }

  /**
   * Deathmatch M4: install/clear a fire interceptor. Offline modes leave this null.
   * When the interceptor returns true, local enemy hitscan is skipped (server owns damage).
   * @param {null|((payload: object) => boolean)} fn
   */
  setCombatInterceptor(fn) {
    this._combatInterceptor = typeof fn === 'function' ? fn : null;
  }

  /**
   * Deathmatch M4: install/clear a reload intent interceptor.
   * @param {null|((payload: object) => boolean)} fn
   */
  setReloadInterceptor(fn) {
    this._reloadInterceptor = typeof fn === 'function' ? fn : null;
  }

  /**
   * Deathmatch M4: when the gate returns true, suppress local gun tryFire
   * (no mag burn while dead / countdown).
   * @param {null|(() => boolean)} fn
   */
  setCombatFireGate(fn) {
    this._combatFireGate = typeof fn === 'function' ? fn : null;
  }

  _onEquippedChanged({ character, combatSystem, firstPersonWeaponSystem }) {
    if (this.isSwordEquipped()) {
      // Hide any gun; sword visibility follows holstered state.
      // Drop gun stance immediately so movement/anim don't keep rifle/pistol
      // settings for the rest of the frame (TP never set fpWeaponStance).
      firstPersonWeaponSystem?.setHolstered?.(true);
      if (character?.combat) {
        character.combat.weaponClass = null;
        character.combat.fpWeaponStance = false;
        character.combat.aiming = false;
        character.combat.reloading = false;
        const ov = character.combat.animationOverride;
        if (typeof ov === 'string' && (
          ov.startsWith('fp_')
          || ov.startsWith('armed')
          || ov.startsWith('rifle_')
          || ov.startsWith('pistol_')
        )) {
          character.combat.animationOverride = null;
        }
      }
    } else if (this.isGunEquipped()) {
      // Sheathe sword quietly when switching to a firearm.
      combatSystem?.forceSheathe?.({ character, silent: true });
      if (!this.holstered) {
        void firstPersonWeaponSystem?.equipGun?.(this.equippedId);
        firstPersonWeaponSystem?.setHolstered?.(false);
      } else {
        firstPersonWeaponSystem?.setHolstered?.(true);
      }
    }
  }

  _applyDrawnState({ character, combatSystem, firstPersonWeaponSystem, animated = true }) {
    if (this.holstered) {
      // Put away.
      if (this.isSwordEquipped()) {
        if (animated) {
          combatSystem?.requestSheathe?.({ character });
        } else {
          combatSystem?.forceSheathe?.({ character, silent: true });
        }
      }
      firstPersonWeaponSystem?.setHolstered?.(true);
      return;
    }

    // Draw equipped.
    if (this.isSwordEquipped()) {
      firstPersonWeaponSystem?.setHolstered?.(true);
      if (animated) {
        combatSystem?.requestDraw?.({ character });
      } else {
        combatSystem?.forceDraw?.({ character, silent: true });
      }
      return;
    }

    if (this.isGunEquipped()) {
      combatSystem?.forceSheathe?.({ character, silent: true });
      void firstPersonWeaponSystem?.equipGun?.(this.equippedId);
      firstPersonWeaponSystem?.setHolstered?.(false);
    }
  }

  _syncVisuals({ character, firstPersonWeaponSystem }) {
    const entry = this.getEquippedEntry();
    if (character?.combat) {
      character.combat.equippedWeaponId = this.equippedId;
      character.combat.weaponHolstered = this.holstered;
      character.combat.equippedWeaponKind = entry?.kind ?? null;
    }

    if (this.isGunDrawn()) {
      firstPersonWeaponSystem?.setHolstered?.(false);
      if (firstPersonWeaponSystem && firstPersonWeaponSystem.equippedGunId !== this.equippedId) {
        void firstPersonWeaponSystem.equipGun?.(this.equippedId);
      }
    } else if (this.isGunEquipped() && this.holstered) {
      firstPersonWeaponSystem?.setHolstered?.(true);
    } else if (this.isSwordEquipped()) {
      firstPersonWeaponSystem?.setHolstered?.(true);
    }
  }

  update({
    delta,
    input,
    character,
    cameraSystem,
    physicsSystem,
    enemySystem,
    enemyCutSystem = null,
    propSystem = null,
    firstPersonWeaponSystem,
    vehicleDamageSystem = null,
    vehicleSystem = null,
    shootingRangeSystem = null,
    aquariumBreachSystem = null,
    propaneTankSystem = null,
    hordeProxySystem = null,
    resolveHordeTarget = null,
    maxDetailedRagdolls = Infinity,
    fallbackHordeDeath = null,
  }) {
    const dt = Math.max(0, Number(delta) || 0);
    this._tickEffects(dt);
    this.presentationSystem.update({ delta: dt, camera: cameraSystem?.camera, gunRoot: this._gunRoot });
    // Dropped mags outlive the fire path (they keep falling while holstered), so
    // sync/age them before the active-weapon early-out.
    this._droppedMags?.update({ delta: dt, physicsSystem });
    this._flushOneRagdoll({
      physicsSystem,
      enemySystem,
      enemyCutSystem,
      propSystem,
      maxDetailedRagdolls,
      fallbackHordeDeath,
    });
    this._recoverRecoil(dt);

    const fp = firstPersonWeaponSystem;
    // Guns only fire when drawn (not holstered) in first person.
    const active = Boolean(
      this.enabled
      && this.isGunDrawn()
      && fp?.active
      && fp?.visibleWeapon
      && fp?.gunView?.gun,
    );
    if (!active) {
      this.inspectBlend = 0;
      cameraSystem?.setWeaponAds?.(0, null);
      if (character?.combat) {
        character.combat.aiming = false;
        character.combat.reloading = false;
      }
      return;
    }

    const gun = fp.gunView.gun;
    const gunRoot = fp.gunView.root;
    this._gunRoot = gunRoot ?? null;
    if (this._preloadedGun !== gun) {
      this._preloadedGun = gun;
      this._preloadGunSounds(gun);
    }

    // Keep switch index aligned with loadout.
    this.switchIndex = weaponIndex(this.equippedId);

    // X held: inspect firearm (Z is holster only).
    const wantInspect = Boolean(input?.inspectHeld);
    const inspectTarget = wantInspect && !gun.isReloading ? 1 : 0;
    const iAlpha = 1 - Math.exp(-INSPECT_BLEND_SPEED * dt);
    this.inspectBlend += (inspectTarget - this.inspectBlend) * iAlpha;

    // Networked deathmatch: suppress tryFire while dead/countdown so mag is not burned.
    const suppressFire = Boolean(this._combatFireGate?.());
    const firePressed = !suppressFire && Boolean(input?.lightAttackPressed || input?.firePressed);
    const fireHeld = !suppressFire && Boolean(input?.mousePrimaryHeld || input?.fireHeld || firePressed);
    const adsHeld = Boolean(input?.mouseSecondaryHeld || input?.heavyAttackPressed || input?.adsHeld);
    const reloadPressed = Boolean(
      input?.reloadPressed
      || input?.shoulderThrowPressed
      || input?.reload,
    );

    const canShoot = this.inspectBlend < 0.5;
    // Aim state drives the shared locomotion resolver (aim_idle + walk gait + the
    // aim-facing body yaw) in both first and third person.
    if (character?.combat) character.combat.aiming = adsHeld && canShoot;
    const { shot, events } = gun.update({
      dt,
      fireHeld: fireHeld && canShoot,
      firePressed: firePressed && canShoot,
      reloadPressed: reloadPressed && !suppressFire,
      adsHeld: adsHeld && canShoot,
      pumpPressed: !fireHeld,
    });

    cameraSystem?.setWeaponAds?.(gun.ads, gun.stats.adsFov ?? 48);

    if (events.includes('dryFire') && !this._playGunSound(gun, 'dryFire')) {
      this._playDryClick();
    }
    if (events.includes('reloadStart')) {
      this._reloadAnimTimer = gun.stats.reloadTime || 1.5;
      if (!this._playGunSound(gun, 'reloadStart')) this._playClick(220, 0.03);
      // Networked deathmatch: server owns reload completion / ammo grant.
      this._reloadInterceptor?.({ weaponId: this.equippedId, gun });
    }
    if (events.includes('reloadComplete')) {
      this._reloadAnimTimer = 0;
      if (!this._playGunSound(gun, 'reloadComplete')) this._playClick(420, 0.025);
      // Networked deathmatch: server reload_complete owns mag contents. Local
      // BaseGun may have already refilled — keep presentation until server event
      // by not treating this as authoritative ammo (combat adapter syncs later).
    }
    if (events.includes('pump')) {
      if (!this._playGunSound(gun, 'pump')) this._playClick(360, 0.03);
    }
    // AR2: the spent magazine falls as a physics prop the moment it clears the well.
    if (events.includes('mag_drop')) {
      this._dropSpentMagazine({ gun, gunRoot, physicsSystem });
      firstPersonWeaponSystem?.handleReloadMagazinePhase?.('mag_drop');
    }
    if (events.includes('mag_spawn')) {
      firstPersonWeaponSystem?.handleReloadMagazinePhase?.('mag_spawn');
    }
    if (events.includes('mag_seat')) {
      firstPersonWeaponSystem?.handleReloadMagazinePhase?.('mag_seat');
    }
    if (events.includes('reloadCancel')) {
      firstPersonWeaponSystem?.cancelReloadMagazineCycle?.();
    }
    if (this._reloadAnimTimer > 0) {
      this._reloadAnimTimer = Math.max(0, this._reloadAnimTimer - dt);
    }
    // Drive the upper-body reload animation layer (legs keep locomotion).
    if (character?.combat) character.combat.reloading = gun.isReloading;

    // Kick data only — postAnimation layout already runs once per frame.
    // Do NOT force another layout here (that was a major fire hitch).
    this.presentationSystem.update({ delta: 0, camera: cameraSystem?.camera, gunRoot });
    if (gunRoot) {
      gunRoot.userData.inspectBlend = this.inspectBlend;
      if (gun.slideLocked) {
        gunRoot.userData.weaponKickZ = Math.max(gunRoot.userData.weaponKickZ || 0, 0.01);
      }
    }

    if (shot) {
      this._resolveShot({
        shot,
        gun,
        fp,
        cameraSystem,
        physicsSystem,
        enemySystem,
        enemyCutSystem,
        propSystem,
        vehicleDamageSystem,
        vehicleSystem,
        shootingRangeSystem,
        aquariumBreachSystem,
        propaneTankSystem,
        hordeProxySystem,
        resolveHordeTarget,
      });
    }

    void character;
  }

  /**
   * Cosmetics-only shot path used when networked deathmatch owns hit resolution.
   * Still plays muzzle flash, recoil, tracer, shell, and audio.
   */
  _presentNetworkedShot({ gun, fp, cameraSystem, origin, direction, muzzlePos }) {
    this.totalShots += 1;
    const camera = cameraSystem?.camera;
    if (camera) {
      _fwd.set(direction[0], direction[1], direction[2]);
      if (_fwd.lengthSq() < 1e-8) camera.getWorldDirection(_fwd);
      else _fwd.normalize();
      _origin.set(origin[0], origin[1], origin[2]);
      if (muzzlePos) _muzzle.copy(muzzlePos);
      else _muzzle.copy(_origin).addScaledVector(_fwd, 0.35);
      _hitPoint.copy(_origin).addScaledVector(_fwd, 40);
      this._spawnTracer(_muzzle, _hitPoint, null);
      this.presentationSystem.presentShot({
        gun,
        muzzlePosition: _muzzle,
        aimDirection: _fwd,
        cameraSystem,
        gunRoot: fp?.gunView?.root,
        ads: gun.ads,
        bounce: null,
      });
      const presentation = this.presentationSystem.snapshot();
      this.gunKick = presentation.weaponBack;
      this._ejectShell(_muzzle, _fwd);
      this._playShotTransient(gun);
      this._playGunshot(gun);
    }
    this.lastShots.length = 0;
  }

  _resolveShot({
    shot,
    gun,
    fp,
    cameraSystem,
    physicsSystem,
    enemySystem,
    enemyCutSystem = null,
    propSystem = null,
    vehicleDamageSystem,
    vehicleSystem,
    shootingRangeSystem = null,
    aquariumBreachSystem = null,
    propaneTankSystem = null,
    hordeProxySystem = null,
    resolveHordeTarget = null,
  }) {
    const camera = cameraSystem?.camera;
    if (!camera) return;

    camera.getWorldDirection(_fwd);
    _origin.copy(camera.position);

    const originAnchorName = shot.originAnchor || 'muzzle';
    const muzzle = fp?.gunView?.anchors?.[originAnchorName]
      || fp?.gunView?.anchors?.muzzle;
    if (muzzle?.parent) {
      // Body yaw/recoil may change after the animation pass, so force the full
      // parent chain current before reading the author-edited muzzle marker.
      muzzle.updateWorldMatrix(true, false);
      muzzle.getWorldPosition(_muzzle);
    }
    else _muzzle.copy(_origin).addScaledVector(_fwd, 0.35);

    // Deathmatch M4: server owns damage. Send fire intent + cosmetics only.
    if (this._combatInterceptor) {
      const intercepted = this._combatInterceptor({
        origin: [_origin.x, _origin.y, _origin.z],
        direction: [_fwd.x, _fwd.y, _fwd.z],
        weaponId: this.equippedId,
        gun,
      });
      if (intercepted) {
        this._presentNetworkedShot({
          gun,
          fp,
          cameraSystem,
          origin: [_origin.x, _origin.y, _origin.z],
          direction: [_fwd.x, _fwd.y, _fwd.z],
          muzzlePos: _muzzle,
        });
        return;
      }
    }

    this.totalShots += 1;

    const pellets = Math.max(1, shot.pellets || 1);
    // Cap pellets hard — shotgun lag guard
    const pelletCount = Math.min(pellets, 6);
    const spread = Number(shot.spread) || 0.02;
    const range = Math.min(Number(shot.range) || 100, 90);

    this._fwdScratch.x = _fwd.x;
    this._fwdScratch.y = _fwd.y;
    this._fwdScratch.z = _fwd.z;
    this._originScratch.x = _origin.x;
    this._originScratch.y = _origin.y;
    this._originScratch.z = _origin.z;

    const dirs = buildPelletDirections(this._fwdScratch, pelletCount, spread);
    const rangeHits = shootingRangeSystem?.getHitEntities?.() ?? [];
    const propaneHits = propaneTankSystem?.getHitEntities?.() ?? [];
    // Spatial proxy candidates near the camera aim (M4) — avoid scanning all 250.
    let proxyTargets = [];
    if (hordeProxySystem?.getHitTargetsNear) {
      const focus = this._originScratch;
      proxyTargets = hordeProxySystem.getHitTargetsNear(focus.x, focus.z, Math.min(range, 36)) ?? [];
    } else {
      proxyTargets = hordeProxySystem?.getHitTargets?.() ?? [];
    }
    // Capsule hitscan treats range targets like enemies (same vertical cylinder).
    // Horde proxies are included so a direct aim promotes (or lightweight-damages).
    const baseEnemies = enemySystem?.enemies ?? [];
    const enemies = rangeHits.length || proxyTargets.length || propaneHits.length
      ? [...baseEnemies, ...rangeHits, ...propaneHits, ...proxyTargets]
      : baseEnemies;
    // City/world raycasts remain opt-in (dense streamed cities are expensive).
    // Compact authored arenas opt in: shooting range (surface response) and
    // horde aquarium breach (glass tanks need world hits for holes + jets).
    // wantsWorldRay covers the pre-bind frame; enabled is the steady state.
    const physics = (
      USE_WORLD_RAY
      || shootingRangeSystem?.enabled
      || aquariumBreachSystem?.enabled
      || aquariumBreachSystem?.wantsWorldRay
    ) ? physicsSystem : null;

    let hitSummary = null;
    let impactAudioPlayed = false;
    // One CSG sever per enemy per shot (shotgun pellets still damage, but only
    // the first pellet that lands a limb/head region runs the cut path).
    const severedThisShot = new Set();
    // Nearest world surface the shot pointed at — drives the fake muzzle-flash
    // bounce glow (cheaper than a dynamic light). Reuses the pellet raycasts.
    let nearestWorld = null;
    for (let i = 0; i < dirs.length; i += 1) {
      const d = dirs[i];
      const result = resolvePelletHit({
        origin: this._originScratch,
        direction: d,
        range,
        enemies,
        physics,
        excludeCollider: physicsSystem?.characterCollider ?? null,
        baseDamage: shot.damage,
      });

      _hitPoint.set(result.point.x, result.point.y, result.point.z);
      this._spawnTracer(_muzzle, _hitPoint, muzzle);

      if (result.kind === 'world' && result.point
        && (!nearestWorld || result.distance < nearestWorld.distance)) {
        nearestWorld = { point: result.point, normal: result.normal, distance: result.distance };
      }

      if (result.kind !== 'miss') {
        this.presentationSystem.presentImpact({
          point: result.point,
          normal: result.normal,
          incomingDirection: d,
          surfaceClass: result.surfaceClass,
          intensity: Math.min(1.8, Math.max(0.6, (Number(shot.damage) || 20) / 22)),
        });
        // Coalesce shotgun pellets to one primary impact voice per shot.
        if (!impactAudioPlayed) {
          this._playImpactSound(result.surfaceClass, result.kind === 'enemy', {
            point: result.point,
            camera,
          });
          impactAudioPlayed = true;
        }
      }

      if (result.kind === 'enemy' && result.enemy?.propaneTank) {
        this.totalHits += 1;
        propaneTankSystem?.onTankHit?.(result.enemy, result);
      } else if (result.kind === 'enemy' && result.enemy?.rangeTarget) {
        this.totalHits += 1;
        shootingRangeSystem?.onTargetHit?.(result.enemy, {
          region: result.region,
          damage: result.damage,
        });
      } else if (result.kind === 'enemy' && result.enemy) {
        let enemy = result.enemy;
        if (resolveHordeTarget) {
          // Horde: route EVERY hit (proxy or full-actor tip) through the
          // resolver so M3 suppression + tip knockback fire for full actors
          // too. Proxies may promote or take lightweight damage (→ null).
          enemy = resolveHordeTarget(enemy, { damage: result.damage, point: result.point }) ?? null;
          if (!enemy) {
            this.totalHits += 1;
            continue;
          }
        } else if (enemy.isHordeProxy) {
          hordeProxySystem?.applyLightweightDamage?.(result.enemy, result.damage);
          this.totalHits += 1;
          continue;
        }
        this._applyEnemyDamage({
          enemy,
          damage: result.damage,
          region: result.region,
          point: result.point,
          direction: d,
          enemySystem,
          enemyCutSystem,
          physicsSystem,
          propSystem,
          severedThisShot,
        });
      } else if (result.kind === 'world') {
        this._tryDamageVehicle({
          point: result.point,
          direction: d,
          damage: shot.damage,
          vehicleSystem,
          vehicleDamageSystem,
        });
        // Aquarium glass pillars (and any future world-hit consumers).
        aquariumBreachSystem?.onWorldHit?.(result);
      }

      if (!hitSummary) {
        hitSummary = {
          kind: result.enemy?.propaneTank
            ? 'propaneTank'
            : result.enemy?.rangeTarget
              ? (result.enemy.friendly ? 'friendly' : 'target')
              : result.kind,
          damage: result.damage,
          region: result.region,
          distance: result.distance,
          enemyId: result.enemy?.id ?? null,
          surfaceClass: result.surfaceClass ?? 'generic',
          normal: result.normal ? {
            x: Number(result.normal.x.toFixed(3)),
            y: Number(result.normal.y.toFixed(3)),
            z: Number(result.normal.z.toFixed(3)),
          } : null,
          targetId: result.targetId ?? result.enemy?.id ?? null,
        };
      }
    }

    // Resolve presentation after the camera-origin ray. This keeps shot direction
    // authoritative while recoil/shake begin in this same rendered frame.
    this.presentationSystem.presentShot({
      gun,
      muzzlePosition: _muzzle,
      aimDirection: _fwd,
      cameraSystem,
      gunRoot: fp?.gunView?.root,
      ads: gun.ads,
      bounce: nearestWorld,
    });
    const presentation = this.presentationSystem.snapshot();
    this.gunKick = presentation.weaponBack;
    this._ejectShell(_muzzle, _fwd);
    this._playShotTransient(gun);
    this._playGunshot(gun);

    // Single summary slot — avoid allocating mapped arrays every shot
    this.lastShots.length = 0;
    if (hitSummary) {
      hitSummary.distance = Number(hitSummary.distance?.toFixed?.(2) ?? hitSummary.distance);
      hitSummary.muzzle = { x: Number(_muzzle.x.toFixed(3)), y: Number(_muzzle.y.toFixed(3)), z: Number(_muzzle.z.toFixed(3)) };
      hitSummary.aimDirection = { x: Number(_fwd.x.toFixed(3)), y: Number(_fwd.y.toFixed(3)), z: Number(_fwd.z.toFixed(3)) };
      this.lastShots.push(hitSummary);
    }
  }

  _applyEnemyDamage({
    enemy,
    damage,
    region,
    point = null,
    direction,
    enemySystem,
    enemyCutSystem = null,
    physicsSystem = null,
    propSystem = null,
    severedThisShot = null,
  }) {
    if (!enemy || enemy.pendingCorpse || enemy.defeated || (enemy.health ?? 0) <= 0) return;
    this.totalHits += 1;

    // Debug invulnerable: arm/leg severs still run (posture testing), but HP
    // never drops and head-sever kill is blocked (allowHead: false).
    const invuln = Boolean(enemySystem?.isInvulnerable?.());

    // Mixamo humanoids: gun hits on limb/head regions use the fast skin-region
    // sever path (disability anim + severed-limb prop). Body stays HP-only; guns
    // never author the sword's expensive torso bisect / waist split geometry.
    const severHandled = this._tryGunLimbSever({
      enemy,
      region,
      point,
      enemySystem,
      enemyCutSystem,
      physicsSystem,
      propSystem,
      severedThisShot,
      allowHead: !invuln,
    });
    if (severHandled === 'removed') {
      // Head death / cut-limit ragdoll already tore down the enemy.
      return;
    }

    if (invuln) {
      enemy.staggerTimer = Math.max(enemy.staggerTimer ?? 0, region === 'head' ? 0.45 : 0.22);
      return;
    }

    enemy.health = Math.max(0, (enemy.health ?? 100) - damage);
    enemy.staggerTimer = Math.max(enemy.staggerTimer ?? 0, region === 'head' ? 0.45 : 0.22);
    enemySystem?.applyKnockback?.(enemy, {
      direction: { x: direction.x, z: direction.z },
      power: region === 'head' ? 3.2 : 2.0,
    });

    if ((enemy.health ?? 0) > 0) return;
    if (enemy.pendingCorpse || enemy.defeated || !enemy.model?.parent) return;

    // Defer ragdoll spawn — smashEnemyToRagdoll is multi-ms and hitchy mid-burst.
    this.totalKills += 1;
    enemy.health = 0;
    enemy.pendingCorpse = true;
    enemySystem?.markDefeated?.(enemy, 'firearm');
    this._pendingRagdolls.push({
      enemy,
      launch: {
        x: direction.x * 4.5,
        y: 2.0 + (region === 'head' ? 1.2 : 0.4),
        z: direction.z * 4.5,
      },
    });
  }

  /**
   * @returns {'removed'|'severed'|false}
   */
  _tryGunLimbSever({
    enemy,
    region,
    point,
    enemySystem,
    enemyCutSystem,
    physicsSystem,
    propSystem,
    severedThisShot,
    allowHead = true,
  }) {
    if (!enemyCutSystem?.applyGunLimbSever) return false;
    if (enemy.limbLossProfile !== 'mixamo-humanoid' || !enemy.limbLoss) return false;
    if (severedThisShot?.has(enemy.id)) return false;

    const hitPoint = point
      ? { x: point.x, y: point.y, z: point.z }
      : {
        x: enemy.model?.position?.x ?? 0,
        y: (enemy.model?.position?.y ?? 0) + (enemy.collisionHeight ?? 1.8) * 0.55,
        z: enemy.model?.position?.z ?? 0,
      };

    const limbRegion = classifyGunHitLimbRegion(enemy, hitPoint, region);
    if (!allowHead && limbRegion === 'head') return false;
    if (!canGunSeverRegion(enemy, limbRegion)) return false;

    const plane = buildLimbSeverPlane(enemy, limbRegion);
    if (!plane) return false;

    const cut = enemyCutSystem.applyGunLimbSever({
      enemy,
      region: limbRegion,
      plane,
      physicsSystem,
      enemySystem,
    });
    if (!cut) return false;

    severedThisShot?.add(enemy.id);

    // Head sever + cut-limit / full ragdoll paths remove or corpse the enemy.
    if (enemy.pendingCorpse || enemy.defeated || !enemy.model?.parent) {
      if (enemy.defeated || enemy.pendingCorpse) {
        this.totalKills += 1;
      }
      return 'removed';
    }

    return 'severed';
  }

  _flushOneRagdoll({
    physicsSystem,
    enemySystem,
    enemyCutSystem,
    propSystem,
    maxDetailedRagdolls = Infinity,
    fallbackHordeDeath = null,
  }) {
    if (!this._pendingRagdolls.length) return;
    const job = this._pendingRagdolls.shift();
    const { enemy, launch } = job;
    // `model.parent` is null after clearEnemies disposed the model but before
    // the enemy record was nulled — skip stale jobs so a post-restart flush
    // can't ragdoll an enemy that no longer exists in the scene.
    if (!enemy?.model?.parent) return;

    // M4: when the detailed-ragdoll budget is exhausted, degrade to an instanced
    // fallen corpse (or silent despawn) instead of spawning more Rapier bodies.
    const canAfford = enemyCutSystem?.canAffordDetailedRagdoll?.(maxDetailedRagdolls) ?? true;
    if (!canAfford) {
      if (typeof fallbackHordeDeath === 'function' && fallbackHordeDeath(enemy, launch)) {
        return;
      }
      physicsSystem?.removeEnemyCollider?.(enemy);
      enemySystem?.releasePlayerSlot?.(enemy);
      enemySystem?.removeEnemy?.(enemy);
      return;
    }

    const smashed = enemyCutSystem?.smashEnemyToRagdoll?.({
      enemy,
      launchVelocity: launch,
      physicsSystem,
      enemySystem,
      propSystem,
    });
    if (!smashed) {
      // smash can fail for non-squishy styles — still try corpse fallback in horde.
      if (typeof fallbackHordeDeath === 'function' && fallbackHordeDeath(enemy, launch)) {
        return;
      }
      physicsSystem?.removeEnemyCollider?.(enemy);
      enemySystem?.releasePlayerSlot?.(enemy);
    } else {
      // Keep budget honest if many shards spawned from one kill.
      enemyCutSystem?.enforceDetailedRagdollBudget?.(maxDetailedRagdolls);
    }
  }

  // Drop every deferred firearm ragdoll without spawning them. Called by
  // EnemySystem.clearEnemies on horde restart/teardown so a queued job can't
  // ragdoll an enemy that was just disposed.
  clearPendingRagdolls() {
    this._pendingRagdolls.length = 0;
  }

  _tryDamageVehicle({ point, direction, damage, vehicleSystem, vehicleDamageSystem }) {
    if (!vehicleSystem?.vehicles?.length || !vehicleDamageSystem) return;
    let best = null;
    let bestD = 2.5;
    for (const v of vehicleSystem.vehicles) {
      const p = v.group?.position;
      if (!p) continue;
      const d = Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (!best) return;
    if (typeof vehicleDamageSystem.applyBulletHit === 'function') {
      vehicleDamageSystem.applyBulletHit({ vehicle: best, damage, point });
    } else if (typeof vehicleDamageSystem.applyImpact === 'function') {
      vehicleDamageSystem.applyImpact({
        vehicle: best,
        impulse: damage * 0.12,
        point,
        direction,
      });
    }
  }

  _spawnTracer(from, to, originAnchor = null) {
    let slot = null;
    for (let i = 0; i < this._tracers.length; i += 1) {
      if (this._tracers[i].life <= 0) {
        slot = this._tracers[i];
        break;
      }
    }
    if (!slot) slot = this._tracers[0];
    if (!slot) return;
    const arr = slot.pos.array;
    arr[0] = from.x;
    arr[1] = from.y;
    arr[2] = from.z;
    arr[3] = to.x;
    arr[4] = to.y;
    arr[5] = to.z;
    slot.pos.needsUpdate = true;
    slot.line.visible = true;
    slot.life = TRACER_LIFE;
    // The gun keeps moving through recoil and locomotion while this short-lived
    // world-space line is visible. Retain the actual socket so the rendered
    // start vertex stays attached to the muzzle instead of lagging behind it.
    slot.originAnchor = originAnchor?.parent ? originAnchor : null;
  }

  _ejectShell(muzzle, forward) {
    let slot = null;
    for (let i = 0; i < this._shells.length; i += 1) {
      if (this._shells[i].life <= 0) {
        slot = this._shells[i];
        break;
      }
    }
    if (!slot) return;
    _right.crossVectors(forward, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    else _right.normalize();
    slot.mesh.position.copy(muzzle).addScaledVector(_right, 0.04).addScaledVector(forward, -0.02);
    slot.mesh.visible = true;
    slot.life = SHELL_LIFE;
    slot.vx = _right.x * 2 + (Math.random() - 0.5) * 0.3;
    slot.vy = 1.4 + Math.random() * 0.5;
    slot.vz = _right.z * 2 + (Math.random() - 0.5) * 0.3;
  }

  _tickEffects(dt) {
    for (let i = 0; i < this._tracers.length; i += 1) {
      const t = this._tracers[i];
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.line.visible = false;
        t.originAnchor = null;
        continue;
      }
      if (t.originAnchor?.parent) {
        t.originAnchor.getWorldPosition(_muzzle);
        const arr = t.pos.array;
        arr[0] = _muzzle.x;
        arr[1] = _muzzle.y;
        arr[2] = _muzzle.z;
        t.pos.needsUpdate = true;
      }
    }
    for (let i = 0; i < this._shells.length; i += 1) {
      const s = this._shells[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vy -= 9.8 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      if (s.mesh.position.y < 0.04) {
        s.mesh.position.y = 0.04;
        s.vy *= -0.2;
        s.vx *= 0.55;
        s.vz *= 0.55;
      }
      if (s.life <= 0) s.mesh.visible = false;
    }
  }

  _recoverRecoil(dt) {
    const a = 1 - Math.exp(-RECOIL_RECOVER * dt);
    this.recoilPitch *= 1 - a;
    this.recoilYaw *= 1 - a;
  }

  _ensureAudio() {
    if (this._audioCtx || typeof AudioContext === 'undefined') return this._audioCtx;
    try {
      this._audioCtx = new AudioContext();
      this._shotGain = this._audioCtx.createGain();
      this._shotGain.gain.value = 0.06;
      this._shotGain.connect(this._audioCtx.destination);
      this._sampleGain = this._audioCtx.createGain();
      this._sampleGain.gain.value = 0.65;
      this._sampleCompressor = this._audioCtx.createDynamicsCompressor();
      this._sampleCompressor.threshold.value = -10;
      this._sampleCompressor.knee.value = 6;
      this._sampleCompressor.ratio.value = 12;
      this._sampleCompressor.attack.value = 0.003;
      this._sampleCompressor.release.value = 0.16;
      this._sampleGain.connect(this._sampleCompressor);
      this._sampleCompressor.connect(this._audioCtx.destination);
    } catch {
      this._audioCtx = null;
    }
    return this._audioCtx;
  }

  _preloadGunSounds(gun) {
    const assignments = gun?.profile?.sounds;
    for (const soundId of Object.values(assignments ?? {})) {
      if (soundId) void this._loadGunSound(soundId);
    }
    if (!this._preloadedPresentationSounds) {
      this._preloadedPresentationSounds = true;
      for (const surfaceClass of ['metal', 'concrete', 'marble', 'wood', 'glass', 'soil', 'flesh']) {
        for (const sound of getWeaponPresentationSoundVariants(surfaceClass)) {
          void this._loadGunSound(sound.id);
        }
      }
    }
  }

  _loadGunSound(soundId) {
    if (this._audioBuffers.has(soundId)) {
      return Promise.resolve(this._audioBuffers.get(soundId));
    }
    if (this._audioLoads.has(soundId)) return this._audioLoads.get(soundId);

    const sound = this._getSoundDefinition(soundId);
    const ctx = this._ensureAudio();
    if (!sound || !ctx || typeof fetch !== 'function') return Promise.resolve(null);

    const generation = this._audioGeneration;
    const load = fetch(sound.url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        if (generation === this._audioGeneration) {
          this._audioBuffers.set(soundId, buffer);
          return buffer;
        }
        return null;
      })
      .catch((error) => {
        console.warn(`[WeaponSystem] gun sound failed: ${soundId}`, error);
        return null;
      })
      .finally(() => {
        this._audioLoads.delete(soundId);
      });
    this._audioLoads.set(soundId, load);
    return load;
  }

  _playGunSound(gun, interaction, { pitchJitter = 0, gainJitter = 0 } = {}) {
    const soundId = gun?.profile?.sounds?.[interaction];
    return this._playSoundById(soundId, { pitchJitter, gainJitter });
  }

  _playPresentationSound(kind, { pitchJitter = 0, point = null, camera = null } = {}) {
    const variants = getWeaponPresentationSoundVariants(kind);
    if (!variants.length) return false;
    const sound = variants[Math.floor(Math.random() * variants.length)];
    return this._playSoundById(sound.id, { pitchJitter, point, camera });
  }

  _playSoundById(soundId, { pitchJitter = 0, gainJitter = 0, point = null, camera = null } = {}) {
    const sound = this._getSoundDefinition(soundId);
    const ctx = this._ensureAudio();
    if (!sound || !ctx) return false;

    const start = (buffer) => {
      if (buffer && this._audioCtx === ctx) {
        this._startGunSound(sound, buffer, pitchJitter, gainJitter, { point, camera });
      }
    };
    const buffer = this._audioBuffers.get(soundId);
    const ready = buffer ? Promise.resolve(buffer) : this._loadGunSound(soundId);

    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => ready.then(start)).catch(() => {});
    } else if (buffer) {
      start(buffer);
    } else {
      void ready.then(start);
    }
    return true;
  }

  _getSoundDefinition(soundId) {
    return getGunSound(soundId) ?? getWeaponPresentationSound(soundId);
  }

  _startGunSound(sound, buffer, pitchJitter = 0, gainJitter = 0, { point = null, camera = null } = {}) {
    const ctx = this._audioCtx;
    const output = this._sampleGain;
    if (!ctx || !output || ctx.state !== 'running') return;
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitchJitter;
      gain.gain.value = (sound.volume ?? 0.7) * (1 + (Math.random() * 2 - 1) * gainJitter);
      source.connect(gain);
      const panner = point && camera && typeof ctx.createStereoPanner === 'function'
        ? ctx.createStereoPanner()
        : null;
      if (panner) {
        _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const dx = point.x - camera.position.x;
        const dy = point.y - camera.position.y;
        const dz = point.z - camera.position.z;
        panner.pan.value = THREE.MathUtils.clamp((dx * _right.x + dy * _right.y + dz * _right.z) / 18, -0.85, 0.85);
        gain.connect(panner);
        panner.connect(output);
      } else {
        gain.connect(output);
      }

      const voiceKey = sound.voiceGroup ?? sound.id;
      const voices = this._audioVoices.get(voiceKey) || [];
      const maxVoices = Math.max(1, sound.maxVoices || 4);
      while (voices.length >= maxVoices) {
        const oldest = voices.shift();
        try { oldest?.source?.stop?.(); } catch {}
      }
      const voice = { source, gain, panner };
      voices.push(voice);
      this._audioVoices.set(voiceKey, voices);
      source.onended = () => {
        const index = voices.indexOf(voice);
        if (index >= 0) voices.splice(index, 1);
        source.disconnect();
        gain.disconnect();
        panner?.disconnect();
      };
      source.start();
    } catch {
      // A failed sound must not interrupt the weapon state machine.
    }
  }

  _playClick(freq = 300, dur = 0.03) {
    const now = performance.now();
    if (now - this._lastAudioMs < AUDIO_MIN_INTERVAL_MS) return;
    this._lastAudioMs = now;
    const ctx = this._ensureAudio();
    if (!ctx || ctx.state === 'suspended') {
      void ctx?.resume?.();
      return;
    }
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.value = 0.02;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.stop(ctx.currentTime + dur);
    } catch {
      // ignore
    }
  }

  _playDryClick() {
    const now = performance.now();
    if (now - this._lastDryClick < 140) return;
    this._lastDryClick = now;
    this._playClick(140, 0.04);
  }

  _playGunshot(gun) {
    // A gun profile owns one stable Gunsmith-selected sample. Small pitch/gain
    // variation makes repeated automatic fire less machine-perfect without
    // swapping to a different recording each round.
    if (this._playGunSound(gun, 'fire', { pitchJitter: 0.012, gainJitter: 0.06 })) return;

    const kind = gun?.weaponKind || gun;
    const now = performance.now();
    if (now - this._lastAudioMs < AUDIO_MIN_INTERVAL_MS) return;
    this._lastAudioMs = now;
    const ctx = this._ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
      return; // skip this shot's tone; next will play after resume
    }
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      const base = kind === 'shotgun' ? 90 : kind === 'pistol' ? 150 : 105;
      o.frequency.setValueAtTime(base, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.05);
      g.gain.setValueAtTime(0.05, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
      o.connect(g);
      g.connect(this._shotGain || ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.08);
    } catch {
      // ignore
    }
  }

  /** Fast transient layer; samples/procedural body remain in _playGunshot. */
  _playShotTransient(gun) {
    const ctx = this._ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const kind = gun?.weaponKind;
      const base = kind === 'shotgun' ? 290 : kind === 'pistol' ? 520 : 380;
      o.type = 'square';
      o.frequency.setValueAtTime(base * 1.7, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(base, ctx.currentTime + 0.018);
      g.gain.setValueAtTime(kind === 'shotgun' ? 0.014 : 0.01, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
      o.connect(g);
      g.connect(this._shotGain || ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.03);
    } catch {
      // Audio is optional presentation and must never interrupt firing.
    }
  }

  _playImpactSound(surfaceClass = 'generic', confirmedHit = false, { point = null, camera = null } = {}) {
    const usedSample = this._playPresentationSound(surfaceClass, {
      pitchJitter: 0.035,
      point,
      camera,
    });
    if (confirmedHit) this._playClick(760, 0.018);
    if (usedSample) return;
    const ctx = this._ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const panner = ctx.createStereoPanner?.() ?? null;
      const frequencies = {
        metal: 1040, concrete: 210, marble: 630, wood: 180,
        glass: 1560, soil: 105, flesh: 140, generic: 300,
      };
      const base = frequencies[surfaceClass] ?? frequencies.generic;
      o.type = surfaceClass === 'metal' || surfaceClass === 'glass' ? 'square' : 'triangle';
      o.frequency.setValueAtTime(base * (0.94 + Math.random() * 0.12), ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(48, base * 0.56), ctx.currentTime + 0.065);
      g.gain.setValueAtTime(surfaceClass === 'flesh' ? 0.018 : 0.013, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.075);
      o.connect(g);
      if (panner) {
        if (point && camera) {
          _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
          const dx = point.x - camera.position.x;
          const dy = point.y - camera.position.y;
          const dz = point.z - camera.position.z;
          panner.pan.value = THREE.MathUtils.clamp((dx * _right.x + dy * _right.y + dz * _right.z) / 18, -0.85, 0.85);
        }
        g.connect(panner);
        panner.connect(this._shotGain || ctx.destination);
      } else {
        g.connect(this._shotGain || ctx.destination);
      }
      o.start();
      o.stop(ctx.currentTime + 0.08);
      o.onended = () => panner?.disconnect();
    } catch {
      // Presentation audio remains best-effort.
    }
  }

  /**
   * Spawn a falling physics prop for the spent magazine at its live world pose.
   * No-op for guns without an authored detachable magazine part.
   */
  _dropSpentMagazine({ gun, gunRoot, physicsSystem }) {
    if (!this._droppedMags || !gunRoot || !physicsSystem?.world || !gun?.profile) return;
    const mags = findMagazineMeshes(gunRoot, gun.profile);
    if (!mags.length) return;
    this._droppedMags.drop({ magMesh: mags[0].mesh, physicsSystem });
  }

  snapshot() {
    const entry = this.getEquippedEntry();
    return {
      enabled: this.enabled,
      totalShots: this.totalShots,
      totalHits: this.totalHits,
      totalKills: this.totalKills,
      recoilPitch: Number(this.recoilPitch.toFixed(4)),
      gunKick: Number(this.gunKick.toFixed(3)),
      inspectBlend: Number(this.inspectBlend.toFixed(3)),
      lastShots: this.lastShots,
      switchIndex: this.switchIndex,
      equippedId: this.equippedId,
      holstered: this.holstered,
      equippedLabel: entry?.label ?? this.equippedId,
      equippedShortLabel: entry?.shortLabel ?? this.equippedId,
      equippedKind: entry?.kind ?? null,
      pendingRagdolls: this._pendingRagdolls.length,
      droppedMags: this._droppedMags?.snapshot() ?? { count: 0, oldestAge: 0 },
      useWorldRay: USE_WORLD_RAY,
      presentation: this.presentationSystem.snapshot(),
    };
  }

  dispose() {
    for (const t of this._tracers) {
      if (t.line.parent) t.line.parent.remove(t.line);
      t.line.geometry?.dispose?.();
    }
    this._tracers = [];
    this._tracerMat?.dispose?.();
    for (const s of this._shells) {
      if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
    }
    this._shells = [];
    this._shellGeo?.dispose?.();
    this._shellMat?.dispose?.();
    this._audioGeneration += 1;
    for (const voices of this._audioVoices.values()) {
      for (const voice of voices) {
        try { voice.source?.stop?.(); } catch {}
      }
    }
    this._audioVoices.clear();
    this._audioBuffers.clear();
    this._audioLoads.clear();
    this._preloadedGun = null;
    this.presentationSystem.dispose();
    this._droppedMags?.dispose();
    this._droppedMags = null;
    this._gunRoot = null;
    try {
      this._audioCtx?.close?.();
    } catch {
      // ignore
    }
    this._audioCtx = null;
    this._shotGain = null;
    this._sampleGain = null;
    this._sampleCompressor = null;
    this._pendingRagdolls.length = 0;
    this.scene = null;
  }
}

function canToggleHolster(character) {
  if (!character) return false;
  if (character.carrying) return false;
  if (character.vehicle?.active || character.vehicle) return false;
  if (character.hang?.active || character.wallRun?.active || character.wallClimb?.active
    || character.vault?.active || character.slide?.active || character.rope?.active
    || character.mount?.active || character.hookSwing?.active || character.wingsuit?.active) {
    return false;
  }
  return true;
}
