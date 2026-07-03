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
  float,
  vec2,
  vec3,
  vec4,
  max,
  exp,
  uv,
  uniform,
  passTexture,
} from 'three/tsl';
import {
  uCloudAltitude,
  uCloudThickness,
  uCloudDensity,
  uSunDirection,
} from './cloudUniforms.js';
import { sampleCloudDensity, shellHeightFractionAt } from './cloudDensity.js';

const _quad = /*@__PURE__*/ new QuadMesh();
let _rendererState;

export class CloudShadowNode extends TempNode {
  constructor({ weatherNode, baseShapeNode, resolution = 512, extent = 3200, steps = 12, updateInterval = 2 }) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.weatherNode = weatherNode;
    this.baseShapeNode = baseShapeNode;
    this.resolution = Math.max(64, Math.floor(resolution));
    this.extent = uniform(Math.max(200, extent));
    this.center = uniform(new Vector2());
    this.intensity = uniform(0.72);
    this.enabled = uniform(1);
    this.steps = Math.max(4, Math.floor(steps));
    this.updateInterval = Math.max(1, Math.floor(updateInterval));
    this._frame = 0;
    this._hasRendered = false;

    this._target = new RenderTarget(this.resolution, this.resolution, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat,
    });
    this._target.texture.name = 'cloud.shadow';
    this._material = new NodeMaterial();
    this._material.name = 'cloud.shadow';
    this._material.fragmentNode = this._buildFn()();
    this._textureNode = passTexture(this, this._target.texture);
  }

  getTextureNode() {
    return this._textureNode;
  }

  setCenter(position) {
    this.center.value.set(position.x, position.z);
  }

  get projection() {
    return {
      center: this.center,
      axisU: [1, 0],
      axisV: [0, 1],
      extent: this.extent,
      intensity: this.intensity,
      enabled: this.enabled,
    };
  }

  updateBefore({ renderer }) {
    this._frame += 1;
    if (this._hasRendered && this._frame % this.updateInterval !== 0) return;
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);
    _quad.material = this._material;
    _quad.name = 'cloud.shadow';
    renderer.setRenderTarget(this._target);
    _quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, _rendererState);
    this._hasRendered = true;
  }

  dispose() {
    this._target.dispose();
    this._material.dispose();
  }

  _buildFn() {
    const STEPS = this.steps;
    const center = this.center;
    const extent = this.extent;
    const weatherNode = this.weatherNode;
    const baseShapeNode = this.baseShapeNode;
    return Fn(() => {
      const mapUV = uv();
      const groundXZ = center.add(mapUV.sub(0.5).mul(extent));
      const sunY = max(uSunDirection.y, 0.12);
      const opticalDepth = float(0).toVar();
      const stepY = uCloudThickness.div(STEPS);

      Loop(STEPS, ({ i }) => {
        const height = float(i).add(0.5).mul(stepY);
        const y = uCloudAltitude.add(height);
        // Follow the sun ray through the slab so the projected shadow shifts
        // naturally with sun elevation instead of remaining directly overhead.
        const shift = uSunDirection.xz.mul(uCloudThickness.sub(height).div(sunY));
        const sampleXZ = groundXZ.add(shift);
        const pos = vec3(sampleXZ.x, y, sampleXZ.y);
        const density = sampleCloudDensity({
          pos,
          shellHeightFraction: shellHeightFractionAt(pos),
          weatherNode,
          baseShapeNode,
        });
        opticalDepth.addAssign(density.mul(stepY));
      });

      const transmission = exp(opticalDepth.mul(uCloudDensity).negate());
      return vec4(transmission, transmission, transmission, 1);
    });
  }
}

export default CloudShadowNode;
