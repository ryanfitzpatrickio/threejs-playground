import * as THREE from 'three';

const TILE_COLUMNS = 10;
const TILE_ROWS = 10;
const TILE_SIZE = 96;

const NAMED_TILES = [
  ['moss_stone', 'mossy stone blocks, old ruin walls, cliff-built foundations', '#6f7f65', '#394538'],
  ['wet_slate', 'dark wet slate, cave floor, shadowed ledges', '#3e4850', '#1c2429'],
  ['limestone_blocks', 'pale cut stone, temple walls, bright courtyards', '#bbb89f', '#73735f'],
  ['granite_cliff', 'gray cliff faces, boulders, mountain walls', '#747b7d', '#3d4244'],
  ['basalt', 'black volcanic stone, deep cave trim, heavy platforms', '#2d3032', '#121516'],
  ['root_mat', 'knotted roots and dark forest floor', '#5a3f28', '#251910'],
  ['packed_earth', 'brown packed dirt, paths, terrain patches', '#7b5a37', '#3d2818'],
  ['forest_moss', 'green moss ground, soft forest platforms', '#56793f', '#243819'],
  ['leaf_litter', 'fallen leaves, forest trail, decay', '#80633b', '#3c2a17'],
  ['snow_dust', 'thin snow, cold stone caps, pale ground', '#d7dedc', '#8c9b99'],
  ['ancient_planks', 'weathered wood planks, bridges, platforms', '#8a6540', '#3f2a19'],
  ['dark_timber', 'dark structural timber, beams, old houses', '#503724', '#1e140d'],
  ['pale_wood', 'newer pale wood, scaffolds, ladders', '#b48a58', '#6f4b2a'],
  ['carved_oak', 'carved oak panels, doors, shrine details', '#775032', '#2f1b10'],
  ['rope_bridge', 'rope and wicker, hanging bridge decks', '#9b7a4a', '#4b3521'],
  ['copper_plate', 'aged copper plate, mechanisms, lift panels', '#9a6a3f', '#3f2c1f'],
  ['verdigris_metal', 'green oxidized metal, old machinery, temple trim', '#4f7b68', '#253b35'],
  ['iron_rivets', 'dark riveted iron, gates, industrial floors', '#4a4d4c', '#202322'],
  ['gold_inlay', 'gold inlay, puzzle markers, shrine accents', '#c69a42', '#5a3f17'],
  ['blue_rune', 'glowing blue runes, magical panels, markers', '#3b80a7', '#142937'],
  ['red_cloth', 'worn red cloth, banners, tent panels', '#9a3f34', '#3d1714'],
  ['canvas', 'tan canvas, awnings, tents, soft barriers', '#b6a47c', '#675b3e'],
  ['white_plaster', 'white plaster walls, broken interiors', '#d1c8ad', '#817862'],
  ['red_plaster', 'red plaster, warm village walls, worn paint', '#a35942', '#4b251b'],
  ['green_tile', 'green glazed tile, wet interiors, baths', '#4f876d', '#1f3d31'],
  ['blue_tile', 'blue glazed tile, water rooms, clean floors', '#4b7398', '#1f3044'],
  ['tan_tile', 'tan square floor tile, plazas, interior floors', '#b79b63', '#69522e'],
  ['cracked_tile', 'cracked pale floor tile, ruins, old halls', '#a99d7b', '#5d5643'],
  ['window_glass', 'blue glass panes, windows, lit interiors', '#79a9bc', '#2f5968'],
  ['black_doorway', 'black open doorway, cave mouth, deep interior', '#202124', '#090a0b'],
  ['fern_panel', 'fern vegetation, forest prop panels', '#49733c', '#1d3218'],
  ['vine_wall', 'climbing vines, overgrown wall panels', '#5f7d42', '#263818'],
  ['water_foam', 'water and foam, stream planes, reflective accents', '#6f9fa7', '#244e56'],
  ['mud', 'wet mud, riverbank, low paths', '#61492f', '#2c2118'],
  ['ash', 'ash ground, burned floor, old camp scars', '#69645c', '#2f2d2a'],
  ['bone', 'bone and ivory fragments, dry ruins, markers', '#d0c4a2', '#7a7058'],
  ['cement_floor', 'industrial cement concrete floor, pit lane, garage slabs, stained gray with wear', '#8a8f8a', '#4f5350'],
  ['brick_wall', 'red industrial brick wall for garages and buildings, mortar lines', '#8c5a4a', '#3d2a22'],
  ['garage_door', 'ribbed metal roll-up garage door, silver industrial panels with rivets', '#7a7e85', '#3a3d42'],
  ['asphalt_pit', 'dark asphalt pit road and lot surface, subtle tire marks and aggregate', '#3a3c3f', '#1f2124'],
  ['metal_siding', 'corrugated metal siding for haulers and modern garages, painted gray', '#6b7075', '#2f3338'],
  ['painted_concrete', 'painted white/yellow concrete for barriers and pit markings', '#d8d8d0', '#6f7068'],
];

