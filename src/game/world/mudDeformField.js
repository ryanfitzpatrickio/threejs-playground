// MudDeformField — CPU-authoritative, world-space deformation field for the
// rally `mud` surface (docs/rally-mud-tread-plan.md, M1).
//
// A fixed-footprint grid that FOLLOWS the active vehicle: each cell holds the
// current { depth, wetness, tread } of the mud there, plus decay bookkeeping.
// Tyres `stamp()` ruts in from contact telemetry; every consumer (`getGroundHeightAt`,
// BaseVehicle visual/suspension sink, and — later — the GPU deform texture)
// reads back through `sampleAt()`/`sampleDepthAt()`. Decay runs on the CPU (no
// render pass) with two timescales: tread melts first, the rut fills in slower.
//
// Why CPU-authoritative: three consumers need synchronous CPU reads, and stamping
// is sparse (≤4 contacts/frame). See the plan's §2/§7.
//
// Ring-buffer discipline: the grid is a torus in world-cell space. Each slot
// records which world cell currently owns it (`ownerX`/`ownerZ`); a slot whose
// owner doesn't match the queried world cell is treated as empty. That makes the
// field follow the car for free — a stamp reclaims whatever slot the new world
// cell maps to, and stale cells that scroll out of range read back as zero
// without any explicit clear pass or recenter step.

import * as THREE from 'three';
import { uniform } from 'three/tsl';

const EPSILON = 1e-4;

// stampKind values: dog paw 0.4, human foot 0.5, preworn 0.75, vehicle 1.0
const KIND_DOG_PAW = 0.4;
const KIND_FOOT = 0.5;
const KIND_PREWORN = 0.75;
const KIND_VEHICLE = 1.0;

function kindValue(kind) {
  if (kind === 'dog-paw') return KIND_DOG_PAW;
  if (kind === 'foot') return KIND_FOOT;
  if (kind === 'preworn') return KIND_PREWORN;
  return KIND_VEHICLE;
}

