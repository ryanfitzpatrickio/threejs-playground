// CloudTemporalNode — temporal accumulation for the cloud march (analysis §6),
// Resolves the reduced-resolution march to full resolution, reprojects the
// previous accumulated frame, rejects stale history with hit-distance and
// neighborhood tests, and writes stable full-resolution cloud color.
//
// Stabilizes the per-frame dither + low sample count by blending each new march
// frame against a reprojected history. Reprojection assumes clouds sit at the
// slab-floor distance (no per-pixel hit-distance MRT yet — that arrives in M6
// along with subpixel jitter + Catmull-Rom upscale + neighborhood clamping), so
// there is parallax error through the slab's thickness; the low new-frame blend
// weight keeps that from ghosting badly.
//
// Ping-pong via a fixed output + a fixed history target with a copy blit (two
// fullscreen passes/frame) — chosen over texture-node swapping because it's
// reliable to author blind. The composite always samples the fixed output.

import {
  RenderTarget,
  QuadMesh,
  NodeMaterial,
  RendererUtils,
  HalfFloatType,
  RGBAFormat,
  Vector2,
  Matrix4,
  TempNode,
} from 'three/webgpu';
import {
  NodeUpdateType,
  Fn,
  float,
  vec2,
  vec4,
  max,
  min,
  abs,
  clamp,
  mix,
  select,
  normalize,
  getViewPosition,
  screenUV,
  passTexture,
  uniform,
  texture,
} from 'three/tsl';
import { uCloudAltitude } from './cloudUniforms.js';
import { uCloudMaxMarchDist } from './cloudReachUniforms.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;
const _sizeScratch = /*@__PURE__*/ new Vector2();
const _currentVP = /*@__PURE__*/ new Matrix4();

class CloudTemporalNode extends TempNode {
  constructor({ camera, marchNode, renderScale = 0.5, blend = 0.24 }) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.camera = camera;
    this.marchNode = marchNode;
    this.renderScale = renderScale;
    this.blend = blend;

