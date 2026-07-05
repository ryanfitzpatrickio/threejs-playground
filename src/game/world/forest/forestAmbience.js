/**
 * SeedThree-style forest ambience — temperate wind bed + sparse bird calls.
 * Gated by proximity to forest zones; respects browser autoplay policy.
 */

const WIND_LEVEL = 0.012;
const BIRD_PEAK = [0.05, 0.12];
const BIRD_INTERVAL = [7, 20];
const PROXIMITY_MARGIN = 48;

const BIRD_KINDS = ['crow', 'mallard'];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function zoneDistanceSq(x, z, zone) {
  const b = zone.rect
    ? zone.rect
    : zone.points?.reduce((acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      maxX: Math.max(acc.maxX, p.x),
      minZ: Math.min(acc.minZ, p.z),
      maxZ: Math.max(acc.maxZ, p.z),
    }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  if (!b) return Infinity;
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
  return dx * dx + dz * dz;
}

function nearestForestDistSq(x, z, zones) {
  let best = Infinity;
  for (const zone of zones) {
    best = Math.min(best, zoneDistanceSq(x, z, zone));
  }
  return best;
}

export function createForestAmbience({ zones = [] } = {}) {
  if (!zones.length) {
    return { update() {}, wake() {}, dispose() {}, snapshot: () => ({ forestAmbience: false }) };
  }

  let ctx = null;
  let master = null;
  let birdBus = null;
  let windSrc = null;
  let windGain = null;
  let enabled = false;
  let targetGain = 0;
  let birdTimer = rand(...BIRD_INTERVAL);
  const buffers = {};
  const urls = {
    wind_temperate: '/assets/audio/forest/wind_temperate.wav',
    crow_1: '/assets/audio/forest/crow_1.mp3',
    crow_2: '/assets/audio/forest/crow_2.mp3',
    mallard_1: '/assets/audio/forest/mallard_1.mp3',
  };

  const variantsOf = (kind) => Object.keys(urls).filter((n) => n === kind || n.startsWith(`${kind}_`));

  async function load(name) {
    const cached = buffers[name];
    if (cached === 'missing') return null;
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) return cached;
    const url = urls[name];
    if (!url) { buffers[name] = 'missing'; return null; }
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { buffers[name] = buf; return buf; })
      .catch(() => { buffers[name] = 'missing'; return null; });
    buffers[name] = p;
    return p;
  }

  async function ensureWind() {
    if (!ctx || windSrc) return;
    const buf = await load('wind_temperate');
    if (!buf) return;
    windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windGain).connect(master);
    windSrc.start();
  }

  function setWindGain(gain, ramp = 1.2) {
    if (!windGain || !ctx) return;
    const now = ctx.currentTime;
    windGain.gain.cancelScheduledValues(now);
    windGain.gain.setValueAtTime(windGain.gain.value, now);
    windGain.gain.linearRampToValueAtTime(Math.max(0.0001, gain), now + ramp);
  }

  async function playBird() {
    if (!ctx || !enabled || targetGain < 0.2) return;
    const kind = pick(BIRD_KINDS);
    const variants = variantsOf(kind);
    if (!variants.length) return;
    const buf = await load(pick(variants));
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rand(0.92, 1.08);
    const g = ctx.createGain();
    g.gain.value = 0;
    const peak = rand(...BIRD_PEAK) * targetGain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.55, 0.55);
    src.connect(g).connect(pan).connect(birdBus);
    const now = ctx.currentTime;
    const dur = buf.duration / src.playbackRate.value;
    g.gain.linearRampToValueAtTime(peak, now + 0.35);
    g.gain.linearRampToValueAtTime(0.0001, now + Math.min(dur, 2.8));
    src.start(now);
    src.stop(now + Math.min(dur, 2.8) + 0.05);
  }

  return {
    wake() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        enabled = true;
        return true;
      }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return false;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      birdBus = ctx.createGain();
      birdBus.gain.value = 1;
      birdBus.connect(master);
      enabled = true;
      ensureWind();
      return true;
    },

    update(position, delta = 0.016) {
      if (!enabled || !ctx || !position) return;
      const margin = PROXIMITY_MARGIN;
      const distSq = nearestForestDistSq(position.x, position.z, zones);
      const inside = distSq <= margin * margin;
      targetGain = inside ? 1 : Math.max(0, 1 - (Math.sqrt(distSq) - margin) / 80);
      setWindGain(WIND_LEVEL * targetGain);
      if (targetGain < 0.05) return;
      birdTimer -= delta;
      if (birdTimer <= 0) {
        birdTimer = rand(...BIRD_INTERVAL);
        playBird();
      }
    },

    dispose() {
      enabled = false;
      try { windSrc?.stop(); } catch { /* noop */ }
      windSrc = null;
      windGain = null;
      if (ctx?.state !== 'closed') ctx?.close?.();
      ctx = null;
      master = null;
      birdBus = null;
    },

    snapshot: () => ({ forestAmbience: enabled && targetGain > 0.05 }),
  };
}
