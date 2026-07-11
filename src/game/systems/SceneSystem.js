import * as THREE from 'three';
import { CachedClipmapShadowNode } from '../render/CachedClipmapShadowNode.js';
import { getRecommendedSceneFog } from '../config/qualityPresets.js';
import { getSkyDaylightFactor, SkySystem, isDirectionalSunDaytime, VOLUMETRIC_SKY_CLEAR } from './SkySystem.js';
import { CITY_FURNITURE_LAYER } from '../render/renderLayers.js';

// Fixed offset from the shadow target to the sun. Keeping this constant while we
// move the target means the light DIRECTION never changes (shadows always fall the
// same way) — only the shadow volume translates to follow the player.
const SUN_OFFSET = new THREE.Vector3(-8, 12, 7);
const HEMISPHERE_INTENSITY = 2.2;
const SUN_INTENSITY = 3.8;
const DAY_BACKGROUND = 0xdfeeea;
const CLUSTERED_BACKGROUND = 0x07111a;
const DAY_FOG = 0xdfeeea;
const WEATHER_FOG = Object.freeze({
  clear: 0x9eb4ba,
  fog: 0x98a6a8,
  overcast: 0x819195,
  rain: 0x697b80,
});
const NIGHT_FOG = 0x08121a;
const CLUSTERED_FOG = 0x07111a;
const DEFAULT_LIGHTING_MODE = 'hemisphere';
const NIGHT_HEMISPHERE_INTENSITY = 0.28;
const NIGHT_SUN_INTENSITY = 0.18;
const STREET_LIGHT_POOL_SIZE = 24;
const STREET_LIGHT_ACTIVE_RADIUS = 82;
const STREET_LIGHT_SPACING = 30;
const CITY_CHUNK_STRIDE_X = 284;
const CITY_CHUNK_STRIDE_Z = 224;
const BLOCK_WIDTH = 120;
const BLOCK_DEPTH = 90;
const STREET_WIDTH = 22;
const SIDEWALK_INSET = 3.4;
const CORNER_SKIP = 12;
const streetLightCandidate = new THREE.Vector3();

