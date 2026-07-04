// Per-frame JS heap sampling for spotting city GC churn. Complements Chrome's
// Allocation profiler: this runs in-game via __DREAMFALL_DEBUG__ and reports
// retained growth between forced GCs when expose-gc is available.

const DEFAULT_DURATION_MS = 3000;
const MAX_SAMPLES = 600;

export class AllocationSampler {
  constructor() {
    this.active = false;
    this.samples = [];
    this._rafId = null;
    this._prevUsed = 0;
    this._startedAt = 0;
    this._durationMs = DEFAULT_DURATION_MS;
    this._pendingUa = null;
  }

  start(durationMs = DEFAULT_DURATION_MS) {
    this.stop();
    this.active = true;
    this.samples = [];
    this._durationMs = Math.max(250, durationMs);
    this._startedAt = performance.now();
    this._prevUsed = performance.memory?.usedJSHeapSize ?? 0;
    this._scheduleTick();
    return this.status();
  }

  stop() {
    this.active = false;
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    return this.report();
  }

  status() {
    return {
      active: this.active,
      sampleCount: this.samples.length,
      durationMs: this._durationMs,
      elapsedMs: this.active ? Math.round(performance.now() - this._startedAt) : 0,
    };
  }

  report() {
    const samples = this.samples;
    const n = samples.length;
    if (n === 0) {
      return {
        active: false,
        sampleCount: 0,
        preciseMemory: Boolean(performance.memory),
        measureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
      };
    }

    let sumDeltaKb = 0;
    let maxDeltaKb = 0;
    let positiveFrames = 0;
    const deltas = [];

    for (let i = 1; i < n; i += 1) {
      const prev = samples[i - 1].usedJsHeap;
      const cur = samples[i].usedJsHeap;
      if (prev == null || cur == null) continue;
      const deltaKb = (cur - prev) / 1024;
      deltas.push(deltaKb);
      sumDeltaKb += deltaKb;
      if (deltaKb > 0) positiveFrames += 1;
      if (deltaKb > maxDeltaKb) maxDeltaKb = deltaKb;
    }

    const first = samples[0];
    const last = samples[n - 1];
    const retainedKb = first.usedJsHeap != null && last.usedJsHeap != null
      ? (last.usedJsHeap - first.usedJsHeap) / 1024
      : null;
    const elapsedSec = (last.t - first.t) / 1000;

    let uaDeltaMb = null;
    if (first.uaBytes != null && last.uaBytes != null) {
      uaDeltaMb = (last.uaBytes - first.uaBytes) / 1048576;
    }

    deltas.sort((a, b) => a - b);
    const p95DeltaKb = deltas.length
      ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))]
      : 0;

    return {
      active: this.active,
      sampleCount: n,
      elapsedSec: round(elapsedSec, 2),
      preciseMemory: Boolean(performance.memory),
      measureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
      startMb: mb(first.usedJsHeap),
      endMb: mb(last.usedJsHeap),
      retainedKb: retainedKb != null ? round(retainedKb, 1) : null,
      retainedKbPerSec: retainedKb != null && elapsedSec > 0 ? round(retainedKb / elapsedSec, 1) : null,
      avgDeltaKbPerFrame: deltas.length ? round(sumDeltaKb / deltas.length, 3) : null,
      p95DeltaKbPerFrame: round(p95DeltaKb, 3),
      maxDeltaKbPerFrame: round(maxDeltaKb, 3),
      positiveDeltaFrames: positiveFrames,
      uaStartMb: mb(first.uaBytes),
      uaEndMb: mb(last.uaBytes),
      uaDeltaMb: uaDeltaMb != null ? round(uaDeltaMb, 2) : null,
      samples: samples.slice(-40),
    };
  }

  _scheduleTick() {
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (!this.active) return;

      const sample = {
        t: performance.now(),
        usedJsHeap: performance.memory?.usedJSHeapSize ?? null,
        uaBytes: null,
      };
      this.samples.push(sample);
      if (this.samples.length > MAX_SAMPLES) {
        this.samples.shift();
      }

      if (typeof performance.measureUserAgentSpecificMemory === 'function' && !this._pendingUa) {
        this._pendingUa = performance.measureUserAgentSpecificMemory()
          .then((result) => {
            sample.uaBytes = result?.bytes ?? null;
          })
          .catch(() => {})
          .finally(() => {
            this._pendingUa = null;
          });
      }

      if (performance.now() - this._startedAt >= this._durationMs) {
        this.active = false;
        return;
      }

      this._scheduleTick();
    });
  }
}

function mb(bytes) {
  return bytes == null ? null : round(bytes / 1048576, 2);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
