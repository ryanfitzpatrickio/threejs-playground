// CloudMarchNode — the volumetric cloud raymarch (analysis §4.4), M2 form.
//
// A TempNode (SSAONode pattern) that renders a fullscreen march into a half-res
// HalfFloat RGBA target each frame: RGB = cloud luminance (linear HDR), A =
// opacity. It reconstructs the world view ray from the camera, intersects the
// flat cloud slab, then runs a FIXED march (no coarse/fine yet — that's M3/M4
// with temporal) integrating Beer-Lambert single-scatter with an inlined cone
// light-march toward the sun (self-shadow) + a uniform ambient term, HG phase,
// and powder effect. Early-exits once transmittance drops below a threshold.
//
// M2 simplifications vs sky reference source: fixed march (not coarse/fine), no per-pixel
// mip LOD (base-level noise sampling), single target (no rayHitDist MRT — the
// composite derives occlusion from slab geometry; hit-distance arrives with the
// temporal pass in M3). Weather/cloud params come from `cloudUniforms`.

import {
  RenderTarget,
  QuadMesh,
  NodeMaterial,
  RendererUtils,
  HalfFloatType,
  RGBAFormat,
  Vector2,
  TempNode,
} from 'three/webgpu';
import {
  NodeUpdateType,
  Fn,
  Loop,
  If,
  Break,
  float,
  int,
  vec3,
  vec4,
  max,
  min,
  exp,
  dot,
  clamp,
  normalize,
  getViewPosition,
  interleavedGradientNoise,
  fract,
  screenUV,
  screenCoordinate,
  passTexture,
  uniform,
} from 'three/tsl';
import {
  uCloudAltitude,
  uCloudThickness,
  uCloudDensity,
  uCloudScatteringAlbedo,
  uCloudPowderStrength,
  uCloudAmbientIntensity,
  uSunDirection,
  uSunIntensity,
  uSunColor,
  uSunTint,
  uCloudAmbientColor,
  uAtmosphereMieG,
  uEvolution,
} from './cloudUniforms.js';
import { sampleCloudDensity, shellHeightFractionAt, multiPhase, powder } from './cloudDensity.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

class CloudMarchNode extends TempNode {
  constructor({
    camera,
    weatherNode,
    baseShapeNode,
    steps = 48,
    lightTaps = 3,
    lightStepSize = 12,
    maxMarchDist = 60000,
    // Upper bound on the in-cloud step size (metres). Without it, grazing rays
    // spread the fixed step budget over a huge span (marchLen/steps → hundreds of
    // metres), sampling the deck at discrete heights → horizontal band aliasing
    // low in the sky that the temporal pass only slowly averages out. Capping dt
    // keeps near-horizon sampling crisp; reach is preserved by the empty-space
    // coarse-skip (4×) and opaque early-exit.
    maxStepSize = 160,
    earlyExitTransmittance = 0.025,
    renderScale = 0.5,
  }) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.camera = camera;
    this.weatherNode = weatherNode;
    this.baseShapeNode = baseShapeNode;
    this.steps = steps;
    this.lightTaps = lightTaps;
    this.lightStepSize = lightStepSize;
    this.maxMarchDist = maxMarchDist;
    this.maxStepSize = maxStepSize;
    this.earlyExitTransmittance = earlyExitTransmittance;
    this.renderScale = renderScale;
    this._size = new Vector2(1, 1);