export class SceneSystem {
  initialize(qualityPreset = {}) {
    this.scene = new THREE.Scene();
    this.scene.name = 'Dreamfall Scene';
    this.scene.background = new THREE.Color(DAY_BACKGROUND);
    const fog = qualityPreset.sceneFogFar != null
      ? { near: qualityPreset.sceneFogNear ?? 82, far: qualityPreset.sceneFogFar }
      : getRecommendedSceneFog(qualityPreset);
    this._sceneFog = new THREE.Fog(DAY_FOG, fog.near, fog.far);
    this.weather = qualityPreset.environment?.weather ?? 'clear';
    this.exteriorDistanceFog = qualityPreset.exteriorDistanceFog !== false;
    this._fogColorScratch = new THREE.Color();
    this._fogDayColorScratch = new THREE.Color();
    this._viewDistance = null;
    this.scene.fog = this._shouldUseDistanceFog() ? this._sceneFog : null;

    const hemisphere = new THREE.HemisphereLight(0xf6fbf5, 0x7f7664, HEMISPHERE_INTENSITY);
    hemisphere.name = 'Salt Marches Hemisphere Light';

    const shadowsEnabled = qualityPreset.shadows === true;
    const sun = new THREE.DirectionalLight(0xfff2cf, SUN_INTENSITY);
    sun.name = 'Low Basin Sun';
    sun.position.copy(SUN_OFFSET);
    sun.castShadow = shadowsEnabled;
    // Shadow quality driven by preset — the follow frustum keeps texel density
    // high where it matters (near the player).
    const shadowSize = qualityPreset.shadowMapSize ?? 512;
    const shadowHalf = qualityPreset.shadowFrustumHalf ?? 14;
    const shadowFar = qualityPreset.shadowFar ?? 42;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = shadowFar;
    sun.shadow.camera.left = -shadowHalf;
    sun.shadow.camera.right = shadowHalf;
    sun.shadow.camera.top = shadowHalf;
    sun.shadow.camera.bottom = -shadowHalf;
    sun.shadow.camera.layers.enable(CITY_FURNITURE_LAYER);
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.05; // base; the clipmap scales this per level texel size

    // The light's target defaults to a detached Object3D at the origin. Add it to
    // the scene so the clipmap shadow node (which reads target − position for the
    // light direction) and its level lights have a valid parent.
    this.streetLightGroup = new THREE.Group();
    this.streetLightGroup.name = 'Street Lights';
    this.streetLightPool = createStreetLightPool();
    this.streetLightPool.forEach((entry) => this.streetLightGroup.add(entry.group));
    this.scene.add(hemisphere, sun, sun.target, this.streetLightGroup);

    // Cached clipmap directional shadows: concentric texel-snapped levels around the
    // camera out to ~km, replacing the short follow-frustum so distant terrain casts
    // shadows. Camera is set later (after CameraSystem init) via setShadowCamera.
    // Low disables this entirely — each active level can re-render the whole city
    // into a shadow map every frame and was the main source of ~45 ms hitches.
    const clipmapConfig = qualityPreset.shadowClipmap ?? {};
    this.clipmapShadow = clipmapConfig.enabled === false
      ? null
      : new CachedClipmapShadowNode(sun, {
        mapSize: shadowSize,
        firstRadius: 12,
        scaleFactor: 2.6,
        maxDistance: 1200,
        dynamicLevels: 1,
        updateBudget: 1,
        ...clipmapConfig,
      }).attach();

    this.hemisphere = hemisphere;
    this.sun = sun;
    this.skySystem = new SkySystem().initialize(this.scene, {
      sun,
      hemisphere,
      qualityPreset,
    });
    this.scene.fog = this._shouldUseDistanceFog() ? this._sceneFog : null;
    this._sunUserEnabled = true;
    this.skySystem.onTimeOfDayChanged = (timeOfDay) => {
      this.syncSunVisibilityForTimeOfDay(timeOfDay);
      this.syncFogColorForTimeOfDay(timeOfDay);
    };
    this.syncSunVisibilityForTimeOfDay(this.skySystem.timeOfDay);
    this.syncFogColorForTimeOfDay(this.skySystem.timeOfDay);
    this.lightingMode = DEFAULT_LIGHTING_MODE;
    this.applyLightingMode();
    this.shadowFrustumWidth = Math.abs(sun.shadow.camera.left) + Math.abs(sun.shadow.camera.right);
    this.shadowTexelSize = this.shadowFrustumWidth / sun.shadow.mapSize.x;
    this._shadowFollow = new THREE.Vector3();
    this._shadowTargetY = 0;
    /** @type {THREE.Vector3|null} When set, shadow volume stays on this point (range warehouse). */
    this._shadowFollowFixed = null;
    /** When true, sun sits along skySystem.sunDirection instead of fixed SUN_OFFSET. */
    this._alignShadowSunToSky = false;
    this._shadowSunDistance = 90;
    this._shadowSunOffsetScratch = new THREE.Vector3();
    this.streetLightsActive = 0;
    this.streetLightsNearby = 0;
    this.streetLightsWarm = 0;
    this.streetLightsWhite = 0;

    // Cache for skipping street light culling work when player moves little.
    this._lastStreetLightPos = new THREE.Vector3();
    this._lastStreetLightPosSet = false;
  }

  setViewDistance(distance) {
    if (!Number.isFinite(distance) || distance <= 0 || !this._sceneFog) return;
    this._viewDistance = distance;
    // Pull distant terrain + horizon skirt into the sky tint before the far plane.
    this._sceneFog.near = Math.max(48, Math.floor(distance * 0.3));
    this._sceneFog.far = Math.max(this._sceneFog.near + 28, Math.floor(distance * 0.9));
    if (this._shouldUseDistanceFog()) {
      this.scene.fog = this._sceneFog;
    }
  }

  _shouldUseDistanceFog() {
    if (this.lightingMode === 'clustered') return false;
    if (this.weather === 'fog') return true;
    // Volumetric sky + terrain aerial already hide the load edge; THREE.Fog on
    // clear weather tints distant hills grey-white and reads as a flat haze band.
    if (this.skySystem?.cloudMode === 'volumetric' && this.weather === 'clear') return false;
    return this.exteriorDistanceFog === true;
  }

