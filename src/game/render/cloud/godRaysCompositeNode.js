// Depth- and cloud-aware god-ray composite. The raw god-ray pass marches the
// cloud-shadow map along the sun direction; without masking it projects that
// field onto every pixel (including the road) as a perspective triangle.

import {
  Fn,
  float,
  vec4,
  max,
  dot,
  normalize,
  smoothstep,
  select,
  getViewPosition,
  screenUV,
  uniform,
} from 'three/tsl';
import { uSunDirection } from './cloudUniforms.js';

export function createGodRaysCompositeNode({
  baseColor,
  sceneDepth,
  cloudTexture,
  raysTexture,
  camera,
}) {
  const cameraMatrixWorld = uniform(camera.matrixWorld);
  const projectionMatrixInverse = uniform(camera.projectionMatrixInverse);

  return Fn(() => {
    const uv = screenUV;
    const depth = sceneDepth.sample(uv).r;
    const base = baseColor;
    const rays = raysTexture.sample(uv);
    const cloud = cloudTexture.sample(uv);

    const viewPos = getViewPosition(uv, depth, projectionMatrixInverse);
    const worldDir = normalize(cameraMatrixWorld.mul(vec4(normalize(viewPos), 0)).xyz);

    const isSky = depth.greaterThan(0.9999);
    const skyMask = select(isSky, float(1), float(0));
    const sunMask = smoothstep(0.22, 0.88, dot(worldDir, uSunDirection));
    const skyBand = smoothstep(0.0, 0.32, worldDir.y);
    // Brighten gaps in the marched cloud layer — shafts read through breaks,
    // not as a flat overlay on terrain.
    const throughCloud = smoothstep(0.06, 0.42, cloud.a).mul(float(1).sub(cloud.a.mul(0.5)));
    const mask = skyMask.mul(sunMask).mul(max(skyBand, throughCloud.mul(0.9)));

    return vec4(base.rgb.add(rays.rgb.mul(mask)), base.a);
  })();
}
