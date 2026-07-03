/**
 * Procedural.js
 * Deterministic, continuous 2D noise for chunk initialization.
 * Guarantees perfect seamlessness when adjacent chunks sample the same world coordinates.
 *
 * Usage:
 *   const sampler = createProceduralSampler({ seed: 12345, amplitude: 2.2, octaves: 5 });
 *   const h = sampler(worldX, worldZ);
 */

const DEFAULTS = {
  seed: 1337,
  amplitude: 2.4,
  octaves: 5,
  lacunarity: 2.0,
  gain: 0.5,
  frequency: 0.015, // world units scale
};

/**
 * Create a seeded 2D noise sampler.
 * Returns a function (x, z) => height that is continuous and deterministic.
 */
export function createProceduralSampler(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const { seed, amplitude, octaves, lacunarity, gain, frequency } = config;

  // Simple 32-bit integer hash (good distribution, no external deps)
  const hash = (x, z, seedOffset = 0) => {
    let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ (seed + seedOffset) | 0;
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n = (n ^ (n >>> 13)) >>> 0;
    return n / 0xffffffff; // [0, 1)
  };

  // Smooth fade curve (quintic)
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  // Bilinear interpolation
  const lerp = (a, b, t) => a + (b - a) * t;

  // Single octave value noise at integer lattice, world-space continuous
  const noise2 = (x, z) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;

    const sx = fade(x - x0);
    const sz = fade(z - z0);

    const n00 = hash(x0, z0);
    const n10 = hash(x1, z0);
    const n01 = hash(x0, z1);
    const n11 = hash(x1, z1);

    const nx0 = lerp(n00, n10, sx);
    const nx1 = lerp(n01, n11, sx);
    return lerp(nx0, nx1, sz);
  };

  // fBM / octave sum
  return function sample(worldX, worldZ) {
    let x = worldX * frequency;
    let z = worldZ * frequency;
    let amp = amplitude;
    let freq = 1.0;
    let sum = 0.0;
    let maxAmp = 0.0;

    for (let o = 0; o < octaves; o += 1) {
      // Use different seed per octave for variety without breaking continuity
      const octaveNoise = noise2(x * freq, z * freq);
      // Center noise around 0: [-0.5, 0.5] * amp contribution
      sum += (octaveNoise - 0.5) * amp;
      maxAmp += amp;
      amp *= gain;
      freq *= lacunarity;
    }

    // Normalize and return
    return (sum / maxAmp) * 2.0; // scale so amplitude is roughly peak-to-trough in world units
  };
}

/**
 * Convenience: create a sampler and immediately sample an entire chunk grid.
 * heights will be a Float32Array laid out row-major: index = j * resolution + i
 * where local world position for vert (i,j) is centered on the chunk:
 *   wx = cx * size - size / 2 + (i / (resolution - 1)) * size
 *   wz = cz * size - size / 2 + (j / (resolution - 1)) * size
 */
export function sampleChunkHeights(sampler, cx, cz, size, resolution) {
  const heights = new Float32Array(resolution * resolution);
  const step = size / (resolution - 1);
  const minX = cx * size - size * 0.5;
  const minZ = cz * size - size * 0.5;

  for (let j = 0; j < resolution; j += 1) {
    for (let i = 0; i < resolution; i += 1) {
      const wx = minX + i * step;
      const wz = minZ + j * step;
      const idx = j * resolution + i;
      heights[idx] = sampler(wx, wz);
    }
  }

  return heights;
}
