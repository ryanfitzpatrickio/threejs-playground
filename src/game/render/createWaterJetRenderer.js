/**
 * Aquarium water jets: continuous ballistic *streams* plus light splash mist.
 *
 * Solid stream read comes from heavily-overlapping velocity-aligned capsule
 * segments sampled along each hole's Torricelli arc — not sparse beads.
 * Beads are reserved for end-of-stream breakup and floor splash.
 *
 * CPU sim + InstancedMesh instanceMatrix/instanceColor (DynamicDrawUsage).
 * Do NOT use TSL storage() for the live pools under WebGPU.
 */

import * as THREE from 'three';
import { createMallWaterHeightfield } from './createMallWaterHeightfield.js';

const GRAVITY = 9.81;
const FLOOR_Y_DEFAULT = 0;
const JET_NUDGE = 0.05;

// Continuous stream segments (the solid column).
// Budget sized for many simultaneous holes × full floor-reaching arcs.
const MAX_STREAM_SEGS = 2048;
/** Integration step for ballistic path — fine enough for smooth arcs. */
const STREAM_INTEGRATE_DT = 0.016;
/** Safety cap on free-flight time so a path always terminates. */
const STREAM_MAX_FLIGHT = 5.0;
/** Max draw samples per jet after decimation (always includes nozzle + floor). */
const MAX_DRAW_POINTS_PER_JET = 48;
const STREAM_OVERLAP = 1.4; // >1 so capsules bridge without bead gaps
/**
 * Stream front advances in *flight time* (not instant). Water that left the
 * hole only draws as far as age allows — so a high jet takes ~1s to hit floor
 * instead of popping in fully formed. Values >1 stretch the pour slower.
 */
const STREAM_FRONT_TIME_SCALE = 1.35;
/** Soft ramp of width/opacity after the hole opens (seconds). */
const STREAM_BIRTH_FADE = 0.55;

// Sparse beads only for mist / splash (not the main stream body).
const MAX_DROPLETS = 280;
const DROPLET_LIFE = 0.85;
const SPLASH_LIFE = 0.35;
const MIST_RATE_SCALE = 10;
const MAX_MIST_PER_HOLE = 3;

const MAX_CRACKS = 48;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _billboardAxis = new THREE.Vector3(0, 0, 1);
const _vel = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _col = new THREE.Color();
const _collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
const _zFwd = new THREE.Vector3(0, 0, 1);
const _yUp = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _twistAxis = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _viewDir = new THREE.Vector3();
const _widthAxis = new THREE.Vector3();
const _faceAxis = new THREE.Vector3();

// Pale wet-glass stream tints (not solid aquarium teal).
const COLOR_DEEP = new THREE.Color(0xa8b6ba);
const COLOR_MID = new THREE.Color(0xd0dce0);
const COLOR_HI = new THREE.Color(0xf4f9fb);
const COLOR_CORE = new THREE.Color(0xffffff);
const COLOR_CRACK = new THREE.Color(0x1a2a2e);

/**
 * Soft capsule texture: pale translucent core + soft edges + specular ridge.
 * Reads as clear water ribbon, not a blue tube.
 */