    this._output = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType, format: RGBAFormat });
    this._output.texture.name = 'cloud.temporal.out';
    this._history = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType, format: RGBAFormat });
    this._history.texture.name = 'cloud.temporal.history';
    this._hitHistory = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType, format: RGBAFormat });
    this._hitHistory.texture.name = 'cloud.temporal.hitHistory';

    this._cameraMatrixWorld = uniform(camera.matrixWorld);
    this._projectionMatrixInverse = uniform(camera.projectionMatrixInverse);
    this._prevViewProjection = uniform(new Matrix4());
    this._marchTexelSize = uniform(new Vector2(1, 1));
    this._settleBlend = uniform(1);

    this._firstFrame = true;
    this._settleFrames = 0;
    this._size = new Vector2(1, 1);

    this._material = new NodeMaterial();
    this._material.name = 'cloud.temporal';
    this._material.fragmentNode = this._buildFn()();
    this._textureNode = passTexture(this, this._output.texture);

    // Copy pass (blit) used to seed/carry history. `_copyInput` is rebound to
    // the source texture before each blit.
    this._copyInput = texture(this._output.texture);
    this._copyMaterial = new NodeMaterial();
    this._copyMaterial.name = 'cloud.temporal.copy';
    this._copyMaterial.fragmentNode = Fn(() => this._copyInput.sample(screenUV))();
  }

  getTextureNode() {
    return this._textureNode;
  }

  clearHistory() {
    this._firstFrame = true;
    this._settleFrames = 5;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this._size.x && h === this._size.y) return;
    this._size.set(w, h);
    this._output.setSize(w, h);
    this._history.setSize(w, h);
    this._hitHistory.setSize(w, h);
    this._firstFrame = true;
  }

  updateBefore(frame) {
    const { renderer } = frame;
    const size = renderer.getDrawingBufferSize(_sizeScratch);
    this.setSize(size.width, size.height);
    this._marchTexelSize.value.set(
      1 / Math.max(1, Math.round(size.width * this.renderScale)),
      1 / Math.max(1, Math.round(size.height * this.renderScale)),
    );
    this._settleBlend.value = this._settleFrames > 0
      ? Math.min(0.62, 0.28 + (5 - this._settleFrames) * 0.08)
      : this.blend;
    if (this._settleFrames > 0) this._settleFrames -= 1;

    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);

    if (this._firstFrame) {
      // Seed output + history with the raw march so the first real frame has a
      // valid history and the composite never reads cleared targets.
      this._blit(renderer, this.marchNode.getTextureNode().value, this._output);
      this._blit(renderer, this._output.texture, this._history);
      this._blit(renderer, this.marchNode.getHitDistanceNode().value, this._hitHistory);
      this._firstFrame = false;
    } else {
      _quadMesh.material = this._material;
      _quadMesh.name = 'cloud.temporal';
      renderer.setRenderTarget(this._output);
      _quadMesh.render(renderer);
      // History for next frame = this frame's accumulated output.
      this._blit(renderer, this._output.texture, this._history);
      this._blit(renderer, this.marchNode.getHitDistanceNode().value, this._hitHistory);
    }

    // Store this frame's view-projection for next frame's reprojection.
    _currentVP.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._prevViewProjection.value.copy(_currentVP);

    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  _blit(renderer, srcTexture, dstTarget) {
    this._copyInput.value = srcTexture;
    _quadMesh.material = this._copyMaterial;
    _quadMesh.name = 'cloud.temporal.copy';
    renderer.setRenderTarget(dstTarget);
    _quadMesh.render(renderer);
  }

  dispose() {
    this._output.dispose();
    this._history.dispose();
    this._hitHistory.dispose();
    this._material.dispose();
    this._copyMaterial.dispose();
  }

  _buildFn() {
    const cameraMatrixWorld = this._cameraMatrixWorld;
    const projectionMatrixInverse = this._projectionMatrixInverse;
    const prevViewProjection = this._prevViewProjection;
    const marchTexture = this.marchNode.getTextureNode();
    const historyTexture = texture(this._history.texture);
    const hitHistoryTexture = texture(this._hitHistory.texture);
    const hitTexture = this.marchNode.getHitDistanceNode();
    const texel = this._marchTexelSize;
    const blend = this._settleBlend;

    return Fn(() => {
      const uv = screenUV;
      const current = marchTexture.sample(uv);
      const currentHit = hitTexture.sample(uv).r;

      // Clamp reprojected history into a small current-frame neighborhood. This
      // removes the long bright/dark trails otherwise left by moving cloud edges.
      const c0 = current;
      const c1 = marchTexture.sample(uv.add(vec2(texel.x, 0)));
      const c2 = marchTexture.sample(uv.sub(vec2(texel.x, 0)));
      const c3 = marchTexture.sample(uv.add(vec2(0, texel.y)));
      const c4 = marchTexture.sample(uv.sub(vec2(0, texel.y)));
      const neighborhoodMin = min(min(min(c0, c1), min(c2, c3)), c4);
      const neighborhoodMax = max(max(max(c0, c1), max(c2, c3)), c4);

      // Reconstruct the world point this pixel's cloud sits at, to reproject it
      // into the previous frame. Use the march's actual first-hit distance when
      // there is a cloud sample: the old slab-floor assumption put every pixel on
      // one horizontal plane, but clouds span the full slab thickness, so at
      // shallow angles that depth error reprojected a single cloud edge onto
      // several screen rows — the horizontal "echo" bands low in the sky. Fall
      // back to the slab floor only for sky pixels (where reprojection is moot).
      const viewPos = getViewPosition(uv, float(1), projectionMatrixInverse);
      const dir = cameraMatrixWorld.mul(vec4(normalize(viewPos), 0)).xyz;
      const origin = cameraMatrixWorld.mul(vec4(0, 0, 0, 1)).xyz;
      const slabDist = uCloudAltitude.sub(origin.y).div(max(dir.y, 0.0001));
      const dist = select(currentHit.lessThan(0.999), currentHit.mul(uCloudMaxMarchDist), slabDist);
      const worldPos = origin.add(dir.mul(dist));

      // Project into the previous frame's screen space (WebGPU y-flip).
      const prevClip = prevViewProjection.mul(vec4(worldPos, 1));
      const prevUV = vec2(prevClip.x.div(prevClip.w), prevClip.y.div(prevClip.w).negate())
        .mul(0.5)
        .add(0.5);
      const lowAngle = abs(dir.y).lessThan(0.045);
      const reprojectedUV = select(lowAngle, uv, prevUV);
      const onScreen = lowAngle.or(prevClip.w
        .greaterThan(0)
        .and(prevUV.x.greaterThanEqual(0))
        .and(prevUV.x.lessThanEqual(1))
        .and(prevUV.y.greaterThanEqual(0))
        .and(prevUV.y.lessThanEqual(1)));

      const rawHistory = historyTexture.sample(reprojectedUV);
      // World-space reprojection is ill-conditioned at the horizon because the
      // slab intersection tends toward infinity. Keep that narrow band in
      // screen space and avoid clamping it to a single jittered empty sample.
      const history = select(lowAngle, rawHistory, clamp(rawHistory, neighborhoodMin, neighborhoodMax));
      const previousHit = hitHistoryTexture.sample(reprojectedUV).r;
      const hitMismatch = abs(previousHit.sub(currentHit)).greaterThan(0.035);
      const opacityMismatch = abs(history.a.sub(current.a)).greaterThan(0.35);
      const hasCloudSample = currentHit.lessThan(0.999).or(previousHit.lessThan(0.999));
      const contentValid = hitMismatch.and(hasCloudSample).not().and(opacityMismatch.not());
      const historyValid = onScreen.and(lowAngle.or(contentValid));
      // Near-horizon: favour the live march so camera motion does not smear
      // blocky half-res noise for dozens of frames.
      const lowAngleBlend = min(float(blend).mul(1.85), float(0.55));
      const historyWeight = select(lowAngle, lowAngleBlend, float(blend));
      const a = select(historyValid, historyWeight, float(1));
      return mix(history, current, a);
    });
  }
}

export { CloudTemporalNode };
export default CloudTemporalNode;
