import { normalizePostEffectMode, resolveEffectivePostEffectMode } from '../config/qualityPresets.js';

/**
 * Resolve which post-processing branches the render pipeline builds. Pure and
 * deterministic so headless tests can assert the branch logic (notably that the
 * SSAO normal pre-pass and the SSR MRT are never allocated together) without a
 * renderer.
 *
 * @param {object} options
 * @param {string} options.requestedMode - The persisted `ssao` | `ssr` | `off` preference.
 * @param {object} options.qualityPreset - The active quality preset.
 * @param {string} options.backend - The resolved renderer backend (`webgpu` or a fallback).
 * @returns {object} The plan the pipeline and renderer snapshots read from.
 */
export function buildPostPipelinePlan({ requestedMode, qualityPreset = {}, backend = 'webgpu' }) {
  // The post-effect branches (like the existing SSR gate) only run on the real
  // WebGPU backend; the WebGL2 fallback renders the plain pipeline.
  const effectiveMode = backend === 'webgpu'
    ? resolveEffectivePostEffectMode(requestedMode, qualityPreset)
    : 'off';

  const ssaoPreset = qualityPreset.ssao ?? {};
  const environmentPreset = qualityPreset.environment ?? {};

  return {
    requestedMode: normalizePostEffectMode(requestedMode),
    effectiveMode,
    normalPrePass: effectiveMode === 'ssao',
    ssrMrt: effectiveMode === 'ssr',
    ssao: effectiveMode === 'ssao'
      ? {
          resolutionScale: ssaoPreset.resolutionScale ?? 0.5,
          samples: ssaoPreset.samples ?? 8,
          radius: ssaoPreset.radius ?? 1.5,
          intensity: ssaoPreset.intensity ?? 4,
          blur: ssaoPreset.blur === true,
          // Render AO (including its normal/depth pre-pass, which is a full
          // CPU-side scene re-render) every Nth frame, reusing the AO texture
          // on the frames between.
          updateInterval: Math.max(1, Math.round(ssaoPreset.updateInterval ?? 1)),
        }
      : null,
    bloom: environmentPreset.bloom === true
      ? {
          implementation: 'dualKawase',
          resolutionScale: environmentPreset.bloomResolutionScale ?? 0.25,
          strength: environmentPreset.bloomStrength ?? 0.16,
          radius: environmentPreset.bloomRadius ?? 0.35,
          threshold: environmentPreset.bloomThreshold ?? 1.1,
        }
      : null,
  };
}
