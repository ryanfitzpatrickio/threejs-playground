/**
 * Pure-logic aquarium breach / drain model (no THREE).
 *
 * - Per-hole Torricelli leaks: Q = Cd · A · √(2g · h)
 * - Per-face structural integrity: enough hits on one side shatters that pane
 * - Shattered face dumps remaining water (catastrophic orifice) and exposes
 *   a waterfall emitter for FX
 */

export const MAX_HOLES_PER_TANK = 12;
export const DEFAULT_HOLE_AREA = 0.12;
export const DISCHARGE_COEFF = 0.7;
export const GRAVITY = 9.81;
/** Outward speed scale for jet FX: k · √(2gh). */
export const JET_SPEED_SCALE = 0.55;
/** Face normals with |ny| above this are top/bottom — not side leaks. */
export const TOP_FACE_NY = 0.65;
/** Hits on one pane before it collapses (side only). */
export const FACE_HITS_TO_SHATTER = 10;
/** Effective orifice area once a full pane collapses (m², gameplay-tuned). */
export const SHATTER_ORIFICE_AREA = 2.4;
/** Waterfall visual speed scale after shatter. */
export const WATERFALL_SPEED_SCALE = 0.85;

export const FACE_IDS = ['+x', '-x', '+z', '-z'];

/**
 * @typedef {{
 *   id: string,
 *   cx: number,
 *   cz: number,
 *   halfSize: number,
 *   waterBottomY: number,
 *   waterTopY: number,
 *   waterH: number,
 *   innerArea: number,
 * }} TankSpec
 *
 * @typedef {{
 *   x: number, y: number, z: number,
 *   nx: number, ny: number, nz: number,
 *   holeArea: number,
 *   isLeak: boolean,
 *   face: string | null,
 * }} Hole
 */

/**
 * Classify a side face from an outward normal (XZ).
 * @returns {'+x'|'-x'|'+z'|'-z'|null}
 */
export function classifyFace(nx, ny, nz) {
  if (Math.abs(ny) > TOP_FACE_NY) return null;
  const ax = Math.abs(nx);
  const az = Math.abs(nz);
  if (ax < 0.35 && az < 0.35) return null;
  if (ax >= az) return nx >= 0 ? '+x' : '-x';
  return nz >= 0 ? '+z' : '-z';
}

export function faceNormal(faceId) {
  switch (faceId) {
    case '+x': return { x: 1, y: 0, z: 0 };
    case '-x': return { x: -1, y: 0, z: 0 };
    case '+z': return { x: 0, y: 0, z: 1 };
    case '-z': return { x: 0, y: 0, z: -1 };
    default: return { x: 1, y: 0, z: 0 };
  }
}

function emptyFaceState() {
  /** @type {Record<string, { hits: number, shattered: boolean }>} */
  const faces = {};
  for (const id of FACE_IDS) faces[id] = { hits: 0, shattered: false };
  return faces;
}

/**
 * @param {{ tanks: TankSpec[], faceHitsToShatter?: number }} options
 */
