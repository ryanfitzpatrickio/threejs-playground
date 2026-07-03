// Cloud composite — blends the cloud march output over the scene color.
//
// A plain TSL `Fn` (like `createAerialPerspectiveOutputNode`), not a TempNode:
// it samples the march pass's texture (the CloudMarchNode owns the render
// target and its own update), reconstructs the view ray, and alpha-blends the
// cloud color over the scene.
//
// Depth occlusion without a hit-distance target (M2): clouds live in a slab
// above `uCloudAltitude`, so a fragment of scene geometry occludes the clouds
// whenever its world distance is less than the distance to the slab floor along
// the view ray. Sky pixels (scene depth ≈ 1, since the sky mesh writes no
// depth) are treated as infinitely far and never occlude — this guard matters
// because dreamfall's camera.far on High (~320 m) sits below the cloud deck, so
// a raw depth comparison would wrongly hide clouds behind the far plane.

import {
  Fn,
  float,
  vec4,
  max,
  min,
  length,
  normalize,
  dot,
  mix,
  select,
  smoothstep,
  getViewPosition,
  screenUV,
  uniform,
} from 'three/tsl';
import { uCloudAltitude } from './cloudUniforms.js';

export function createCloudCompositeOutputNode({
  sceneColor,
  sceneDepth,
  camera,
  cloudTexture,
  sceneColorIsTexture = true,
}) {
  const cameraMatrixWorld = uniform(camera.matrixWorld);
  const projectionMatrixInverse = uniform(camera.projectionMatrixInverse);

  return Fn(() => {
    const uv = screenUV;
    const sceneTexel = sceneColorIsTexture ? sceneColor.sample(uv) : sceneColor;
    const depth = sceneDepth.sample(uv).r;

    const viewPos = getViewPosition(uv, depth, projectionMatrixInverse);
    const sceneDist = length(viewPos);
    const viewDir = normalize(viewPos);
    const worldDir = cameraMatrixWorld.mul(vec4(viewDir, 0)).xyz;
    const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;

    // Distance to the cloud-slab floor along this ray.
    const dirY = max(worldDir.y, 0.0001);
    const cloudNear = uCloudAltitude.sub(origin.y).div(dirY);

    // Sky pixels (no geometry wrote depth) never occlude; otherwise geometry in
    // front of the deck hides the clouds.
    const isSky = depth.greaterThan(0.9999);
    const occluded = isSky.not().and(sceneDist.lessThan(cloudNear));

    const cloud = cloudTexture.sample(uv);
    // Near-horizon fades, aligned to the 150 km march cutoff (see provider
    // `_maxMarchDist`). `horizonMelt` only softens the last fraction of a degree
    // where the grazing march is numerically worst; `farMelt` fades the deck out
    // exactly where the march stops giving samples (cloudNear → 150 km), so there
    // is no hard edge; aerial perspective adds gentle recession over the last few
    // degrees without washing the deck to the bright horizon-sky colour.
    const horizonMelt = smoothstep(0.003, 0.014, worldDir.y);
    const farMelt = float(1).sub(smoothstep(125000, 150000, cloudNear));
    const alpha = select(occluded, float(0), cloud.a.mul(horizonMelt).mul(farMelt));
    const aerialAmount = smoothstep(40000, 125000, cloudNear).mul(0.45);
    const aerialCloud = mix(cloud.rgb, sceneTexel.rgb, aerialAmount);
    return vec4(mix(sceneTexel.rgb, aerialCloud, alpha), sceneTexel.a);
  })();
}
