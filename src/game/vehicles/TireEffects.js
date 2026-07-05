import * as THREE from 'three';
import { createAaaMudParticleRenderer } from '../render/createAaaMudParticleRenderer.js';
import { resolveMudWheelDynamics } from './mudWheelDynamics.js';

const MAX_STREAK_SEGMENTS = 320;
const MIN_POINT_DISTANCE = 0.16;
const STREAK_LIFT = 0.025;

const TURN_SCREECH_URLS = [
  '/audio/tires/turn-01.mp3',
  '/audio/tires/turn-02.mp3',
  '/audio/tires/turn-03.mp3',
  '/audio/tires/turn-04.mp3',
  '/audio/tires/turn-05.mp3',
];

const BRAKE_SCREECH_URLS = [
  '/audio/tires/brake-01.mp3',
  '/audio/tires/brake-02.mp3',
  '/audio/tires/brake-03.mp3',
  '/audio/tires/brake-04.mp3',
];

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _wheelPoint = new THREE.Vector3();
const _side = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Skid marks + recorded tire screech samples (turn vs brake pools). */
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
    this.audio = new TireScreechAudioSystem();
    this.dust = new DirtDustSystem(this.group, this.vehicle);
    this.mudSplash = new MudLiquidSpraySystem(this.group, this.vehicle);
    this.glassBurst = new WindshieldGlassBurst(this.group);
  }

  update({ controls, groundedFraction = 0, physics = null, surface = 'asphalt', dt = 1 / 60, camera = null }) {
    const vehicle = this.vehicle;
    if (!vehicle?.group || vehicle.domain !== 'ground') return;

    _velocity.copy(vehicle.linearVelocity).setY(0);
    const speed = _velocity.length();
    _forward.set(0, 0, -1).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    _right.set(1, 0, 0).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    const lateralSigned = _velocity.dot(_right);
    const lateralSpeed = Math.abs(lateralSigned);

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

    const grounded = THREE.MathUtils.clamp(groundedFraction, 0, 1);
    const turnIntensity = THREE.MathUtils.clamp(lateralSlip * grounded, 0, 1);
    const brakeIntensity = THREE.MathUtils.clamp(
      Math.max(hardBrake, handbrake * 0.92) * grounded,
      0,
      1,
    );
    const intensity = THREE.MathUtils.clamp(
      Math.max(turnIntensity, brakeIntensity, wheelspin, controllerSlip) * grounded,
      0,
      1,
    );

    this.audio.update(turnIntensity, brakeIntensity, speed, { surface, slip: intensity });
    this.dust.update({
      dt, surface, speed, intensity, vehicle,
      throttle: Math.abs(controls?.throttle ?? 0),
      lateralSpeed,
      lateralSign: lateralSigned >= 0 ? 1 : -1,
      camera,
    });
    this.mudSplash.update({
      dt, surface, speed, vehicle,
      throttle: Math.abs(controls?.throttle ?? 0),
      camera,
    });
    this.glassBurst.update({ dt, camera });
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
    mesh.renderOrder = 4;
    this.group.add(mesh);
    this.segments[index] = mesh;
    return mesh;
  }

  burstWindshieldGlass({ origin, forward, right, severity = 14 }) {
    this.glassBurst.burst({ origin, forward, right, severity });
  }

  dispose() {
    this.audio.dispose();
    this.dust.dispose();
    this.mudSplash.dispose();
    this.glassBurst.dispose();
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

// Defensive fallback mirrored from DEFAULT_VEHICLE_CONFIG.ground.dust so a
// stub vehicle (e.g. the headless verify harness) gets a full dust block.
// Real vehicles always supply the block via createVehicleConfig's deep merge.
const DUST_DEFAULTS = {
  poolSize: 1200,
  textureSize: 96,
  emitAllWheelsAbove: 0.55,
  emitRate: {
    base: 8, perSpeed: 0.85, speedCap: 38, perIntensity: 28,
    driftBoost: 14, driftThreshold: 3, maxPerFrame: 10,
    burstAtIntensity: 0.72, burstParticles: 2,
  },
  life: { min: 0.95, max: 2.35 },
  size: { baseMin: 0.55, baseMax: 1.05, ageGrow: 1.85 },
  buoyancy: 0.95,
  gravity: 0.52,
  drag: 0.65,
  turbulence: 0.2,
  color: {
    fresh: [0.42, 0.29, 0.17],
    mid: [0.72, 0.60, 0.42],
    old: [0.85, 0.80, 0.72],
  },
  drift: { fanScale: 0.18, coneWiden: 1.4, smoothstart: 2, smoothend: 8 },
  spin: { roostScale: 0.05, upBias: 0.68 },
  opacity: { peak: 1.0, fadePow: 1.35 },
};

// Rally dirt-dust rooster tail. CPU-simulated particle pool (cheap ring buffer,
// tuned to rear-wheel contacts / slip / drift) rendered as camera-facing
// billboards: an InstancedMesh of unit quads whose per-instance matrix (world
// position + camera-facing rotation + age-grown scale) and per-instance color
// (baked brown→tan→pale ramp) are rewritten every frame.
//
// The render streams are the InstancedMesh's own instanceMatrix + instanceColor
// with DynamicDrawUsage — the same per-frame dynamic-instancing pattern
// createInfiniteCityLevel.js uses, which is the proven path under WebGPU. An
// earlier pass fed per-instance data through TSL storage() buffers rewritten
// from the CPU each frame; under WebGPU those are intended for compute-shader
// writes and did not re-upload from needsUpdate (the CPU's activeParticles was
// >0 while the GPU kept reading the initial dead-state), so nothing rendered.
// Soft puff shape comes from a generated CanvasTexture radial gradient (no asset
// file), and billboarding is done on the CPU from the camera quaternion so no
// per-instance data has to reach a custom shader at all.
const _IDENTITY_QUAT = new THREE.Quaternion();

// Deep-merge the `mud` partial onto a dust config, producing the mud spray
// profile the DirtDustSystem swaps to on mud surfaces. Returns null when the
// config has no mud override (so non-rally vehicles keep only the dirt profile).
function withMudProfile(base) {
  const m = base?.mud;
  if (!m) return null;
  const merged = {
    ...base,
    ...m,
    emitRate: { ...base.emitRate, ...(m.emitRate ?? {}) },
    life: { ...base.life, ...(m.life ?? {}) },
    size: { ...base.size, ...(m.size ?? {}) },
    color: { ...base.color, ...(m.color ?? {}) },
    drift: { ...base.drift, ...(m.drift ?? {}) },
    spin: { ...base.spin, ...(m.spin ?? {}) },
    opacity: { ...base.opacity, ...(m.opacity ?? {}) },
  };
  delete merged.mud;
  return merged;
}

function makeDustPuffTexture(size = 96) {
  if (typeof document === 'undefined') return null; // headless harness — no rendering
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.68, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Hard-edged clod: mostly-opaque out to ~0.7 radius, then a quick falloff. Reads
// as a solid flung speck rather than the soft puff gradient (which looks smoky).
function makeMudClodTexture(size = 96) {
  if (typeof document === 'undefined') return null; // headless harness — no rendering
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.62, 'rgba(255,255,255,1)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.92, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Brown → tan → pale ramp baked into `out` from age01 (0 fresh → 1 dying),
// brightness jittered by seed so the plume isn't uniform. Color triples are
// linear RGB (consumed directly by Color.setRGB in working space).
function setRampColor(out, age01, seed, c) {
  let r, g, b;
  if (age01 < 0.45) {
    const k = age01 / 0.45;
    r = c.fresh[0] + (c.mid[0] - c.fresh[0]) * k;
    g = c.fresh[1] + (c.mid[1] - c.fresh[1]) * k;
    b = c.fresh[2] + (c.mid[2] - c.fresh[2]) * k;
  } else {
    const k = (age01 - 0.45) / 0.55;
    r = c.mid[0] + (c.old[0] - c.mid[0]) * k;
    g = c.mid[1] + (c.old[1] - c.mid[1]) * k;
    b = c.mid[2] + (c.old[2] - c.mid[2]) * k;
  }
  const j = 0.85 + seed * 0.3;
  out.setRGB(r * j, g * j, b * j);
}

export class DirtDustSystem {
  constructor(group, vehicle) {
    const cfg = vehicle?.config?.ground?.dust ?? DUST_DEFAULTS;
    // Base (dirt/offroad) profile plus the rally MUD profile (a deep-merge of
    // cfg.mud onto the base). update() swaps `this.cfg` between them by surface,
    // so mud reuses the whole pool/emit path with darker, heavier, ballistic
    // clods — no forked system. mudCfg is null when no mud override is configured.
    this.baseCfg = cfg;
    this.mudCfg = withMudProfile(cfg);
    this.cfg = cfg;
    this.max = cfg.poolSize ?? 1200;

    this.particles = Array.from({ length: this.max }, () => ({
      life: 0, maxLife: 1, age: 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      baseSize: 0, seed: 0, isClod: false, floorY: 0,
    }));

    this._puffTexture = makeDustPuffTexture(cfg.textureSize ?? 96);
    this._clodTexture = makeMudClodTexture(cfg.textureSize ?? 96);
    this._activeTexture = this._puffTexture;
    this.aaaMud = typeof document !== 'undefined'
      ? createAaaMudParticleRenderer({
        poolSize: this.max,
        parent: group,
        name: 'Rally Mud Clods (AAA)',
      })
      : null;
    this._elapsed = 0;
    const materialParams = {
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      opacity: 0,
    };
    if (this._puffTexture) materialParams.map = this._puffTexture; // null under headless
    const material = new THREE.MeshBasicMaterial(materialParams);
    const geometry = new THREE.PlaneGeometry(1, 1);

    this.mesh = new THREE.InstancedMesh(geometry, material, this.max);
    this.mesh.name = 'Rally Dirt Dust and Roost';
    this.mesh.frustumCulled = false;
    this.mesh.count = this.max;
    this.mesh.renderOrder = 3;
    // Start every instance collapsed to scale 0 (invisible) until emitted. Both
    // per-instance streams are rewritten every frame, so DynamicDrawUsage lets
    // WebGPU stage the re-upload cheaply (the city's dynamic-instancing pattern).
    const white = new THREE.Color(1, 1, 1);
    const collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i += 1) {
      this.mesh.setMatrixAt(i, collapsed);
      this.mesh.setColorAt(i, white); // also materializes instanceColor
    }
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    group.add(this.mesh);

    // Per-frame scratch (no allocation in the hot loop).
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._col = new THREE.Color();
    this._camQuat = new THREE.Quaternion();

    this.cursor = 0;
    this.emitCarry = 0;
    this.wheelEmitCarry = [];
    this._emitStep = 0;
    this._emittedByWheel = [0, 0, 0, 0];
    this._active = 0;
    this._opacityMax = 0;
    this._materialOpacity = 0;
  }

  update({ dt, surface, speed, intensity, vehicle, throttle = 0, lateralSpeed = 0, lateralSign = 1, camera = null }) {
    // Swap to the mud profile on mud surfaces (reference swap, no per-frame alloc);
    // _emit + the ramp colour both read this.cfg, so the whole plume turns to clods.
    const wheelMud = (vehicle?.wheelTelemetry ?? []).some((wheel) => wheel?.surface === 'mud');
    this.cfg = (surface === 'mud' || wheelMud) && this.mudCfg ? this.mudCfg : this.baseCfg;
    const cfg = this.cfg;
    // Point the mesh at the hard clod texture on mud, the soft puff otherwise.
    // Swapped only when it actually changes (surface boundary), not every frame.
    const wantTexture = cfg.clod ? this._clodTexture : this._puffTexture;
    if (wantTexture && this._activeTexture !== wantTexture) {
      this._activeTexture = wantTexture;
      this.mesh.material.map = wantTexture;
      this.mesh.material.needsUpdate = true;
    }
    const step = THREE.MathUtils.clamp(dt || 0, 0, 0.05);
    const turb = cfg.turbulence;
    const buoy = cfg.buoyancy;
    const grav = cfg.gravity;
    const dragK = Math.exp(-cfg.drag * step);
    const peak = cfg.opacity.peak;
    // Billboard rotation = camera orientation (screen-aligned); identity when no
    // camera is available (e.g. headless harness — nothing renders anyway).
    this._camQuat.copy(camera?.quaternion ?? _IDENTITY_QUAT);
    let active = 0;
    let opacityMax = 0;

    for (let i = 0; i < this.max; i += 1) {
      const p = this.particles[i];
      if (p.life <= 0) {
        this._hide(i);
        this.aaaMud?.hideParticle(i);
        continue;
      }
      p.life -= step;
      p.age += step;
      if (p.life <= 0) {
        this._hide(i);
        this.aaaMud?.hideParticle(i);
        continue;
      }
      // Turbulence on the CPU so neighbouring trajectories actually diverge.
      if (turb) {
        p.vx += Math.sin(p.age * 7.0 + p.seed * 6.283185) * turb * step;
        p.vz += Math.cos(p.age * 6.1 + p.seed * 6.283185) * turb * step;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      // Arc: buoyancy fades with age, gravity takes over — dust rises then settles.
      const ageFrac = THREE.MathUtils.clamp(p.age / p.maxLife, 0, 1);
      p.vy += (buoy * (1 - ageFrac) - grav) * step;
      p.vx *= dragK;
      p.vz *= dragK;

      if (p.isClod && p.y <= p.floorY) {
        this.aaaMud?.spawnDecal(p.x, p.floorY, p.z, this._elapsed);
        p.life = 0;
        this._hide(i);
        this.aaaMud?.hideParticle(i);
        continue;
      }

      const lifeFrac = THREE.MathUtils.clamp(p.life / p.maxLife, 0, 1); // 1 fresh → 0 dying
      const age01 = 1 - lifeFrac;

      if (p.isClod && this.aaaMud) {
        this.aaaMud.writeParticle(i, {
          x: p.x, y: p.y, z: p.z,
          vx: p.vx, vy: p.vy, vz: p.vz,
          life01: age01,
          scale: p.baseSize,
          seed: p.seed,
        });
        this._hide(i);
      } else {
        this.aaaMud?.hideParticle(i);
        // Puff grows with age, then shrinks to nothing in its last 30% (death fade).
        const grown = p.baseSize * (1 + age01 * cfg.size.ageGrow);
        const deathFade = lifeFrac > 0.3 ? 1 : lifeFrac / 0.3;
        const scale = grown * deathFade;
        this._p.set(p.x, p.y, p.z);
        this._s.set(scale, scale, scale);
        this._m.compose(this._p, this._camQuat, this._s);
        this.mesh.setMatrixAt(i, this._m);
        setRampColor(this._col, age01, p.seed, cfg.color);
        this.mesh.setColorAt(i, this._col);
      }
      active += 1;
      const op = lifeFrac * peak;
      if (op > opacityMax) opacityMax = op;
    }
    this._active = active;
    this._opacityMax = opacityMax;
    const targetOpacity = active > 0
      ? THREE.MathUtils.clamp(opacityMax * 0.92 + 0.04, 0.08, 1)
      : 0;
    const opacityLerp = 1 - Math.exp(-(active > 0 ? 10 : 14) * step);
    this._materialOpacity += (targetOpacity - this._materialOpacity) * opacityLerp;
    this.mesh.material.opacity = this._materialOpacity;

    const onMud = surface === 'mud' || wheelMud;
    const onLooseSurface = surface === 'dirt' || surface === 'offroad' || onMud;
    if (cfg.clod && onMud && vehicle?.groundedFraction > 0) {
      const mudDynamics = resolveMudWheelDynamics(vehicle?.config?.ground?.mudWheelDynamics);
      (vehicle.wheelTelemetry ?? []).forEach((wheel, wheelIndex) => {
        if (wheelIndex >= vehicle.wheelAnchors.length || !wheel?.inContact || !wheel.contactPoint
          || (wheel.surface ?? surface) !== 'mud') {
          this.wheelEmitCarry[wheelIndex] = 0;
          return;
        }
        const wheelIntensity = THREE.MathUtils.clamp(wheel.mudIntensity ?? 0, 0, 1);
        if (wheelIntensity <= 0) {
          this.wheelEmitCarry[wheelIndex] = 0;
          return;
        }
        this.wheelEmitCarry[wheelIndex] = (this.wheelEmitCarry[wheelIndex] ?? 0)
          + step * mudDynamics.emission.clodPerIntensity * wheelIntensity;
        const emitCount = Math.min(cfg.emitRate.maxPerFrame, Math.floor(this.wheelEmitCarry[wheelIndex]));
        this.wheelEmitCarry[wheelIndex] -= emitCount;
        const slot = {
          contact: wheel.contactPoint,
          slip: wheel.slipRatio ?? 0,
          angularVelocity: wheel.angularVelocity ?? 0,
          wheelIndex,
          anchor: vehicle.wheelAnchors[wheelIndex],
          wheel,
          intensity: wheelIntensity,
        };
        for (let i = 0; i < emitCount; i += 1) this._emit(slot, vehicle, speed, wheelIntensity, lateralSpeed, lateralSign);
      });
    } else if (onLooseSurface && !onMud && vehicle?.groundedFraction > 0 && speed > 1.5) {
      const er = cfg.emitRate;
      const driftBoost = lateralSpeed > (er.driftThreshold ?? 3) ? (er.driftBoost ?? 0) : 0;
      this.emitCarry += step * (er.base + Math.min(speed, er.speedCap) * er.perSpeed
        + intensity * er.perIntensity + driftBoost);
      const emitCount = Math.min(er.maxPerFrame, Math.floor(this.emitCarry));
      this.emitCarry -= emitCount;
      const acceleratingInMud = surface === 'mud' && throttle > 0.08;
      const emitAllWheels = acceleratingInMud || intensity >= (cfg.emitAllWheelsAbove ?? 0.55)
        || lateralSpeed > (cfg.drift?.smoothstart ?? 2) * 1.35;
      const wheelContacts = [];
      (vehicle.wheelTelemetry ?? []).forEach((wheel, index) => {
        if (index >= vehicle.wheelAnchors.length || !wheel?.inContact || !wheel.contactPoint) return;
        const isRear = vehicle.wheelAnchors[index].z > 0;
        if (!emitAllWheels && !isRear) return;
        wheelContacts.push({
          contact: wheel.contactPoint,
          slip: wheel.slipRatio ?? 0,
          angularVelocity: wheel.angularVelocity ?? 0,
          wheelIndex: index,
          anchor: vehicle.wheelAnchors[index],
          wheel,
        });
      });
      const burstAt = er.burstAtIntensity ?? 0.72;
      const burstParticles = Math.max(1, er.burstParticles ?? 1);
      const burstsPerEmit = intensity >= burstAt ? burstParticles : 1;
      // Cycle contacts via a persistent counter so one-per-frame emission still
      // alternates wheels when emitCount is 0/1.
      for (let i = 0; i < emitCount; i += 1) {
        const slot = wheelContacts[this._emitStep % Math.max(1, wheelContacts.length)];
        this._emitStep += 1;
        if (!slot) break;
        for (let burst = 0; burst < burstsPerEmit; burst += 1) {
          this._emit(slot, vehicle, speed, intensity, lateralSpeed, lateralSign, burst);
        }
      }
    } else {
      this.emitCarry = 0;
      if (!onMud) this.wheelEmitCarry.fill(0);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this._elapsed += step;
    this.aaaMud?.update({ camera, elapsedTime: this._elapsed });
    const hasClodParticles = this.particles.some((p) => p.isClod && p.life > 0);
    this.mesh.visible = !hasClodParticles || !this.aaaMud;
  }

  // Collapse an instance to zero scale so it renders nothing.
  _hide(i) {
    this._s.set(0, 0, 0);
    this._p.set(0, 0, 0);
    this._m.compose(this._p, this._camQuat, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  _emit(slot, vehicle, speed, intensity, lateralSpeed, lateralSign, burstIndex = 0) {
    const cfg = this.cfg;
    const { contact, slip, angularVelocity = 0, wheelIndex = -1, anchor, wheel: telemetry } = slot;
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const p = this.particles[index];

    // Chassis forward is -Z, so +Z applied is backward (roost trails behind).
    _forward.set(0, 0, 1).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    _side.set(1, 0, 0).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    const sideSign = Math.sign(anchor?.x ?? 0) || 1;
    if (telemetry?.braking) {
      _forward.multiplyScalar(-0.45).addScaledVector(_side, sideSign * 0.9).normalize();
    } else if ((telemetry?.landingTimeRemaining ?? 0) > 0) {
      _forward.multiplyScalar(0.25).addScaledVector(_side, sideSign).normalize();
    }

    const burstSpread = burstIndex * 0.11;
    // Spawn at the contact, nudged back and up with jitter.
    p.x = contact.x + (Math.random() - 0.5) * (0.35 + burstSpread) + _forward.x * (0.12 + burstSpread);
    p.y = contact.y + 0.12 + Math.random() * 0.24 + burstIndex * 0.04;
    p.z = contact.z + (Math.random() - 0.5) * (0.35 + burstSpread) + _forward.z * (0.12 + burstSpread);

    // Backward roost scales with speed + rear-wheel slip (wheelspin launches a
    // bigger plume). Drift fans the cone sideways along the slide direction.
    const radius = vehicle.config?.ground?.wheelRadius ?? 0.38;
    const wheelSurfaceSpeed = Math.abs(angularVelocity) * radius;
    const spin = THREE.MathUtils.clamp(Math.max(slip, (wheelSurfaceSpeed - speed) / Math.max(speed, 2)), 0, 1.5);
    const roost = 0.85 + Math.min(speed, 32) * (0.038 + intensity * 0.06)
      + spin * cfg.spin.roostScale * 34;
    const driftAmt = cfg.drift.smoothend > cfg.drift.smoothstart
      ? smoothstep(cfg.drift.smoothstart, cfg.drift.smoothend, lateralSpeed)
      : 0;
    const cone = (1.25 + driftAmt * cfg.drift.coneWiden) * (cfg.clod ? 2.6 : 1);
    const driftBias = lateralSpeed * cfg.drift.fanScale * (lateralSign || 1);
    p.vx = _forward.x * roost + (Math.random() - 0.5) * cone + _side.x * driftBias;
    p.vz = _forward.z * roost + (Math.random() - 0.5) * cone + _side.z * driftBias;
    const upKick = 0.48 + intensity * 1.65 + Math.random() * 0.75;
    p.vy = upKick * (0.72 + 0.65 * Math.min(spin, 1) + spin * (cfg.spin.upBias ?? 0.6));
    if (cfg.clod) {
      const speedJitter = 0.45 + Math.random() * 1.35;
      p.vx = p.vx * speedJitter + (Math.random() - 0.5) * 2.1;
      p.vz = p.vz * speedJitter + (Math.random() - 0.5) * 2.1;
      p.vy *= 0.55 + Math.random() * 1.25;
    }

    const sizeBoost = 1 + intensity * 0.22 + Math.min(spin, 1) * 0.18;
    p.baseSize = (cfg.size.baseMin + Math.random() * (cfg.size.baseMax - cfg.size.baseMin)) * sizeBoost;
    p.seed = Math.random();
    p.maxLife = cfg.life.min + Math.random() * (cfg.life.max - cfg.life.min);
    p.life = p.maxLife;
    p.age = 0;
    p.wheelIndex = wheelIndex;
    p.isClod = Boolean(cfg.clod);
    p.floorY = contact.y + 0.015;
    this._emittedByWheel[wheelIndex] = (this._emittedByWheel[wheelIndex] ?? 0) + 1;
    // No per-instance write here: the next update() loop sees life > 0 and
    // writes this particle's matrix + color; until then it stays collapsed.
  }

  snapshot() {
    return {
      activeParticles: this._active ?? 0,
      opacityMax: Number((this._opacityMax ?? 0).toFixed(3)),
      poolSize: this.max,
      emittedByWheel: [...this._emittedByWheel],
    };
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._puffTexture?.dispose();
    this._clodTexture?.dispose();
    this.aaaMud?.dispose();
  }
}

const MUD_LIQUID_DEFAULTS = {
  poolSize: 6000,
  textureSize: 96,
  emitRate: { base: 120, perSpeed: 20, perThrottle: 550, speedCap: 46, maxPerFrame: 120 },
  life: { min: 0.3, max: 0.72, speedThin: 0.6 },
  size: {
    widthMin: 0.1, widthMax: 0.24, lengthMin: 0.16, lengthMax: 0.4,
    speedThin: 0.7, sheetEvery: 4, sheetWidth: 2.8, sheetLength: 1.55,
  },
  launch: {
    tangentialScale: 0.28, speedScale: 0.07,
    rearYawDeg: 6, frontYawDeg: 45,
    rearElevationDeg: 9, frontElevationDeg: 6,
    randomYawDeg: 24, randomElevationDeg: 18, randomSpeedScale: 0.55,
    randomLateral: 0.42, randomUpKick: 0.95, rearFanDeg: 34,
    inheritVelocity: 0.02,
    visualSurfaceLift: 0.3, spawnLift: 0.1,
  },
  breakup: { delay: 0.075, fragments: 3, speedScale: 0.82, spread: 0.7, sizeScale: 0.42, life: 0.32 },
  gravity: 11.5,
  drag: 0.9,
  turbulence: 0.42,
  color: { fresh: [0.20, 0.13, 0.07], old: [0.36, 0.25, 0.16] },
  opacity: 0.72,
};

function mergeMudLiquidConfig(vehicle) {
  const override = vehicle?.config?.ground?.dust?.mud?.liquid ?? {};
  return {
    ...MUD_LIQUID_DEFAULTS,
    ...override,
    emitRate: { ...MUD_LIQUID_DEFAULTS.emitRate, ...(override.emitRate ?? {}) },
    life: { ...MUD_LIQUID_DEFAULTS.life, ...(override.life ?? {}) },
    size: { ...MUD_LIQUID_DEFAULTS.size, ...(override.size ?? {}) },
    launch: { ...MUD_LIQUID_DEFAULTS.launch, ...(override.launch ?? {}) },
    breakup: { ...MUD_LIQUID_DEFAULTS.breakup, ...(override.breakup ?? {}) },
    color: { ...MUD_LIQUID_DEFAULTS.color, ...(override.color ?? {}) },
  };
}

/** Wet wheel spray: AAA-shaded liquid blobs separate from the heavier mud clods. */
export class MudLiquidSpraySystem {
  constructor(group, vehicle) {
    this.cfg = mergeMudLiquidConfig(vehicle);
    this.max = this.cfg.poolSize;
    this.particles = Array.from({ length: this.max }, () => ({
      life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      width: 0, length: 0, seed: 0, age: 0, floorY: 0,
      wheelIndex: -1, sheet: false, broken: false, fragment: false,
    }));
    this.aaaMud = typeof document !== 'undefined'
      ? createAaaMudParticleRenderer({
        poolSize: this.max,
        parent: group,
        name: 'Rally Mud Liquid Splash (AAA)',
      })
      : null;
    this._elapsed = 0;

    this.cursor = 0;
    this.emitCarry = 0;
    this.wheelEmitCarry = [];
    this.emitStep = 0;
    this._active = 0;
    this._fragmentsSpawned = 0;
    this._emittedByWheel = [0, 0, 0, 0];
    this._contactNormal = new THREE.Vector3();
  }

  update({ dt, surface, speed, vehicle, throttle = 0, camera = null }) {
    const cfg = this.cfg;
    const step = THREE.MathUtils.clamp(dt || 0, 0, 0.05);
    const drag = Math.exp(-cfg.drag * step);
    let active = 0;

    for (let i = 0; i < this.max; i += 1) {
      const p = this.particles[i];
      if (p.life <= 0) {
        this.aaaMud?.hideParticle(i);
        continue;
      }
      p.life -= step;
      p.age += step;
      if (p.life <= 0) {
        this.aaaMud?.hideParticle(i);
        continue;
      }
      p.vx += Math.sin(p.age * 13 + p.seed * 6.283185) * cfg.turbulence * step;
      p.vz += Math.cos(p.age * 11 + p.seed * 6.283185) * cfg.turbulence * step;
      p.vy -= cfg.gravity * step;
      p.vx *= drag;
      p.vz *= drag;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      if (p.sheet && !p.broken && p.age >= cfg.breakup.delay) {
        p.broken = true;
        this._breakSheet(p, i);
      }
      if (p.vy < 0 && p.y <= p.floorY) {
        this.aaaMud?.spawnDecal(p.x, p.floorY, p.z, this._elapsed);
        p.life = 0;
        this.aaaMud?.hideParticle(i);
        continue;
      }
      const lifeFrac = THREE.MathUtils.clamp(p.life / p.maxLife, 0, 1);
      const age01 = 1 - lifeFrac;
      const sheetBreakup = p.sheet ? Math.max(0.32, 1 - age01 * 1.15) : 1;
      const particleScale = Math.sqrt(Math.max(0.001, p.width * p.length))
        * sheetBreakup
        * (p.sheet ? 0.85 : 1.0);
      this.aaaMud?.writeParticle(i, {
        x: p.x, y: p.y, z: p.z,
        vx: p.vx, vy: p.vy, vz: p.vz,
        life01: age01,
        scale: particleScale,
        seed: p.seed,
      });
      active += 1;
    }
    this._active = active;

    const wheelMud = (vehicle?.wheelTelemetry ?? []).some((wheel) => wheel?.surface === 'mud');
    if ((surface === 'mud' || wheelMud) && vehicle?.groundedFraction > 0) {
      const mudDynamics = resolveMudWheelDynamics(vehicle?.config?.ground?.mudWheelDynamics);
      (vehicle.wheelTelemetry ?? []).forEach((wheel, wheelIndex) => {
        if (!wheel?.inContact || !wheel.contactPoint || wheelIndex >= vehicle.wheelAnchors.length
          || (wheel.surface ?? surface) !== 'mud') {
          this.wheelEmitCarry[wheelIndex] = 0;
          return;
        }
        const intensity = THREE.MathUtils.clamp(wheel.mudIntensity ?? 0, 0, 1);
        if (intensity <= 0) {
          this.wheelEmitCarry[wheelIndex] = 0;
          return;
        }
        const er = cfg.emitRate;
        this.wheelEmitCarry[wheelIndex] = (this.wheelEmitCarry[wheelIndex] ?? 0)
          + step * mudDynamics.emission.liquidPerIntensity * intensity;
        const count = Math.min(er.maxPerFrame, Math.floor(this.wheelEmitCarry[wheelIndex]));
        this.wheelEmitCarry[wheelIndex] -= count;
        const contact = { wheel, wheelIndex, anchor: vehicle.wheelAnchors[wheelIndex] };
        for (let i = 0; i < count; i += 1) {
          this.emitStep += 1;
          this._emit(contact, vehicle, speed, intensity);
        }
      });
    } else {
      this.emitCarry = 0;
      this.wheelEmitCarry.fill(0);
    }

    this._elapsed += step;
    this.aaaMud?.update({ camera, elapsedTime: this._elapsed });
  }

  _emit({ wheel, wheelIndex, anchor }, vehicle, speed, intensity = 1) {
    const cfg = this.cfg;
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    const radius = vehicle.config?.ground?.wheelRadius ?? 0.38;
    const surfaceSpeed = Math.abs(wheel.angularVelocity ?? 0) * radius;
    const tangentialSpeed = Math.max(speed, surfaceSpeed);
    const sideSign = Math.sign(anchor?.x ?? 0) || 1;
    _forward.set(0, 0, 1).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();
    _side.set(1, 0, 0).applyQuaternion(vehicle.group.quaternion).setY(0).normalize();

    this._contactNormal.copy(wheel.contactNormal ?? THREE.Object3D.DEFAULT_UP);
    if (this._contactNormal.lengthSq() < 0.25) this._contactNormal.set(0, 1, 0);
    this._contactNormal.normalize();
    const deckLift = cfg.launch.visualSurfaceLift;
    const originLift = deckLift + cfg.launch.spawnLift + Math.random() * 0.12;
    const launchJitter = cfg.launch.spawnJitter ?? 0.14;
    // Physics contacts are on the terrain collider, but the soft-mud ribbon is
    // rendered 0.28 m above it. Start just above that deck at the tyre's trailing
    // edge, otherwise depth testing correctly hides the entire effect underground.
    p.x = wheel.contactPoint.x + this._contactNormal.x * originLift
      + _side.x * sideSign * (0.02 + Math.random() * launchJitter)
      + _forward.x * (0.04 + Math.random() * launchJitter);
    p.y = wheel.contactPoint.y + this._contactNormal.y * originLift + Math.random() * 0.08;
    p.z = wheel.contactPoint.z + this._contactNormal.z * originLift
      + _side.z * sideSign * (0.02 + Math.random() * launchJitter)
      + _forward.z * (0.04 + Math.random() * launchJitter);
    const launch = cfg.launch;
    const throwSpeed = (0.8 + tangentialSpeed * launch.tangentialScale + speed * launch.speedScale)
      * (1 + (Math.random() - 0.5) * 2 * (launch.randomSpeedScale ?? 0));
    const inherit = vehicle.linearVelocity ?? _velocity.set(0, 0, 0);
    const isFront = (anchor?.z ?? 0) < 0;
    const yawDeg = isFront ? launch.frontYawDeg : launch.rearYawDeg;
    let yaw = THREE.MathUtils.degToRad(
      yawDeg * sideSign + (Math.random() - 0.5) * 2 * launch.randomYawDeg,
    );
    if (!isFront && Math.random() < 0.38) {
      yaw += (Math.random() - 0.5) * 2 * THREE.MathUtils.degToRad(launch.rearFanDeg ?? 0);
    }
    let dirX = _forward.x * Math.cos(yaw) + _side.x * Math.sin(yaw);
    let dirZ = _forward.z * Math.cos(yaw) + _side.z * Math.sin(yaw);
    if (wheel.braking) {
      dirX = -_forward.x * 0.65 + _side.x * sideSign * 0.76;
      dirZ = -_forward.z * 0.65 + _side.z * sideSign * 0.76;
    } else if ((wheel.landingTimeRemaining ?? 0) > 0) {
      dirX = _forward.x * 0.2 + _side.x * sideSign;
      dirZ = _forward.z * 0.2 + _side.z * sideSign;
    }
    const directionLength = Math.hypot(dirX, dirZ) || 1;
    dirX /= directionLength;
    dirZ /= directionLength;
    p.vx = dirX * throwSpeed + (inherit.x ?? 0) * launch.inheritVelocity;
    p.vz = dirZ * throwSpeed + (inherit.z ?? 0) * launch.inheritVelocity;
    const elevationDeg = (isFront ? launch.frontElevationDeg : launch.rearElevationDeg)
      + (Math.random() - 0.5) * 2 * (launch.randomElevationDeg ?? 0);
    const elevation = THREE.MathUtils.degToRad(elevationDeg);
    p.vy = throwSpeed * Math.tan(elevation) + 0.08 + Math.random() * (launch.randomUpKick ?? 0.55);
    const lateralKick = (Math.random() - 0.5) * 2 * (launch.randomLateral ?? 0) * throwSpeed;
    p.vx += _side.x * lateralKick;
    p.vz += _side.z * lateralKick;

    const speed01 = THREE.MathUtils.clamp(speed / cfg.emitRate.speedCap, 0, 1);
    const thin = THREE.MathUtils.lerp(1, cfg.size.speedThin, speed01);
    p.width = THREE.MathUtils.lerp(cfg.size.widthMin, cfg.size.widthMax, Math.random()) * thin;
    p.length = THREE.MathUtils.lerp(cfg.size.lengthMin, cfg.size.lengthMax, Math.random()) * (0.8 + speed01 * 0.55);
    p.sheet = this.emitStep % (cfg.size.sheetEvery ?? 5) === 0;
    if (p.sheet) {
      p.width *= cfg.size.sheetWidth ?? 2.4;
      p.length *= cfg.size.sheetLength ?? 1.35;
    }
    p.maxLife = THREE.MathUtils.lerp(cfg.life.min, cfg.life.max, Math.random())
      * THREE.MathUtils.lerp(1, cfg.life.speedThin, speed01);
    p.life = p.maxLife;
    p.seed = Math.random();
    p.age = 0;
    p.floorY = wheel.contactPoint.y + Math.max(0.04, this._contactNormal.y * deckLift) + 0.015;
    p.wheelIndex = wheelIndex;
    p.broken = false;
    p.fragment = false;
    p.intensity = intensity;
    this._emittedByWheel[wheelIndex] = (this._emittedByWheel[wheelIndex] ?? 0) + 1;
  }

  // Cheap liquid approximation: a broad cohesive sheet survives for a few
  // frames, then atomizes into smaller mass points which inherit its momentum.
  // This is not SPH, but it supplies the visually important breakup stage for
  // one extra CPU loop and no additional draw call.
  _breakSheet(parent, parentIndex) {
    const cfg = this.cfg.breakup;
    const horizontalSpeed = Math.hypot(parent.vx, parent.vz);
    const tangentX = horizontalSpeed > 1e-4 ? -parent.vz / horizontalSpeed : 1;
    const tangentZ = horizontalSpeed > 1e-4 ? parent.vx / horizontalSpeed : 0;
    for (let n = 0; n < cfg.fragments; n += 1) {
      let index = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      if (index === parentIndex) {
        index = this.cursor;
        this.cursor = (this.cursor + 1) % this.max;
      }
      const child = this.particles[index];
      const spread = (n - (cfg.fragments - 1) * 0.5) * cfg.spread
        + (Math.random() - 0.5) * cfg.spread * 0.5;
      child.x = parent.x + tangentX * spread * 0.04;
      child.y = parent.y + Math.random() * 0.04;
      child.z = parent.z + tangentZ * spread * 0.04;
      child.vx = parent.vx * cfg.speedScale + tangentX * spread;
      child.vy = parent.vy * 0.72 + 0.15 + Math.random() * 0.45;
      child.vz = parent.vz * cfg.speedScale + tangentZ * spread;
      child.width = parent.width * cfg.sizeScale * (0.55 + Math.random() * 0.35);
      child.length = parent.length * cfg.sizeScale * (0.55 + Math.random() * 0.45);
      child.maxLife = Math.min(parent.life, cfg.life * (0.65 + Math.random() * 0.35));
      child.life = child.maxLife;
      child.age = 0;
      child.seed = Math.random();
      child.floorY = parent.floorY;
      child.wheelIndex = parent.wheelIndex;
      child.sheet = false;
      child.broken = true;
      child.fragment = true;
      this._fragmentsSpawned += 1;
    }
  }

  snapshot() {
    return {
      activeParticles: this._active,
      poolSize: this.max,
      emittedByWheel: [...this._emittedByWheel],
      fragmentsSpawned: this._fragmentsSpawned,
    };
  }

  dispose() {
    this.aaaMud?.dispose();
  }
}

const GLASS_BURST_DEFAULTS = {
  poolSize: 220,
  countMin: 48,
  countMax: 120,
  life: { min: 0.22, max: 0.82 },
  size: { baseMin: 0.04, baseMax: 0.14, ageGrow: 0.35 },
  speed: { min: 2.5, max: 11 },
  scatter: 4.2,
  gravity: 14,
  drag: 2.4,
  opacity: { peak: 0.92, fadePow: 1.2 },
};

function setGlassShardColor(out, age01, seed) {
  const cool = 0.82 + seed * 0.18;
  const warm = 0.9 + (1 - seed) * 0.08;
  if (age01 < 0.35) {
    out.setRGB(0.92 * warm, 0.96 * warm, 1.0 * cool);
  } else {
    const k = (age01 - 0.35) / 0.65;
    out.setRGB(
      THREE.MathUtils.lerp(0.92 * warm, 0.72, k),
      THREE.MathUtils.lerp(0.96 * warm, 0.76, k),
      THREE.MathUtils.lerp(1.0 * cool, 0.82, k),
    );
  }
}

/** One-shot windshield shard burst — same instanced billboard pattern as rally dust. */
export class WindshieldGlassBurst {
  constructor(group) {
    const cfg = GLASS_BURST_DEFAULTS;
    this.cfg = cfg;
    this.max = cfg.poolSize;
    this.particles = Array.from({ length: this.max }, () => ({
      life: 0, maxLife: 1, age: 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      baseSize: 0, seed: 0,
    }));

    this._puffTexture = makeDustPuffTexture();
    const material = new THREE.MeshBasicMaterial({
      map: this._puffTexture ?? undefined,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.max);
    this.mesh.name = 'Windshield glass shard burst';
    this.mesh.frustumCulled = false;
    this.mesh.count = this.max;
    this.mesh.renderOrder = 5;

    const white = new THREE.Color(1, 1, 1);
    const collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i += 1) {
      this.mesh.setMatrixAt(i, collapsed);
      this.mesh.setColorAt(i, white);
    }
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    group.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._col = new THREE.Color();
    this._camQuat = new THREE.Quaternion();
    this._burstDir = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this.cursor = 0;
    this._active = 0;
    this._opacityMax = 0;
  }

  burst({ origin, forward, right, severity = 14 }) {
    if (!origin) return;
    const cfg = this.cfg;
    const norm = THREE.MathUtils.clamp((severity - 10) / 10, 0, 1);
    const count = Math.floor(
      THREE.MathUtils.lerp(cfg.countMin, cfg.countMax, norm),
    );

    this._burstDir.copy(forward).setY(0);
    if (this._burstDir.lengthSq() < 1e-6) this._burstDir.set(0, 0, -1);
    this._burstDir.normalize();
    this._side.copy(right).setY(0);
    if (this._side.lengthSq() < 1e-6) this._side.set(1, 0, 0);
    this._side.normalize();
    this._up.set(0, 1, 0);

    for (let i = 0; i < count; i += 1) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const p = this.particles[index];

      p.x = origin.x + (Math.random() - 0.5) * 0.55;
      p.y = origin.y + (Math.random() - 0.5) * 0.28;
      p.z = origin.z + (Math.random() - 0.5) * 0.35;

      const speed = THREE.MathUtils.lerp(cfg.speed.min, cfg.speed.max, Math.random())
        * (0.75 + norm * 0.55);
      const scatter = cfg.scatter * (0.65 + Math.random() * 0.7);
      const rx = (Math.random() - 0.5) * scatter;
      const ry = Math.random() * scatter * 0.65 + 0.4;
      const rz = (Math.random() - 0.5) * scatter;
      p.vx = this._burstDir.x * speed + this._side.x * rx + this._up.x * ry;
      p.vy = this._burstDir.y * speed + ry * 0.35 + 1.2 + Math.random() * 2.4;
      p.vz = this._burstDir.z * speed + this._side.z * rz + this._up.z * ry;

      p.baseSize = cfg.size.baseMin + Math.random() * (cfg.size.baseMax - cfg.size.baseMin);
      p.seed = Math.random();
      p.maxLife = cfg.life.min + Math.random() * (cfg.life.max - cfg.life.min);
      p.life = p.maxLife;
      p.age = 0;
    }
  }

  update({ dt, camera = null }) {
    const cfg = this.cfg;
    const step = THREE.MathUtils.clamp(dt || 0, 0, 0.05);
    const dragK = Math.exp(-cfg.drag * step);
    this._camQuat.copy(camera?.quaternion ?? _IDENTITY_QUAT);
    let active = 0;
    let opacityMax = 0;

    for (let i = 0; i < this.max; i += 1) {
      const p = this.particles[i];
      if (p.life <= 0) {
        this._hide(i);
        continue;
      }
      p.life -= step;
      p.age += step;
      if (p.life <= 0) {
        this._hide(i);
        continue;
      }

      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      p.vy -= cfg.gravity * step;
      p.vx *= dragK;
      p.vz *= dragK;

      const lifeFrac = THREE.MathUtils.clamp(p.life / p.maxLife, 0, 1);
      const age01 = 1 - lifeFrac;
      const grown = p.baseSize * (1 + age01 * cfg.size.ageGrow);
      const deathFade = lifeFrac > 0.25 ? 1 : lifeFrac / 0.25;
      const scale = grown * deathFade;
      this._p.set(p.x, p.y, p.z);
      this._s.set(scale, scale, scale);
      this._m.compose(this._p, this._camQuat, this._s);
      this.mesh.setMatrixAt(i, this._m);
      setGlassShardColor(this._col, age01, p.seed);
      this.mesh.setColorAt(i, this._col);
      active += 1;
      const op = lifeFrac * cfg.opacity.peak;
      if (op > opacityMax) opacityMax = op;
    }

    this._active = active;
    this._opacityMax = opacityMax;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  _hide(i) {
    this._s.set(0, 0, 0);
    this._p.set(0, 0, 0);
    this._m.compose(this._p, this._camQuat, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  snapshot() {
    return {
      activeParticles: this._active ?? 0,
      opacityMax: Number((this._opacityMax ?? 0).toFixed(3)),
      poolSize: this.max,
    };
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._puffTexture?.dispose();
  }
}

class TireScreechAudioSystem {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.turn = new TireSamplePool({ urls: TURN_SCREECH_URLS, volume: 0.62 });
    this.brake = new TireSamplePool({ urls: BRAKE_SCREECH_URLS, volume: 0.58 });
    this.muted = true;
    this.loadPromise = null;
    this.gravelSource = null;
    this.gravelGain = null;
    this.gravelFilter = null;
    this.lastStoneAt = 0;
    // Rally mud: a wetter, duller squelch loop (low-passed noise) + a sticky
    // "peel" one-shot on high slip. Kept separate from the bright gravel layer.
    this.mudSource = null;
    this.mudGain = null;
    this.mudFilter = null;
    this.lastPeelAt = 0;
  }

  _ensure() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this._init();
    return this.loadPromise;
  }

  async _init() {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
    this._createGravelLayer();
    this._createMudLayer();
    await Promise.all([
      this.turn.load(this.ctx, this.masterGain),
      this.brake.load(this.ctx, this.masterGain),
    ]);
  }

  resume() {
    this.muted = false;
    this._ensure().then(() => this.ctx?.resume()).catch(() => {});
  }

  mute(state) {
    this.muted = Boolean(state);
    if (state) {
      this.turn.setMuted(true);
      this.brake.setMuted(true);
      if (this.gravelGain && this.ctx) this.gravelGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
      if (this.mudGain && this.ctx) this.mudGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
    } else {
      this.turn.setMuted(false);
      this.brake.setMuted(false);
    }
  }

  update(turnIntensity, brakeIntensity, speed, { surface = 'asphalt', slip = 0 } = {}) {
    if (!this.ctx || !this.masterGain) return;
    const muted = this.muted;
    this.turn.update(muted ? 0 : turnIntensity, speed);
    this.brake.update(muted ? 0 : brakeIntensity, speed);
    const mud = surface === 'mud';
    if (this.gravelGain && this.gravelFilter) {
      // Dry loose surfaces (not mud) drive the bright gravel rattle.
      const dirt = surface === 'dirt' || surface === 'offroad';
      const amount = muted || !dirt ? 0 : THREE.MathUtils.clamp(speed / 24, 0, 1) * (0.035 + slip * 0.075);
      this.gravelGain.gain.setTargetAtTime(amount, this.ctx.currentTime, amount > 0 ? 0.05 : 0.12);
      this.gravelFilter.frequency.setTargetAtTime(850 + Math.min(speed, 38) * 34, this.ctx.currentTime, 0.08);
      if (dirt && !muted && slip > 0.62 && this.ctx.currentTime - this.lastStoneAt > 0.16) {
        this.lastStoneAt = this.ctx.currentTime;
        this._stonePing(slip);
      }
    }
    if (this.mudGain && this.mudFilter) {
      // Wet mud: a duller, wetter squelch that swells with speed + slip, plus a
      // sticky "peel" one-shot when the tyres break loose.
      const amount = muted || !mud ? 0 : THREE.MathUtils.clamp(speed / 20, 0, 1) * (0.05 + slip * 0.11);
      this.mudGain.gain.setTargetAtTime(amount, this.ctx.currentTime, amount > 0 ? 0.06 : 0.14);
      this.mudFilter.frequency.setTargetAtTime(360 + Math.min(speed, 30) * 16, this.ctx.currentTime, 0.1);
      if (mud && !muted && slip > 0.55 && this.ctx.currentTime - this.lastPeelAt > 0.28) {
        this.lastPeelAt = this.ctx.currentTime;
        this._squelchPeel(slip);
      }
    }
  }

  _createGravelLayer() {
    if (!this.ctx || !this.masterGain) return;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      data[i] = last * (0.55 + Math.random() * 0.45);
    }
    this.gravelSource = this.ctx.createBufferSource();
    this.gravelSource.buffer = buffer;
    this.gravelSource.loop = true;
    this.gravelFilter = this.ctx.createBiquadFilter();
    this.gravelFilter.type = 'bandpass';
    this.gravelFilter.frequency.value = 1050;
    this.gravelFilter.Q.value = 0.7;
    this.gravelGain = this.ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.gravelSource.connect(this.gravelFilter).connect(this.gravelGain).connect(this.masterGain);
    this.gravelSource.start();
  }

  _createMudLayer() {
    if (!this.ctx || !this.masterGain) return;
    // Wet-noise: heavier low-passed noise than the gravel bandpass — a squelch,
    // not a rattle. Reuse the 2 s looping noise idiom.
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      // Heavier smoothing → duller, wetter texture.
      last = last * 0.86 + white * 0.14;
      data[i] = last * (0.6 + Math.random() * 0.4);
    }
    this.mudSource = this.ctx.createBufferSource();
    this.mudSource.buffer = buffer;
    this.mudSource.loop = true;
    this.mudFilter = this.ctx.createBiquadFilter();
    this.mudFilter.type = 'lowpass';
    this.mudFilter.frequency.value = 420;
    this.mudFilter.Q.value = 0.9;
    this.mudGain = this.ctx.createGain();
    this.mudGain.gain.value = 0;
    this.mudSource.connect(this.mudFilter).connect(this.mudGain).connect(this.masterGain);
    this.mudSource.start();
  }

  _squelchPeel(intensity) {
    // A short downward-swept low-passed noise burst — the sticky "peel" of a tyre
    // pulling free of wet mud.
    const buffer = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.22), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      last = last * 0.9 + (Math.random() * 2 - 1) * 0.1;
      data[i] = last;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(180, this.ctx.currentTime + 0.2);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.05 * THREE.MathUtils.clamp(intensity, 0, 1.5), this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.22);
    src.connect(filter).connect(gain).connect(this.masterGain);
    src.start();
    src.stop(this.ctx.currentTime + 0.24);
  }

  _stonePing(intensity) {
    const oscillator = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 2100 + Math.random() * 2600;
    gain.gain.setValueAtTime(0.018 * intensity, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.045);
    oscillator.connect(gain).connect(this.masterGain);
    oscillator.start();
    oscillator.stop(this.ctx.currentTime + 0.05);
  }

  dispose() {
    this.turn.dispose();
    this.brake.dispose();
    try { this.gravelSource?.stop(); } catch {}
    try { this.mudSource?.stop(); } catch {}
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.masterGain = null;
    this.loadPromise = null;
    this.gravelSource = null;
    this.gravelGain = null;
    this.gravelFilter = null;
    this.mudSource = null;
    this.mudGain = null;
    this.mudFilter = null;
  }
}

/** One looping sample from a pool; picks a new clip whenever screech restarts. */
class TireSamplePool {
  constructor({ urls, volume = 0.5 }) {
    this.urls = urls;
    this.volume = volume;
    this.buffers = [];
    this.source = null;
    this.gain = null;
    this.lastIndex = -1;
    this.lastIntensity = 0;
    this.ctx = null;
    this.output = null;
    this.externalMuted = false;
  }

  async load(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.buffers = await Promise.all(this.urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load tire audio: ${url}`);
      const arrayBuffer = await response.arrayBuffer();
      return ctx.decodeAudioData(arrayBuffer);
    }));
  }

  setMuted(state) {
    this.externalMuted = Boolean(state);
    if (state) this._fadeTo(0, 0.04);
  }

  update(intensity, speed) {
    if (!this.ctx || !this.buffers.length) return;

    const amount = THREE.MathUtils.clamp(intensity, 0, 1);
    const startThreshold = 0.12;
    const stopThreshold = 0.05;

    if (amount >= startThreshold && this.lastIntensity < startThreshold) {
      this._startRandomLoop();
    }

    if (this.source && this.gain) {
      if (amount >= stopThreshold) {
        const target = amount * this.volume;
        this.gain.gain.setTargetAtTime(
          this.externalMuted ? 0 : target,
          this.ctx.currentTime,
          amount > this.lastIntensity ? 0.035 : 0.07,
        );
        const rate = 0.88 + Math.min(speed, 42) * 0.0075;
        this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.06);
      } else {
        this._fadeTo(0, 0.08);
      }
    } else if (amount >= startThreshold) {
      this._startRandomLoop();
      this.update(amount, speed);
    }

    if (amount < stopThreshold && this.lastIntensity >= stopThreshold) {
      this._fadeTo(0, 0.1);
    }
    if (amount < 0.02 && this.source) {
      this._stop();
    }

    this.lastIntensity = amount;
  }

  _startRandomLoop() {
    if (!this.ctx || !this.buffers.length) return;
    this._stop();

    let index = Math.floor(Math.random() * this.buffers.length);
    if (this.buffers.length > 1 && index === this.lastIndex) {
      index = (index + 1) % this.buffers.length;
    }
    this.lastIndex = index;

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffers[index];
    this.source.loop = true;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain).connect(this.output);
    this.source.start(0);
  }

  _fadeTo(value, timeConstant) {
    if (!this.gain || !this.ctx) return;
    this.gain.gain.setTargetAtTime(value, this.ctx.currentTime, timeConstant);
  }

  _stop() {
    if (!this.source) return;
    try { this.source.stop(); } catch {}
    this.source.disconnect();
    this.gain?.disconnect();
    this.source = null;
    this.gain = null;
  }

  dispose() {
    this._stop();
    this.buffers = [];
    this.ctx = null;
    this.output = null;
  }
}

function writeVertex(attribute, index, value) {
  attribute.setXYZ(index, value.x, value.y, value.z);
}

function smoothstep(min, max, value) {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