export function createBreachModel({ tanks, faceHitsToShatter = FACE_HITS_TO_SHATTER } = {}) {
  const hitsToShatter = Math.max(3, faceHitsToShatter | 0);
  /** @type {Map<string, {
   *   spec: TankSpec,
   *   waterLevel: number,
   *   holes: Hole[],
   *   faces: Record<string, { hits: number, shattered: boolean }>,
   *   shatteredFace: string | null,
   * }>} */
  const byId = new Map();
  /** @type {Array<{ tankId: string, face: string }>} */
  const shatterEvents = [];

  for (const spec of tanks ?? []) {
    if (!spec?.id) continue;
    const waterBottomY = Number(spec.waterBottomY) || 0;
    const waterTopY = Number(spec.waterTopY) || waterBottomY;
    const waterH = Math.max(0.01, waterTopY - waterBottomY);
    const innerArea = Math.max(0.01, Number(spec.innerArea) || 1);
    byId.set(spec.id, {
      spec: {
        id: spec.id,
        cx: Number(spec.cx) || 0,
        cz: Number(spec.cz) || 0,
        halfSize: Math.max(0.1, Number(spec.halfSize) || 1),
        waterBottomY,
        waterTopY,
        waterH,
        innerArea,
      },
      waterLevel: waterTopY,
      holes: [],
      faces: emptyFaceState(),
      shatteredFace: null,
    });
  }

  function getTank(tankId) {
    return byId.get(tankId) ?? null;
  }

  function resolveTankAt(point) {
    if (!point) return null;
    const px = Number(point.x);
    const pz = Number(point.z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
    for (const entry of byId.values()) {
      const { cx, cz, halfSize, waterBottomY, waterTopY } = entry.spec;
      const py = Number(point.y);
      if (Number.isFinite(py) && (py < waterBottomY - 0.4 || py > waterTopY + 0.5)) {
        continue;
      }
      if (Math.abs(px - cx) <= halfSize + 0.05 && Math.abs(pz - cz) <= halfSize + 0.05) {
        return entry.spec;
      }
    }
    return null;
  }

  /**
   * @param {string} tankId
   * @param {{ point: { x: number, y: number, z: number }, normal?: { x?: number, y?: number, z?: number }, holeArea?: number }} hit
   */
  function addHole(tankId, hit) {
    const entry = getTank(tankId);
    if (!entry || !hit?.point) {
      return {
        hole: null, tankId: null, accepted: false, isLeak: false, coalesced: false,
        face: null, shattered: false, faceHits: 0,
      };
    }
    const x = Number(hit.point.x);
    const y = Number(hit.point.y);
    const z = Number(hit.point.z);
    if (![x, y, z].every(Number.isFinite)) {
      return {
        hole: null, tankId: null, accepted: false, isLeak: false, coalesced: false,
        face: null, shattered: false, faceHits: 0,
      };
    }

    let nx = Number(hit.normal?.x) || 0;
    let ny = Number(hit.normal?.y) || 0;
    let nz = Number(hit.normal?.z) || 0;
    let nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-6) {
      nx = x - entry.spec.cx;
      ny = 0;
      nz = z - entry.spec.cz;
      nLen = Math.hypot(nx, nz) || 1;
    }
    let fnx = nx / nLen;
    let fny = ny / nLen;
    let fnz = nz / nLen;
    if (Math.abs(fny) <= TOP_FACE_NY) {
      const ox = x - entry.spec.cx;
      const oz = z - entry.spec.cz;
      if (fnx * ox + fnz * oz < 0) {
        fnx = -fnx;
        fnz = -fnz;
      }
    }

    const isTopFace = fny > TOP_FACE_NY;
    const aboveWater = y >= entry.spec.waterTopY - 1e-4;
    const face = classifyFace(fnx, fny, fnz);
    // Hits on an already-shattered face still accept (decals) but don't re-shatter.
    const faceAlreadyShattered = Boolean(face && entry.faces[face]?.shattered);
    const isLeak = !isTopFace && !aboveWater && !faceAlreadyShattered;

    const holeArea = Math.max(1e-4, Number(hit.holeArea) || DEFAULT_HOLE_AREA);
    let coalesced = false;
    if (entry.holes.length >= MAX_HOLES_PER_TANK) {
      const oldest = entry.holes.shift();
      coalesced = true;
      if (oldest && isLeak) {
        const absorb = oldest.isLeak ? oldest.holeArea : 0;
        const hole = {
          x, y, z, nx: fnx, ny: fny, nz: fnz,
          holeArea: holeArea + absorb, isLeak, face,
        };
        entry.holes.push(hole);
        const shatter = registerFaceHit(entry, face, tankId, { x, y, z }, { x: fnx, y: fny, z: fnz });
        return {
          hole, tankId, accepted: true, isLeak, coalesced,
          face, shattered: shatter, faceHits: face ? entry.faces[face].hits : 0,
          impactPoint: shatter ? { x, y, z } : null,
        };
      }
    }

    const hole = {
      x, y, z, nx: fnx, ny: fny, nz: fnz,
      holeArea, isLeak, face,
    };
    entry.holes.push(hole);

    // Structural hits: any side hit counts (even above waterline) for pane integrity.
    let shattered = false;
    if (face && !isTopFace) {
      shattered = registerFaceHit(entry, face, tankId, { x, y, z }, { x: fnx, y: fny, z: fnz });
    }

    return {
      hole, tankId, accepted: true, isLeak, coalesced,
      face, shattered, faceHits: face ? entry.faces[face].hits : 0,
      impactPoint: shattered ? { x, y, z } : null,
    };
  }

  function registerFaceHit(entry, face, tankId, hitPoint = null, hitNormal = null) {
    if (!face || !entry.faces[face]) return false;
    if (entry.faces[face].shattered) return false;
    entry.faces[face].hits += 1;
    if (hitPoint) {
      entry._lastHitPoint = {
        x: Number(hitPoint.x),
        y: Number(hitPoint.y),
        z: Number(hitPoint.z),
      };
    }
    if (hitNormal) {
      entry._lastHitNormal = {
        x: Number(hitNormal.x) || 0,
        y: Number(hitNormal.y) || 0,
        z: Number(hitNormal.z) || 0,
      };
    }
    if (entry.faces[face].hits < hitsToShatter) return false;
    // Only one structural collapse per tank (first pane that fails).
    if (entry.shatteredFace) return false;
    entry.faces[face].shattered = true;
    entry.shatteredFace = face;
    // Impact point is filled by caller via optional lastHit on entry.
    shatterEvents.push({
      tankId,
      face,
      point: entry._lastHitPoint ? { ...entry._lastHitPoint } : null,
      normal: entry._lastHitNormal ? { ...entry._lastHitNormal } : null,
    });
    return true;
  }

  /**
   * Force-shatter a face (debug / tests).
   * @param {string} tankId
   * @param {string} face
   * @param {{ point?: {x:number,y:number,z:number}, normal?: {x:number,y:number,z:number} }} [impact]
   */
  function shatterFace(tankId, face, impact = null) {
    const entry = getTank(tankId);
    if (!entry || !FACE_IDS.includes(face)) return false;
    if (entry.shatteredFace) return false;
    entry.faces[face].shattered = true;
    entry.faces[face].hits = Math.max(entry.faces[face].hits, hitsToShatter);
    entry.shatteredFace = face;
    if (impact?.point) {
      entry._lastHitPoint = {
        x: Number(impact.point.x),
        y: Number(impact.point.y),
        z: Number(impact.point.z),
      };
    }
    if (impact?.normal) {
      entry._lastHitNormal = {
        x: Number(impact.normal.x) || 0,
        y: Number(impact.normal.y) || 0,
        z: Number(impact.normal.z) || 0,
      };
    }
    shatterEvents.push({
      tankId,
      face,
      point: entry._lastHitPoint ? { ...entry._lastHitPoint } : null,
      normal: entry._lastHitNormal ? { ...entry._lastHitNormal } : null,
    });
    return true;
  }

  function drainShatterEvents() {
    if (!shatterEvents.length) return [];
    const out = shatterEvents.splice(0, shatterEvents.length);
    return out;
  }

  function jetSpeedForHole(hole, waterLevel) {
    if (!hole?.isLeak) return 0;
    const head = waterLevel - hole.y;
    if (head <= 1e-4) return 0;
    return JET_SPEED_SCALE * Math.sqrt(2 * GRAVITY * head);
  }

  function step(dt) {
    const dtClamped = Math.max(0, Math.min(0.1, Number(dt) || 0));
    if (dtClamped <= 0) return;

    for (const entry of byId.values()) {
      const { waterBottomY, waterTopY, innerArea } = entry.spec;
      let level = entry.waterLevel;
      if (level <= waterBottomY + 1e-5) {
        entry.waterLevel = waterBottomY;
        continue;
      }

      let sumQ = 0;
      let lowestLeakY = Infinity;

      // Bullet holes (skipped once that face is open — waterfall handles dump).
      if (!entry.shatteredFace) {
        for (const hole of entry.holes) {
          if (!hole.isLeak) continue;
          if (hole.y < lowestLeakY) lowestLeakY = hole.y;
          const head = level - hole.y;
          if (head <= 1e-5) continue;
          const speed = Math.sqrt(2 * GRAVITY * head);
          sumQ += DISCHARGE_COEFF * hole.holeArea * speed;
        }
      }

      // Full-pane collapse: huge orifice from water surface down to substrate.
      if (entry.shatteredFace) {
        const head = level - waterBottomY;
        if (head > 1e-4) {
          const speed = Math.sqrt(2 * GRAVITY * head);
          sumQ += DISCHARGE_COEFF * SHATTER_ORIFICE_AREA * speed;
          lowestLeakY = waterBottomY;
        }
      }

      if (sumQ <= 0) continue;

      const drainFloor = entry.shatteredFace
        ? waterBottomY
        : (Number.isFinite(lowestLeakY) ? Math.max(waterBottomY, lowestLeakY) : waterBottomY);

      level -= (sumQ / innerArea) * dtClamped;
      if (level < drainFloor) level = drainFloor;
      if (level > waterTopY) level = waterTopY;
      entry.waterLevel = level;
    }
  }

  function getWaterLevel(tankId) {
    const entry = getTank(tankId);
    return entry ? entry.waterLevel : null;
  }

  function getFill01(tankId) {
    const entry = getTank(tankId);
    if (!entry) return 0;
    const { waterBottomY, waterH } = entry.spec;
    return Math.max(0, Math.min(1, (entry.waterLevel - waterBottomY) / waterH));
  }

  function getHoles(tankId) {
    const entry = getTank(tankId);
    return entry ? entry.holes.slice() : [];
  }

  function getFaceState(tankId) {
    const entry = getTank(tankId);
    if (!entry) return null;
    return {
      shatteredFace: entry.shatteredFace,
      faces: Object.fromEntries(
        FACE_IDS.map((id) => [id, { ...entry.faces[id] }]),
      ),
    };
  }

  function getActiveJets() {
    const out = [];
    for (const [tankId, entry] of byId) {
      const level = entry.waterLevel;
      // Once shattered, individual bullet jets stop — waterfall takes over.
      if (entry.shatteredFace) continue;
      for (const hole of entry.holes) {
        const speed = jetSpeedForHole(hole, level);
        if (speed > 1e-3) {
          out.push({ tankId, hole, jetSpeed: speed, waterLevel: level });
        }
      }
    }
    return out;
  }

  /**
   * Wide dump emitters for shattered faces (still have water above bottom).
   * @returns {Array<{
   *   tankId: string,
   *   face: string,
   *   nx: number, nz: number,
   *   cx: number, cz: number,
   *   halfSize: number,
   *   waterLevel: number,
   *   waterBottomY: number,
   *   waterTopY: number,
   *   jetSpeed: number,
   *   fill01: number,
   * }>}
   */
  function getActiveWaterfalls() {
    const out = [];
    for (const [tankId, entry] of byId) {
      const face = entry.shatteredFace;
      if (!face) continue;
      const level = entry.waterLevel;
      const { waterBottomY, waterTopY, waterH, cx, cz, halfSize } = entry.spec;
      const head = level - waterBottomY;
      if (head <= 0.05) continue;
      const n = faceNormal(face);
      const jetSpeed = WATERFALL_SPEED_SCALE * Math.sqrt(2 * GRAVITY * head);
      out.push({
        tankId,
        face,
        nx: n.x,
        nz: n.z,
        cx,
        cz,
        halfSize,
        waterLevel: level,
        waterBottomY,
        waterTopY,
        jetSpeed,
        fill01: Math.max(0, Math.min(1, head / waterH)),
      });
    }
    return out;
  }

  function snapshot() {
    const tanks = [];
    let totalHoles = 0;
    let totalLeaks = 0;
    let activeJets = 0;
    let shatteredFaces = 0;
    for (const [id, entry] of byId) {
      const holes = entry.holes.length;
      const leaks = entry.holes.filter((h) => h.isLeak).length;
      const jets = entry.shatteredFace
        ? 0
        : entry.holes.filter((h) => jetSpeedForHole(h, entry.waterLevel) > 1e-3).length;
      totalHoles += holes;
      totalLeaks += leaks;
      activeJets += jets;
      if (entry.shatteredFace) shatteredFaces += 1;
      tanks.push({
        id,
        waterLevel: entry.waterLevel,
        fill01: getFill01(id),
        waterBottomY: entry.spec.waterBottomY,
        waterTopY: entry.spec.waterTopY,
        holeCount: holes,
        leakCount: leaks,
        activeJetCount: jets,
        shatteredFace: entry.shatteredFace,
        faces: Object.fromEntries(
          FACE_IDS.map((fid) => [fid, { hits: entry.faces[fid].hits, shattered: entry.faces[fid].shattered }]),
        ),
      });
    }
    return {
      tankCount: byId.size,
      totalHoles,
      totalLeaks,
      activeJets,
      shatteredFaces,
      activeWaterfalls: getActiveWaterfalls().length,
      hitsToShatter,
      tanks,
    };
  }

  return {
    addHole,
    step,
    resolveTankAt,
    getWaterLevel,
    getFill01,
    getHoles,
    getFaceState,
    getActiveJets,
    getActiveWaterfalls,
    shatterFace,
    drainShatterEvents,
    jetSpeedForHole,
    classifyFace,
    snapshot,
    hitsToShatter,
    /** @internal test helper */
    _tanks: byId,
  };
}
