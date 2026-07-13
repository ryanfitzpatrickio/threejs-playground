/**
 * Suppression scalar field for the Horde flow-mob (M3 of
 * docs/horde-flow-mob-plan.md). Co-located with HordeFlowField: same bounds +
 * cellSize + row-major indexing, so `∇suppression` and `flowDir` align
 * cell-for-cell and the steering blend can subtract one from the other.
 *
 * Pure / dependency-free (plain JS + typed arrays, no `three`, no renderer) so
 * it stays importable from a pure-node verify script.
 *
 * Combat deposits scalar "pressure" at impact points; `update(dt)` applies
 * exponential decay + light diffusion each fixed step, so a sustained stream of
 * fire builds a standing suppression wall between the mob and the player while a
 * few stray shots fade fast. Steering samples `sampleGradient` (points UPHILL
 * toward higher suppression) and flees it, so concentrated fire on the front
 * recoils the tip; letting up lets the wall decay and the mob surge back.
 */

const DEFAULT_DECAY_PER_SEC = 1.6;      // e-folding rate: higher = fades faster
const DEFAULT_DIFFUSION_PER_SEC = 2.4;  // spread rate to 4-neighbors (per second)
const MAX_CELL_SUPPRESSION = 12;        // clamp so a hot spot can't run away

export class HordeSuppressionField {
  /**
   * @param {object} opts - share bounds/cellSize with the flow field.
   * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} opts.bounds
   * @param {number} [opts.cellSize=1]
   * @param {number} [opts.decayPerSec]
   * @param {number} [opts.diffusionPerSec]
   * @param {number} [opts.maxCell]
   */
  constructor({
    bounds,
    cellSize = 1,
    decayPerSec = DEFAULT_DECAY_PER_SEC,
    diffusionPerSec = DEFAULT_DIFFUSION_PER_SEC,
    maxCell = MAX_CELL_SUPPRESSION,
  } = {}) {
    if (!bounds) throw new Error('HordeSuppressionField requires bounds {minX,maxX,minZ,maxZ}');
    this.cellSize = Math.max(0.05, Number(cellSize) || 1);
    this.decayPerSec = Math.max(0, Number(decayPerSec) || 0);
    this.diffusionPerSec = Math.max(0, Number(diffusionPerSec) || 0);
    this.maxCell = Math.max(0.1, Number(maxCell) || MAX_CELL_SUPPRESSION);

    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.maxX = bounds.maxX;
    this.maxZ = bounds.maxZ;

    this.cols = Math.max(1, Math.ceil((this.maxX - this.minX) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((this.maxZ - this.minZ) / this.cellSize));
    this.cellCount = this.cols * this.rows;

    this.value = new Float32Array(this.cellCount);
    this._scratch = new Float32Array(this.cellCount);
    this._total = 0;
  }

  // ── Grid <-> world (mirrors HordeFlowField) ─────────────────────────────

  worldToCell(x, z) {
    const col = Math.floor((x - this.minX) / this.cellSize);
    const row = Math.floor((z - this.minZ) / this.cellSize);
    return {
      col: clampInt(col, 0, this.cols - 1),
      row: clampInt(row, 0, this.rows - 1),
    };
  }

  cellIndex(col, row) {
    return row * this.cols + col;
  }

  isInBounds(col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  // ── Deposit / update / sample ───────────────────────────────────────────

  /** Add `amount` of suppression at a world position (nearest-cell). */
  deposit(x, z, amount) {
    const add = Number(amount);
    if (!Number.isFinite(add) || add <= 0) return;
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return;
    const { col, row } = this.worldToCell(x, z);
    const idx = this.cellIndex(col, row);
    const next = Math.min(this.maxCell, this.value[idx] + add);
    this._total += next - this.value[idx];
    this.value[idx] = next;
  }

  /**
   * One fixed-step tick: exponential decay + explicit 4-neighbor diffusion.
   * Deterministic (no RNG); diffusion is written into a scratch buffer then
   * swapped so it doesn't bias by iteration order.
   */
  update(dt) {
    const delta = Number(dt);
    if (!Number.isFinite(delta) || delta <= 0) return this;
    if (this._total <= 1e-6) return this;

    const decay = Math.exp(-this.decayPerSec * delta);
    // Diffusion coefficient per step, clamped to <0.25 for stability (an
    // explicit 4-neighbor Laplacian is stable while 4*coeff < 1).
    const coeff = Math.min(0.24, this.diffusionPerSec * delta);

    const src = this.value;
    const dst = this._scratch;
    const cols = this.cols;
    const rows = this.rows;
    let total = 0;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const idx = row * cols + col;
        const center = src[idx];
        // Laplacian with reflective (no-flux) boundaries: missing neighbors
        // mirror the center so suppression isn't lost off-grid.
        const left = col > 0 ? src[idx - 1] : center;
        const right = col < cols - 1 ? src[idx + 1] : center;
        const up = row > 0 ? src[idx - cols] : center;
        const down = row < rows - 1 ? src[idx + cols] : center;
        const diffused = center + coeff * (left + right + up + down - 4 * center);
        const next = diffused * decay;
        dst[idx] = next > 1e-5 ? next : 0;
        total += dst[idx];
      }
    }

    this.value = dst;
    this._scratch = src;
    this._total = total;
    return this;
  }

  /** Suppression scalar at a world position (nearest-cell). */
  sample(x, z) {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return 0;
    const { col, row } = this.worldToCell(x, z);
    return this.value[this.cellIndex(col, row)];
  }

  /**
   * Gradient of suppression at a world position — points UPHILL toward higher
   * suppression (central differences). Steering negates + normalizes this so
   * agents flee the hot zone. Returns {x, z} in world units (not normalized).
   */
  sampleGradient(x, z) {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return { x: 0, z: 0 };
    const { col, row } = this.worldToCell(x, z);
    const left = this.isInBounds(col - 1, row) ? this.value[this.cellIndex(col - 1, row)] : this.value[this.cellIndex(col, row)];
    const right = this.isInBounds(col + 1, row) ? this.value[this.cellIndex(col + 1, row)] : this.value[this.cellIndex(col, row)];
    const up = this.isInBounds(col, row - 1) ? this.value[this.cellIndex(col, row - 1)] : this.value[this.cellIndex(col, row)];
    const down = this.isInBounds(col, row + 1) ? this.value[this.cellIndex(col, row + 1)] : this.value[this.cellIndex(col, row)];
    const inv2h = 1 / (2 * this.cellSize);
    return {
      x: (right - left) * inv2h,
      z: (down - up) * inv2h,
    };
  }

  clear() {
    this.value.fill(0);
    this._total = 0;
  }

  snapshot() {
    let peak = 0;
    let hot = 0;
    for (let i = 0; i < this.cellCount; i += 1) {
      const v = this.value[i];
      if (v > peak) peak = v;
      if (v > 0.05) hot += 1;
    }
    return {
      cols: this.cols,
      rows: this.rows,
      cellSize: this.cellSize,
      total: Number(this._total.toFixed(3)),
      peak: Number(peak.toFixed(3)),
      hotCells: hot,
      decayPerSec: this.decayPerSec,
      diffusionPerSec: this.diffusionPerSec,
    };
  }
}

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