  // Clipmaps follow the camera themselves. When they are disabled, translate the
  // standard directional-light frustum with the active locomotion root instead.
  // Moving the light and target together preserves the sun direction, while the
  // texel-snapped horizontal target keeps the shadow projection stable.
  //
  // Range mode pins the follow point to the warehouse centre and aligns the sun
  // offset with SkySystem.sunDirection so the whole course is in one shadow
  // volume and god rays / sky / contact shadows agree on sun direction.
  updateShadowFollow(position) {
    if (this.clipmapShadow || !this.sun) return;
    const source = this._shadowFollowFixed ?? position;
    if (!source) return;

    const texelSize = this.shadowTexelSize > 0 ? this.shadowTexelSize : 1;
    const targetY = Number.isFinite(source.y) ? source.y : this._shadowTargetY;
    // Fixed warehouse centre: no lerp/snap lag so the volume never creeps.
    if (this._shadowFollowFixed) {
      this._shadowTargetY = targetY;
      this._shadowFollow.copy(this._shadowFollowFixed);
      this._shadowFollow.y = targetY;
    } else {
      this._shadowTargetY = THREE.MathUtils.lerp(this._shadowTargetY, targetY, 0.12);
      this._shadowFollow.set(
        Math.round(source.x / texelSize) * texelSize,
        this._shadowTargetY,
        Math.round(source.z / texelSize) * texelSize,
      );
    }

    this.sun.target.position.copy(this._shadowFollow);

    if (this._alignShadowSunToSky && this.skySystem?.sunDirection) {
      // Sky sunDirection is the vector toward the sun (same as sky disc).
      // DirectionalLight shines from position → target, so park the light along
      // that direction from the follow point.
      const dist = this._shadowSunDistance;
      this.sun.position
        .copy(this._shadowFollow)
        .addScaledVector(this.skySystem.sunDirection, dist);
    } else {
      this.sun.position.copy(this._shadowFollow).add(SUN_OFFSET);
    }
    this.sun.target.updateMatrixWorld(true);
    this.sun.updateMatrixWorld(true);
    this.sun.shadow?.camera?.updateMatrixWorld?.(true);
  }

  /**
   * Pin a single large shadow volume over the shooting-range warehouse and
   * drive sun offset from sky time-of-day (so far walls stay in the same map).
   * @param {{ center?: THREE.Vector3, halfExtent?: number, far?: number, sunDistance?: number, mapSize?: number }} [opts]
   */
  configureRangeShadows(opts = {}) {
    if (!this.sun?.shadow?.camera) return;
    const center = opts.center ?? new THREE.Vector3(0, 1.5, 50);
    const half = Number.isFinite(opts.halfExtent) ? opts.halfExtent : 72;
    const far = Number.isFinite(opts.far) ? opts.far : 220;
    const sunDistance = Number.isFinite(opts.sunDistance) ? opts.sunDistance : 100;
    const mapSize = Number.isFinite(opts.mapSize) ? opts.mapSize : this.sun.shadow.mapSize.x;

    this._shadowFollowFixed = center.clone();
    this._alignShadowSunToSky = true;
    this._shadowSunDistance = sunDistance;

    if (mapSize > 0 && this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      // Force rebuild on next use.
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }

    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = far;
    cam.updateProjectionMatrix();

    this.shadowFrustumWidth = half * 2;
    this.shadowTexelSize = this.shadowFrustumWidth / this.sun.shadow.mapSize.x;
    this.updateShadowFollow(center);
  }

  /** Restore open-world player-follow shadows (fixed SUN_OFFSET). */
  clearRangeShadows() {
    this._shadowFollowFixed = null;
    this._alignShadowSunToSky = false;
    this._shadowSunDistance = 90;
  }

  // Set the camera the clipmap shadow centers on (after CameraSystem init).
  setShadowCamera(camera) {
    this.clipmapShadow?.setCamera(camera);
  }

  dispose() {
    this.skySystem?.dispose();
    this.skySystem = null;
    this.clipmapShadow?.dispose();
    this.clipmapShadow = null;
  }

