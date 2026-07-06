/**
 * CachedClipmapShadowNode.js
 *
 * Cached clipmap shadows for directional lights (WebGPU/TSL). Renders concentric
 * square shadow-map levels around a camera in light space. Each level is a normal
 * Three.js shadow map with stable texel snapping; coarse levels stay cached across
 * frames while near levels update continuously for dynamic casters.
 *
 * Ported to JS from the provided TypeScript implementation. Integration matches the
 * shipped examples/jsm/tsl/shadows/TileShadowNode.js contract:
 *   const node = new CachedClipmapShadowNode(sunLight, opts).attach();
 *   node.setCamera(gameCamera);
 * The renderer drives setup()/updateBefore() once the node is attached to the
 * light's shadow.
 */

import {
  Object3D,
  Vector3,
  Vector4,
  Matrix4,
  MathUtils,
  ShadowBaseNode,
  ShadowNode,
} from 'three/webgpu';
import {
  reference,
  uniform,
  renderGroup,
  shadowPositionWorld,
  Fn,
  vec4,
  float,
  smoothstep,
  max,
  abs,
} from 'three/tsl';
import { CITY_FURNITURE_LAYER } from './renderLayers.js';

const ORIGIN = new Vector3();
const up = new Vector3(0, 1, 0);
const lightDirection = new Vector3();
const lightOrientationMatrix = new Matrix4();
const cameraWorldPosition = new Vector3();
const cameraLightPosition = new Vector3();
const levelCenter = new Vector3();
const regionCenter = new Vector3();

class ClipmapLight extends Object3D {
  constructor() {
    super();
    this.target = new Object3D();
    this.castShadow = true;
    this.shadow = null;
  }
}

export class CachedClipmapShadowNode extends ShadowBaseNode {
  constructor(light, options = {}) {
    super(light);

    this.light = light;
    this.camera = options.camera ?? null;

    if (options.mapSize !== undefined) {
      light.shadow.mapSize.set(options.mapSize, options.mapSize);
    }

    const firstRadius = Math.max(options.firstRadius ?? 12, 1);
    const scaleFactor = Math.max(options.scaleFactor ?? 2.5, 1.5);
    this.maxDistance = options.maxDistance ?? 2_000;
    this.levels =
      options.levels ??
      Math.max(
        1,
        Math.ceil(Math.log(this.maxDistance / firstRadius) / Math.log(scaleFactor)) + 1,
      );

    this._halfWidths = [];
    for (let i = 0; i < this.levels; i++) {
      const halfWidth = Math.min(firstRadius * scaleFactor ** i, this.maxDistance);
      this._halfWidths.push(i === this.levels - 1 ? this.maxDistance : halfWidth);
    }

    this.lightMargin = options.lightMargin ?? 100;
    this.shadowCameraNear = options.shadowCameraNear ?? 1;
    this.shadowCameraFar = options.shadowCameraFar ?? 3_000;
    this.guardBand = MathUtils.clamp(options.guardBand ?? 0.15, 0.02, 0.5);
    this.blendRatio = MathUtils.clamp(options.blendRatio ?? 0.15, 0.01, 0.9);
    this.dynamicLevels = MathUtils.clamp(options.dynamicLevels ?? 2, 0, this.levels);
    // Fractions intentionally spread cached-level refreshes across frames.
    // Clamping to 1 silently defeated Ultra's 0.5 budget and forced one full
    // cached level (hundreds of draws) to render every frame while driving.
    this.updateBudget = Math.max(options.updateBudget ?? 2, 0);
    this.maxCacheAge = Math.max(options.maxCacheAge ?? 64, 0);
    // Coarser (outer) levels get progressively lower shadow-map resolution — the
    // standard cascaded-shadow technique (distant shadows don't need fine detail)
    // — which ALSO makes their texel grid coarser. That matters here beyond just
    // GPU cost: the "moved" re-render trigger snaps to a whole texel, so with every
    // level sharing one resolution, a mid-radius level's texel was tiny relative to
    // its huge coverage area and tripped "moved" on nearly every frame of normal
    // camera movement — defeating the cache and re-traversing (and redrawing) every
    // caster in that level's radius far more often than intended. Halving
    // resolution per level (floored at minLevelMapSize) was measured to cut a
    // representative mid-level's redraw rate from ~30-100% of frames while driving
    // down to a small fraction, with no visible loss (that level's coverage radius
    // — and thus its texel's absolute world size — is unchanged, it's still
    // proportioned the same way the innermost level is).
    this.minLevelMapSize = Math.max(64, options.minLevelMapSize ?? 256);
    this._directionCos = Math.cos(options.directionEpsilon ?? 0.002);

    this.lights = [];
    this._levelStates = [];
    this._levelData = [];
    this._shadowNodes = [];
    this._worldToLight = new Matrix4();
    this._lastDirection = new Vector3();
    this._baseBias = 0;
    this._baseNormalBias = 0;
    this._firstUpdate = true;
    this._initialized = false;
  }