export const TILE_PALETTE_CATALOG = Array.from({ length: TILE_COLUMNS * TILE_ROWS }, (_, index) => {
  const named = NAMED_TILES[index];
  if (named) {
    return {
      index,
      name: named[0],
      use: named[1],
      colors: [named[2], named[3]],
    };
  }
  const hue = (index * 37) % 360;
  return {
    index,
    name: `atlas_tile_${String(index + 1).padStart(2, '0')}`,
    use: 'spare atlas slot for imported art or temporary blockout material',
    colors: [`hsl(${hue} 32% 48%)`, `hsl(${hue} 28% 24%)`],
  };
});

let atlasCanvas = null;
let tileTextureCache = null;

// Generated race-track material sources. These load directly into each material
// texture after the procedural tile is available, so existing editor objects
// update in place when the image finishes loading (instead of requiring the
// object/material to be recreated).
const REAL_TILE_TEXTURES = Object.freeze({
  36: 'cement_floor',
  37: 'brick_wall',
  38: 'garage_door',
  39: 'asphalt_pit',
  40: 'metal_siding',
  41: 'painted_concrete',
});
const realTileLoadStates = new Map();

export function getTileDescriptor(tileIndex) {
  const index = clampTileIndex(Number.isFinite(tileIndex) ? tileIndex : 0);
  const tile = TILE_PALETTE_CATALOG[index];
  return {
    index,
    number: index + 1,
    name: tile.name,
    use: tile.use,
  };
}

export function formatTileCatalogForPrompt() {
  return TILE_PALETTE_CATALOG
    .map((tile) => `${tile.index}/${tile.index + 1}: ${tile.name} - ${tile.use}`)
    .join('\n');
}

export function normalizeTileIndex(tile) {
  if (typeof tile === 'number') {
    return clampTileIndex(tile >= 1 && tile <= 100 ? tile - 1 : tile);
  }

  const normalized = String(tile ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
  if (!normalized) return 0;

  const exact = TILE_PALETTE_CATALOG.find((entry) => entry.name === normalized);
  if (exact) return exact.index;

  const fuzzy = TILE_PALETTE_CATALOG.find((entry) => {
    const haystack = `${entry.name} ${entry.use}`.toLowerCase().replace(/_/g, ' ');
    return haystack.includes(normalized.replace(/_/g, ' '));
  });
  if (fuzzy) return fuzzy.index;

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return clampTileIndex(numeric >= 1 && numeric <= 100 ? numeric - 1 : numeric);

  throw new Error(`Unknown atlas tile "${tile}"`);
}

export function createAtlasMaterial(tileIndex = 0, textureRepeat = [1, 1], zIndex = 0) {
  const tile = clampTileIndex(tileIndex);
  const texture = getTileTexture(tile).clone();
  texture.needsUpdate = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    Math.max(0.01, Number(textureRepeat?.[0]) || 1),
    Math.max(0.01, Number(textureRepeat?.[1]) || 1),
  );
  loadRealTileTexture(texture, tile);

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.88,
    metalness: isMetalTile(tile) ? 0.18 : 0.02,
    side: THREE.DoubleSide,
  });
  material.userData = { tileIndex: tile, zIndex };
  return material;
}

function clampTileIndex(value) {
  return THREE.MathUtils.clamp(Math.round(Number(value) || 0), 0, TILE_PALETTE_CATALOG.length - 1);
}

function isMetalTile(tileIndex) {
  const name = TILE_PALETTE_CATALOG[tileIndex]?.name || '';
  return name.includes('metal') || name.includes('garage_door')
    || name.includes('iron') || name.includes('copper') || name.includes('gold');
}