  updateStreetLights(position) {
    if (!position || this.lightingMode !== 'clustered') {
      this.setStreetLightCount(0);
      this._lastStreetLightPosSet = false;
      return;
    }

    if (this._lastStreetLightPosSet) {
      const dx = position.x - this._lastStreetLightPos.x;
      const dz = position.z - this._lastStreetLightPos.z;
      if (dx * dx + dz * dz < 1.0) {
        // Player moved <1m; lights culling/positions unchanged, skip math + writes.
        return;
      }
    }

    const candidates = collectStreetLightCandidates(position);
    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    const active = Math.min(candidates.length, this.streetLightPool.length);
    let warm = 0;
    let white = 0;

    for (let index = 0; index < this.streetLightPool.length; index += 1) {
      const entry = this.streetLightPool[index];
      const candidate = candidates[index];
      const visible = index < active && Boolean(candidate);

      entry.group.visible = visible;
      entry.light.visible = visible;

      if (!visible) {
        continue;
      }

      entry.group.position.set(candidate.x, candidate.y, candidate.z);
      applyStreetLightStyle(entry, candidate.kind);
      if (candidate.kind === 'warm') warm += 1;
      if (candidate.kind === 'white') white += 1;
    }

    this.streetLightsActive = active;
    this.streetLightsNearby = candidates.length;
    this.streetLightsWarm = warm;
    this.streetLightsWhite = white;

    this._lastStreetLightPos.set(position.x, 0, position.z);
    this._lastStreetLightPosSet = true;
  }

  setLightingMode(mode = 'hemisphere') {
    this.lightingMode = mode === 'clustered' ? 'clustered' : 'hemisphere';
    this.applyLightingMode();
    return this.snapshot();
  }

  applyLightingMode() {
    if (this.lightingMode === 'clustered') {
      this.hemisphere.intensity = NIGHT_HEMISPHERE_INTENSITY;
      this.sun.intensity = NIGHT_SUN_INTENSITY;
      this.skySystem?.setVisible(false);
      this.scene.background = new THREE.Color(CLUSTERED_BACKGROUND);
      this.scene.fog?.color.setHex(CLUSTERED_FOG);
      this.streetLightGroup.visible = true;
    } else {
      this.skySystem?.setVisible(true);
      this.scene.background = this.skySystem?.cloudMode === 'volumetric'
        ? new THREE.Color(VOLUMETRIC_SKY_CLEAR)
        : null;
      this.skySystem?.setTimeOfDay(this.skySystem.timeOfDay);
      this.syncFogColorForTimeOfDay(this.skySystem?.timeOfDay ?? 0.72);
      this.streetLightGroup.visible = false;
      this.setStreetLightCount(0);
    }
  }

  setStreetLightCount(count) {
    for (let index = 0; index < this.streetLightPool.length; index += 1) {
      const visible = index < count;
      this.streetLightPool[index].group.visible = visible;
      this.streetLightPool[index].light.visible = visible;
    }
    this.streetLightsActive = count;
    this.streetLightsNearby = 0;
    this.streetLightsWarm = 0;
    this.streetLightsWhite = 0;
  }

  setSceneFogEnabled(enabled) {
    if (enabled) {
      if (this._sceneFog && this.scene.fog !== this._sceneFog) this.scene.fog = this._sceneFog;
    } else if (!this._shouldUseDistanceFog()) {
      this.scene.fog = null;
    }
    return this.snapshot();
  }

  setWeather(weather = 'clear') {
    this.weather = Object.hasOwn(WEATHER_FOG, weather) ? weather : 'clear';
    this.syncFogColorForTimeOfDay(this.skySystem?.timeOfDay ?? 0.72);
    this.scene.fog = this._shouldUseDistanceFog() ? this._sceneFog : null;
    return this.weather;
  }

  syncFogColorForTimeOfDay(timeOfDay) {
    if (!this._sceneFog || this.lightingMode === 'clustered') return;
    const daylight = getSkyDaylightFactor(timeOfDay);
    const dayColor = WEATHER_FOG[this.weather] ?? WEATHER_FOG.clear;
    this._fogDayColorScratch.setHex(dayColor);
    this._fogColorScratch.setHex(NIGHT_FOG).lerp(this._fogDayColorScratch, daylight);
    this._sceneFog.color.copy(this._fogColorScratch);
  }

