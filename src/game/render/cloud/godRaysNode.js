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
  float,
  vec2,
  vec3,
  vec4,
  max,
  length,
  clamp,
  pow,
  dot,
  normalize,
  smoothstep,
  getViewPosition,
  screenUV,
  uniform,
  passTexture,
  select,
} from 'three/tsl';
import { uCloudAltitude, uSunDirection, uSunColor } from './cloudUniforms.js';

const _quad = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
let _rendererState;

// World metres marched along the sun through the cloud-shadow map per pixel.
const SHADOW_MARCH_METRES = 1400;

export class GodRaysNode extends TempNode {
  constructor({
    camera,
    shadowNode,
    sceneDepth,
    steps = 24,
    renderScale = 0.25,
    strength = 0.16,
  }) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.camera = camera;
    this.shadowNode = shadowNode;
    this.sceneDepth = sceneDepth;
    this.steps = Math.max(4, Math.floor(steps));
    this.renderScale = renderScale;
    this.strength = strength;
    this._cameraMatrixWorld = uniform(camera.matrixWorld);
    this._projectionMatrixInverse = uniform(camera.projectionMatrixInverse);
    this._target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType, format: RGBAFormat });
    this._target.texture.name = 'cloud.godRays';
    this._material = new NodeMaterial();
    this._material.name = 'cloud.godRays';
    this._material.fragmentNode = this._buildFn()();
    this._textureNode = passTexture(this, this._target.texture);
  }

  getTextureNode() {
    return this._textureNode;
  }

  updateBefore({ renderer }) {
    renderer.getDrawingBufferSize(_size);
    this._target.setSize(
      Math.max(1, Math.round(_size.width * this.renderScale)),
      Math.max(1, Math.round(_size.height * this.renderScale)),
    );
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);
    _quad.material = this._material;
    _quad.name = 'cloud.godRays';
    renderer.setRenderTarget(this._target);
    _quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  dispose() {
    this._target.dispose();
    this._material.dispose();
  }

  _buildFn() {
    const STEPS = this.steps;
    const projection = this.shadowNode.projection;
    const shadowTexture = this.shadowNode.getTextureNode();
    const sceneDepth = this.sceneDepth;
    const cameraMatrixWorld = this._cameraMatrixWorld;
    const projectionMatrixInverse = this._projectionMatrixInverse;
    const strength = this.strength;
    const extent = projection.extent;
    return Fn(() => {
      const depth = sceneDepth.sample(screenUV).r;
      const viewPos = getViewPosition(screenUV, depth, projectionMatrixInverse);
      const dir = cameraMatrixWorld.mul(vec4(normalize(viewPos), 0)).xyz;
      const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;
      const distanceToDeck = uCloudAltitude.sub(origin.y).div(max(dir.y, float(0.0001)));
      const world = origin.add(dir.mul(distanceToDeck));
      const shadowUV = world.xz.sub(projection.center).div(extent).add(0.5);

      const sunXZ = uSunDirection.xz;
      const sunXZLen = max(length(sunXZ), float(0.001));
      const sunStep = sunXZ.div(sunXZLen).mul(float(SHADOW_MARCH_METRES).div(extent).div(STEPS));

      const peakGap = float(0).toVar();
      const shafts = float(0).toVar();

      If(dir.y.greaterThan(0).and(uSunDirection.y.greaterThan(0.02)), () => {
        Loop(STEPS, ({ i }) => {
          const suv = shadowUV.add(sunStep.mul(float(i)));
          const transmission = shadowTexture.sample(suv).r;
          const gap = float(1).sub(transmission);
          peakGap.assign(max(peakGap, gap));
          shafts.addAssign(gap);
        });
      });

      // Peak gap finds sun-lit breaks; mean softens the response across the march.
      const shaftSignal = peakGap.mul(0.72).add(shafts.div(STEPS).mul(0.28));
      const amount = clamp(
        pow(shaftSignal, float(1.35)).mul(strength).mul(uSunDirection.y),
        0,
        0.32,
      );

      const isSky = depth.greaterThan(0.9999);
      const skyMask = select(isSky, float(1), float(0));
      const sunMask = smoothstep(0.2, 0.9, dot(normalize(dir), uSunDirection));
      const skyBand = smoothstep(0.0, 0.28, dir.y);
      const masked = amount.mul(skyMask).mul(sunMask).mul(skyBand);

      return vec4(uSunColor.mul(masked), masked);
    });
  }
}

export default GodRaysNode;
