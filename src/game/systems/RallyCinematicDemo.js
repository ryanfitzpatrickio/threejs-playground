import * as THREE from 'three';
import { buildRoadProfile } from '../../world/worldMap/roadProfile.js';
import { buildRibbonFrame, placementsAlong } from '../../world/worldMap/trackFrame.js';
import { getRallyWorldMapSync } from '../../world/worldMap/worldMapScenes.js';

const _lookFrom = new THREE.Vector3();
const _lookTo = new THREE.Vector3();
const _blendPos = new THREE.Vector3();
const _blendLook = new THREE.Vector3();

const WAYPOINT_SPACING = 18;
const CAMERA_SPACING = 85;
const CAMERA_SIDE_OFFSET = 12;
const CAMERA_EYE_HEIGHT = 2.5;
const CAMERA_LOOK_AHEAD = 42;
const WAYPOINT_REACH = 14;
const CAMERA_SWITCH_PAST = 32;
const CAMERA_BLEND_SEC = 0.55;

function pickStageRoad(worldMap) {
  const roads = (worldMap?.roads ?? []).filter((road) => road.points?.length >= 2);
  if (!roads.length) return null;
  return roads.find((road) => road.trackStyle === 'rallySpectator')
    ?? roads.reduce((best, road) => (
      (road.points?.length ?? 0) > (best?.points?.length ?? 0) ? road : best
    ), roads[0]);
}

function sampleFrameAtArc(frame, s) {
  const { n, arc, posX, posZ, roadY, tanX, tanZ, norX, norZ } = frame;
  const total = n > 0 ? arc[n - 1] : 0;
  const sc = total > 0 ? Math.max(0, Math.min(total, s)) : 0;
  let seg = 0;
  while (seg < n - 2 && arc[seg + 1] < sc) seg += 1;
  const a0 = arc[seg];
  const a1 = arc[seg + 1];
  let t = a1 > a0 ? (sc - a0) / (a1 - a0) : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const lerp = (arr) => arr[seg] + (arr[seg + 1] - arr[seg]) * t;
  let nx = lerp(norX);
  let nz = lerp(norZ);
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl;
  nz /= nl;
  let tx = lerp(tanX);
  let tz = lerp(tanZ);
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  return {
    s: sc,
    x: lerp(posX),
    z: lerp(posZ),
    roadY: lerp(roadY),
    nx,
    nz,
    tx,
    tz,
  };
}