  setStreetLightsVisible(enabled) {
    if (this.streetLightGroup) this.streetLightGroup.visible = enabled;
    if (!enabled) this.setStreetLightCount(0);
    return this.snapshot();
  }

  syncSunVisibilityForTimeOfDay(timeOfDay) {
    if (!this.sun) return;
    const daytime = isDirectionalSunDaytime(timeOfDay);
    this.sun.visible = this._sunUserEnabled && daytime;
  }

  setSunEnabled(enabled) {
    this._sunUserEnabled = Boolean(enabled);
    this.syncSunVisibilityForTimeOfDay(this.skySystem?.timeOfDay ?? 0.72);
    return this.snapshot();
  }

  setHemisphereEnabled(enabled) {
    if (this.hemisphere) this.hemisphere.visible = enabled;
    return this.snapshot();
  }

  snapshot() {
    const sun = this.sun;
    return {
      lightingMode: this.lightingMode,
      clusteredTestLightCount: this.streetLightsActive,
      sceneFogEnabled: Boolean(this.scene.fog),
      streetLightsVisible: this.streetLightGroup?.visible ?? false,
      sunUserEnabled: this._sunUserEnabled ?? true,
      sunVisible: sun ? sun.visible : true,
      hemisphereVisible: this.hemisphere ? this.hemisphere.visible : true,
      streetLights: {
        active: this.streetLightsActive,
        nearby: this.streetLightsNearby,
        warm: this.streetLightsWarm,
        white: this.streetLightsWhite,
        pool: this.streetLightPool?.length ?? 0,
        radius: STREET_LIGHT_ACTIVE_RADIUS,
      },
      hemisphereIntensity: this.hemisphere ? round3(this.hemisphere.intensity) : null,
      sunIntensity: sun ? sun.intensity : null,
      background: this.scene.background?.isColor ? `#${this.scene.background.getHexString()}` : null,
      fog: this.scene.fog?.color ? `#${this.scene.fog.color.getHexString()}` : null,
      shadowMapSize: sun ? sun.shadow.mapSize.x : null,
      shadowFrustum: sun ? Math.abs(sun.shadow.camera.left) + Math.abs(sun.shadow.camera.right) : null,
      shadowTarget: sun ? [round3(sun.target.position.x), round3(sun.target.position.y), round3(sun.target.position.z)] : null,
      sky: this.skySystem?.snapshot() ?? null,
    };
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function createStreetLightPool() {
  return Array.from({ length: STREET_LIGHT_POOL_SIZE }, () => createStreetLightFixture());
}

function createStreetLightFixture() {
  const group = new THREE.Group();
  group.name = 'Pooled Street Light';
  group.visible = false;

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.075, 3.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x2f3539, roughness: 0.64, metalness: 0.35 }),
  );
  pole.name = 'Street Light Pole';
  pole.position.y = 1.75;
  pole.castShadow = false;
  group.add(pole);

  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.07, 0.07),
    pole.material,
  );
  arm.name = 'Street Light Arm';
  arm.position.set(0.42, 3.42, 0);
  arm.castShadow = false;
  group.add(arm);

  const headMaterial = new THREE.MeshStandardMaterial({
    color: 0xf6efe0,
    emissive: 0xffc45f,
    emissiveIntensity: 1.2,
    roughness: 0.32,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.28), headMaterial);
  head.name = 'Street Light Head';
  head.position.set(0.98, 3.36, 0);
  head.castShadow = false;
  group.add(head);

  const light = new THREE.PointLight(0xffbd62, 58, 15, 2);
  light.name = 'Pooled Clustered Street Light';
  light.position.set(0.98, 3.18, 0);
  light.visible = false;
  group.add(light);

  return { group, light, head, headMaterial };
}

