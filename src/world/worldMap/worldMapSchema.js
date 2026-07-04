/**
 * worldMapSchema.js
 *
 * Single source of truth for the top-down "world map" format produced by the 2D
 * World-Map Editor (src/map/WorldMapEditor.js) and — in a later milestone —
 * consumed by the composed streaming runtime (terrain everywhere, the infinite
 * city generator inside a `city` zone, infinite procedural continuation past
 * `loopout` edges).
 *
 * Keep editor + runtime in lockstep by importing constants/normalize from here.
 *
 * Shape (v1, chunk-aligned rectangles; polygons are a later add):
 *   {
 *     version, name, chunkSize,
 *     bounds: { minX, minZ, maxX, maxZ },
 *     spawn:  { x, z, yaw },
 *     zones:  [ { id, type, shape:'rect', rect:{minX,minZ,maxX,maxZ}, props:{} } ],
 *     districts: [ { id, name, shape:'rect'|'polygon'|'circle'|'triangle', rect?, points?, center?, radius?, props:{} } ],
 *     pois:   [ { id, name, kind, x, z } ],
 *     entities: [ { id, name, blueprintId, x, z, yaw, scale, groundMode } ],
 *     createdAt
 *   }
 */

import { zoneContains } from './zoneGeometry.js';
import { normalizeRoadSurface } from './roadSurface.js';

export const WORLD_MAP_VERSION = 1;
export const WORLDMAP_STORAGE_KEY = 'dreamfall:worldmap:autosave';

// chunkSize matches createStreamingTerrainLevel so editor coords map 1:1 to
// runtime chunk coords later.
export const DEFAULT_CHUNK_SIZE = 32;

export const ZONE_TYPES = {
  terrain: { label: 'Terrain', color: '#6d845f' },
  city: { label: 'City', color: '#5a6470' },
  loopout: { label: 'Loop-out', color: '#7a5a8a' },
  wilds: { label: 'Wilds', color: '#2f5a36' },
};

export const ZONE_TYPE_ORDER = ['terrain', 'city', 'loopout', 'wilds'];

export const CITY_STYLES = {
  downtown: { label: 'Downtown' },
  suburbs: { label: 'Suburbs' },
  commercial: { label: 'Commercial' },
};

export const CITY_STYLE_ORDER = ['downtown', 'suburbs', 'commercial'];

// Named height presets for `terrain` zones (zone.props.biome). `amplitude` is the
// approximate peak height in metres the procedural surface reaches in that zone;
// taller zones rise into the terrain material's rock/snow bands. Absence of a
// biome → the level's gentle base amplitude. `wilds` zones use the `alpine` preset.
export const TERRAIN_BIOMES = {
  plains: { label: 'Plains', amplitude: 2 },
  hills: { label: 'Hills', amplitude: 11 },
  mountains: { label: 'Mountains', amplitude: 46 },
  alpine: { label: 'Alpine', amplitude: 62 },
};

export const TERRAIN_BIOME_ORDER = ['plains', 'hills', 'mountains', 'alpine'];

export const POI_KINDS = {
  spawn: { label: 'Spawn', color: '#e8c34a' },
  landmark: { label: 'Landmark', color: '#4ab0e8' },
  city_gate: { label: 'City Gate', color: '#e87a4a' },
};

export const POI_KIND_ORDER = ['spawn', 'landmark', 'city_gate'];

// How an `entity` (a placed blueprint instance) brings its ground into the world.
//   none     — drop the blueprint's terrain; rest its objects on existing ground.
//   merge    — stamp the blueprint's sculpted terrain in and feather the edges.
//   platform — a flat priority ground that wins under the footprint (no stamp).
// `color` drives the 2D editor marker + the in-world overlay.
export const ENTITY_GROUND_MODES = {
  none: { label: 'None', color: '#9aa0a6', desc: 'Place objects on existing world ground; drop blueprint terrain.' },
  merge: { label: 'Merge', color: '#7bd389', desc: 'Stamp blueprint terrain into the world and feather the edges into it.' },
  platform: { label: 'Platform', color: '#6fb3e8', desc: 'Flat priority ground that wins under the footprint; no heightfield stamp.' },
};

export const ENTITY_GROUND_MODE_ORDER = ['none', 'merge', 'platform'];

export const DEFAULT_ROAD_WIDTH = 8;

// Districts are named areas for LLM guidance + in-game name popups (GTA style)
export const DISTRICT_SHAPES = ['rect', 'polygon', 'circle', 'triangle'];

// Rivers carve terrain DOWN into a channel (inverse of a road). `width` is the
// surface span; `depth` is how far the channel bed drops below the natural surface.
export const DEFAULT_RIVER_WIDTH = 10;
export const DEFAULT_RIVER_DEPTH = 6;

export function createEmptyWorldMap() {
  return {
    version: WORLD_MAP_VERSION,
    name: 'Untitled World',
    chunkSize: DEFAULT_CHUNK_SIZE,
    bounds: { minX: -512, minZ: -512, maxX: 512, maxZ: 512 },
    spawn: { x: 0, z: 0, yaw: 0 },
    zones: [],
    districts: [],
    roads: [],
    rivers: [],
    pois: [],
    entities: [],
    createdAt: Date.now(),
  };
}

