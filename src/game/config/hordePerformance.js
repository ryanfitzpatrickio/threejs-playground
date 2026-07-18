/**
 * Horde-mode quality overrides.
 *
 * The train yard is a compact outdoor combat box (~72 m). Open-world Ultra
 * costs (volumetric clouds, aerial perspective, large shadow clipmaps, high
 * DPR, heavy SSAO) still run full-screen even with zero robots and dominate
 * the frame. Keep readable combat shading; cut everything the yard barely sees.
 */

export function applyHordeLevelOverrides(qualityPreset = {}, levelMode = 'city') {
  if (levelMode !== 'horde') return qualityPreset;

  const environment = qualityPreset.environment ?? {};
  const ssao = qualityPreset.ssao?.enabled === true
    ? {
      ...qualityPreset.ssao,
      resolutionScale: Math.min(qualityPreset.ssao.resolutionScale ?? 0.5, 0.4),
      samples: Math.min(qualityPreset.ssao.samples ?? 12, 6),
      updateInterval: Math.max(qualityPreset.ssao.updateInterval ?? 1, 2),
      updateOnCameraMotion: false,
    }
    : qualityPreset.ssao;

  // Low quality: no mall LightProbeGrid (docs/horde-gi-plan.md).
  const isLow = qualityPreset.ssao?.enabled !== true
    && (qualityPreset.maxPixelRatio ?? 2) <= 1;
  const existingGi = environment.hordeGi ?? {};
  const hordeGi = isLow
    ? { ...existingGi, enabled: false }
    : {
      enabled: true,
      intensity: 0.95,
      probes: { x: 8, y: 3, z: 8 },
      cubemapSize: 8,
      bounces: 1,
      sampleCount: 128,
      fadeInSeconds: 0,
      ...existingGi,
      // Force on for high+ unless caller set enabled: false
      enabled: existingGi.enabled === false ? false : true,
    };

  return {
    ...qualityPreset,
    hordeMode: true,
    propaneFx: {
      gasCapacity: isLow ? 56 : 128,
      smokeCapacity: isLow ? 36 : 72,
      explosionCapacity: isLow ? 2 : 4,
      heatShimmer: !isLow,
      distortion: !isLow,
      ...(qualityPreset.propaneFx ?? {}),
    },
    // Retina DPR² blows full-screen post; cap hard for combat FPS.
    maxPixelRatio: Math.min(qualityPreset.maxPixelRatio ?? 2, 1.15),
    ssao,
    // Single follow shadow is enough outdoors; clipmap multiplies map cost.
    shadowMapSize: Math.min(qualityPreset.shadowMapSize ?? 1024, 1024),
    shadowFrustumHalf: Math.min(qualityPreset.shadowFrustumHalf ?? 28, 28),
    shadowFar: Math.min(qualityPreset.shadowFar ?? 64, 64),
    shadowClipmap: {
      ...(qualityPreset.shadowClipmap ?? {}),
      enabled: false,
    },
    terrainCloudShadow: false,
    // Prefer a stable cadence over uncapped frame spikes while the yard loads.
    renderCap60: qualityPreset.renderCap60 !== false,
    environment: {
      ...environment,
      // Dome sky is fine; full volumetric raymarch is free cost over a foundry pad.
      clouds: 'dome',
      aerialPerspective: false,
      rangeGodRays: false,
      volumetricClouds: {
        ...(environment.volumetricClouds ?? {}),
        enabled: false,
      },
      hordeGi,
    },
  };
}