function collectStreetLightCandidates(position) {
  const candidates = [];
  const seen = new Set();
  const chunkX = Math.round(position.x / CITY_CHUNK_STRIDE_X);
  const chunkZ = Math.round(position.z / CITY_CHUNK_STRIDE_Z);
  const maxDistanceSq = STREET_LIGHT_ACTIVE_RADIUS * STREET_LIGHT_ACTIVE_RADIUS;

  for (let cx = chunkX - 1; cx <= chunkX + 1; cx += 1) {
    for (let cz = chunkZ - 1; cz <= chunkZ + 1; cz += 1) {
      const originX = cx * CITY_CHUNK_STRIDE_X;
      const originZ = cz * CITY_CHUNK_STRIDE_Z;
      addChunkSidewalkLightCandidates(candidates, seen, position, originX, originZ, maxDistanceSq);
    }
  }

  return candidates;
}

function addChunkSidewalkLightCandidates(candidates, seen, position, originX, originZ, maxDistanceSq) {
  const baseX = originX - (BLOCK_WIDTH * 2 + STREET_WIDTH) * 0.5;
  const baseZ = originZ - (BLOCK_DEPTH * 2 + STREET_WIDTH) * 0.5;

  for (let bx = 0; bx < 2; bx += 1) {
    for (let bz = 0; bz < 2; bz += 1) {
      const minX = baseX + bx * (BLOCK_WIDTH + STREET_WIDTH);
      const maxX = minX + BLOCK_WIDTH;
      const minZ = baseZ + bz * (BLOCK_DEPTH + STREET_WIDTH);
      const maxZ = minZ + BLOCK_DEPTH;
      addBlockEdgeCandidates(candidates, seen, position, {
        axis: 'x',
        start: minX + CORNER_SKIP,
        end: maxX - CORNER_SKIP,
        fixedA: minZ + SIDEWALK_INSET,
        fixedB: maxZ - SIDEWALK_INSET,
      }, maxDistanceSq);
      addBlockEdgeCandidates(candidates, seen, position, {
        axis: 'z',
        start: minZ + CORNER_SKIP,
        end: maxZ - CORNER_SKIP,
        fixedA: minX + SIDEWALK_INSET,
        fixedB: maxX - SIDEWALK_INSET,
      }, maxDistanceSq);
    }
  }
}

function addBlockEdgeCandidates(candidates, seen, position, edge, maxDistanceSq) {
  const first = Math.ceil(edge.start / STREET_LIGHT_SPACING) * STREET_LIGHT_SPACING;
  for (let along = first; along <= edge.end; along += STREET_LIGHT_SPACING) {
    addStreetLightCandidate(candidates, seen, position, edge, along, edge.fixedA, maxDistanceSq);
    addStreetLightCandidate(candidates, seen, position, edge, along, edge.fixedB, maxDistanceSq);
  }
}

function addStreetLightCandidate(candidates, seen, position, run, along, fixed, maxDistanceSq) {
  const x = run.axis === 'x' ? along : fixed;
  const z = run.axis === 'x' ? fixed : along;
  const key = `${Math.round(x * 100)}:${Math.round(z * 100)}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  streetLightCandidate.set(x, 0, z);
  const distanceSq = streetLightCandidate.distanceToSquared(position);

  if (distanceSq > maxDistanceSq) {
    return;
  }

  const gridX = Math.round((x + 10000) / STREET_LIGHT_SPACING);
  const gridZ = Math.round((z + 10000) / STREET_LIGHT_SPACING);
  candidates.push({
    x,
    y: 0,
    z,
    distanceSq,
    kind: (gridX + gridZ * 2) % 4 === 0 ? 'white' : 'warm',
  });
}

function applyStreetLightStyle(entry, kind) {
  if (kind === 'white') {
    entry.light.color.setHex(0xf4fbff);
    entry.light.intensity = 70;
    entry.light.distance = 17;
    entry.headMaterial.emissive.setHex(0xf4fbff);
    entry.headMaterial.color.setHex(0xe9f3f7);
    entry.headMaterial.emissiveIntensity = 1.6;
  } else {
    entry.light.color.setHex(0xffbd62);
    entry.light.intensity = 58;
    entry.light.distance = 15;
    entry.headMaterial.emissive.setHex(0xffbd62);
    entry.headMaterial.color.setHex(0xf6efe0);
    entry.headMaterial.emissiveIntensity = 1.25;
  }
}