export const DEFAULT_WORLD_MAP = Object.freeze(createEmptyWorldMap());

let idCounter = 0;
export function makeId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let minX = num(raw.minX, NaN);
  let minZ = num(raw.minZ, NaN);
  let maxX = num(raw.maxX, NaN);
  let maxZ = num(raw.maxZ, NaN);
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite)) return null;
  if (maxX < minX) [minX, maxX] = [maxX, minX];
  if (maxZ < minZ) [minZ, maxZ] = [maxZ, minZ];
  // Reject degenerate (zero-area) rects.
  if (maxX - minX < 1e-3 || maxZ - minZ < 1e-3) return null;
  return { minX, minZ, maxX, maxZ };
}

function normalizePoints(raw) {
  if (!Array.isArray(raw)) return null;
  const points = [];
  for (const p of raw) {
    const x = num(p?.x, NaN);
    const z = num(p?.z, NaN);
    if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
  }
  return points.length >= 3 ? points : null;
}

export function normalizeZone(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = ZONE_TYPES[raw.type] ? raw.type : 'terrain';
  const id = typeof raw.id === 'string' && raw.id ? raw.id : makeId('z');
  const props = raw.props && typeof raw.props === 'object' ? { ...raw.props } : {};
  if (type === 'city') {
    props.cityStyle = CITY_STYLES[props.cityStyle] ? props.cityStyle : 'downtown';
    props.seed = Number.isFinite(Number(props.seed)) ? Number(props.seed) : 1;
  }

  if (raw.shape === 'polygon') {
    const points = normalizePoints(raw.points);
    if (!points) return null;
    return { id, type, shape: 'polygon', points, props };
  }

  const rect = normalizeRect(raw.rect);
  if (!rect) return null;
  return { id, type, shape: 'rect', rect, props };
}

export function normalizePoi(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = num(raw.x, NaN);
  const z = num(raw.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const kind = POI_KINDS[raw.kind] ? raw.kind : 'landmark';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('p'),
    name: typeof raw.name === 'string' && raw.name ? raw.name : POI_KINDS[kind].label,
    kind,
    x,
    z,
  };
}

// A placed blueprint instance. `blueprintId` references a saved Map Builder
// project in the blueprint library (src/map/blueprintLibrary.js). `knownBlueprintIds`
// (a Set) is optional: when supplied (editor load/runtime), entities whose
// blueprint was deleted are pruned here, matching how normalizeZone drops a bad
// rect. Omit it (1-arg form) for faithful history round-trips (undo/redo/autosave).
export function normalizeEntity(raw, knownBlueprintIds = null) {
  if (!raw || typeof raw !== 'object') return null;
  const x = num(raw.x, NaN);
  const z = num(raw.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const blueprintId = typeof raw.blueprintId === 'string' && raw.blueprintId ? raw.blueprintId : null;
  if (!blueprintId) return null;
  if (knownBlueprintIds && !knownBlueprintIds.has(blueprintId)) return null;
  const groundMode = ENTITY_GROUND_MODES[raw.groundMode] ? raw.groundMode : 'none';
  const yaw = num(raw.yaw, 0);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('e'),
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Entity',
    blueprintId,
    x,
    z,
    yaw: ((yaw % 360) + 360) % 360,
    scale: Math.max(0.01, num(raw.scale, 1)),
    groundMode,
  };
}

export function normalizeDistrict(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : makeId('d');
  const name = (typeof raw.name === 'string' && raw.name ? raw.name : 'District').trim() || 'District';
  let shape = DISTRICT_SHAPES.includes(raw.shape) ? raw.shape : 'rect';
  const color = typeof raw.color === 'string' && raw.color ? raw.color : '#4fc3f7';
  const props = raw.props && typeof raw.props === 'object' ? { ...raw.props } : {};

  if (shape === 'circle') {
    const c = raw.center || {};
    const cx = num(c.x, 0);
    const cz = num(c.z, 0);
    const radius = Math.max(1, num(raw.radius, 32));
    return { id, name, shape: 'circle', center: { x: cx, z: cz }, radius, color, props };
  }

  if (shape === 'polygon' || shape === 'triangle') {
    const pts = [];
    for (const p of Array.isArray(raw.points) ? raw.points : []) {
      const px = num(p?.x, NaN);
      const pz = num(p?.z, NaN);
      if (Number.isFinite(px) && Number.isFinite(pz)) pts.push({ x: px, z: pz });
    }
    if (pts.length < 3) return null;
    const finalPts = shape === 'triangle' ? pts.slice(0, 3) : pts;
    return { id, name, shape, points: finalPts, color, props };
  }

  // rect default
  const rect = normalizeRect(raw.rect);
  if (!rect) return null;
  return { id, name, shape: 'rect', rect, color, props };
}