  attach() {
    this.light.shadow.shadowNode = this;
    return this;
  }

  detach() {
    if (this.light.shadow.shadowNode === this) delete this.light.shadow.shadowNode;
    return this;
  }

  setCamera(camera) {
    this.camera = camera;
    return this;
  }

  setup(builder) {
    if (!this._initialized) this.init(this.camera ?? builder.camera);

    const levelData = reference('_levelData', 'vec4', this)
      .setGroup(renderGroup)
      .setName('clipmapLevels');
    const worldToLight = uniform(this._worldToLight)
      .setGroup(renderGroup)
      .setName('clipmapWorldToLight');

    return Fn((fnBuilder) => {
      this.setupShadowPosition(fnBuilder);

      const lightPos = worldToLight.mul(vec4(shadowPositionWorld, 1)).xy.toVar('clipmapPosition');

      const accumulated = vec4(0, 0, 0, 0).toVar('clipmapShadow');
      const remaining = float(1).toVar('clipmapRemaining');

      for (let i = 0; i < this.levels; i++) {
        const level = vec4().toVar(`clipmapLevel${i}`);
        level.assign(levelData.element(i));

        // Chebyshev distance from this level's rendered center; level.z is its
        // sampled half-width, so containment stays correct even while the level
        // waits in the update queue.
        const levelDistance = max(
          abs(lightPos.x.sub(level.x)),
          abs(lightPos.y.sub(level.y)),
        );

        const fade = float(1).sub(
          smoothstep(level.z.mul(1 - this.blendRatio), level.z, levelDistance),
        );
        const weight = fade.mul(remaining);

        // The shadow sample must be evaluated in uniform control flow (no per-pixel
        // If gate), so evaluate unconditionally then weight. Unselected levels get
        // weight 0 and contribute nothing.
        accumulated.addAssign(this._shadowNodes[i].mul(weight));
        remaining.mulAssign(float(1).sub(fade));
      }

      // Leftover weight = "outside all levels" → unshadowed, a smooth distance fade.
      return accumulated.add(vec4(remaining));
    })();
  }