export function createMudDeformField({
  cellSize = 0.5, // metres per cell
  resolution = 256, // cells across (footprint = resolution * cellSize metres)
  maxDepth = 0.12, // clamp on stamped/accumulated sink (m)
  // Decay time constants (seconds). value *= exp(-dt / tau) each decay(dt).
  // Tread detail melts fastest, wetness dries next, the rut fills in slowest.
  depthTau = 9,
  treadTau = 4,
  wetnessTau = 3,
  // Pre-worn demo tracks (another car's prior laps) linger much longer than live
  // tyre stamps so the stage still reads used after a full run.
  prewornDepthTau = 160,
  prewornTreadTau = 90,
  prewornWetnessTau = 70,
  maxFootprints = 48,
  footprintFadeTau = 0.18,
} = {}) {
  const R = Math.max(2, Math.floor(resolution));
  const N = R * R;
  const invCell = 1 / cellSize;

  const depth = new Float32Array(N);
  const wetness = new Float32Array(N);
  const tread = new Float32Array(N);
  const directionX = new Float32Array(N);
  const directionZ = new Float32Array(N).fill(-1);
  const lateralPhase = new Float32Array(N);
  const stampKind = new Float32Array(N);
  // Player prints are tracked as whole stamps rather than unrelated cells. This
  // lets the bounded trail retire strictly oldest-first; otherwise a shallow
  // edge texel from a new print can decay below EPSILON before an old print's
  // deeper centre and make the trail appear to erase from the wrong end.
  const footprintId = new Uint32Array(N);
  const footprintQueue = [];
  let nextFootprintId = 1;
  let dogPawStampCount = 0;
  // Owner world-cell coords per slot; NaN = never written (empty).
  const ownerX = new Float32Array(N).fill(NaN);
  const ownerZ = new Float32Array(N).fill(NaN);
  // Slots with any live channel — decay only sweeps these, not all N cells.
  const active = new Set();
  // Slots cleared since the last texture sync — get a one-time zero write so the
  // packed texture drops the rut without a full-grid rewrite.
  const pendingClear = new Set();

  const wrap = (c) => ((c % R) + R) % R;
  const slot = (wx, wz) => wrap(wz) * R + wrap(wx);

  // Reused scratch so the hot sample path allocates nothing (TSL/GC gotcha).
  const _sample = { depth: 0, wetness: 0, tread: 0 };

  // Footprint in metres and the world-XZ → deform-UV scale the mud material uses.
  const footprint = R * cellSize;
  const deformTilesPerMetre = 1 / footprint;

  // World-XZ centre of the active region (the car), shared with the mud material
  // so it can fade the deform to zero beyond the footprint — the texture wraps
  // (torus), so without this a rut would ghost onto distant road one footprint
  // away. Updated each frame via setCenter.
  const centerUniform = uniform(new THREE.Vector2(0, 0));
  function setCenter(x, z) {
    centerUniform.value.set(x, z);
  }

  // Packed RGBA8 deform + orientation textures (lazy, GPU exposure — M2).
  // slot: the material samples it by positionWorld.xz with RepeatWrapping, which
  // wraps straight onto the same torus slot the CPU stamps into. Re-uploaded via
  // needsUpdate on the SAME texture object each frame (never swapped/resized) so
  // it doesn't re-dirty the node material (city-GC gotcha).
  // deform:      R = depth/maxDepth, G = wetness, B = tread, A = presence.
  // orientation: R/G = signed world heading encoded 0..1,
  //              B = lateral texture phase, A = presence.
  let texture = null;
  let orientationTexture = null;
  let texData = null;
  let orientationData = null;
  function ensureTexture() {
    if (texture) return texture;
    texData = new Uint8Array(N * 4);
    orientationData = new Uint8Array(N * 4);
    texture = createFieldTexture(texData, R);
    orientationTexture = createFieldTexture(orientationData, R);
    return texture;
  }
  // Only re-pack the LIVE cells (they decay every frame) plus any cell cleared
  // since the last sync (a one-time zero write) — never the whole grid, so a big
  // fine field stays cheap. The texel buffer starts zeroed and cells are only
  // ever non-zero while active, so untouched texels are already correct.
  //
  // GPU writeBuffer was a top self-time hotspot when this ran every frame with
  // an empty active set (dog park grass). Skip the upload entirely when idle.
  let texDirty = false;
  let syncFrame = 0;
  function markTextureDirty() {
    texDirty = true;
  }
  function syncTexture({ force = false } = {}) {
    if (!texture) return false;
    if (!force && active.size === 0 && pendingClear.size === 0 && !texDirty) {
      return false;
    }
    // While only decaying (no new stamps this frame), ~30 Hz uploads are enough
    // for soft ruts and cut writeBuffer cost roughly in half.
    syncFrame += 1;
    if (!force && !texDirty && active.size > 0 && pendingClear.size === 0 && (syncFrame & 1) === 0) {
      return false;
    }
    const invMax = 1 / maxDepth;
    for (const i of active) {
      const r = clamp255(depth[i] * invMax);
      const g = clamp255(wetness[i]);
      const b = clamp255(tread[i]);
      const o = i * 4;
      texData[o] = r;
      texData[o + 1] = g;
      texData[o + 2] = b;
      texData[o + 3] = Math.max(r, g, b); // presence: >0 wherever mud was stamped
      orientationData[o] = clamp255(directionX[i] * 0.5 + 0.5);
      orientationData[o + 1] = clamp255(directionZ[i] * 0.5 + 0.5);
      orientationData[o + 2] = clamp255(lateralPhase[i]);
      orientationData[o + 3] = texData[o + 3] > 0 ? clamp255(stampKind[i]) : 0;
    }
    for (const i of pendingClear) {
      const o = i * 4;
      texData[o] = 0;
      texData[o + 1] = 0;
      texData[o + 2] = 0;
      texData[o + 3] = 0;
      orientationData[o] = 0;
      orientationData[o + 1] = 0;
      orientationData[o + 2] = 0;
      orientationData[o + 3] = 0;
    }
    pendingClear.clear();
    texDirty = false;
    texture.needsUpdate = true;
    orientationTexture.needsUpdate = true;
    // WebGPU node materials can miss a bare needsUpdate on DataTextures that were
    // bound empty at first compile; bumping version forces a re-upload.
    texture.version = (texture.version | 0) + 1;
    orientationTexture.version = (orientationTexture.version | 0) + 1;
    return true;
  }
  function disposeTexture() {
    texture?.dispose?.();
    orientationTexture?.dispose?.();
    texture = null;
    orientationTexture = null;
    texData = null;
    orientationData = null;
  }

  function cellDepth(wx, wz) {
    const i = slot(wx, wz);
    return ownerX[i] === wx && ownerZ[i] === wz ? depth[i] : 0;
  }
  function readCell(wx, wz, out) {
    const i = slot(wx, wz);
    if (ownerX[i] === wx && ownerZ[i] === wz) {
      out.depth = depth[i];
      out.wetness = wetness[i];
      out.tread = tread[i];
    } else {
      out.depth = 0;
      out.wetness = 0;
      out.tread = 0;
    }
    return out;
  }

  // Bilinear-sample the field at world (x, z). Cell centres sit at
  // (worldCell + 0.5) * cellSize. Fills and returns the shared scratch object —
  // copy out immediately, it's overwritten on the next call.
  function sampleAt(x, z) {
    const gx = x * invCell - 0.5;
    const gz = z * invCell - 0.5;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;

    const c00 = readCell(x0, z0, _c00);
    const c10 = readCell(x0 + 1, z0, _c10);
    const c01 = readCell(x0, z0 + 1, _c01);
    const c11 = readCell(x0 + 1, z0 + 1, _c11);

    _sample.depth = bilerp(c00.depth, c10.depth, c01.depth, c11.depth, fx, fz);
    _sample.wetness = bilerp(c00.wetness, c10.wetness, c01.wetness, c11.wetness, fx, fz);
    _sample.tread = bilerp(c00.tread, c10.tread, c01.tread, c11.tread, fx, fz);
    return _sample;
  }

  // Depth-only fast path for the hot analytic-ground query (no object alloc).
  function sampleDepthAt(x, z) {
    const gx = x * invCell - 0.5;
    const gz = z * invCell - 0.5;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    return bilerp(
      cellDepth(x0, z0), cellDepth(x0 + 1, z0),
      cellDepth(x0, z0 + 1), cellDepth(x0 + 1, z0 + 1),
      fx, fz,
    );
  }

  // Stamp a tyre contact. `depth` max-combines (a wheel passing again doesn't
  // erase a deeper rut); `add` ACCUMULATES on top (a spinning/bogged wheel bores
  // progressively deeper each frame) toward maxDepth. wetness/tread max-combine.
  function stamp(x, z, {
    depth: d = 0,
    add = 0,
    wetness: w = 0,
    tread: t = 0,
    directionX: headingX = 0,
    directionZ: headingZ = -1,
    kind = 'vehicle',
    _lateralPhase = null,
    _footprintId = 0,
  } = {}) {
    if (!(d > 0 || add > 0 || w > 0 || t > 0)) return;
    const wx = Math.round(x * invCell - 0.5);
    const wz = Math.round(z * invCell - 0.5);
    const i = slot(wx, wz);
    if (ownerX[i] !== wx || ownerZ[i] !== wz) {
      // Reclaim the slot for this world cell (scrolled-in or first touch).
      ownerX[i] = wx;
      ownerZ[i] = wz;
      depth[i] = 0;
      wetness[i] = 0;
      tread[i] = 0;
      stampKind[i] = 0;
      footprintId[i] = 0;
    }
    let dx = Number(headingX) || 0;
    let dz = Number(headingZ);
    if (!Number.isFinite(dz)) dz = -1;
    const directionLength = Math.hypot(dx, dz) || 1;
    dx /= directionLength;
    dz /= directionLength;
    const kv = kindValue(kind);
    if (kv >= stampKind[i]) {
      directionX[i] = dx;
      directionZ[i] = dz;
      lateralPhase[i] = _lateralPhase ?? fract01((x * -dz + z * dx) / 1.4);
      stampKind[i] = kv;
      footprintId[i] = kind === 'foot' || kind === 'dog-paw' ? _footprintId : 0;
    }
    depth[i] = Math.min(maxDepth, Math.max(depth[i], d) + add);
    wetness[i] = Math.max(wetness[i], w);
    // Force GPU upload next sync so new stamps are not deferred by the
    // every-other-frame decay throttle.
    texDirty = true;
    tread[i] = Math.max(tread[i], t);
    active.add(i);
    pendingClear.delete(i); // re-stamped before its clear was flushed
    return (kind === 'foot' || kind === 'dog-paw') && footprintId[i] === _footprintId ? i : -1;
  }

  // Stamp a round brush (radius in metres, linear falloff to the edge) so a tyre
  // lays a rut a realistic ~1 m wide — wide enough to span several ribbon columns
  // and read as a real trough, not a one-cell nick.
  function stampBrush(x, z, radius, {
    depth: d = 0,
    add = 0,
    wetness: w = 0,
    tread: t = 0,
    directionX: headingX = 0,
    directionZ: headingZ = -1,
    kind = 'vehicle',
  } = {}) {
    const r = Math.max(cellSize, radius);
    let dx = Number(headingX) || 0;
    let dz = Number(headingZ);
    if (!Number.isFinite(dz)) dz = -1;
    const directionLength = Math.hypot(dx, dz) || 1;
    dx /= directionLength;
    dz /= directionLength;
    const phase = fract01((x * -dz + z * dx) / 1.4);
    for (let oz = -r; oz <= r + 1e-6; oz += cellSize) {
      for (let ox = -r; ox <= r + 1e-6; ox += cellSize) {
        const dist = Math.hypot(ox, oz);
        if (dist > r) continue;
        const fall = 1 - dist / r; // 1 at centre → 0 at the rim
        stamp(x + ox, z + oz, {
          depth: d * fall,
          add: add * fall,
          wetness: w * fall,
          tread: t * fall,
          directionX: dx,
          directionZ: dz,
          kind,
          _lateralPhase: phase,
        });
      }
    }
  }

  // Stamp an oriented shoe sole. Separate heel and forefoot ellipses plus a
  // narrow bridge read as a footprint at field resolution instead of the old
  // circular puddle brush. `directionX/Z` points from heel toward toe.
  function stampFootprint(x, z, {
    depth: d = 0,
    wetness: w = 0,
    tread: t = 0,
    directionX: headingX = 0,
    directionZ: headingZ = -1,
    side = 1,
  } = {}) {
    let dx = Number(headingX) || 0;
    let dz = Number(headingZ);
    if (!Number.isFinite(dz)) dz = -1;
    const directionLength = Math.hypot(dx, dz) || 1;
    dx /= directionLength;
    dz /= directionLength;
    const rightX = -dz;
    const rightZ = dx;
    const id = nextFootprintId++;
    const cells = new Set();
    // The live rally field uses 15 cm cells. These dimensions are deliberately
    // a little broader than a literal shoe so the filtered texture retains a
    // recognisable multi-texel sole instead of collapsing to one round texel.
    const reach = 0.38;
    const minWx = Math.floor((x - reach) * invCell - 0.5);
    const maxWx = Math.ceil((x + reach) * invCell - 0.5);
    const minWz = Math.floor((z - reach) * invCell - 0.5);
    const maxWz = Math.ceil((z + reach) * invCell - 0.5);

    for (let wz = minWz; wz <= maxWz; wz += 1) {
      for (let wx = minWx; wx <= maxWx; wx += 1) {
        const px = (wx + 0.5) * cellSize;
        const pz = (wz + 0.5) * cellSize;
        const ox = px - x;
        const oz = pz - z;
        const along = ox * dx + oz * dz;
        const across = ox * rightX + oz * rightZ;
        // The forefoot is wider and shifts slightly toward the big-toe side.
        const toeAcross = across - Math.sign(side || 1) * 0.022;
        const fore = ellipseFalloff(along - 0.12, toeAcross, 0.19, 0.17);
        const bridge = ellipseFalloff(along + 0.015, across, 0.2, 0.1);
        const heel = ellipseFalloff(along + 0.15, across, 0.14, 0.135);
        const fall = Math.max(fore, bridge * 0.72, heel * 0.9);
        if (!(fall > 0)) continue;
        const stampedSlot = stamp(px, pz, {
          depth: d * fall,
          wetness: w * fall,
          tread: t * fall,
          directionX: dx,
          directionZ: dz,
          kind: 'foot',
          _footprintId: id,
        });
        if (stampedSlot >= 0) cells.add(stampedSlot);
      }
    }

    if (cells.size > 0) footprintQueue.push({ id, cells });
    return id;
  }

  // Stamp a compact, oriented dog pad. The central pad is followed by three
  // shallow toe lobes so filtered dog-park mud still reads as a paw rather than
  // a miniature human shoe. `directionX/Z` points toward the toes.
  function stampDogPaw(x, z, {
    depth: d = 0,
    wetness: w = 0,
    tread: t = 0,
    directionX: headingX = 0,
    directionZ: headingZ = -1,
    side = 1,
  } = {}) {
    let dx = Number(headingX) || 0;
    let dz = Number(headingZ);
    if (!Number.isFinite(dz)) dz = -1;
    const directionLength = Math.hypot(dx, dz) || 1;
    dx /= directionLength;
    dz /= directionLength;
    const rightX = -dz;
    const rightZ = dx;
    const id = nextFootprintId++;
    const cells = new Set();
    // Slightly exaggerated for a chase camera: still paw-scale in world space,
    // but large enough to survive texture filtering and remain visible after a
    // nearby torso splash.
    const reach = 0.25;
    const minWx = Math.floor((x - reach) * invCell - 0.5);
    const maxWx = Math.ceil((x + reach) * invCell - 0.5);
    const minWz = Math.floor((z - reach) * invCell - 0.5);
    const maxWz = Math.ceil((z + reach) * invCell - 0.5);
    const sideSign = Math.sign(side || 1);

    for (let wz = minWz; wz <= maxWz; wz += 1) {
      for (let wx = minWx; wx <= maxWx; wx += 1) {
        const px = (wx + 0.5) * cellSize;
        const pz = (wz + 0.5) * cellSize;
        const ox = px - x;
        const oz = pz - z;
        const along = ox * dx + oz * dz;
        const across = ox * rightX + oz * rightZ;
        const pad = ellipseFalloff(along + 0.03, across, 0.14, 0.12);
        let toes = 0;
        for (const toeOffset of [-0.072, 0, 0.072]) {
          const splay = toeOffset + sideSign * 0.008;
          toes = Math.max(toes, ellipseFalloff(along - 0.12, across - splay, 0.07, 0.048));
        }
        const fall = Math.max(pad, toes * 0.82);
        if (!(fall > 0)) continue;
        const stampedSlot = stamp(px, pz, {
          depth: d * fall,
          wetness: w * fall,
          tread: t * fall,
          directionX: dx,
          directionZ: dz,
          kind: 'dog-paw',
          _footprintId: id,
        });
        if (stampedSlot >= 0) cells.add(stampedSlot);
      }
    }

    if (cells.size > 0) {
      footprintQueue.push({ id, cells });
      dogPawStampCount += 1;
    }
    return cells.size > 0 ? id : 0;
  }

  // CPU decay sweep over live cells only. Two timescales melt tread before the
  // rut fills back in. Pre-worn cells use much longer taus so demo "prior laps"
  // linger after live tyre marks have melted. Cells that fall below EPSILON on
  // every channel are cleared.
  function decay(dt) {
    if (!(dt > 0) || active.size === 0) return;
    const kdVehicle = Math.exp(-dt / depthTau);
    const ktVehicle = Math.exp(-dt / treadTau);
    const kwVehicle = Math.exp(-dt / wetnessTau);
    const kdPre = Math.exp(-dt / prewornDepthTau);
    const ktPre = Math.exp(-dt / prewornTreadTau);
    const kwPre = Math.exp(-dt / prewornWetnessTau);
    for (const i of active) {
      // Footprints are retired atomically by the FIFO pass below. Holding newer
      // prints stable is what guarantees that despawning cannot eat into them.
      if (footprintId[i] !== 0) continue;
      const preworn = stampKind[i] > KIND_FOOT + 0.05 && stampKind[i] < KIND_VEHICLE - 0.05;
      const kd = preworn ? kdPre : kdVehicle;
      const kt = preworn ? ktPre : ktVehicle;
      const kw = preworn ? kwPre : kwVehicle;
      const nd = depth[i] * kd;
      const nt = tread[i] * kt;
      const nw = wetness[i] * kw;
      if (nd < EPSILON && nt < EPSILON && nw < EPSILON) {
        depth[i] = 0;
        wetness[i] = 0;
        tread[i] = 0;
        stampKind[i] = 0;
        ownerX[i] = NaN;
        ownerZ[i] = NaN;
        active.delete(i);
        pendingClear.add(i); // flush a zero to the texture on the next sync
      } else {
        depth[i] = nd;
        tread[i] = nt;
        wetness[i] = nw;
      }
    }

    // Keep a fixed recent trail. If several prints were added in one frame the
    // loop may discard already-overwritten records, but only the queue head can
    // ever fade live cells.
    while (footprintQueue.length > maxFootprints) {
      const oldest = footprintQueue[0];
      const kf = Math.exp(-dt / Math.max(0.01, footprintFadeTau));
      let live = 0;
      for (const i of oldest.cells) {
        if (footprintId[i] !== oldest.id) continue;
        depth[i] *= kf;
        wetness[i] *= kf;
        tread[i] *= kf;
        if (depth[i] < EPSILON && wetness[i] < EPSILON && tread[i] < EPSILON) {
          clearCell(i);
        } else {
          live += 1;
        }
      }
      if (live > 0) break;
      footprintQueue.shift();
    }
  }

  function clearCell(i) {
    depth[i] = 0;
    wetness[i] = 0;
    tread[i] = 0;
    stampKind[i] = 0;
    footprintId[i] = 0;
    ownerX[i] = NaN;
    ownerZ[i] = NaN;
    active.delete(i);
    pendingClear.add(i);
  }

  // Pre-worn seed points (world XZ + heading). Installed once from road profiles;
  // refreshPreWorn seeds empty cells as the field scrolls so the whole stage can
  // show prior-lap tracks despite the torus footprint. A Set tracks which world
  // cells already received a pre-worn stamp this visit so marks can slowly fade
  // instead of instantly re-seeding every frame.
  let prewornPoints = null;
  const prewornSeeded = new Set();

  function installPreWornPoints(points) {
    prewornPoints = Array.isArray(points) && points.length > 0 ? points : null;
    prewornSeeded.clear();
  }

  function prewornCellKey(x, z) {
    const wx = Math.round(x * invCell - 0.5);
    const wz = Math.round(z * invCell - 0.5);
    return `${wx},${wz}`;
  }

  /**
   * Seed pre-worn dual-wheel tracks inside the active footprint. Only stamps
   * virgin cells (and only once per visit) so slow-fade preworn marks aren't
   * refreshed every frame, and live vehicle ruts are never overwritten.
   */
  function refreshPreWorn(centerX, centerZ) {
    if (!prewornPoints) return 0;
    const half = footprint * 0.47;
    const halfSq = half * half;
    const pruneR = half * 1.2;
    const pruneRSq = pruneR * pruneR;
    // Drop keys that scrolled out so re-entering a fully-faded stretch re-seeds.
    if (prewornSeeded.size > 0) {
      for (const key of prewornSeeded) {
        const comma = key.indexOf(',');
        const wx = Number(key.slice(0, comma));
        const wz = Number(key.slice(comma + 1));
        const px = (wx + 0.5) * cellSize;
        const pz = (wz + 0.5) * cellSize;
        const ddx = px - centerX;
        const ddz = pz - centerZ;
        if (ddx * ddx + ddz * ddz > pruneRSq) prewornSeeded.delete(key);
      }
    }
    let stamped = 0;
    for (let i = 0; i < prewornPoints.length; i += 1) {
      const p = prewornPoints[i];
      const dx = p.x - centerX;
      const dz = p.z - centerZ;
      if (dx * dx + dz * dz > halfSq) continue;
      const key = prewornCellKey(p.x, p.z);
      if (prewornSeeded.has(key)) continue;
      const s = sampleAt(p.x, p.z);
      // Only seed virgin cells — don't fight live vehicle ruts or in-progress fade.
      if (s.depth > 0.008 || s.tread > 0.06) {
        prewornSeeded.add(key); // occupied; don't try again until pruned
        continue;
      }
      stampBrush(p.x, p.z, p.radius ?? 0.2, {
        depth: p.depth ?? 0.04,
        wetness: p.wetness ?? 0.55,
        tread: p.tread ?? 0.85,
        directionX: p.directionX ?? 0,
        directionZ: p.directionZ ?? -1,
        kind: 'preworn',
      });
      prewornSeeded.add(key);
      stamped += 1;
    }
    return stamped;
  }

  return {
    cellSize,
    resolution: R,
    maxDepth,
    footprint,
    deformTilesPerMetre,
    centerUniform,
    setCenter,
    stamp,
    stampBrush,
    stampFootprint,
    stampDogPaw,
    sampleAt,
    sampleDepthAt,
    decay,
    ensureTexture,
    syncTexture,
    disposeTexture,
    installPreWornPoints,
    refreshPreWorn,
    get hasPreWorn() { return Boolean(prewornPoints?.length); },
    get prewornCount() { return prewornPoints?.length ?? 0; },
    get texture() { return texture; },
    get orientationTexture() { return orientationTexture; },
    // Introspection for verify scripts / texture upload (M2).
    get activeCount() { return active.size; },
    get dogPawStampCount() { return dogPawStampCount; },
    _buffers: {
      depth, wetness, tread, directionX, directionZ, lateralPhase, stampKind, footprintId,
      ownerX, ownerZ, resolution: R,
    },
  };

  // ---- locals (hoisted scratch for sampleAt) --------------------------------
  function bilerp(v00, v10, v01, v11, fx, fz) {
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fz;
  }


  function ellipseFalloff(along, across, alongRadius, acrossRadius) {
    const q = Math.hypot(along / alongRadius, across / acrossRadius);
    return q >= 1 ? 0 : 1 - q * q;
  }
}

function clamp255(v) {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

function fract01(value) {
  return ((value % 1) + 1) % 1;
}

function createFieldTexture(data, resolution) {
  const texture = new THREE.DataTexture(
    data,
    resolution,
    resolution,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // Explicit linear data — never sRGB-decode depth/wetness/tread channels.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

// sampleAt neighbour scratch — module-scoped so no per-call allocation.
const _c00 = { depth: 0, wetness: 0, tread: 0 };
const _c10 = { depth: 0, wetness: 0, tread: 0 };
const _c01 = { depth: 0, wetness: 0, tread: 0 };
const _c11 = { depth: 0, wetness: 0, tread: 0 };