function makeStreamCapsuleTexture(size = 128) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);

  // Vertical soft gradient (U = across stream, V = along stream).
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    const endFade = Math.min(v * 8, (1 - v) * 8, 1);
    for (let x = 0; x < size; x += 1) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const across = Math.abs(u);
      const core = Math.max(0, 1 - across / 0.22);
      const body = Math.max(0, 1 - across / 0.62);
      const sheath = Math.max(0, 1 - across / 0.95);
      // Keep alpha modest so overlapping segments stay translucent.
      const a = (core * 0.55 + body * 0.28 + sheath * 0.1) * endFade;
      const t = core * 0.55 + body * 0.35;
      // Near-white / cool grey — only a whisper of teal.
      const r = 210 + t * 40;
      const g = 220 + t * 30;
      const b = 225 + t * 28;
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  // Bright specular ridge (glass stream highlight).
  const g = ctx.createLinearGradient(size * 0.38, 0, size * 0.62, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(size * 0.38, size * 0.06, size * 0.24, size * 0.88);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Soft radial mist — pale / clear, not cyan. */
function makeMistBlobTexture(size = 64) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  g.addColorStop(0.35, 'rgba(220, 230, 235, 0.22)');
  g.addColorStop(1, 'rgba(180, 195, 200, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Integrate ballistic path until the stream hits the floor (always).
 * Never stops mid-air due to a fixed segment count — only a long flight-time
 * safety cap can terminate early, and even then we force a floor endpoint.
 *
 * Each sample carries `t` (flight time from nozzle) and `dist` (arc length)
 * so the draw front can advance gradually without truncating the final path.
 *
 * @returns {{
 *   points: Array<{ x:number,y:number,z:number, vx:number,vy:number,vz:number, dist:number, t:number }>,
 *   totalLength: number,
 *   flightTime: number,
 *   reachedFloor: boolean,
 * }}
 */
function sampleBallisticPathToFloor(ox, oy, oz, vx, vy, vz, floorY) {
  const points = [{ x: ox, y: oy, z: oz, vx, vy, vz, dist: 0, t: 0 }];
  let x = ox;
  let y = oy;
  let z = oz;
  let sx = vx;
  let sy = vy;
  let sz = vz;
  let dist = 0;
  let t = 0;
  let reachedFloor = oy <= floorY + 0.02;
  const dt = STREAM_INTEGRATE_DT;
  const maxSteps = Math.ceil(STREAM_MAX_FLIGHT / dt) + 2;

  for (let i = 0; i < maxSteps && !reachedFloor; i += 1) {
    sx *= 0.9985;
    sz *= 0.9985;
    sy -= GRAVITY * dt;
    const nx = x + sx * dt;
    const ny = y + sy * dt;
    const nz = z + sz * dt;

    if (ny <= floorY + 0.01) {
      const denom = Math.max(1e-5, y - ny);
      const tHit = THREE.MathUtils.clamp((y - floorY) / denom, 0, 1);
      const hx = x + (nx - x) * tHit;
      const hz = z + (nz - z) * tHit;
      const hy = floorY + 0.012;
      const stepLen = Math.hypot(hx - x, hy - y, hz - z);
      dist += stepLen;
      t += dt * tHit;
      points.push({ x: hx, y: hy, z: hz, vx: sx, vy: 0, vz: sz, dist, t });
      reachedFloor = true;
      break;
    }

    t += dt;
    const stepLen = Math.hypot(nx - x, ny - y, nz - z);
    dist += stepLen;
    x = nx;
    y = ny;
    z = nz;
    points.push({ x, y, z, vx: sx, vy: sy, vz: sz, dist, t });
  }

  // Safety: if integration timed out above the floor, drop a final vertical
  // fall segment so the drawn arc still terminates on the ground.
  if (!reachedFloor && points.length > 0) {
    const last = points[points.length - 1];
    const hy = floorY + 0.012;
    dist += Math.max(0, last.y - hy);
    t += 0.2;
    points.push({
      x: last.x,
      y: hy,
      z: last.z,
      vx: last.vx * 0.2,
      vy: 0,
      vz: last.vz * 0.2,
      dist,
      t,
    });
    reachedFloor = true;
  }

  return {
    points,
    totalLength: dist,
    flightTime: points[points.length - 1]?.t ?? 0,
    reachedFloor,
  };
}

/**
 * Reduce a dense floor-reaching path to ≤ maxPoints while always keeping the
 * nozzle and floor endpoints. Intermediate samples are evenly spaced by
 * arc-length so the full arc is preserved, not truncated mid-air.
 */
function decimatePathByArcLength(points, maxPoints) {
  if (!points?.length) return [];
  if (points.length <= maxPoints) return points;
  const total = points[points.length - 1].dist || 1;
  const out = [points[0]];
  const inner = Math.max(1, maxPoints - 2);
  for (let i = 1; i <= inner; i += 1) {
    const target = (total * i) / (inner + 1);
    // Binary-ish scan for nearest sample at/after target dist.
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].dist < target) lo = mid + 1;
      else hi = mid;
    }
    const p = points[lo];
    if (p !== out[out.length - 1]) out.push(p);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Orient a camera-facing quad stretched along world tangent (stream direction).
 * Local X = width (across stream), Y = length (along tangent), Z = facing.
 * PlaneGeometry is XY with +Z normal — matches this basis.
 */
function composeStreamSegment(mid, tangent, length, width, camera) {
  _tangent.copy(tangent);
  if (_tangent.lengthSq() < 1e-8) _tangent.set(0, -1, 0);
  else _tangent.normalize();

  if (camera) {
    camera.getWorldDirection(_viewDir);
    // Width axis ⊥ stream and roughly ⊥ view so the strip faces the camera.
    _widthAxis.crossVectors(_tangent, _viewDir);
    if (_widthAxis.lengthSq() < 1e-8) {
      _widthAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _widthAxis.crossVectors(_tangent, _widthAxis);
    }
    _widthAxis.normalize();
    _faceAxis.crossVectors(_widthAxis, _tangent).normalize();
    _basis.makeBasis(_widthAxis, _tangent, _faceAxis);
    _q.setFromRotationMatrix(_basis);
  } else {
    _q.setFromUnitVectors(_yUp, _tangent);
  }

  _p.copy(mid);
  _s.set(Math.max(0.02, width), Math.max(0.02, length), 1);
  _m.compose(_p, _q, _s);
  return _m;
}

/**
 * @param {object} [opts]
 * @param {THREE.Object3D} [opts.parent]
 * @param {number} [opts.poolSize] mist droplet pool (not stream segs)
 * @param {number} [opts.floorY]
 * @param {string} [opts.name]
 * @param {Array<{ id: string, cx: number, cz: number }>} [opts.tanks]
 */
export function createWaterJetRenderer({
  parent = null,
  poolSize = MAX_DROPLETS,
  floorY = FLOOR_Y_DEFAULT,
  name = 'Aquarium Water Jets',
  tanks = [],
} = {}) {
  const mistMax = Math.max(16, poolSize | 0);
  const floor = Number.isFinite(floorY) ? floorY : FLOOR_Y_DEFAULT;

  // ── Continuous stream segment pool ──────────────────────────────────────
  const streamTex = makeStreamCapsuleTexture(128);
  const streamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: streamTex || null,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexColors: true,
    // Additive-ish soft stack: overlapping segments brighten highlights, not mud.
    blending: THREE.NormalBlending,
  });
  const streamGeom = new THREE.PlaneGeometry(1, 1);
  const streamMesh = new THREE.InstancedMesh(streamGeom, streamMat, MAX_STREAM_SEGS);
  streamMesh.name = `${name} Streams`;
  // Never frustum-cull long arcs — instance bounds would otherwise clip mid-air.
  streamMesh.frustumCulled = false;
  streamMesh.count = MAX_STREAM_SEGS;
  streamMesh.renderOrder = 8;
  streamMesh.userData.noStaticMerge = true;
  streamMesh.userData.skipLevelRaycast = true;
  if (streamGeom.boundingSphere) {
    streamGeom.boundingSphere.center.set(0, 0, 0);
    streamGeom.boundingSphere.radius = 1e5;
  } else {
    streamGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  }
  streamGeom.boundingBox = null;
  for (let i = 0; i < MAX_STREAM_SEGS; i += 1) {
    streamMesh.setMatrixAt(i, _collapsed);
    streamMesh.setColorAt(i, COLOR_CORE);
  }
  streamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streamMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  streamMesh.instanceMatrix.needsUpdate = true;
  streamMesh.instanceColor.needsUpdate = true;
  if (parent) parent.add(streamMesh);

  // ── Mist / splash bead pool (secondary) ─────────────────────────────────
  const mistTex = makeMistBlobTexture(64);
  const mistMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: mistTex || null,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexColors: true,
  });
  const mistGeom = new THREE.PlaneGeometry(1, 1);
  const mistMesh = new THREE.InstancedMesh(mistGeom, mistMat, mistMax);
  mistMesh.name = `${name} Mist`;
  mistMesh.frustumCulled = false;
  mistMesh.count = mistMax;
  mistMesh.renderOrder = 9;
  mistMesh.userData.noStaticMerge = true;
  mistMesh.userData.skipLevelRaycast = true;
  const mistParticles = Array.from({ length: mistMax }, () => ({
    life: 0,
    maxLife: DROPLET_LIFE,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    baseSize: 0.08,
    isSplash: false,
    seed: 0,
  }));
  for (let i = 0; i < mistMax; i += 1) {
    mistMesh.setMatrixAt(i, _collapsed);
    mistMesh.setColorAt(i, COLOR_HI);
  }
  mistMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mistMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mistMesh.instanceMatrix.needsUpdate = true;
  mistMesh.instanceColor.needsUpdate = true;
  if (parent) parent.add(mistMesh);

  // ── Meatball ground water (wine-style heightfield) ───────────────────────
  // Cover the aquarium plaza so spill spreads under all four tanks.
  let fieldCenterX = -82;
  let fieldCenterZ = 0;
  if (tanks?.length) {
    fieldCenterX = tanks.reduce((s, t) => s + (t.cx ?? 0), 0) / tanks.length;
    fieldCenterZ = tanks.reduce((s, t) => s + (t.cz ?? 0), 0) / tanks.length;
  }
  const floorWater = createMallWaterHeightfield({
    parent,
    floorY: floor,
    centerX: fieldCenterX,
    centerZ: fieldCenterZ,
    width: 30,
    depth: 30,
    columns: 72,
    rows: 72,
    name: 'Mall Aquarium Floor Water',
  });
  /** Last drained01 per tank for continuous seep as water leaves the glass. */
  const lastDrained01 = new Map();
  /** Latest floor-impact point per tank so drained water pools at the jet landing. */
  const lastImpactByTank = new Map();

  // ── Cracks ──────────────────────────────────────────────────────────────
  const crackMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexColors: true,
  });
  const crackGeom = new THREE.PlaneGeometry(1, 1);
  const crackMesh = new THREE.InstancedMesh(crackGeom, crackMat, MAX_CRACKS);
  crackMesh.name = 'Aquarium Glass Cracks';
  crackMesh.frustumCulled = false;
  crackMesh.count = MAX_CRACKS;
  crackMesh.renderOrder = 5;
  crackMesh.userData.noStaticMerge = true;
  crackMesh.userData.skipLevelRaycast = true;
  for (let i = 0; i < MAX_CRACKS; i += 1) {
    crackMesh.setMatrixAt(i, _collapsed);
    crackMesh.setColorAt(i, COLOR_CRACK);
  }
  crackMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  crackMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  crackMesh.instanceMatrix.needsUpdate = true;
  crackMesh.instanceColor.needsUpdate = true;
  if (parent) parent.add(crackMesh);
  let crackCount = 0;
  /** @type {Set<string>} */
  const crackKeys = new Set();

  let mistCursor = 0;
  let activeMist = 0;
  let activeStreamSegs = 0;
  /** @type {Map<string, number>} */
  const mistCarry = new Map();
  /**
   * Per-hole stream growth: age drives how far along the arc the front has
   * travelled so jets pour out gradually instead of appearing fully formed.
   * @type {Map<string, { age: number }>}
   */
  const streamGrowth = new Map();
  let splashCursor = 0;
  let streamPhase = 0;

  function holeKey(jet) {
    const h = jet.hole;
    return `${jet.tankId}:${h.x.toFixed(2)},${h.y.toFixed(2)},${h.z.toFixed(2)}`;
  }

  function hideMist(i) {
    mistMesh.setMatrixAt(i, _collapsed);
    mistParticles[i].life = 0;
  }

  function allocMist() {
    const start = mistCursor;
    for (let n = 0; n < mistMax; n += 1) {
      const i = (start + n) % mistMax;
      if (mistParticles[i].life <= 0) {
        mistCursor = (i + 1) % mistMax;
        return i;
      }
    }
    const i = mistCursor % mistMax;
    mistCursor = (mistCursor + 1) % mistMax;
    return i;
  }

  function spawnMist({
    x, y, z, vx, vy, vz, size = 0.08, isSplash = false, life = DROPLET_LIFE,
  }) {
    const i = allocMist();
    const p = mistParticles[i];
    p.life = life;
    p.maxLife = life;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.baseSize = size;
    p.isSplash = isSplash;
    p.seed = Math.random();
    return i;
  }

  function spawnSplash(x, y, z, intensity = 1, velocityX = 0, velocityZ = 0) {
    splashCursor += 1;
    const n = Math.min(6, 2 + Math.floor(intensity * 3) + (splashCursor % 2));
    for (let k = 0; k < n; k += 1) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 1.0 * intensity;
      spawnMist({
        x: x + Math.cos(ang) * 0.04,
        y: y + 0.03,
        z: z + Math.sin(ang) * 0.04,
        vx: Math.cos(ang) * sp,
        vy: 0.5 + Math.random() * 1.2,
        vz: Math.sin(ang) * sp,
        size: 0.07 + Math.random() * 0.06,
        isSplash: true,
        life: SPLASH_LIFE * (0.7 + Math.random() * 0.5),
      });
    }
    // Meatball puddle impact — wine-style heightfield deposit.
    floorWater.deposit(
      x,
      z,
      0.28 + intensity * 0.22,
      1.2 + intensity * 3.5,
      velocityX,
      velocityZ,
    );
  }

  function addCrackMark(jet) {
    if (!jet?.hole || crackCount >= MAX_CRACKS) return;
    const key = holeKey(jet);
    if (crackKeys.has(key)) return;
    crackKeys.add(key);

    const h = jet.hole;
    _n.set(h.nx || 0, h.ny || 0, h.nz || 0);
    if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0);
    else _n.normalize();

    const arms = 2 + (crackCount % 2);
    for (let a = 0; a < arms && crackCount < MAX_CRACKS; a += 1) {
      const i = crackCount;
      crackCount += 1;
      const ang = (a / arms) * Math.PI + (Math.random() - 0.5) * 0.55;
      const len = 0.12 + Math.random() * 0.2;
      const width = 0.01 + Math.random() * 0.012;
      const alongX = Math.sin(ang) * len * 0.4;
      const alongY = Math.cos(ang) * len * 0.4;
      const tx = -_n.z;
      const tz = _n.x;
      const tLen = Math.hypot(tx, tz) || 1;
      const ux = tx / tLen;
      const uz = tz / tLen;
      const cx = h.x + _n.x * 0.03 + ux * alongX;
      const cy = h.y + alongY;
      const cz = h.z + _n.z * 0.03 + uz * alongX;

      _q.setFromUnitVectors(_zFwd, _n);
      _twistAxis.copy(_n);
      _q.multiply(new THREE.Quaternion().setFromAxisAngle(_twistAxis, ang));
      _p.set(cx, cy, cz);
      _s.set(width, len, 1);
      _m.compose(_p, _q, _s);
      crackMesh.setMatrixAt(i, _m);
      _col.copy(COLOR_CRACK).lerp(COLOR_MID, 0.12);
      crackMesh.setColorAt(i, _col);
    }
    crackMesh.instanceMatrix.needsUpdate = true;
    if (crackMesh.instanceColor) crackMesh.instanceColor.needsUpdate = true;
  }

  function update({
    dt = 0,
    jets = [],
    waterfalls = [],
    camera = null,
    tankDrain = [],
  } = {}) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    streamPhase = (streamPhase + step * 6) % (Math.PI * 2);

    // ── Rebuild continuous streams from active jets + shatter waterfalls ──
    let segIndex = 0;
    const liveKeys = new Set();
    const activeJets = (jets ?? []).filter((j) => j?.hole && j.jetSpeed > 1e-3);
    const activeFalls = (waterfalls ?? []).filter((w) => w?.jetSpeed > 1e-3 && w.fill01 > 0.02);
    const streamSources = activeJets.length + Math.max(1, activeFalls.length * 3);
    // Fair segment budget so many holes never starve later jets mid-arc.
    const drawBudget = Math.max(
      12,
      Math.floor(MAX_STREAM_SEGS / Math.max(1, streamSources)),
    );
    const pointsBudget = Math.min(MAX_DRAW_POINTS_PER_JET, drawBudget + 1);

    for (const jet of activeJets) {
      const h = jet.hole;
      const key = holeKey(jet);
      liveKeys.add(key);

      // Grow stream front over time (pour out, don't pop in fully formed).
      let growth = streamGrowth.get(key);
      if (!growth) {
        growth = { age: 0 };
        streamGrowth.set(key, growth);
      }
      growth.age += step;

      const speed = jet.jetSpeed;
      // Pressure-driven initial velocity; slight downward bias for arc.
      // Slightly damped so the visual arc is readable, not a sniper bolt.
      const vx0 = h.nx * speed * 0.92;
      const vy0 = h.ny * speed * 0.1 + 0.02;
      const vz0 = h.nz * speed * 0.92;
      const ox = h.x + h.nx * JET_NUDGE;
      const oy = h.y + h.ny * JET_NUDGE;
      const oz = h.z + h.nz * JET_NUDGE;

      const sampled = sampleBallisticPathToFloor(ox, oy, oz, vx0, vy0, vz0, floor);
      const fullPath = sampled.points;
      if (fullPath.length < 2) continue;

      // Front advances in flight-time: water pours out of the hole and only
      // draws as far as age allows. Full arc (to floor) once age covers flight.
      const frontT = growth.age / STREAM_FRONT_TIME_SCALE;
      const visibleDense = [];
      for (let i = 0; i < fullPath.length; i += 1) {
        visibleDense.push(fullPath[i]);
        if (fullPath[i].t >= frontT && i > 0) break;
      }
      // Short nozzle stub while the front is still at the hole.
      if (visibleDense.length < 2 && fullPath.length >= 2) {
        visibleDense.length = 0;
        visibleDense.push(fullPath[0], fullPath[1]);
      }

      const path = decimatePathByArcLength(visibleDense, pointsBudget);
      const pathLen = path.length;
      const reachedFrontFloor = sampled.reachedFloor
        && frontT >= sampled.flightTime * 0.98;

      // Width ramps in over STREAM_BIRTH_FADE so the nozzle softens open.
      const birth = Math.min(1, growth.age / STREAM_BIRTH_FADE);
      const baseWidth = (0.065 + Math.min(0.13, speed * 0.026)) * (0.35 + birth * 0.65);

      for (let s = 0; s < pathLen - 1 && segIndex < MAX_STREAM_SEGS; s += 1) {
        const a = path[s];
        const b = path[s + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const chord = Math.hypot(dx, dy, dz);
        if (chord < 1e-4) continue;

        // Taper: fat at nozzle, thinner near floor; slight pulse for living fluid.
        const t = s / Math.max(1, pathLen - 2);
        const taper = 1 - t * 0.55;
        const pulse = 1 + 0.05 * Math.sin(streamPhase + s * 0.7 + speed);
        const width = baseWidth * taper * pulse;
        const length = chord * STREAM_OVERLAP;

        _p.set(
          (a.x + b.x) * 0.5,
          (a.y + b.y) * 0.5,
          (a.z + b.z) * 0.5,
        );
        _tangent.set(dx, dy, dz);
        composeStreamSegment(_p, _tangent, length, width, camera);
        streamMesh.setMatrixAt(segIndex, _m);

        // Pale sheen near nozzle → slightly greyer as stream thins (still not blue).
        _col.copy(COLOR_CORE).lerp(COLOR_MID, t * 0.45).lerp(COLOR_DEEP, t * 0.25);
        _col.multiplyScalar((0.85 + (1 - t) * 0.2) * (0.5 + birth * 0.5));
        streamMesh.setColorAt(segIndex, _col);
        segIndex += 1;
      }

      // Floor impact only once the growing front actually reaches the ground.
      const last = path[path.length - 1];
      if (reachedFrontFloor && last && last.y <= floor + 0.05) {
        lastImpactByTank.set(jet.tankId, {
          x: last.x,
          z: last.z,
          vx: last.vx ?? h.nx * speed,
          vz: last.vz ?? h.nz * speed,
        });
        const splashKey = `${key}:splash`;
        const carry = (mistCarry.get(splashKey) ?? 0) + step * (1.5 + speed * 0.6);
        if (carry >= 1) {
          mistCarry.set(splashKey, carry - 1);
          spawnSplash(
            last.x,
            floor,
            last.z,
            Math.min(1.4, speed * 0.25),
            last.vx ?? h.nx * speed,
            last.vz ?? h.nz * speed,
          );
        } else {
          mistCarry.set(splashKey, carry);
        }
        // Continuous seep at the landing (this tank's stream only).
        floorWater.seep(
          last.x,
          last.z,
          step * (0.014 + speed * 0.007),
          0.75 + Math.min(0.9, speed * 0.09),
        );
      }

      // Sparse side-mist near the current front (not the full solid column).
      if (pathLen > 4 && growth.age > 0.2) {
        const rate = Math.min(MAX_MIST_PER_HOLE, speed * MIST_RATE_SCALE * 0.06);
        const carry = (mistCarry.get(key) ?? 0) + rate * step;
        const count = Math.min(MAX_MIST_PER_HOLE, Math.floor(carry));
        mistCarry.set(key, carry - count);
        for (let e = 0; e < count; e += 1) {
          // Prefer mist near the advancing tip.
          const idx = Math.max(1, pathLen - 2 - Math.floor(Math.random() * 2));
          const p = path[Math.min(pathLen - 1, idx)];
          spawnMist({
            x: p.x + (Math.random() - 0.5) * 0.05,
            y: p.y + (Math.random() - 0.5) * 0.03,
            z: p.z + (Math.random() - 0.5) * 0.05,
            vx: p.vx * 0.25 + (Math.random() - 0.5) * 0.35,
            vy: p.vy * 0.15 + Math.random() * 0.25,
            vz: p.vz * 0.25 + (Math.random() - 0.5) * 0.35,
            size: 0.045 + Math.random() * 0.035,
            life: 0.3 + Math.random() * 0.25,
          });
        }
      }
    }

    // ── Shatter dump: one full-face-width particle ribbon (not multi-column cards) ─
    for (const fall of activeFalls) {
      const key = `wf:${fall.tankId}:${fall.face}`;
      liveKeys.add(key);
      let growth = streamGrowth.get(key);
      if (!growth) {
        growth = { age: 0 };
        streamGrowth.set(key, growth);
      }
      growth.age += step;

      const n = { x: fall.nx || 0, z: fall.nz || 0 };
      const nLen = Math.hypot(n.x, n.z) || 1;
      n.x /= nLen;
      n.z /= nLen;
      const half = fall.halfSize ?? 1.9;
      const speed = fall.jetSpeed;
      const surfaceY = fall.waterLevel;
      const birth = Math.min(1, growth.age / 0.4);

      // Emit from face center; ribbon width = full side width.
      const ox = fall.cx + n.x * (half + 0.1);
      const oz = fall.cz + n.z * (half + 0.1);
      const oy = surfaceY - 0.08;
      const vx0 = n.x * speed * 0.55;
      const vy0 = -0.45 - speed * 0.1;
      const vz0 = n.z * speed * 0.55;

      const sampled = sampleBallisticPathToFloor(ox, oy, oz, vx0, vy0, vz0, floor);
      const frontT = growth.age / 0.9;
      const visibleDense = [];
      for (let i = 0; i < sampled.points.length; i += 1) {
        visibleDense.push(sampled.points[i]);
        if (sampled.points[i].t >= frontT && i > 0) break;
      }
      if (visibleDense.length < 2 && sampled.points.length >= 2) {
        visibleDense.length = 0;
        visibleDense.push(sampled.points[0], sampled.points[1]);
      }
      const path = decimatePathByArcLength(visibleDense, Math.min(36, Math.max(pointsBudget, 24)));

      // Full pane width across the shattered side (halfSize * 2), slight birth ramp.
      const faceWidth = half * 2 * 0.98 * (0.55 + birth * 0.45);

      for (let s = 0; s < path.length - 1 && segIndex < MAX_STREAM_SEGS; s += 1) {
        const a = path[s];
        const b = path[s + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const chord = Math.hypot(dx, dy, dz);
        if (chord < 1e-4) continue;
        const t = s / Math.max(1, path.length - 2);
        // Stay nearly full-width along the fall; slight taper near the floor.
        const width = faceWidth * (1.0 - t * 0.12);
        _p.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
        _tangent.set(dx, dy, dz);
        composeStreamSegment(_p, _tangent, chord * 1.5, width, camera);
        streamMesh.setMatrixAt(segIndex, _m);
        _col.copy(COLOR_CORE).lerp(COLOR_MID, t * 0.4);
        _col.multiplyScalar(0.8 + birth * 0.2);
        streamMesh.setColorAt(segIndex, _col);
        segIndex += 1;
      }

      // Heavy flood under the sheet.
      const last = path[path.length - 1];
      if (last && last.y <= floor + 0.08 && growth.age > 0.3) {
        floorWater.seep(last.x, last.z, step * (0.12 + fall.fill01 * 0.18), half * 1.6);
        // Spread seeps across the face width so the pool matches the ribbon.
        const ax = -n.z;
        const az = n.x;
        for (const u of [-0.55, 0, 0.55]) {
          floorWater.seep(
            last.x + ax * half * u,
            last.z + az * half * u,
            step * (0.05 + fall.fill01 * 0.08),
            half * 0.9,
          );
        }
        lastImpactByTank.set(fall.tankId, {
          x: last.x,
          z: last.z,
          vx: n.x * speed,
          vz: n.z * speed,
        });
        const splashKey = `${key}:splash`;
        const carry = (mistCarry.get(splashKey) ?? 0) + step * (4 + speed);
        if (carry >= 1) {
          mistCarry.set(splashKey, carry - 1);
          spawnSplash(last.x, floor, last.z, 1.8, n.x * speed, n.z * speed);
        } else {
          mistCarry.set(splashKey, carry);
        }
      }
    }

    // Clear unused stream slots.
    for (let i = segIndex; i < MAX_STREAM_SEGS; i += 1) {
      streamMesh.setMatrixAt(i, _collapsed);
    }
    activeStreamSegs = segIndex;
    streamMesh.instanceMatrix.needsUpdate = true;
    if (streamMesh.instanceColor) streamMesh.instanceColor.needsUpdate = true;
    streamMat.opacity = segIndex > 0 ? 0.52 : 0;

    // Drop growth / mist carry for dead holes.
    for (const key of streamGrowth.keys()) {
      if (!liveKeys.has(key)) streamGrowth.delete(key);
    }
    for (const key of mistCarry.keys()) {
      const base = key.replace(/:splash.*$/, '');
      if (!liveKeys.has(base) && !liveKeys.has(key.split(':splash')[0])) {
        // keep if base jet/waterfall still live
        const jetBase = key.includes(':splash') ? key.slice(0, key.indexOf(':splash')) : key;
        if (!liveKeys.has(jetBase)) mistCarry.delete(key);
      }
    }

    // ── Integrate mist beads ──────────────────────────────────────────────
    const camQuat = camera?.quaternion ?? null;
    if (camQuat) {
      _camRight.set(1, 0, 0).applyQuaternion(camQuat);
      _camUp.set(0, 1, 0).applyQuaternion(camQuat);
    }

    let liveMist = 0;
    for (let i = 0; i < mistMax; i += 1) {
      const p = mistParticles[i];
      if (p.life <= 0) {
        hideMist(i);
        continue;
      }
      p.life -= step;
      if (p.life <= 0) {
        hideMist(i);
        continue;
      }
      p.vy -= GRAVITY * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.z += p.vz * step;
      p.vx *= 0.99;
      p.vz *= 0.99;
      if (p.y <= floor + 0.01) {
        // Mist beads that land feed the meatball puddle lightly.
        if (p.isSplash) {
          floorWater.deposit(p.x, p.z, 0.12, 0.8, p.vx, p.vz);
        }
        hideMist(i);
        continue;
      }

      const lifeRem = Math.max(0, Math.min(1, p.life / p.maxLife));
      const deathFade = lifeRem > 0.25 ? 1 : lifeRem / 0.25;
      const size = p.baseSize * (0.8 + (1 - lifeRem) * 0.5) * deathFade;

      if (camQuat) {
        _q.copy(camQuat);
      } else {
        _q.identity();
      }
      _p.set(p.x, p.y, p.z);
      _s.set(size, size, 1);
      _m.compose(_p, _q, _s);
      mistMesh.setMatrixAt(i, _m);
      _col.copy(COLOR_HI).lerp(COLOR_MID, 1 - lifeRem);
      _col.multiplyScalar(0.65 + lifeRem * 0.35);
      mistMesh.setColorAt(i, _col);
      liveMist += 1;
    }
    activeMist = liveMist;
    mistMesh.instanceMatrix.needsUpdate = true;
    if (mistMesh.instanceColor) mistMesh.instanceColor.needsUpdate = true;
    mistMat.opacity = liveMist > 0 ? 0.38 : 0;

    // ── Meatball floor water: drained volume follows this tank's jet landing ─
    if (tankDrain?.length && tanks?.length) {
      for (const info of tankDrain) {
        const target = THREE.MathUtils.clamp(Number(info?.drained01) || 0, 0, 1);
        const prev = lastDrained01.get(info.tankId) ?? 0;
        const delta = Math.max(0, target - prev);
        lastDrained01.set(info.tankId, Math.max(prev, target));
        if (delta <= 1e-5) continue;
        const tank = tanks.find((t) => t.id === info.tankId);
        if (!tank) continue;
        const impact = lastImpactByTank.get(info.tankId);
        // Prefer the stream landing for this tank; fall back to tank base.
        const px = impact?.x ?? tank.cx;
        const pz = impact?.z ?? tank.cz;
        floorWater.seep(px, pz, delta * 0.5, 1.0 + target * 1.5);
        // Small secondary pool at the pillar base (same tank only).
        floorWater.seep(tank.cx, tank.cz, delta * 0.12, 0.7 + target * 0.6);
      }
    }
    floorWater.update(step);
  }

  function snapshot() {
    return {
      poolSize: mistMax,
      activeDroplets: activeMist,
      activeStreamSegs,
      floorY: floor,
      crackCount,
      continuousStreams: true,
      streamsReachFloor: true,
      activeHoles: streamGrowth.size,
      softSprite: Boolean(streamTex),
      floorWater: floorWater.snapshot(),
    };
  }

  function dispose() {
    streamMesh.parent?.remove(streamMesh);
    mistMesh.parent?.remove(mistMesh);
    streamGeom.dispose();
    streamMat.dispose();
    streamTex?.dispose?.();
    mistGeom.dispose();
    mistMat.dispose();
    mistTex?.dispose?.();
    floorWater.dispose();
    crackMesh.parent?.remove(crackMesh);
    crackGeom.dispose();
    crackMat.dispose();
    mistCarry.clear();
    streamGrowth.clear();
    lastDrained01.clear();
    lastImpactByTank.clear();
    crackKeys.clear();
    activeMist = 0;
    activeStreamSegs = 0;
    crackCount = 0;
  }

  return {
    // Primary mesh is the continuous stream (for any debug that looks at .mesh).
    mesh: streamMesh,
    mistMesh,
    floorWater,
    update,
    addCrackMark,
    snapshot,
    dispose,
    get activeDroplets() { return activeMist; },
    get activeStreamSegs() { return activeStreamSegs; },
    get crackCount() { return crackCount; },
  };
}