function smoothStep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export class RallyCinematicDemo {
  constructor() {
    this.active = false;
    this.frame = null;
    this.totalLength = 0;
    this.waypoints = [];
    this.cameras = [];
    this.waypointIndex = 0;
    this.activeCameraIndex = 0;
    this.carArc = 0;
    this._lastSegArc = null;
    this._unwrapOffset = 0;
    this._blendT = 1;
    this._blendFromPos = new THREE.Vector3();
    this._blendFromLook = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
  }

  snapshot() {
    return {
      active: this.active,
      cameraIndex: this.activeCameraIndex,
      cameraCount: this.cameras.length,
      carArc: Number(this.carArc.toFixed(1)),
      trackLength: Number(this.totalLength.toFixed(1)),
    };
  }

  start({ vehicle, level, physics, camera }) {
    if (!vehicle?.group || !level?.getGroundHeightAt || !physics) return false;

    const worldMap = getRallyWorldMapSync();
    const road = pickStageRoad(worldMap);
    if (!road) return false;

    const sampleHeight = (x, z) => {
      const y = level.getGroundHeightAt({ x, y: 0, z }, 0.5, { preferRoadSurface: true });
      return Number.isFinite(y) ? y : 0;
    };

    const profile = buildRoadProfile({
      roads: [road],
      sampleHeight,
      smoothRadius: 12,
    });
    const built = profile.roads?.[0];
    if (!built?.samples?.length) return false;

    const frame = buildRibbonFrame(built);
    this.frame = frame;
    this.totalLength = frame.n > 0 ? frame.arc[frame.n - 1] : 0;

    const waypointAnchors = placementsAlong(frame, WAYPOINT_SPACING, { phase: 0, lateral: 0 });
    this.waypoints = waypointAnchors.map((anchor) => ({ x: anchor.x, z: anchor.z }));

    const half = frame.half ?? 3.2;
    let side = 1;
    const cameraAnchors = placementsAlong(frame, CAMERA_SPACING, {
      phase: CAMERA_SPACING * 0.35,
      lateral: 0,
    });
    this.cameras = cameraAnchors.map((anchor) => {
      const lateral = side * (half + CAMERA_SIDE_OFFSET);
      side *= -1;
      const lookSample = sampleFrameAtArc(frame, anchor.s + CAMERA_LOOK_AHEAD);
      const groundY = sampleHeight(
        anchor.x + anchor.nx * lateral,
        anchor.z + anchor.nz * lateral,
      );
      return {
        triggerArc: anchor.s,
        position: {
          x: anchor.x + anchor.nx * lateral,
          y: groundY + CAMERA_EYE_HEIGHT,
          z: anchor.z + anchor.nz * lateral,
        },
        lookAt: {
          x: lookSample.x,
          y: lookSample.roadY + 1.4,
          z: lookSample.z,
        },
      };
    });

    if (!this.waypoints.length || !this.cameras.length) return false;

    const start = waypointAnchors[0];
    const next = waypointAnchors[Math.min(1, waypointAnchors.length - 1)];
    const rotationY = Math.atan2(-(next.x - start.x), -(next.z - start.z));
    const ground = sampleHeight(start.x, start.z);
    const spawnPos = new THREE.Vector3(
      start.x,
      ground + vehicle.getGroundSpawnClearance(),
      start.z,
    );

    level.ensureGroundCollider?.(spawnPos, physics, { radiusChunks: 2 });
    vehicle.recover({ position: spawnPos, rotationY, physics });
    vehicle.wakeForDrive(physics);

    this.waypointIndex = Math.min(1, this.waypoints.length - 1);
    vehicle.autopilot = {
      target: { ...this.waypoints[this.waypointIndex] },
      throttle: 0.8,
      steerGain: Math.PI / 4,
    };

    this.activeCameraIndex = 0;
    this._lastSegArc = null;
    this._unwrapOffset = 0;
    this.carArc = 0;
    this._blendT = 1;

    const firstCam = this.cameras[0];
    if (camera) {
      camera.position.set(firstCam.position.x, firstCam.position.y, firstCam.position.z);
      _lookTo.set(firstCam.lookAt.x, firstCam.lookAt.y, firstCam.lookAt.z);
      camera.lookAt(_lookTo);
      this._currentLook.copy(_lookTo);
    }

    this.active = true;
    return true;
  }

  stop() {
    this.active = false;
    this.frame = null;
    this.waypoints = [];
    this.cameras = [];
    this.waypointIndex = 0;
    this.activeCameraIndex = 0;
    this.carArc = 0;
    this._lastSegArc = null;
    this._unwrapOffset = 0;
    this._blendT = 1;
  }

  update(delta, { vehicle, camera, level }) {
    if (!this.active || !vehicle?.group || !camera) return;

    this._advanceWaypoint(vehicle);
    this.carArc = this._projectCarArc(vehicle.group.position.x, vehicle.group.position.z);

    const nextIndex = this._cameraIndexForArc(this.carArc);
    if (nextIndex !== this.activeCameraIndex) {
      this._blendFromPos.copy(camera.position);
      this._blendFromLook.copy(this._currentLook);
      this.activeCameraIndex = nextIndex;
      this._blendT = 0;
    }

    const cam = this.cameras[this.activeCameraIndex];
    if (!cam) return;

    _blendPos.set(cam.position.x, cam.position.y, cam.position.z);
    _blendLook.set(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);

    if (level?.getGroundHeightAt) {
      const ground = level.getGroundHeightAt(
        { x: _blendPos.x, y: 0, z: _blendPos.z },
        0.5,
        { preferRoadSurface: true },
      );
      if (Number.isFinite(ground)) {
        _blendPos.y = Math.max(_blendPos.y, ground + CAMERA_EYE_HEIGHT);
      }
    }

    this._blendT = Math.min(1, this._blendT + delta / CAMERA_BLEND_SEC);
    const t = smoothStep(this._blendT);

    if (this._blendT < 1) {
      camera.position.lerpVectors(this._blendFromPos, _blendPos, t);
      _lookFrom.copy(this._blendFromLook);
      _lookTo.copy(_blendLook);
      this._currentLook.lerpVectors(_lookFrom, _lookTo, t);
    } else {
      camera.position.copy(_blendPos);
      this._currentLook.copy(_blendLook);
    }
    camera.lookAt(this._currentLook);
  }

  _advanceWaypoint(vehicle) {
    const target = this.waypoints[this.waypointIndex];
    if (!target) return;

    vehicle.autopilot = vehicle.autopilot ?? {};
    vehicle.autopilot.target = target;
    vehicle.autopilot.throttle = vehicle.autopilot.throttle ?? 0.8;
    vehicle.autopilot.steerGain = vehicle.autopilot.steerGain ?? Math.PI / 4;

    const pos = vehicle.group.position;
    if (Math.hypot(target.x - pos.x, target.z - pos.z) < WAYPOINT_REACH) {
      this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
    }
  }

  _projectCarArc(x, z) {
    const frame = this.frame;
    if (!frame) return 0;

    const { n, arc, posX, posZ } = frame;
    let bestSeg = 0;
    let bestT = 0;
    let bestDistSq = Infinity;

    for (let i = 0; i < n - 1; i += 1) {
      const ax = posX[i];
      const az = posZ[i];
      const bx = posX[i + 1];
      const bz = posZ[i + 1];
      const segDx = bx - ax;
      const segDz = bz - az;
      const lenSq = segDx * segDx + segDz * segDz;
      let t = lenSq > 1e-8 ? ((x - ax) * segDx + (z - az) * segDz) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + segDx * t;
      const pz = az + segDz * t;
      const dSq = (x - px) ** 2 + (z - pz) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestSeg = i;
        bestT = t;
      }
    }

    const a0 = arc[bestSeg];
    const a1 = arc[bestSeg + 1];
    const segArc = a0 + (a1 - a0) * bestT;

    if (this._lastSegArc != null && this.totalLength > 0) {
      const delta = segArc - this._lastSegArc;
      if (delta < -this.totalLength * 0.5) this._unwrapOffset += this.totalLength;
      else if (delta > this.totalLength * 0.5) this._unwrapOffset -= this.totalLength;
    }
    this._lastSegArc = segArc;
    return segArc + this._unwrapOffset;
  }

  _cameraIndexForArc(carArc) {
    if (!this.cameras.length || this.totalLength <= 0) return 0;

    const lapArc = ((carArc % this.totalLength) + this.totalLength) % this.totalLength;
    let idx = 0;
    for (let i = 0; i < this.cameras.length; i += 1) {
      if (lapArc + 12 >= this.cameras[i].triggerArc) idx = i;
    }

    while (
      idx < this.cameras.length - 1
      && lapArc >= this.cameras[idx].triggerArc + CAMERA_SWITCH_PAST
    ) {
      idx += 1;
    }
    return idx;
  }
}
