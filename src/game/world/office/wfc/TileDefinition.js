// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

export class TileDefinition {
  constructor({
    id,
    category = 'generic',
    style = 'stone',
    tags = [],
    sockets = {},
    color = 0x888888,
    weight = 1,
    model = null,
  }) {
    this.id = id;
    this.category = category;
    this.style = style;
    this.tags = new Set(tags);
    this.sockets = {
      PX: 'any',
      NX: 'any',
      PY: 'any',
      NY: 'any',
      PZ: 'any',
      NZ: 'any',
      ...sockets,
    };
    this.color = color;
    this.weight = weight;
    this.model = model;
  }
}
