/**
 * Shooting-range quality overrides.
 *
 * The range is a compact covered scene, so open-world Ultra costs (volumetric
 * clouds, aerial perspective, a 2k follow shadow, and unrestricted DPR) buy
 * very little on screen. Keep the visible Ultra features — SSAO, antialiasing,
 * and directional shadows — while giving the renderer enough headroom for a
 * stable 60 fps first-person view.
 */
export function applyRangeLevelOverrides(qualityPreset = {}, levelMode = 'city') {
  if (levelMode !== 'range') return qualityPreset;

  const environment = qualityPreset.environment ?? {};
  const ssao = qualityPreset.ssao?.enabled === true
    ? {
        ...qualityPreset.ssao,
        // Eight half-resolution taps plus the existing bilateral blur retain
        // contact shading on timber/crates at substantially lower fragment cost.
        resolutionScale: Math.min(qualityPreset.ssao.resolutionScale ?? 0.5, 0.5),
        samples: Math.min(qualityPreset.ssao.samples ?? 12, 8),
        updateInterval: Math.max(qualityPreset.ssao.updateInterval ?? 1, 2),
        // At 60 Hz, one reused AO frame is only 16.7 ms old. Do not turn camera
        // motion into an accidental every-frame normal/depth scene re-render.
        updateOnCameraMotion: false,
      }
    : qualityPreset.ssao;

  return {
    ...qualityPreset,
    rangeMode: true,
    // Protect Retina/high-DPR displays: full-screen post targets scale with DPR².
    maxPixelRatio: Math.min(qualityPreset.maxPixelRatio ?? 2, 1.25),
    ssao,
    // A 1k, 32 m-wide follow shadow resolves ~3 cm texels around the player.
    // The range's merged static geometry makes the shadow pass only a few draws.
    shadowMapSize: Math.min(qualityPreset.shadowMapSize ?? 1024, 1024),
    shadowFrustumHalf: Math.min(qualityPreset.shadowFrustumHalf ?? 16, 16),
    shadowFar: Math.min(qualityPreset.shadowFar ?? 56, 56),
    shadowClipmap: {
      ...(qualityPreset.shadowClipmap ?? {}),
      enabled: false,
    },
    terrainCloudShadow: false,
    environment: {
      ...environment,
      // The covered warehouse already has authored light shafts. The Ultra
      // volumetric cloud/atmosphere composite is almost entirely hidden by its
      // roof yet still raymarches the full screen.
      clouds: 'dome',
      aerialPerspective: false,
    },
  };
}
