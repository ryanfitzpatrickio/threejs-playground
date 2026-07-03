import * as THREE from 'three';

const MAX_STREAK_SEGMENTS = 320;
const MIN_POINT_DISTANCE = 0.16;
const STREAK_LIFT = 0.025;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _wheelPoint = new THREE.Vector3();
const _side = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Placeholder skid marks and synthesized tire noise. */
export class TireEffects {
  constructor({ scene, vehicle }) {
    this.scene = scene;
    this.vehicle = vehicle;
    this.group = new THREE.Group();
    this.group.name = 'Tire streaks (placeholder)';
    this.scene?.add(this.group);

    this.material = new THREE.MeshBasicMaterial({
      color: 0x171717,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
    });
    this.segments = [];
    this.cursor = 0;
    this.previous = new Map();
    this.audio = new TireScreechAudio();
  }

  update({ controls, groundedFraction = 0, physics = null }) {
    const vehicle = this.vehicle;
    if (!vehicle?.group || vehicle.domain !== 'ground') return;

    _velocity.copy(vehicle.linearVelocity).setY(0);
    const speed = _velocity.length();
    _forward.set(0, 0, -1).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    _right.set(1, 0, 0).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    const lateralSpeed = Math.abs(_velocity.dot(_right));

    const lateralSlip = smoothstep(1.5, 5.5, lateralSpeed);
    const hardBrake = (controls?.brake ?? 0) * smoothstep(7, 16, speed);
    const handbrake = controls?.handbrake ? smoothstep(3, 8, speed) : 0;
    const wheelspin = Math.max(0, (controls?.throttle ?? 0) - 0.68)
      * (1 - smoothstep(8, 15, speed));
    const controllerSlip = Math.max(
      0,
      ...(vehicle.wheelTelemetry ?? []).map((wheel) => {
        if (!wheel?.inContact) return 0;
        const slip = smoothstep(0.18, 0.9, wheel.slipRatio ?? 0);
        const impulse = smoothstep(800, 4500, Math.hypot(
          wheel.forwardImpulse ?? 0,
          wheel.sideImpulse ?? 0,
        ));
        return Math.max(slip, impulse);
      }),
    );
    const intensity = THREE.MathUtils.clamp(
      Math.max(lateralSlip, hardBrake, handbrake, wheelspin, controllerSlip) * groundedFraction,
      0,
      1,
    );

    this.audio.update(intensity, speed);
    if (intensity < 0.08) {
      this.previous.clear();
      return;
    }

    const radius = vehicle.config.ground?.wheelRadius ?? 0.38;
    const markAllWheels = hardBrake > 0.25;
    vehicle.wheelAnchors.forEach((anchor, index) => {
      // Chassis forward is -Z, so positive-Z anchors are the rear axle.
      if (!markAllWheels && anchor.z < 0) return;
      const telemetry = vehicle.wheelTelemetry?.[index];
      if (telemetry && !telemetry.inContact) return;
      if (telemetry?.contactPoint) {
        _wheelPoint.copy(telemetry.contactPoint);
        if (telemetry.contactNormal) {
          _wheelPoint.addScaledVector(telemetry.contactNormal, STREAK_LIFT);
        } else {
          _wheelPoint.y += STREAK_LIFT;
        }
        this._append(index, _wheelPoint, intensity);
        return;
      }
      const wheel = vehicle.wheelMeshes[index];
      const suspY = wheel?.userData?.suspNode?.position?.y;
      _wheelPoint.set(anchor.x, Number.isFinite(suspY) ? suspY - radius : anchor.y - radius, anchor.z);
      vehicle.group.localToWorld(_wheelPoint);
      this._projectToSurface(_wheelPoint, physics);
      this._append(index, _wheelPoint, intensity);
    });
  }

  resume() {
    this.audio.resume();
  }

  mute(state) {
    this.audio.mute(state);
  }