function getTileTexture(tileIndex) {
  if (!tileTextureCache) buildTileTextureCache();
  return tileTextureCache[clampTileIndex(tileIndex)];
}

function buildTileTextureCache() {
  const source = getAtlasCanvas();
  tileTextureCache = TILE_PALETTE_CATALOG.map((_, index) => {
    const tile = document.createElement('canvas');
    tile.width = TILE_SIZE;
    tile.height = TILE_SIZE;
    const ctx = tile.getContext('2d');
    const sx = (index % TILE_COLUMNS) * TILE_SIZE;
    const sy = Math.floor(index / TILE_COLUMNS) * TILE_SIZE;
    ctx.drawImage(source, sx, sy, TILE_SIZE, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE);
    const texture = new THREE.CanvasTexture(tile);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  });
}

function getAtlasCanvas() {
  if (atlasCanvas) return atlasCanvas;

  atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = TILE_COLUMNS * TILE_SIZE;
  atlasCanvas.height = TILE_ROWS * TILE_SIZE;
  const ctx = atlasCanvas.getContext('2d');

  for (const tile of TILE_PALETTE_CATALOG) {
    const x = (tile.index % TILE_COLUMNS) * TILE_SIZE;
    const y = Math.floor(tile.index / TILE_COLUMNS) * TILE_SIZE;
    drawTile(ctx, x, y, TILE_SIZE, tile);
  }

  return atlasCanvas;
}

function loadRealTileTexture(texture, tileIndex) {
  const sourceName = REAL_TILE_TEXTURES[tileIndex];
  if (!sourceName || typeof Image === 'undefined') return;
  const existing = realTileLoadStates.get(tileIndex);
  if (existing) {
    if (existing.loaded) texture.needsUpdate = true;
    else existing.pending.push(texture);
    return;
  }

  // All clones of a cached CanvasTexture share this tile canvas. Load each source
  // only once, draw it into that shared canvas, then flag the clones that already
  // exist. Keeping the GPU tile at TILE_SIZE avoids uploading the same 1024px JPG
  // once per blueprint object (the race-center blueprint contains many repeated
  // pieces with independent texture transforms).
  const state = { loaded: false, pending: [texture] };
  realTileLoadStates.set(tileIndex, state);
  const image = new Image();
  image.onload = () => {
    const canvas = texture.image;
    const context = canvas?.getContext?.('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);
    }
    state.loaded = true;
    for (const pendingTexture of state.pending) pendingTexture.needsUpdate = true;
    state.pending.length = 0;
  };
  image.src = `/textures/atlas-sources/${sourceName}.jpg`;
}

function drawTile(ctx, x, y, size, tile) {
  const [base, dark] = tile.colors;
  ctx.fillStyle = base;
  ctx.fillRect(x, y, size, size);

  const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
  gradient.addColorStop(0, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.02)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, size, size);

  ctx.strokeStyle = dark;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.55;

  const name = tile.name || '';
  if (name.includes('garage_door') || name.includes('metal')) {
    drawGarageDoor(ctx, x, y, size);
  } else if (name.includes('brick')) {
    drawBrick(ctx, x, y, size);
  } else if (name.includes('cement') || name.includes('asphalt') || name.includes('concrete')) {
    drawCementAsphalt(ctx, x, y, size);
  } else if (name.includes('siding') || name.includes('panel')) {
    drawMetalSiding(ctx, x, y, size);
  } else {
    const mode = tile.index % 6;
    if (mode === 0) drawBlocks(ctx, x, y, size);
    else if (mode === 1) drawCracks(ctx, x, y, size);
    else if (mode === 2) drawPlanks(ctx, x, y, size);
    else if (mode === 3) drawPebbles(ctx, x, y, size);
    else if (mode === 4) drawPanels(ctx, x, y, size);
    else drawStrata(ctx, x, y, size);
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
}

function drawBlocks(ctx, x, y, size) {
  for (let row = 0; row < 4; row += 1) {
    const yy = y + row * (size / 4);
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + size, yy);
    ctx.stroke();
    const offset = row % 2 ? size / 4 : 0;
    for (let col = -1; col < 4; col += 1) {
      const xx = x + offset + col * (size / 3);
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx, yy + size / 4);
      ctx.stroke();
    }
  }
}

