import * as THREE from 'three';

const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fromEye = new THREE.Vector3();
const _fromLook = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const BLEND_SEC = 1.15;
const DEFAULT_SHOT_SEC = 11;

function smoothStep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Five authored park “tour” shots that highlight different systems.
 * Styles:
 * - `follow` — DogCameraSystem orbit on a live subject
 * - `side-track` — lateral drive-by that keeps the subject framed
 * - `world` — fixed / drifting scenic camera
 *
 * @typedef {'follow' | 'side-track' | 'world'} CinematicShotStyle
 * @typedef {{
 *   id: string,
 *   label: string,
 *   duration: number,
 *   style: CinematicShotStyle,
 *   subjectMode?: 'player' | 'cinematic' | 'aerial',
 *   framingScale?: number,
 * }} CinematicShot
 */

/** @type {CinematicShot[]} */
export const CINEMATIC_SHOTS = Object.freeze([
  {
    id: 'geese-v',
    label: 'Canada geese V',
    duration: 13,
    style: 'follow',
    subjectMode: 'aerial',
    framingScale: 1.15,
  },
  {
    id: 'squirrel-driveby',
    label: 'Squirrel chase drive-by',
    duration: 11,
    style: 'side-track',
  },
  {
    id: 'tree-canopy',
    label: 'Tree canopy pigeons',
    duration: 9,
    style: 'world',
  },
  {
    id: 'lake-overlook',
    label: 'Lake overlook',
    duration: 10,
    style: 'world',
  },
  {
    id: 'cat-fight',
    label: 'Cat fight',
    duration: 10,
    style: 'follow',
    subjectMode: 'cinematic',
    framingScale: 0.85,
  },
]);

/**
 * Rotating multi-camera tour of the dog park.
 * Does not own the Three camera object — writes into the host chase cam
 * or positions the render camera for world / side-track shots.
 */
export class DogParkCinematicDirector {
  /**
   * @param {{
   *   getChasePair?: () => object | null,
   *   getGooseFlock?: () => object | null,
   *   getCatFight?: () => object | null,
   *   getTreePigeons?: () => object | null,
   *   getPlayerDog?: () => object | null,
   *   getLake?: () => { x: number, z: number, radiusX?: number, radiusZ?: number } | null,
   *   getBounds?: () => { minX: number, maxX: number, minZ: number, maxZ: number } | null,
   *   getMudPatches?: () => Array<{ x: number, z: number }> | null,
   *   shots?: CinematicShot[],
   * }} [opts]
   */
  constructor({
    getChasePair = () => null,
    getGooseFlock = () => null,
    getCatFight = () => null,
    getTreePigeons = () => null,
    getPlayerDog = () => null,
    getLake = () => null,
    getBounds = () => null,
    getMudPatches = () => null,
    shots = CINEMATIC_SHOTS,
  } = {}) {
    this.getChasePair = getChasePair;
    this.getGooseFlock = getGooseFlock;
    this.getCatFight = getCatFight;
    this.getTreePigeons = getTreePigeons;
    this.getPlayerDog = getPlayerDog;
    this.getLake = getLake;
    this.getBounds = getBounds;
    this.getMudPatches = getMudPatches;
    this.shots = shots;
    this.active = false;
    this.shotIndex = 0;
    this.shotTime = 0;
    this.blendT = 1;
    this._blendFromEye = new THREE.Vector3();
    this._blendFromLook = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
    this._hasLook = false;
    /** Last resolved follow target so DogCameraSystem only rebinds on change. */
    this._boundTarget = null;
    this._boundShotId = null;
  }

  start({ snapCamera = null } = {}) {
    this.active = true;
    this.shotIndex = 0;
    this.shotTime = 0;
    this.blendT = 1;
    this._boundTarget = null;
    this._boundShotId = null;
    this._hasLook = false;
    if (snapCamera) {
      this._currentLook.set(
        snapCamera.position.x,
        snapCamera.position.y - 2,
        snapCamera.position.z - 4,
      );
      this._hasLook = true;
    }
  }

  stop() {
    this.active = false;
    this._boundTarget = null;
    this._boundShotId = null;
  }

  /** @returns {CinematicShot | null} */
  getCurrentShot() {
    if (!this.shots.length) return null;
    return this.shots[this.shotIndex % this.shots.length] ?? null;
  }

  /**
   * Advance the tour and write the active camera.
   *
   * @param {number} delta
   * @param {{
   *   camera: THREE.Camera,
   *   chaseCamera: import('../../../systems/DogCameraSystem.js').DogCameraSystem,
   *   frameInput?: object,
   * }} ctx
   */
  update(delta, { camera, chaseCamera, frameInput = {} }) {
    if (!this.active || !camera || !this.shots.length) return;
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);
    const shot = this.getCurrentShot();
    if (!shot) return;

