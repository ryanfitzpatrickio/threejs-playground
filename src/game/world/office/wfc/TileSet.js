// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

import { TileDefinition } from './TileDefinition.js';

export class TileSet {
  constructor() {
    this.tiles = new Map();
  }

  register(tile) {
    const def = tile instanceof TileDefinition ? tile : new TileDefinition(tile);
    this.tiles.set(def.id, def);
    return def;
  }

  get(id) {
    return this.tiles.get(id);
  }

  getAll() {
    return Array.from(this.tiles.values());
  }

  findByTags(tags = []) {
    return this.getAll().filter((tile) => tags.every((tag) => tile.tags.has(tag)));
  }

  findByCategoryStyle(category, style) {
    return this.getAll().filter((tile) => tile.category === category && tile.style === style);
  }
}