    this._renderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat,
    });
    this._renderTarget.texture.name = 'cloud.march';
    this._hitRenderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat,
    });
    this._hitRenderTarget.texture.name = 'cloud.rayHitDist';

    this._cameraMatrixWorld = uniform(camera.matrixWorld);
    this._projectionMatrixInverse = uniform(camera.projectionMatrixInverse);

    this._material = new NodeMaterial();
    this._material.name = 'cloud.march';
    this._material.fragmentNode = this._buildMarchFn()();
    this._textureNode = passTexture(this, this._renderTarget.texture);
    this._hitMaterial = new NodeMaterial();
    this._hitMaterial.name = 'cloud.rayHitDist';
    this._hitMaterial.fragmentNode = this._buildHitDistanceFn()();
    this._hitDistanceNode = passTexture(this, this._hitRenderTarget.texture);
  }

  getTextureNode() {
    return this._textureNode;
  }

  getHitDistanceNode() {
    return this._hitDistanceNode;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(this.renderScale * width));
    const h = Math.max(1, Math.round(this.renderScale * height));
    this._size.set(w, h);
    this._renderTarget.setSize(w, h);
    this._hitRenderTarget.setSize(w, h);
  }

  updateBefore(frame) {
    const { renderer } = frame;
    const size = renderer.getDrawingBufferSize(_sizeScratch);
    this.setSize(size.width, size.height);

    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);
    _quadMesh.material = this._material;
    _quadMesh.name = 'cloud.march';
    renderer.setRenderTarget(this._renderTarget);
    _quadMesh.render(renderer);
    _quadMesh.material = this._hitMaterial;
    _quadMesh.name = 'cloud.rayHitDist';
    renderer.setRenderTarget(this._hitRenderTarget);
    _quadMesh.render(renderer);
    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  dispose() {
    this._renderTarget.dispose();
    this._hitRenderTarget.dispose();
    this._material.dispose();
    this._hitMaterial.dispose();
  }

  _buildMarchFn() {
    const STEPS = this.steps;
    const LIGHT_TAPS = this.lightTaps;
    const LIGHT_STEP = this.lightStepSize;
    const MAX_MARCH = this.maxMarchDist;
    const MAX_STEP = this.maxStepSize;
    const EARLY_EXIT = this.earlyExitTransmittance;
    const weatherNode = this.weatherNode;
    const baseShapeNode = this.baseShapeNode;
    const cameraMatrixWorld = this._cameraMatrixWorld;
    const projectionMatrixInverse = this._projectionMatrixInverse;

    return Fn(() => {
      // Reconstruct the world-space view ray for this pixel.
      const viewPos = getViewPosition(screenUV, float(1), projectionMatrixInverse);
      const viewDir = normalize(viewPos);
      const dir = cameraMatrixWorld.mul(vec4(viewDir, 0)).xyz;

      // The camera origin in world space is the matrix translation column.
      const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;

      // Flat-slab intersection: two horizontal planes at altitude / altitude+thickness.
      const bottomY = uCloudAltitude;
      const topY = uCloudAltitude.add(uCloudThickness);
      const dirY = max(dir.y, 0.0001);
      const tBottom = bottomY.sub(origin.y).div(dirY);
      const tTop = topY.sub(origin.y).div(dirY);
      const tA = min(tBottom, tTop);
      const tB = max(tBottom, tTop);
      const tStart = max(tA, 0);
      const tEnd = min(max(tB, tStart), MAX_MARCH);
      const marchLen = tEnd.sub(tStart);
      // Cap the base step so grazing rays (huge marchLen) still sample the deck
      // finely instead of in coarse horizontal bands. Empty-space coarse-skip +
      // opaque early-exit keep the reach.
      const dt = min(marchLen.div(STEPS), float(MAX_STEP));
      const valid = dir.y.greaterThan(0).and(marchLen.greaterThan(0));

      const transmittance = float(1).toVar();
      const luminance = vec3(0, 0, 0).toVar();
      const jitter = fract(interleavedGradientNoise(screenCoordinate).add(uEvolution.mul(0.6180339))).sub(0.5);

      If(valid, () => {
        const t = tStart.add(float(0.5).add(jitter).mul(dt)).toVar();
        const stepSize = dt.toVar();
        const emptyCount = int(0).toVar();
        Loop(STEPS, () => {
          If(transmittance.lessThan(EARLY_EXIT).or(t.greaterThanEqual(tEnd)), () => {
            Break();
          });
          const pos = origin.add(dir.mul(t));
          const hf = shellHeightFractionAt(pos);
          const density = sampleCloudDensity({ pos, shellHeightFraction: hf, weatherNode, baseShapeNode });

          If(density.greaterThan(0.01), () => {
            // A coarse step found cloud: back up and resume at fine spacing.
            If(stepSize.greaterThan(dt.mul(1.01)), () => {
              t.subAssign(stepSize);
              stepSize.assign(dt);
              emptyCount.assign(0);
            }).Else(() => {
              const tau = min(density.mul(uCloudDensity).mul(stepSize), 0.5);
              const sunDir = uSunDirection;
              const lightOD = float(0).toVar();
              Loop(LIGHT_TAPS, ({ i: li }) => {
                const lt = float(li).add(1).mul(LIGHT_STEP);
                const lpos = pos.add(sunDir.mul(lt));
                const lhf = shellHeightFractionAt(lpos);
                const ld = sampleCloudDensity({ pos: lpos, shellHeightFraction: lhf, weatherNode, baseShapeNode });
                lightOD.addAssign(ld.mul(LIGHT_STEP));
              });
              const extinction = lightOD.mul(uCloudDensity);
              const lightT = exp(extinction.negate())
                .add(exp(extinction.mul(-0.5)).mul(0.5))
                .add(exp(extinction.mul(-0.25)).mul(0.25))
                .div(1.75);
              const phase = multiPhase(dot(dir, sunDir));
              const pwdr = powder(tau, uCloudPowderStrength);
              const sunLight = uSunColor.mul(uSunIntensity).mul(uSunTint).mul(lightT).mul(phase).mul(pwdr);
              const ambient = uCloudAmbientColor.mul(uCloudAmbientIntensity);
              const radiance = sunLight.add(ambient).mul(uCloudScatteringAlbedo).mul(density);
              const stepT = exp(tau.negate());
              luminance.addAssign(
                transmittance.mul(radiance).mul(float(1).sub(stepT)).div(max(tau, 1e-4)),
              );
              transmittance.mulAssign(stepT);
              emptyCount.assign(0);
            });
          }).Else(() => {
            emptyCount.addAssign(1);
            If(emptyCount.greaterThanEqual(4), () => {
              stepSize.assign(dt.mul(4));
            });
          });
          t.addAssign(stepSize);
        });
      });

      const opacity = clamp(float(1).sub(transmittance), 0, 1);
      return vec4(luminance, opacity);
    });
  }

  _buildHitDistanceFn() {
    const STEPS = Math.max(24, Math.ceil(this.steps * 0.5));
    const MAX_MARCH = this.maxMarchDist;
    const weatherNode = this.weatherNode;
    const baseShapeNode = this.baseShapeNode;
    const cameraMatrixWorld = this._cameraMatrixWorld;
    const projectionMatrixInverse = this._projectionMatrixInverse;
    return Fn(() => {
      const viewPos = getViewPosition(screenUV, float(1), projectionMatrixInverse);
      const dir = cameraMatrixWorld.mul(vec4(normalize(viewPos), 0)).xyz;
      const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;
      const dirY = max(dir.y, 0.0001);
      const tStart = max(uCloudAltitude.sub(origin.y).div(dirY), 0);
      const tEnd = min(
        uCloudAltitude.add(uCloudThickness).sub(origin.y).div(dirY),
        MAX_MARCH,
      );
      const dt = max(tEnd.sub(tStart), 0).div(STEPS);
      const firstHit = float(MAX_MARCH).toVar();
      If(dir.y.greaterThan(0).and(tEnd.greaterThan(tStart)), () => {
        Loop(STEPS, ({ i }) => {
          const t = tStart.add(float(i).add(0.5).mul(dt));
          const pos = origin.add(dir.mul(t));
          const density = sampleCloudDensity({
            pos,
            shellHeightFraction: shellHeightFractionAt(pos),
            weatherNode,
            baseShapeNode,
          });
          If(density.greaterThan(0.01).and(firstHit.greaterThan(MAX_MARCH * 0.999)), () => {
            firstHit.assign(t);
          });
        });
      });
      const normalizedHit = min(firstHit.div(MAX_MARCH), 1);
      return vec4(normalizedHit, normalizedHit, normalizedHit, 1);
    });
  }
}

const _sizeScratch = /*@__PURE__*/ new Vector2();

export { CloudMarchNode };
export default CloudMarchNode;