    this.shotTime += dt;
    const duration = Number.isFinite(shot.duration) ? shot.duration : DEFAULT_SHOT_SEC;
    if (this.shotTime >= duration) {
      this._beginBlend(camera);
      this.shotIndex = (this.shotIndex + 1) % this.shots.length;
      this.shotTime = 0;
      this._boundTarget = null;
      this._boundShotId = null;
    }

    const current = this.getCurrentShot();
    if (!current) return;

    if (current.style === 'follow') {
      this._updateFollow(dt, current, { camera, chaseCamera, frameInput });
      return;
    }

    // World / side-track own the lens — keep chase cam from fighting.
    chaseCamera.active = false;

    if (current.style === 'side-track') {
      this._resolveSideTrack(current, _eye, _look);
    } else {
      this._resolveWorld(current, _eye, _look);
    }

    this.blendT = Math.min(1, this.blendT + dt / BLEND_SEC);
    const t = smoothStep(this.blendT);
    if (this.blendT < 1 && this._hasLook) {
      camera.position.lerpVectors(this._blendFromEye, _eye, t);
      this._currentLook.lerpVectors(this._blendFromLook, _look, t);
    } else {
      camera.position.copy(_eye);
      this._currentLook.copy(_look);
      this._hasLook = true;
    }
    camera.lookAt(this._currentLook);
    camera.updateMatrixWorld(true);
  }

  _beginBlend(camera) {
    this._blendFromEye.copy(camera.position);
    if (this._hasLook) this._blendFromLook.copy(this._currentLook);
    else {
      camera.getWorldDirection(_fwd);
      this._blendFromLook.copy(camera.position).addScaledVector(_fwd, 6);
    }
    this.blendT = 0;
  }

  _updateFollow(dt, shot, { camera, chaseCamera, frameInput }) {
    const subject = this._resolveFollowSubject(shot);
    if (!subject?.target) {
      // Subject missing (flock still loading, etc.) — hold last pose with a scenic fallback.
      this._resolveWorld(shot, _eye, _look);
      chaseCamera.active = false;
      camera.position.lerp(_eye, 1 - Math.exp(-3 * dt));
      if (!this._hasLook) {
        this._currentLook.copy(_look);
        this._hasLook = true;
      } else {
        this._currentLook.lerp(_look, 1 - Math.exp(-4 * dt));
      }
      camera.lookAt(this._currentLook);
      camera.updateMatrixWorld(true);
      return;
    }

    chaseCamera.active = true;
    const needBind = this._boundTarget !== subject.target
      || this._boundShotId !== shot.id;
    if (needBind) {
      const yaw = (subject.motion?.headingYaw ?? 0) + Math.PI;
      chaseCamera.setTarget(subject.target, {
        yaw,
        subjectMode: shot.subjectMode ?? 'cinematic',
        framingScale: shot.framingScale ?? 1,
        snap: this.blendT >= 1 && this.shotTime < 0.05,
      });
      this._boundTarget = subject.target;
      this._boundShotId = shot.id;
      // Soft blend into the new orbit by keeping blendT low briefly.
      if (this.blendT >= 1) this._beginBlend(camera);
    }

    chaseCamera.update(dt, frameInput, subject.motion ?? {
      headingYaw: 0,
      yawRate: 0,
      moving: true,
      speed: 2,
      forwardIntent: 1,
    });

    // While blending into a follow shot, lerp eye from previous world pose.
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_SEC);
      const t = smoothStep(this.blendT);
      _fromEye.copy(this._blendFromEye);
      camera.position.lerpVectors(_fromEye, camera.position, t);
      if (this._hasLook) {
        camera.getWorldDirection(_fwd);
        _fromLook.copy(camera.position).addScaledVector(_fwd, 4);
        this._currentLook.lerpVectors(this._blendFromLook, _fromLook, t);
        camera.lookAt(this._currentLook);
      }
    } else {
      camera.getWorldDirection(_fwd);
      this._currentLook.copy(camera.position).addScaledVector(_fwd, 5);
      this._hasLook = true;
    }
    camera.updateMatrixWorld(true);
  }

  /**
   * @param {CinematicShot} shot
   * @returns {{ target: THREE.Object3D, motion?: object } | null}
   */
  _resolveFollowSubject(shot) {
    if (shot.id === 'geese-v') {
      const flock = this.getGooseFlock?.();
      const target = flock?.getLeadCameraTarget?.() ?? null;
      if (!target) return null;
      return { target, motion: flock.getLeadCameraMotion?.() ?? null };
    }
    if (shot.id === 'cat-fight') {
      const fight = this.getCatFight?.();
      const target = fight?.getCameraTarget?.() ?? null;
      if (!target) {
        // Fallback: player dog if cats failed to spawn.
        const dog = this.getPlayerDog?.();
        const dogTarget = dog?.rig?.root ?? dog?.root ?? null;
        if (!dogTarget) return null;
        return {
          target: dogTarget,
          motion: {
            headingYaw: dog?.animation?.getRootYaw?.() ?? 0,
            yawRate: 0,
            moving: false,
            speed: 0.4,
            forwardIntent: 0,
          },
        };
      }
      return { target, motion: fight.getCameraMotion?.() ?? null };
    }
    // Default follow: squirrel
    const chase = this.getChasePair?.();
    const target = chase?.getSquirrelCameraTarget?.() ?? null;
    if (!target) return null;
    return { target, motion: chase.getSquirrelCameraMotion?.() ?? null };
  }

  /**
   * Lateral drive-by of the golden ↔ squirrel chase.
   * @param {CinematicShot} _shot
   * @param {THREE.Vector3} outEye
   * @param {THREE.Vector3} outLook
   */
  _resolveSideTrack(_shot, outEye, outLook) {
    const chase = this.getChasePair?.();
    const sPos = chase?.squirrel?.animal?.root?.position;
    const dPos = chase?.dog?.animal?.root?.position;
    if (!sPos) {
      this._resolveWorld(_shot, outEye, outLook);
      return;
    }

    if (dPos) {
      _mid.set(
        (sPos.x + dPos.x) * 0.5,
        (sPos.y + dPos.y) * 0.5 + 0.35,
        (sPos.z + dPos.z) * 0.5,
      );
      _fwd.set(sPos.x - dPos.x, 0, sPos.z - dPos.z);
    } else {
      _mid.set(sPos.x, sPos.y + 0.35, sPos.z);
      const yaw = chase?.getSquirrelCameraMotion?.()?.headingYaw ?? 0;
      _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    }
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    else _fwd.normalize();
    // Perpendicular right-hand lateral for a classic roadside tracking angle.
    _lat.set(_fwd.z, 0, -_fwd.x).normalize();

    const lateral = 7.5;
    const height = 2.15;
    const lead = 1.4;
    outEye.set(
      _mid.x + _lat.x * lateral - _fwd.x * lead,
      _mid.y + height,
      _mid.z + _lat.z * lateral - _fwd.z * lead,
    );
    outLook.set(
      _mid.x + _fwd.x * 1.2,
      _mid.y + 0.15,
      _mid.z + _fwd.z * 1.2,
    );
  }

  /**
   * Scenic fixed cameras that highlight trees / lake / fallback park views.
   * @param {CinematicShot} shot
   * @param {THREE.Vector3} outEye
   * @param {THREE.Vector3} outLook
   */
  _resolveWorld(shot, outEye, outLook) {
    const lake = this.getLake?.() ?? { x: 16, z: 8 };
    const bounds = this.getBounds?.() ?? {
      minX: -30, maxX: 30, minZ: -22.5, maxZ: 22.5,
    };
    // Slow drift so world holds don't feel frozen.
    const drift = Math.sin(this.shotTime * 0.22) * 0.35;

    if (shot.id === 'tree-canopy') {
      // North grove canopy — frame rock pigeons (bugs stand-in) in the cypress belt.
      const pigeons = this.getTreePigeons?.();
      const focus = pigeons?.getFocusPoint?.(_look) ?? null;
      const lookX = focus ? focus.x : 2 + drift;
      const lookY = focus ? focus.y : 5.5;
      const lookZ = focus ? focus.z : bounds.maxZ - 4;
      outEye.set(
        lookX + drift * 1.5,
        lookY + 1.6 + Math.sin(this.shotTime * 0.35) * 0.2,
        lookZ + 3.8,
      );
      outLook.set(lookX, lookY - 0.15, lookZ);
      return;
    }

    if (shot.id === 'lake-overlook') {
      // Southwest look toward the lake + city skyline beyond the fence.
      outEye.set(
        lake.x - 14 + drift,
        5.2,
        lake.z - 11,
      );
      outLook.set(lake.x, 0.6, lake.z);
      return;
    }

    // Fallback scenic: elevated center looking north across the lawn.
    outEye.set(drift, 6.5, bounds.minZ + 4);
    outLook.set(0, 1.2, 2);
  }

  snapshot() {
    const shot = this.getCurrentShot();
    return {
      active: this.active,
      shotIndex: this.shotIndex,
      shotId: shot?.id ?? null,
      shotLabel: shot?.label ?? null,
      shotTime: Number(this.shotTime.toFixed(2)),
      shotCount: this.shots.length,
      blendT: Number(this.blendT.toFixed(3)),
    };
  }
}