export function districtContains(d, x, z) {
  if (!d) return false;
  if (d.shape === 'circle') {
    const c = d.center;
    const dx = x - c.x;
    const dz = z - c.z;
    return (dx * dx + dz * dz) <= (d.radius * d.radius + 1e-6);
  }
  if (d.shape === 'polygon' || d.shape === 'triangle') {
    // reuse point in poly logic (simple raycast)
    const pts = d.points || [];
    let inside = false;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const xi = pts[i].x, zi = pts[i].z;
      const xj = pts[j].x, zj = pts[j].z;
      const intersects = (zi > z) !== (zj > z) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }
  const r = d.rect;
  if (!r) return false;
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

export function districtAtPoint(map, x, z) {
  const ds = map?.districts ?? [];
  for (let i = ds.length - 1; i >= 0; i -= 1) {
    if (districtContains(ds[i], x, z)) return ds[i];
  }
  return null;
}

// Exported so the 3D Map Builder can validate blueprint-project roads with the
// exact same rules as world-map roads (≥2 finite points, width clamp, type, id).
export function normalizeRoad(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const points = [];
  for (const p of Array.isArray(raw.points) ? raw.points : []) {
    const x = num(p?.x, NaN);
    const z = num(p?.z, NaN);
    if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
  }
  if (points.length < 2) return null;
  const elevationInput = raw.elevation;
  const elevation = (typeof elevationInput === 'number'
    || (typeof elevationInput === 'string' && elevationInput.trim() !== ''))
    ? num(elevationInput, NaN)
    : NaN;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('r'),
    points,
    width: Math.max(2, num(raw.width, DEFAULT_ROAD_WIDTH)),
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'road',
    // Optional GT3-style trackside cross-section preset (curb/shoulder/wall/…).
    // null/absent → a plain road. See trackCrossSection.js for valid names.
    trackStyle: typeof raw.trackStyle === 'string' && raw.trackStyle ? raw.trackStyle : null,
    // Optional material override. null follows the track-style default.
    surface: normalizeRoadSurface(raw.surface),
    // null/absent follows terrain; a finite value pins the entire road to that
    // world-space height.
    elevation: Number.isFinite(elevation) ? elevation : null,
  };
}

// A river polyline: same point rules as a road, plus a `depth` (how far the
// channel bed drops below the natural surface). `width` is the surface span.
// Exported so the 3D Map Builder validates blueprint-project rivers identically.
export function normalizeRiver(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const points = [];
  for (const p of Array.isArray(raw.points) ? raw.points : []) {
    const x = num(p?.x, NaN);
    const z = num(p?.z, NaN);
    if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
  }
  if (points.length < 2) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('rv'),
    points,
    width: Math.max(2, num(raw.width, DEFAULT_RIVER_WIDTH)),
    depth: Math.max(1, num(raw.depth, DEFAULT_RIVER_DEPTH)),
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'river',
    // Treat the river as a coastline: the flagged side never fades back to
    // natural terrain (infinite ocean) instead of the normal symmetric channel.
    oceanLeft: raw.oceanLeft === true,
    oceanRight: raw.oceanRight === true,
  };
}

/**
 * Validate/coerce arbitrary JSON into a well-formed world map, filling defaults
 * and dropping malformed entries. Always returns a usable map.
 *
 * `knownBlueprintIds` (optional Set): when supplied, entities referencing a
 * blueprint id not in the set are pruned. Omit for faithful history round-trips.
 */
export function normalizeWorldMap(json, knownBlueprintIds = null) {
  const base = createEmptyWorldMap();
  if (!json || typeof json !== 'object') {
    return base;
  }

  const bounds = normalizeRect(json.bounds) ?? base.bounds;
  const chunkSize = Math.max(1, num(json.chunkSize, base.chunkSize));

  const spawn = {
    x: num(json.spawn?.x, 0),
    z: num(json.spawn?.z, 0),
    yaw: num(json.spawn?.yaw, 0),
  };

  const zones = Array.isArray(json.zones)
    ? json.zones.map(normalizeZone).filter(Boolean)
    : [];
  const roads = Array.isArray(json.roads)
    ? json.roads.map(normalizeRoad).filter(Boolean)
    : [];
  const rivers = Array.isArray(json.rivers)
    ? json.rivers.map(normalizeRiver).filter(Boolean)
    : [];
  const pois = Array.isArray(json.pois)
    ? json.pois.map(normalizePoi).filter(Boolean)
    : [];
  const entities = Array.isArray(json.entities)
    ? json.entities.map((e) => normalizeEntity(e, knownBlueprintIds)).filter(Boolean)
    : [];

  const districts = Array.isArray(json.districts)
    ? json.districts.map(normalizeDistrict).filter(Boolean)
    : [];

  return {
    version: WORLD_MAP_VERSION,
    name: typeof json.name === 'string' && json.name ? json.name : base.name,
    chunkSize,
    bounds,
    spawn,
    zones,
    districts,
    roads,
    rivers,
    pois,
    entities,
    createdAt: num(json.createdAt, base.createdAt),
  };
}

/** Which zone (topmost / last drawn) contains a world point, or null. */
export function zoneAtPoint(map, x, z) {
  const zones = map?.zones ?? [];
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    if (zoneContains(zones[i], x, z)) return zones[i];
  }
  return null;
}