function drawCracks(ctx, x, y, size) {
  for (let i = 0; i < 7; i += 1) {
    ctx.beginPath();
    let px = x + ((i * 29) % size);
    let py = y + ((i * 41) % size);
    ctx.moveTo(px, py);
    for (let k = 0; k < 4; k += 1) {
      px += (((i + k) * 17) % 25) - 10;
      py += size / 9;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawPlanks(ctx, x, y, size) {
  for (let i = 1; i < 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x, y + i * (size / 5));
    ctx.lineTo(x + size, y + i * (size / 5));
    ctx.stroke();
  }
  for (let i = 0; i < 20; i += 1) {
    const yy = y + ((i * 19) % size);
    ctx.beginPath();
    ctx.moveTo(x + 8, yy);
    ctx.lineTo(x + size - 8, yy + ((i % 3) - 1) * 4);
    ctx.stroke();
  }
}

function drawPebbles(ctx, x, y, size) {
  for (let i = 0; i < 28; i += 1) {
    const px = x + 8 + ((i * 31) % (size - 16));
    const py = y + 8 + ((i * 47) % (size - 16));
    ctx.beginPath();
    ctx.ellipse(px, py, 2 + (i % 5), 2 + ((i + 2) % 4), i, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPanels(ctx, x, y, size) {
  for (let i = 1; i < 4; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + i * (size / 4), y);
    ctx.lineTo(x + i * (size / 4), y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + i * (size / 4));
    ctx.lineTo(x + size, y + i * (size / 4));
    ctx.stroke();
  }
}

function drawStrata(ctx, x, y, size) {
  for (let i = 0; i < 8; i += 1) {
    const yy = y + 8 + i * 11;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.bezierCurveTo(x + 25, yy - 8, x + 58, yy + 8, x + size, yy - 3);
    ctx.stroke();
  }
}

// Industrial patterns for race track / garage atlas tiles
function drawGarageDoor(ctx, x, y, size) {
  // Vertical ribbed panels
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i += 1) {
    const xx = x + 8 + i * (size / 6);
    ctx.beginPath();
    ctx.moveTo(xx, y + 4);
    ctx.lineTo(xx, y + size - 4);
    ctx.stroke();
  }
  // Horizontal panel lines (roll up door look)
  for (let i = 1; i < 5; i += 1) {
    const yy = y + i * (size / 5);
    ctx.beginPath();
    ctx.moveTo(x + 4, yy);
    ctx.lineTo(x + size - 4, yy);
    ctx.stroke();
  }
  // Rivets / bolts
  ctx.fillStyle = ctx.strokeStyle;
  for (let row = 1; row < 5; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const px = x + 12 + col * (size / 6);
      const py = y + row * (size / 5);
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBrick(ctx, x, y, size) {
  const brickH = size / 5;
  const brickW = size / 3.5;
  ctx.lineWidth = 2.5;
  for (let row = 0; row < 5; row += 1) {
    const yy = y + row * brickH;
    const offset = (row % 2) * (brickW / 2);
    for (let col = -1; col < 4; col += 1) {
      const xx = x + offset + col * brickW;
      ctx.strokeRect(xx, yy, brickW - 2, brickH - 2);
    }
  }
}

function drawCementAsphalt(ctx, x, y, size) {
  // Base is already filled; add aggregate dots and subtle cracks
  ctx.lineWidth = 1;
  for (let i = 0; i < 35; i += 1) {
    const px = x + 4 + ((i * 23) % (size - 8));
    const py = y + 4 + ((i * 37) % (size - 8));
    ctx.beginPath();
    ctx.arc(px, py, 1 + (i % 3) * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Light wear lines
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 12 + i * 17);
    ctx.lineTo(x + size - 10, y + 18 + i * 15);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.55;
}

function drawMetalSiding(ctx, x, y, size) {
  // Corrugated look
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i += 1) {
    const xx = x + 6 + i * (size / 8);
    ctx.beginPath();
    ctx.moveTo(xx, y + 2);
    ctx.lineTo(xx, y + size - 2);
    ctx.stroke();
  }
  // Horizontal seams
  for (let i = 1; i < 4; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + 2, y + i * (size / 4));
    ctx.lineTo(x + size - 2, y + i * (size / 4));
    ctx.stroke();
  }
}
