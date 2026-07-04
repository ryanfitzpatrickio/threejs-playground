// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

export class Cell {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;

    this.occupancy = 'empty';
    this.zoneId = null;
    this.shapeId = null;
    this.floor = y;
    this.style = 'stone';

    this.tags = new Set();
    this.neighbors = {};

    this.fixedTile = null;
    this.possibleTiles = new Set();
    this.collapsedTile = null;

    this.generatedBy = null;
    this.lockedByUser = false;
    this.contradiction = false;
  }

  key() {
    return `${this.x},${this.y},${this.z}`;
  }

  clearGeneratedData() {
    if (this.lockedByUser) {
      this.possibleTiles = new Set();
      this.collapsedTile = this.fixedTile || this.collapsedTile;
      this.contradiction = false;
      return;
    }
    const lockedByUser = this.lockedByUser;
    const fixedTile = this.fixedTile;
    this.generatedBy = null;
    this.possibleTiles = new Set();
    this.collapsedTile = null;
    this.contradiction = false;
    this.tags.clear();
    this.shapeId = null;
    this.occupancy = 'empty';
    this.style = 'stone';
    this.lockedByUser = lockedByUser;
    this.fixedTile = fixedTile;
  }

  setFromAuthoring(planCell) {
    this.occupancy = planCell.occupancy;
    this.shapeId = planCell.shapeId;
    this.floor = planCell.floor;
    this.style = planCell.style;
  }
}