  updateBefore(frame) {
    if (!this.camera || !this.light.parent) return;

    for (const levelLight of this.lights) {
      if (levelLight.parent === null) {
        this.light.parent.add(levelLight.target);
        this.light.parent.add(levelLight);
      }
    }

    lightDirection.subVectors(this.light.target.position, this.light.position).normalize();
    lightOrientationMatrix.lookAt(ORIGIN, lightDirection, up);
    this._worldToLight.copy(lightOrientationMatrix).invert();

    const directionChanged = lightDirection.dot(this._lastDirection) < this._directionCos;
    if (directionChanged) this._lastDirection.copy(lightDirection);

    cameraWorldPosition.setFromMatrixPosition(this.camera.matrixWorld);
    cameraLightPosition.copy(cameraWorldPosition).applyMatrix4(this._worldToLight);

    // Fractional budgets are allowed (e.g. 0.5 = one cached-level re-render
    // every other frame): while driving fast every level crosses its texel-snap
    // threshold continuously, so an integer budget of 1 means a full cached
    // level (hundreds of draws) re-renders EVERY frame. The accumulator drips
    // whole renders at the configured average rate; the dynamic level(s) are
    // exempt and still render every frame.
    const fullRefresh = this._firstUpdate || directionChanged;
    this._budgetAccumulator = fullRefresh
      ? 0 // levels are all fresh after a full refresh; restart the drip
      : Math.min(
        (this._budgetAccumulator ?? 0) + this.updateBudget,
        Math.max(1, this.updateBudget),
      );
    let budget = fullRefresh ? this.levels : Math.floor(this._budgetAccumulator);
    this._firstUpdate = false;

    let baseTexelWidth = 0;

    for (let i = 0; i < this.levels; i++) {
      const state = this._levelStates[i];
      const levelLight = this.lights[i];
      const shadow = levelLight.shadow;
      const shadowCamera = shadow.camera;
      const texelWidth = (shadowCamera.right - shadowCamera.left) / shadow.mapSize.width;
      if (i === 0) baseTexelWidth = texelWidth;

      // Per-level bias: coarser levels have larger texels → more world-space normal
      // bias. Keep depth bias as-is; scale only normalBias by texel footprint.
      const texelScale = baseTexelWidth > 0 ? texelWidth / baseTexelWidth : 1;
      shadow.bias = this._baseBias;
      shadow.normalBias = this._baseNormalBias * texelScale;

      state.age++;

      // Snap the level center to a whole number of texels (standard clipmap
      // stabilization): the ortho projection slides in exact one-texel increments,
      // so each level's texel grid is fixed in world space and shadows never lurch.
      const desiredX = Math.round(cameraLightPosition.x / texelWidth) * texelWidth;
      const desiredY = Math.round(cameraLightPosition.y / texelWidth) * texelWidth;
      // Z only controls re-render cadence (depth has no texel grid to shimmer).
      const quantumZ = state.halfWidth * 0.5;
      const desiredZ = Math.round(cameraLightPosition.z / quantumZ) * quantumZ;

      const isDynamic = i < this.dynamicLevels;
      const moved =
        desiredX !== state.centerX || desiredY !== state.centerY || desiredZ !== state.centerZ;
      const expired = this.maxCacheAge > 0 && state.age >= this.maxCacheAge;
      const dirty =
        isDynamic || !state.valid || state.forceDirty || moved || expired || directionChanged;

      const canRender = isDynamic || budget > 0;

      if (dirty && canRender) {
        if (!isDynamic) {
          budget--;
          if (!fullRefresh) this._budgetAccumulator -= 1;
        }
        state.centerX = desiredX;
        state.centerY = desiredY;
        state.centerZ = desiredZ;
        state.valid = true;
        state.forceDirty = false;
        state.age = 0;

        // The light sits lightMargin above the level's receiver volume; the far
        // plane (set in init) reaches exactly to its bottom.
        levelCenter.set(desiredX, desiredY, desiredZ + state.halfWidth + this.lightMargin);
        levelCenter.applyMatrix4(lightOrientationMatrix);
        levelLight.position.copy(levelCenter);
        levelLight.target.position.copy(levelCenter).add(lightDirection);

        levelLight.updateMatrixWorld(true);
        levelLight.target.updateMatrixWorld(true);

        shadow.needsUpdate = true;
        const shadowNode = this._shadowNodes[i];
        if (shadowNode.shadowMap) {
          shadowNode.updateShadow(frame);
          shadow.needsUpdate = false;
        }
      }

      // Publish the level's committed center to the shader every frame (not only on
      // re-render) so the shader's containment test always matches map content.
      if (state.valid) {
        this._levelData[i].set(
          state.centerX,
          state.centerY,
          state.halfWidth * (1 - this.guardBand),
          0,
        );
      }
    }
  }

