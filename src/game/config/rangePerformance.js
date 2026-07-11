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
    // Cover the whole warehouse (~28×116 m) in one ortho shadow volume.
    // The old 32 m player-follow frustum left the far end unshadowed while the
    // near half cast — a visible mix of lit/unlit bricks. 2k over ~144 m still
    // gives ~7 cm texels; the range is a few static batches so the pass is cheap.
    shadowMapSize: Math.max(qualityPreset.shadowMapSize ?? 1024, 2048),
    shadowFrustumHalf: 72,
    shadowFar: 220,
    shadowClipmap: {
      ...(qualityPreset.shadowClipmap ?? {}),
      enabled: false,
    },
    terrainCloudShadow: false,
    environment: {
      ...environment,
      // Ultra volumetric clouds are almost entirely hidden by the warehouse roof
      // yet still raymarch the full screen — force the cheap dome path.
      clouds: 'dome',
      aerialPerspective: false,
      // Official three.js WebGPU godrays (TSL GodraysNode) on the sun light.
      // Responds to time-of-day via sun direction + intensity + shadow map.
      rangeGodRays: true,
      rangeGodRayResolutionScale: 0.45,
      rangeGodRayDensity: 0.58,
      rangeGodRayMaxDensity: 0.42,
      rangeGodRayDistanceAttenuation: 1.55,
      rangeGodRaySteps: 36,
    },
  };
}