  _projectToSurface(point, physics) {
    const world = physics?.world;
    const RAPIER = physics?.RAPIER;
    if (!world || !RAPIER) {
      point.y += STREAK_LIFT;
      return;
    }
    this.ray ??= new RAPIER.Ray(
      { x: point.x, y: point.y + 1.5, z: point.z },
      { x: 0, y: -1, z: 0 },
    );
    this.ray.origin.x = point.x;
    this.ray.origin.y = point.y + 1.5;
    this.ray.origin.z = point.z;
    const body = physics.getFreshBody?.(this.vehicle.bodyHandle);
    const collider = world.colliders.get(this.vehicle.colliderHandle);
    const hit = world.castRay(this.ray, 4, true, undefined, undefined, collider, body);
    const toi = hit?.timeOfImpact ?? hit?.toi;
    if (Number.isFinite(toi)) point.y = this.ray.origin.y - toi;
    point.y += STREAK_LIFT;
  }

  _append(wheelIndex, point, intensity) {
    const previous = this.previous.get(wheelIndex);
    if (!previous) {
      this.previous.set(wheelIndex, point.clone());
      return;
    }
    const distance = previous.distanceTo(point);
    if (distance < MIN_POINT_DISTANCE) return;
    // Avoid a long connector after a teleport or a dropped frame.
    if (distance > 2.5) {
      previous.copy(point);
      return;
    }

    const width = (this.vehicle.config.ground?.wheelWidth ?? 0.3) * 0.72;
    _side.subVectors(point, previous).cross(THREE.Object3D.DEFAULT_UP).setY(0).normalize()
      .multiplyScalar(width * 0.5);
    _a.copy(previous).add(_side);
    _b.copy(previous).sub(_side);
    _c.copy(point).add(_side);
    _d.copy(point).sub(_side);

    const segment = this._segmentAtCursor();
    const positions = segment.geometry.attributes.position;
    writeVertex(positions, 0, _a);
    writeVertex(positions, 1, _b);
    writeVertex(positions, 2, _c);
    writeVertex(positions, 3, _b);
    writeVertex(positions, 4, _d);
    writeVertex(positions, 5, _c);
    positions.needsUpdate = true;
    segment.material.opacity = 0.3 + intensity * 0.5;
    segment.visible = true;
    previous.copy(point);
  }

  _segmentAtCursor() {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_STREAK_SEGMENTS;
    if (this.segments[index]) return this.segments[index];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
    const material = this.material.clone();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // Road ribbons render at order 3. Draw afterward while retaining depth testing
    // so the streak stays on asphalt/shoulder but remains hidden by cars and props.
    mesh.renderOrder = 4;
    this.group.add(mesh);
    this.segments[index] = mesh;
    return mesh;
  }

  dispose() {
    this.audio.dispose();
    this.scene?.remove(this.group);
    for (const segment of this.segments) {
      segment.geometry.dispose();
      segment.material.dispose();
    }
    this.material.dispose();
    this.segments.length = 0;
    this.previous.clear();
  }
}

class TireScreechAudio {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.filter = null;
    this.muted = true;
  }

  _ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.ctx = new AudioContext();
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 1800;
    this.filter.Q.value = 1.7;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.filter).connect(this.gain).connect(this.ctx.destination);
    this.source.start();
  }

  resume() {
    this._ensure();
    this.muted = false;
    this.ctx?.resume().catch(() => {});
  }

  mute(state) {
    this.muted = Boolean(state);
    if (state && this.gain && this.ctx) this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.025);
  }

  update(intensity, speed) {
    if (!this.ctx || !this.gain || !this.filter) return;
    const amount = this.muted ? 0 : intensity;
    this.gain.gain.setTargetAtTime(amount * 0.16, this.ctx.currentTime, amount > 0 ? 0.035 : 0.08);
    this.filter.frequency.setTargetAtTime(1300 + Math.min(speed, 35) * 38, this.ctx.currentTime, 0.05);
  }

  dispose() {
    try { this.source?.stop(); } catch {}
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

function writeVertex(attribute, index, value) {
  attribute.setXYZ(index, value.x, value.y, value.z);
}

function smoothstep(min, max, value) {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