  invalidate(worldBounds) {
    if (!worldBounds) {
      for (const state of this._levelStates) state.forceDirty = true;
      return;
    }
    regionCenter.copy(worldBounds.center).applyMatrix4(this._worldToLight);
    for (const state of this._levelStates) {
      const reach = state.halfWidth + worldBounds.radius;
      if (
        Math.abs(regionCenter.x - state.centerX) < reach &&
        Math.abs(regionCenter.y - state.centerY) < reach
      ) {
        state.forceDirty = true;
      }
    }
  }

  dispose() {
    this.detach();
    for (const shadowNode of this._shadowNodes) shadowNode.dispose?.();
    for (const levelLight of this.lights) {
      levelLight.shadow?.dispose();
      levelLight.parent?.remove(levelLight);
      levelLight.target.parent?.remove(levelLight.target);
    }
    super.dispose?.();
  }

  init(camera) {
    this.camera = camera;
    this._initialized = true;
    this._baseBias = this.light.shadow.bias;
    this._baseNormalBias = this.light.shadow.normalBias;

    const baseMapSize = this.light.shadow.mapSize.x;

    for (let i = 0; i < this.levels; i++) {
      const halfWidth = this._halfWidths[i];
      const levelLight = new ClipmapLight();
      const levelShadow = this.light.shadow.clone();
      const levelMapSize = Math.max(this.minLevelMapSize, Math.round(baseMapSize / (4 ** i)));
      levelShadow.mapSize.set(levelMapSize, levelMapSize);
      levelShadow.camera.left = -halfWidth;
      levelShadow.camera.right = halfWidth;
      levelShadow.camera.top = halfWidth;
      levelShadow.camera.bottom = -halfWidth;
      levelShadow.camera.near = this.shadowCameraNear;
      levelShadow.camera.far = Math.max(
        this.shadowCameraNear + 1,
        Math.min(this.shadowCameraFar, this.lightMargin + halfWidth * 2),
      );
      levelShadow.camera.updateProjectionMatrix();
      levelShadow.camera.layers.enable(CITY_FURNITURE_LAYER);
      // All levels are driven manually after repositioning their light.
      levelShadow.autoUpdate = false;
      levelShadow.needsUpdate = false;
      levelLight.shadow = levelShadow;
      this.lights.push(levelLight);
      this._shadowNodes.push(new BoundedShadowNode(levelLight, levelShadow));

      // Park unrendered levels far away with a tiny extent so they never win
      // selection (and never divide by a zero-width fade band).
      this._levelData.push(new Vector4(1e9, 1e9, 1e-6, 0));
      this._levelStates.push({
        halfWidth,
        centerX: Number.NaN,
        centerY: Number.NaN,
        centerZ: Number.NaN,
        valid: false,
        forceDirty: false,
        // Stagger periodic refreshes so levels never expire on the same frame.
        age: Math.floor(-(i * this.maxCacheAge) / Math.max(this.levels, 1)),
      });
    }
  }
}

class BoundedShadowNode extends ShadowNode {
  constructor(light, shadow) {
    super(light, shadow);
  }

  setupShadowFilter(_builder, args) {
    const { filterFn, depthTexture, shadowCoord, shadow, depthLayer } = args;
    const inShadowProjection = shadowCoord.x
      .greaterThanEqual(0)
      .and(shadowCoord.x.lessThanEqual(1))
      .and(shadowCoord.y.greaterThanEqual(0))
      .and(shadowCoord.y.lessThanEqual(1))
      .and(shadowCoord.z.greaterThanEqual(0))
      .and(shadowCoord.z.lessThanEqual(1));

    const shadowValue = filterFn({ depthTexture, shadowCoord, shadow, depthLayer });
    return inShadowProjection.select(shadowValue, float(1));
  }
}
