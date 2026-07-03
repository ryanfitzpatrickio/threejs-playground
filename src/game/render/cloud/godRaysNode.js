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
  clamp,
  normalize,
  getViewPosition,
  screenUV,
  uniform,
  passTexture,
} from 'three/tsl';
import { uCloudAltitude, uSunDirection, uSunColor } from './cloudUniforms.js';

const _quad = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
let _rendererState;

export class GodRaysNode extends TempNode {
  constructor({ camera, shadowNode, steps = 24, renderScale = 0.25, strength = 0.16 }) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.camera = camera;
    this.shadowNode = shadowNode;
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
    const cameraMatrixWorld = this._cameraMatrixWorld;
    const projectionMatrixInverse = this._projectionMatrixInverse;
    const strength = this.strength;
    return Fn(() => {
      const viewPos = getViewPosition(screenUV, float(1), projectionMatrixInverse);
      const dir = cameraMatrixWorld.mul(vec4(normalize(viewPos), 0)).xyz;
      const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;
      const distanceToDeck = uCloudAltitude.sub(origin.y).div(max(dir.y, 0.0001));
      const world = origin.add(dir.mul(distanceToDeck));
      const shadowUV = world.xz.sub(projection.center).div(projection.extent).add(0.5);
      const sunStep = uSunDirection.xz.mul(0.18).div(STEPS);
      const shafts = float(0).toVar();

      If(dir.y.greaterThan(0).and(uSunDirection.y.greaterThan(0.02)), () => {
        Loop(STEPS, ({ i }) => {
          const suv = shadowUV.add(sunStep.mul(float(i)));
          const transmission = shadowTexture.sample(suv).r;
          shafts.addAssign(float(1).sub(transmission));
        });
      });

      const amount = clamp(shafts.div(STEPS).mul(strength).mul(uSunDirection.y), 0, 0.3);
      return vec4(uSunColor.mul(amount), amount);
    });
  }
}

export default GodRaysNode;
