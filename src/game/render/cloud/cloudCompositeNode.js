// Cloud composite — blends the cloud march output over the scene color.
//
// Occlusion rule (by design): clouds are always behind solid geometry.
// Any pixel that wrote scene depth (terrain, mountains, buildings, …) kills
// cloud alpha. Only true sky — where nothing wrote depth (clear = 1.0; the
// sky dome has depthWrite off) — receives clouds.
//
// Do NOT gate on "sceneDist < camera.far * k": distant mountains sit near the
// far plane and would fail that test, putting clouds in front of peaks.

import {
  Fn,
  float,
  vec4,
  max,
  normalize,
  mix,
  select,
  smoothstep,
  getViewPosition,
  screenUV,
  uniform,
} from 'three/tsl';
import { uCloudAltitude, uCloudAmbientColor } from './cloudUniforms.js';
import {
  uCloudFadeEnd,
  uCloudFadeStart,
} from './cloudReachUniforms.js';

export function createCloudCompositeOutputNode({
  sceneColor,
  sceneDepth,
  camera,
  cloudTexture,
  // Kept for call-site compatibility; unused under the always-behind-geometry rule.
  cloudHitTexture = null,
  sceneColorIsTexture = true,
}) {
  const cameraMatrixWorld = uniform(camera.matrixWorld);
  const projectionMatrixInverse = uniform(camera.projectionMatrixInverse);

  return Fn(() => {
    const uv = screenUV;
    const sceneTexel = sceneColorIsTexture ? sceneColor.sample(uv) : sceneColor;
    const depth = sceneDepth.sample(uv).r;

    const viewPos = getViewPosition(uv, depth, projectionMatrixInverse);
    const viewDir = normalize(viewPos);
    const worldDir = cameraMatrixWorld.mul(vec4(viewDir, 0)).xyz;
    const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;

    const dirY = max(worldDir.y, 0.0001);
    const cloudNear = uCloudAltitude.sub(origin.y).div(dirY);

    // Sky clear is 1.0 (dome has depthWrite off). Any drawn solid is depth < 1.
    // No far-distance gate — that put clouds in front of distant peaks.
    const isSolidGeometry = depth.lessThan(1.0);
    const depthVis = select(isSolidGeometry, float(0), float(1));

    const cloud = cloudTexture.sample(uv);
    const horizonMelt = smoothstep(0.0015, 0.028, worldDir.y);
    const reachFade = float(1).sub(smoothstep(uCloudFadeStart, uCloudFadeEnd, cloudNear));
    const horizonHaze = float(1).sub(smoothstep(0.006, 0.05, worldDir.y));
    const cloudColor = mix(
      cloud.rgb,
      mix(sceneTexel.rgb, uCloudAmbientColor, float(0.55)),
      horizonHaze.mul(0.38),
    );
    const alpha = cloud.a.mul(horizonMelt).mul(reachFade).mul(depthVis);
    return vec4(mix(sceneTexel.rgb, cloudColor, alpha), sceneTexel.a);
  })();
}
