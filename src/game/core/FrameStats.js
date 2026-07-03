// Lightweight per-frame timing for spotting stream-in hitches. Cheap enough to leave on:
// the frame time comes from the rAF timestamp delta (no extra clock calls), and the rolling
// stats keep a fixed-size window. Exposed via GameRuntime.snapshot().frame so the debug
// bridge / overlay can show it without console spam.
//
// Use it to decide whether heavier work (e.g. moving physics to a worker) is still warranted:
// if recentP95Ms stays near budget and hitches stop climbing during streaming, it isn't.

const HITCH_MS = 20; // a frame over this drops a 60fps frame
const WINDOW_SIZE = 120; // rolling window (~2s at 60fps)

export class FrameStats {
  constructor() {
    this.window = new Float64Array(WINDOW_SIZE);
    this.index = 0;
    this.filled = false;
    this.hitches = 0; // cumulative frames >= HITCH_MS since reset
    this.streamingHitches = 0; // those that coincided with a streaming event / collider build
    this.maxMs = 0; // worst single frame since reset
    this.streamingMs = 0; // cost of the most recent streaming segment
    this.renderMs = 0; // cost of the most recent render() call
    // Most-recent duration (ms) of each timed system section, labeled by name.
    // Populated by recordSystem() from GameRuntime.update. Cheap: one field set.
    this.systems = Object.create(null);
  }

  // Record one system section's latest duration. Call site wraps the system call:
  //   const t = performance.now(); enemySystem.update(...); frameStats.recordSystem('enemy', performance.now() - t);
  recordSystem(label, ms) {
    this.systems[label] = ms;
  }

  // Lightweight section timer used by GameRuntime: start(label) before the call,
  // endSection() after. Zero allocations (reuses two scratch fields).
  start(label) {
    this._sectionLabel = label;
    this._sectionT = performance.now();
  }

  endSection() {
    this.systems[this._sectionLabel] = performance.now() - this._sectionT;
  }

  // frameMs: true inter-frame time. streamingMs: updateStreaming + collider drain. renderMs:
  // the renderer.render() call (shader compile + GPU upload happen here on a chunk's first
  // render). streamingActive: a chunk attached/unloaded or colliders were built.
  record(frameMs, streamingMs, renderMs, streamingActive) {
    this.window[this.index] = frameMs;
    this.index = (this.index + 1) % WINDOW_SIZE;
    if (this.index === 0) {
      this.filled = true;
    }

    if (frameMs > this.maxMs) {
      this.maxMs = frameMs;
    }
    if (frameMs >= HITCH_MS) {
      this.hitches += 1;
      if (streamingActive) {
        this.streamingHitches += 1;
      }
    }
    this.streamingMs = streamingMs;
    this.renderMs = renderMs;
  }

  summary() {
    const len = this.filled ? WINDOW_SIZE : this.index;
    if (len === 0) {
      return emptySummary();
    }

    const sorted = Array.from(this.window.subarray(0, len)).sort((a, b) => a - b);
    const pick = (quantile) => sorted[Math.min(len - 1, Math.floor(len * quantile))];

    return {
      recentAvgMs: round(sum(sorted) / len),
      recentP95Ms: round(pick(0.95)),
      recentMaxMs: round(sorted[len - 1]),
      hitches: this.hitches,
      streamingHitches: this.streamingHitches,
      hitchMs: HITCH_MS,
      maxMs: round(this.maxMs),
      streamingMs: round(this.streamingMs),
      renderMs: round(this.renderMs),
      systems: systemsSummary(this.systems),
    };
  }

  reset() {
    this.window.fill(0);
    this.index = 0;
    this.filled = false;
    this.hitches = 0;
    this.streamingHitches = 0;
    this.maxMs = 0;
    this.streamingMs = 0;
    this.renderMs = 0;
    this.systems = Object.create(null);
  }
}

function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function round(value) {
  return Number(value.toFixed(2));
}

function emptySummary() {
  return {
    recentAvgMs: 0,
    recentP95Ms: 0,
    recentMaxMs: 0,
    hitches: 0,
    streamingHitches: 0,
    hitchMs: HITCH_MS,
    maxMs: 0,
    streamingMs: 0,
    renderMs: 0,
    systems: {},
  };
}

function systemsSummary(systems) {
  const out = {};
  for (const key of Object.keys(systems)) {
    out[key] = round(systems[key]);
  }
  return out;
}
