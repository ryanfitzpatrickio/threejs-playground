// officeCarpetMaterials.js — PBR carpet tiles for office floor zones.
// Atlases are 2×2 (albedo / normal / roughness / height); sliced to
// public/assets/textures/office/carpet-{white,grey,office}/.
//
// Clones of the master textures are created for per-use repeat scaling. To avoid
// a race (clone forces version=1 while image still null) that hits
// three.webgpu Textures.updateTexture -> image.complete, we temporarily force
// version=0 (lets it use default texture) and register for a post-load bump.

import * as THREE from 'three';

const ROOT = '/assets/textures/office';
/** One albedo quadrant = 2×2 carpet tiles at ~0.5 m each → 1 m repeat. */
export const OFFICE_CARPET_MODULE_M = 1.0;

const mapCache = new Map();
const materialCache = new Map();

// Master -> set of clones that were created while the image was still loading.
// On load we bump .needsUpdate on them so their version changes and the now-ready
// image (shared via source) gets uploaded. Prevents "null.complete" crash in
// three's Textures.updateTexture (version>0 path assumes image present).
const _carpetPendingClones = new Map(); // Texture -> Set<Texture>

function configureMap(tex, { colorSpace = THREE.NoColorSpace, repeatU = 1, repeatV = 1 } = {}) {
  if (!tex) return tex;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatU, repeatV);
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function loadOfficeCarpetMaps(variant = 'grey') {
  if (variant === 'dark') variant = 'grey';
  if (variant === 'light') variant = 'white';
  const key = variant;
  if (mapCache.has(key)) return mapCache.get(key);
  if (typeof document === 'undefined') {
    const empty = { map: null, normalMap: null, roughnessMap: null, heightMap: null };
    mapCache.set(key, empty);
    return empty;
  }

  const loader = new THREE.TextureLoader();
  const base = `${ROOT}/carpet-${variant}`;

  const makeTex = (file, colorSpace = THREE.NoColorSpace) => {
    const url = `${base}/${file}`;
    const raw = loader.load(
      url,
      (tex) => {
        // onload (after image set). Bump any pending clones sharing this source.
        const clones = _carpetPendingClones.get(tex);
        if (clones) {
          clones.forEach((c) => { if (c) c.needsUpdate = true; });
          _carpetPendingClones.delete(tex);
        }
      },
      undefined,
      (err) => {
        console.warn(`[officeCarpet] texture load failed: ${url}`, err);
      }
    );
    return configureMap(raw, { colorSpace });
  };

  const maps = {
    map: makeTex('albedo.png', THREE.SRGBColorSpace),
    normalMap: makeTex('normal.png'),
    roughnessMap: makeTex('roughness.png'),
    heightMap: makeTex('height.png'),
  };

  // Seed tracking sets for these masters (clones created before load completes will register).
  for (const m of [maps.map, maps.normalMap, maps.roughnessMap]) {
    if (m && !_carpetPendingClones.has(m)) {
      _carpetPendingClones.set(m, new Set());
    }
  }

  mapCache.set(key, maps);
  return maps;
}

const FALLBACK = {
  white: { color: 0xb9b9bd, roughness: 0.65 },
  grey: { color: 0x666687, roughness: 0.92 },
  office: { color: 0x6f6f92, roughness: 0.88 },
  // legacy aliases
  dark: { color: 0x666687, roughness: 0.92 },
  light: { color: 0xb9b9bd, roughness: 0.65 },
};

/**
 * PBR carpet for one grid cell (cw × cd metres). Repeat scales maps to world size.
 */
export function getOfficeCarpetMaterial(variant = 'grey', { cellW = 3.2, cellD = 3.2 } = {}) {
  if (variant === 'dark') variant = 'grey';
  if (variant === 'light') variant = 'white';
  const repeatU = cellW / OFFICE_CARPET_MODULE_M;
  const repeatV = cellD / OFFICE_CARPET_MODULE_M;
  const cacheKey = `${variant}|${repeatU}|${repeatV}`;
  if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

  const maps = loadOfficeCarpetMaps(variant);
  const fb = FALLBACK[variant] ?? FALLBACK.grey;

  if (!maps.map) {
    const mat = new THREE.MeshStandardMaterial({
      color: fb.color, roughness: fb.roughness, metalness: 0,
    });
    materialCache.set(cacheKey, mat);
    return mat;
  }

  const map = maps.map.clone();
  const normalMap = maps.normalMap?.clone() ?? null;
  const roughnessMap = maps.roughnessMap?.clone() ?? null;
  for (const tex of [map, normalMap, roughnessMap]) {
    if (tex) tex.repeat.set(repeatU, repeatV);
  }

  // Register clones against their masters for post-load version bump (if not already loaded).
  // Also force version=0 while unloaded: clone() does needsUpdate=true (version=1), which
  // routes into three's version>0 + image.complete path and crashes on null before load.
  const registerClone = (master, cloneTex) => {
    if (!master || !cloneTex || master.image) return; // already loaded or no clone
    let set = _carpetPendingClones.get(master);
    if (!set) {
      set = new Set();
      _carpetPendingClones.set(master, set);
    }
    set.add(cloneTex);
  };
  registerClone(maps.map, map);
  registerClone(maps.normalMap, normalMap);
  registerClone(maps.roughnessMap, roughnessMap);

  if (!maps.map?.image) {
    map.version = 0;
    if (normalMap) normalMap.version = 0;
    if (roughnessMap) roughnessMap.version = 0;
  }

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });
  materialCache.set(cacheKey, mat);
  return mat;
}

/** Zone → carpet variant (white/grey/office). Corridor gets traffic-wear darkening. */
export function getOfficeZoneFloorMaterials({ cellW, cellD }) {
  const grey = getOfficeCarpetMaterial('grey', { cellW, cellD });
  const officeC = getOfficeCarpetMaterial('office', { cellW, cellD });
  let corridor = grey;
  if (grey?.map) {
    const worn = grey.clone();
    worn.color.multiplyScalar(0.88);
    worn.roughness = Math.min(1, (worn.roughness ?? 1) + 0.06);
    corridor = worn;
  } else if (grey?.color) {
    const worn = grey.clone();
    worn.color.multiplyScalar(0.9);
    corridor = worn;
  }
  return {
    open: grey,
    corridor,
    meeting: grey,
    office: officeC,
    elevator: grey,
  };
}
