import * as THREE from 'three';

// Ordered light → heavy; harder impacts pick higher clips.
const CRASH_URLS = [
  '/audio/vehicles/crash-01.mp3',
  '/audio/vehicles/crash-02.mp3',
  '/audio/vehicles/crash-03.mp3',
  '/audio/vehicles/crash-04.mp3',
];

// Glass-inclusive impacts for the hardest crashes.
const GLASS_CRASH_URLS = [
  '/audio/vehicles/crash-glass-01.mp3',
  '/audio/vehicles/crash-glass-02.mp3',
  '/audio/vehicles/crash-glass-03.mp3',
  '/audio/vehicles/crash-glass-04.mp3',
];

const shared = {
  ctx: null,
  buffers: [],
  glassBuffers: [],
  loadPromise: null,
  lastIndex: -1,
  lastGlassIndex: -1,
  muted: false,
};

function ensureLoaded() {
  if (shared.loadPromise) return shared.loadPromise;
  shared.loadPromise = (async () => {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    shared.ctx = new AudioContext();
    const decode = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load crash audio: ${url}`);
      return shared.ctx.decodeAudioData(await response.arrayBuffer());
    };
    shared.buffers = await Promise.all(CRASH_URLS.map(decode));
    shared.glassBuffers = await Promise.all(GLASS_CRASH_URLS.map(decode));
  })();
  return shared.loadPromise;
}

function severityNorm(severity) {
  const minSeverity = 2.8;
  const maxSeverity = 18;
  return THREE.MathUtils.clamp(
    (severity - minSeverity) / (maxSeverity - minSeverity),
    0,
    1,
  );
}

function pickBufferFromPool(buffers, { severity = 5, tier = 'fender', lastIndexKey = 'lastIndex' } = {}) {
  if (buffers.length === 0) return null;

  const norm = severityNorm(severity);
  const tierFloor = tier === 'severe' ? 0.58 : tier === 'crumple' ? 0.3 : 0;
  const pickNorm = Math.max(norm, tierFloor);
  let index = Math.min(
    buffers.length - 1,
    Math.floor(pickNorm * buffers.length),
  );

  const lastIndex = shared[lastIndexKey];
  if (buffers.length > 1 && index === lastIndex) {
    index = (index + 1) % buffers.length;
  }
  shared[lastIndexKey] = index;
  return buffers[index];
}

function playBuffer(ctx, buffer, volume) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start(0);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
}

/** One-shot crash impacts — shared buffer pool, clip + volume scale with severity. */
export class VehicleCrashAudio {
  setMuted(state) {
    shared.muted = Boolean(state);
  }

  mute(state) {
    this.setMuted(state);
  }

  resume() {
    ensureLoaded().then(() => shared.ctx?.resume()).catch(() => {});
  }

  playImpact({
    severity = 5,
    tier = 'fender',
    glass = false,
    sourcePosition = null,
    listenerPosition = null,
  } = {}) {
    if (shared.muted) return;
    ensureLoaded().then(() => {
      const ctx = shared.ctx;
      const buffers = glass ? shared.glassBuffers : shared.buffers;
      const buffer = pickBufferFromPool(buffers, {
        severity,
        tier,
        lastIndexKey: glass ? 'lastGlassIndex' : 'lastIndex',
      });
      if (!ctx || !buffer) return;
      ctx.resume().catch(() => {});

      const norm = severityNorm(severity);
      const tierBoost = glass
        ? 1.0
        : tier === 'severe' ? 1.05 : tier === 'crumple' ? 0.9 : 0.72;
      let volume = THREE.MathUtils.lerp(glass ? 0.55 : 0.32, 1.0, norm) * tierBoost;

      if (sourcePosition && listenerPosition) {
        const distance = sourcePosition.distanceTo(listenerPosition);
        const falloff = THREE.MathUtils.clamp(1 - (distance - 6) / 42, 0.12, 1);
        volume *= falloff;
      }

      playBuffer(ctx, buffer, volume);
    }).catch(() => {});
  }

  dispose() {
    // Shared pool — other vehicles may still be playing.
  }
}
