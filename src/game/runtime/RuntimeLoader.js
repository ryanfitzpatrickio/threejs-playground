import * as THREE from 'three';
import { rainWind } from '../systems/weatherUniforms.js';
import { syncTerrainViewDistance, syncTerrainAtmosphereFromSky } from '../systems/terrainAerialUniforms.js';
import { syncCloudReach } from '../render/cloud/cloudReachUniforms.js';
import { resolveJacketMode } from '../characters/mara/jacketConfig.js';
import { defaultGunIdFromQuery } from '../weapons/loadGunView.js';
import { BaseVehicle } from '../vehicles/BaseVehicle.js';
import { QuadBikeVehicle } from '../vehicles/QuadBikeVehicle.js';
import { spawnVehicleOptions } from '../vehicles/garageBuilds.js';
import {
  getActiveWorldMapSync,
  getRallyWorldMapSync,
} from '../../world/worldMap/worldMapScenes.js';
import { sanitizeWebGPUVertexBuffers } from '../geometry/prepareWebGPUGeometry.js';
import { installRangeEnvironment } from '../world/installRangeEnvironment.js';
import { createHordeGiController } from '../world/hordeGi.js';
import { registerBuiltinShaderDebug } from 'virtual:dreamfall-shader-debug';
import { configureRuntimeStartupEnvironment } from './configureRuntimeStartupEnvironment.js';
import {
  getOnFootFirstPerson,
  setOnFootFirstPerson,
  getCameraFeel,
  getComfortEnabled,
} from '../config/cameraComfort.js';
import {
  horseSpawnPosition,
  horseGroundHeight,
  carSpawnPosition,
  isCollisionTestMap,
  spawnCollisionTestVehicles,
} from './runtimeHelpers.js';

/**
 * Ordered async initialization and background asset streaming.
 */
export class RuntimeLoader {
  constructor(host) {
    this._host = host;
  }

  async start() {
    return startRuntime.call(this._host);
  }

  async streamAssetsInBackground() {
    return streamAssetsInBackground.call(this._host);
  }
}

async function startRuntime() {
  if (this.disposed) {
    return;
  }

  this.stage = 'loading';
  // Do not emitSnapshot yet — camera/renderer are not initialized (snapshot
  // reads camera.aspect). Progress is seeded here; first emit is after camera init.
  this.loadProgress = {
    phase: 'level',
    label: 'Starting…',
    fraction: 0,
    detail: {},
    ready: false,
  };
  this.installDebugBridge();
  this.sceneSystem.initialize(this.qualityPreset);
  // Register after sky/provider init so uniform defaults match the live preset.
  // Dev-only via virtual:dreamfall-shader-debug (prod = inert stub).
  try {
    registerBuiltinShaderDebug(this);
  } catch (err) {
    console.warn('[shader-debug] registerBuiltinShaderDebug failed', err);
  }
  await this.rendererSystem.initialize();
  if (this.disposed) {
    return;
  }
  configureRuntimeStartupEnvironment(this);

  this.cameraSystem.initialize(this.sceneSystem.scene, this.qualityPreset);
  this.cameraSystem.setComfortOptions({
    enabled: getComfortEnabled(),
    feel: getCameraFeel(),
  });
  this.cameraSystem.setOnFootFirstPerson(getOnFootFirstPerson());
  this.sceneSystem.skySystem?.attachToCamera?.(this.cameraSystem.camera);
  this.sceneSystem.setShadowCamera(this.cameraSystem.camera);
  this.enemyCutSystem.initialize(this.sceneSystem.scene, this.qualityPreset);
  this.combatSystem.initialize(this.sceneSystem.scene);
  this.cameraSystem.resize(this.rendererSystem.getViewport());
  this.inputSystem.connect();
  document.addEventListener('visibilitychange', this._onVisibilityChange);
  this.emitSnapshot();

  // Launch the animation loop immediately so the page feels instant.
  // Update() will no-op gracefully until core assets are ready.
  this.lastFrameAt = performance.now();
  await this.rendererSystem.setAnimationLoop((timeMs) => this.update(timeMs));
  if (this.disposed) {
    return;
  }

  // Stream in heavy assets in the background. The loop is already running.
  this._streamAssetsInBackground().catch((err) => {
    console.error('Asset streaming failed', err);
  });
}

async function streamAssetsInBackground() {
  const gen = this._loadGeneration;
  this._setLoadProgress({ phase: 'level', label: 'Loading world…', sub: { level: 0.05 } });

  await this.levelSystem.loadBaseLevel(this.sceneSystem.scene, this.qualityPreset, this.levelMode, this.rendererSystem.renderer);
  if (this._aborted(gen)) {
    return;
  }
  this._setLoadProgress({ phase: 'level', label: 'World loaded', sub: { level: 1 } });

  const levelViewDistance = this.levelSystem.level?.viewDistance;
  if (Number.isFinite(levelViewDistance) && levelViewDistance > 0) {
    this.cameraSystem.camera.far = levelViewDistance;
    this.cameraSystem.camera.updateProjectionMatrix();
    this.sceneSystem.setViewDistance?.(levelViewDistance);
    syncTerrainViewDistance(
      levelViewDistance,
      {
        ...(this.qualityPreset.environment ?? {}),
        terrainReach: this.levelSystem.level?.terrainReach,
      },
    );
    syncTerrainAtmosphereFromSky(
      this.sceneSystem.skySystem,
      this.qualityPreset.environment ?? {},
    );
    this.rendererSystem.setViewDistance?.(levelViewDistance);
    if (this.rendererSystem.cloudSkyProvider) {
      syncCloudReach({
        viewDistance: levelViewDistance,
        fogMaxDistance: this.rendererSystem.fogMaxDistance,
        environmentPreset: this.qualityPreset.environment ?? {},
      });
    }
  }

  this._setLoadProgress({ phase: 'character', label: 'Loading character…', sub: { character: 0.1 } });
  if (this.levelMode === 'dog-park') {
    this.characterSystem.installDogParkStub(this.sceneSystem.scene);
  } else {
    await this.characterSystem.loadMara(this.sceneSystem.scene);
  }
  if (this._aborted(gen) || !this.characterSystem.character) {
    return;
  }

  // Jacket cloth (three-simplecloth on WebGPU). Skipped when jacketExperiments is off
  // (see gameConfig); ?jacket=cloth still forces it on for one-off tuning.
  if (this.levelMode !== 'dog-park' && resolveJacketMode() !== 'off') {
    await this.characterSystem.attachJacketCloth(this.rendererSystem.renderer);
  }
  if (this._aborted(gen)) return;

  this._setLoadProgress({ phase: 'character', label: 'Character ready', sub: { character: 1 } });
  this.coreSceneReady = true;
  // Unlock stream + full render path. Never wait on near-field under 'loading'.
  this.stage = 'prewarming';
  this._prewarmingStarted = true;
  this.inputEnabled = false;
  this.simEnabled = false;
  this.emitSnapshot(performance.now(), { force: true });

  // Prewarm needs live rAF renders (pipeline batches); start under prewarming.
  const prewarmPromise = this._runPrewarm(gen);
  // Near-field wait yields so update() can pump city streaming.
  const nearFieldPromise = this._waitNearFieldReady({ generation: gen, timeoutMs: 20_000 })
    .then((ok) => {
      if (this._aborted(gen)) return;
      this._nearFieldReady = ok !== false;
      this._tryEnterRunning();
    });

  // Snap character to the actual ground height of the (possibly edited) terrain.
  // This prevents spawning inside or below the heightfield surface, which causes "stuck" behavior.
  // We do it before physics body creation so the Rapier capsule starts above the surface.
  const character = this.characterSystem.character;
  if (character && this.levelSystem.level?.spawnPoint) {
    character.group.position.copy(this.levelSystem.level.spawnPoint);
    character.group.visible = this.levelMode !== 'sims' && this.levelMode !== 'dog-park';
    if (this.levelMode === 'sims') character.hiddenForSims = true;
    if (this.levelMode === 'dog-park') character.hiddenForDogPark = true;
    if (character.velocity) character.velocity.set(0, 0, 0);
    character.verticalVelocity = 0;
  }

  if (character && typeof this.levelSystem.getGroundHeightAt === 'function') {
    const p = character.group.position;
    const ground = this.levelSystem.getGroundHeightAt(p, 0.5);
    if (Number.isFinite(ground)) {
      character.group.position.y = ground;
      if (character.velocity) character.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
      character.grounded = true;
      // clear any traversal states so it doesn't think it's stuck in a wall/ledge
      character.hang = null;
      character.mount = null;
      character.wallRun = null;
      character.wallClimb = null;
      character.vault = null;
      character.hookSwing = null;
      character.vehicle = null;
    }
  }

  await this.simsFeature.initializeAfterLevel();
  await this.dogParkFeature.initializeAfterLevel();

  this._setLoadProgress({ phase: 'systems', label: 'Loading systems…', sub: { systems: 0.05 } });

  // Rally / range / horde / highway are purpose-built scenes — skip open-world ambient systems.
  if (this.levelMode !== 'rally' && this.levelMode !== 'range' && this.levelMode !== 'horde' && this.levelMode !== 'highway' && this.levelMode !== 'sims' && this.levelMode !== 'dog-park') {
    await this.horseSystem.load(this.sceneSystem.scene, {
      position: horseSpawnPosition(character?.group.position, this.levelSystem),
      getGroundHeightAt: (position) => horseGroundHeight(this.levelSystem, position),
    });
    if (this._aborted(gen)) return;

    await this.enemySystem.load(this.sceneSystem.scene, {
      playerPosition: character?.group.position,
      level: this.levelSystem,
    });
    if (this._aborted(gen)) return;

    await this.crowdSystem.load(this.sceneSystem.scene, {
      level: this.levelSystem,
      playerPosition: character?.group.position ?? new THREE.Vector3(),
    });
    if (this._aborted(gen)) return;

    await this.propSystem.load(this.sceneSystem.scene, {
      playerPosition: character?.group.position,
      level: this.levelSystem,
    });
    if (this._aborted(gen)) return;
  }

  // Horde M2: start GLB preload while physics boots (spawn happens after).
  const hordePreloadPromise = this.levelMode === 'horde'
    ? this.enemySystem.preloadArchetypes(this.sceneSystem.scene, {
      archetypes: ['cyclop', 'tessy', 'faceless'],
    })
    : null;

  // Highway combat: preload only when debug/encounter content is requested (O6).
  // highwayMode is null outside highway — never call mode-only helpers bare.
  this._highwayDebug = this.levelMode === 'highway'
    ? Boolean(this._resolveHighwayDebugFlag?.() ?? false)
    : false;
  const highwayCombatPreloadPromise = this.levelMode === 'highway' && this._highwayDebug
    ? this.enemySystem.preloadArchetypes(this.sceneSystem.scene, {
      archetypes: ['highwayGangMember', 'soldier'],
    })
    : null;

  this._setLoadProgress({ phase: 'systems', label: 'Initializing physics…', sub: { systems: 0.45 } });

  await this.physicsSystem.initialize({
    level: this.levelSystem.level,
    character: this.characterSystem.character,
    enemies: [...this.enemySystem.enemies, ...this.propSystem.props],
  });
  if (this._aborted(gen)) {
    return;
  }

  if (hordePreloadPromise) {
    this._setLoadProgress({ phase: 'systems', label: 'Loading horde robots…', sub: { systems: 0.55 } });
    await hordePreloadPromise;
    if (this._aborted(gen)) return;
    this._setLoadProgress({ phase: 'systems', label: 'Baking horde crowd proxies…', sub: { systems: 0.62 } });
    await this.hordeProxySystem.load(this.sceneSystem.scene, {
      enemySystem: this.enemySystem,
      colliders: this.levelSystem.level?.colliders ?? null,
      getGroundHeightAt: this.levelSystem.level?.getGroundHeightAt
        ? (position, radius, options) => this.levelSystem.level.getGroundHeightAt(position, radius, options)
        : null,
    });
    if (this._aborted(gen)) return;
    // Post-init dynamic spawn path (same seam M3 HordeSystem will use).
    // Mark ready so EnemySystem.update drives AI/animation (load() is skipped
    // for arena modes and is what normally flips status idle → ready).
    this.enemySystem.status = 'ready';
    this._hordePlaygroundReady = true;
    // M6: default density/readability preset (flock + fog). Does not spawn.
    this.applyHordeSpectaclePreset('default');
    this._spawnHordeSmokeBots();
  }

  if (highwayCombatPreloadPromise) {
    this._setLoadProgress({ phase: 'systems', label: 'Loading highway combat…', sub: { systems: 0.58 } });
    await highwayCombatPreloadPromise;
    if (this._aborted(gen)) return;
    this.enemySystem.status = 'ready';
  }

  this.animationStateSystem.start({
    character: this.characterSystem.character,
  });

  this.vehicleSystem.initialize({
    physics: this.physicsSystem,
    scene: this.sceneSystem.scene,
    level: this.levelSystem,
    weatherSystem: this.weatherSystem,
    vehicleDamageSystem: this.vehicleDamageSystem,
    cameraSystem: this.cameraSystem,
  });
  this.platformRidingSystem.initialize({
    physics: this.physicsSystem,
    scene: this.sceneSystem.scene,
  });
  this.carLeapSystem.initialize({ scene: this.sceneSystem.scene });
  // Fixed-step hooks: platform capture/carry + vehicle pose capture/integration.
  // afterTick accumulates platform deltas for MovementSystem to consume.
  this.physicsSystem.stepHooks = {
    beforeTick: () => {
      // Kinematic semi trailers follow cab hitch before platform capture samples them.
      this.highwayTrafficSystem?.stepTrailers?.(this.physicsSystem.stepDt);
      this.platformRidingSystem?.captureBeforeTick?.(this.physicsSystem.stepDt);
      this.vehicleSystem?.capturePrevPoses();
    },
    integrate: (dt, tick) => this.vehicleSystem?.integrateStep(dt, tick),
    afterTick: () => {
      this.platformRidingSystem?.accumulateAfterTick?.();
    },
  };
  this.vehicleDamageSystem.initialize({
    physics: this.physicsSystem,
    scene: this.sceneSystem.scene,
  });

  this._setLoadProgress({ phase: 'systems', label: 'Spawning vehicles…', sub: { systems: 0.7 } });

  // One garage build beside the player on every map except the collision test
  // track, which spawns two autopilot chassis cars from opposite directions.
  // Indoor range and horde arena have no vehicles. Highway spawns a dedicated
  // player car plus a bounded parked-traffic pool (not open-world garage logic).
  // Fail-open: never block play-ready on chassis/audio GLB stalls.
  const VEHICLE_SPAWN_BUDGET_MS = 12_000;
  let vehicleSpawnTimer = null;
  try {
    await Promise.race([
      spawnPlayVehicles(this, character),
      new Promise((resolve) => {
        vehicleSpawnTimer = setTimeout(() => {
          console.warn('[RuntimeLoader] vehicle spawn budget exceeded; continuing load');
          resolve(null);
        }, VEHICLE_SPAWN_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    console.error('[RuntimeLoader] vehicle spawn failed', err);
  } finally {
    if (vehicleSpawnTimer !== null) clearTimeout(vehicleSpawnTimer);
  }
  if (this._aborted(gen)) {
    return;
  }

  this.hookSwingSystem.initialize(this.sceneSystem.scene);

  this.combatSystem.start({
    character: this.characterSystem.character,
  });
  this.firstPersonWeaponSystem.start({
    character: this.characterSystem.character,
  });
  // Late systems (FP weapons, etc.) can force Mara visible; re-park after they start.
  if (this.levelMode === 'sims') this.simsFeature?.parkMainPlayer?.();
  if (this.levelMode === 'dog-park') this.dogParkFeature?.parkMainPlayer?.();
  // The dog product has no weapon gameplay. Avoid creating presentation pools
  // (and loading the bullet-hole atlas) for this standalone mode.
  if (this.levelMode !== 'dog-park') {
    this.weaponSystem.initialize(this.sceneSystem.scene);
  }

  // Shooting range: force first-person + equip a gun for the session (training focus).
  if (this.levelMode === 'range') {
    this.cameraSystem.setOnFootFirstPerson(true);
    this.weaponSystem.equipAndDraw(defaultGunIdFromQuery(), {
      character: this.characterSystem.character,
      combatSystem: this.combatSystem,
      firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    });
    this.shootingRangeSystem.start(this.sceneSystem.scene, {
      spawns: this.levelSystem.level?.rangeTargets ?? [],
      doors: this.levelSystem.level?.rangeDoors ?? [],
      level: this.levelSystem.level,
    });
    const spawnYaw = this.levelSystem.level?.spawnYaw;
    if (Number.isFinite(spawnYaw) && this.characterSystem.character) {
      this.characterSystem.character.yaw = spawnYaw;
      this.cameraSystem.yaw = spawnYaw;
    }
    // Clear outdoor sky for open roof + warehouse HDR as scene.environment IBL.
    const rangeEnv = this.levelSystem.level?.rangeEnvironment ?? {};
    if (Number.isFinite(rangeEnv.timeOfDay)) {
      this.sceneSystem.skySystem?.setTimeOfDay?.(rangeEnv.timeOfDay);
    }
    this.sceneSystem.skySystem?.setWeather?.(rangeEnv.weather ?? 'clear');
    this.sceneSystem.setWeather?.(rangeEnv.weather ?? 'clear');
    this.sceneSystem.setSceneFogEnabled?.(rangeEnv.fogEnabled === true);
    this.rendererSystem.setWeather?.(rangeEnv.weather ?? 'clear');
    try {
      await installRangeEnvironment(
        this.sceneSystem.scene,
        this.rendererSystem.renderer,
        {
          intensity: rangeEnv.intensity ?? 1.05,
          rotationY: rangeEnv.environmentRotationY ?? 0.35,
          asBackground: rangeEnv.asBackground === true,
        },
      );
    } catch (err) {
      console.warn('[GameRuntime] warehouse environment failed; keeping sky PMREM', err);
      this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
      if (Number.isFinite(rangeEnv.intensity)) {
        this.sceneSystem.scene.environmentIntensity = rangeEnv.intensity;
      }
    }
  }

  // Ground carry pickups (propane tanks, etc.) authored on the level.
  this.carryItemSystem?.bindLevel?.({
    scene: this.sceneSystem.scene,
    level: this.levelSystem.level,
  });

  // Mall aquarium breach (horde centerpiece); no-ops when level has no tanks.
  this.aquariumBreachSystem?.bindLevel?.({
    scene: this.sceneSystem.scene,
    level: this.levelSystem.level,
  });

  // Shootable propane pickups (inert on levels without level.propaneTanks).
  this.propaneTankSystem?.bindLevel?.({
    scene: this.sceneSystem.scene,
    level: this.levelSystem.level,
  });

  // Horde / Deathmatch: third-person arena with normal weapon switching. Apply
  // spawn yaw and the level's environment (no forced FP / gun / range systems).
  if (this.levelMode === 'horde' || this.levelMode === 'deathmatch') {
    const spawnYaw = this.levelSystem.level?.spawnYaw;
    if (Number.isFinite(spawnYaw) && this.characterSystem.character) {
      this.characterSystem.character.yaw = spawnYaw;
      this.cameraSystem.yaw = spawnYaw;
    }
    const arenaEnv = this.levelSystem.level?.hordeEnvironment
      ?? this.levelSystem.level?.deathmatchEnvironment
      ?? {};
    if (Number.isFinite(arenaEnv.timeOfDay)) {
      this.sceneSystem.skySystem?.setTimeOfDay?.(arenaEnv.timeOfDay);
    }
    this.sceneSystem.skySystem?.setWeather?.(arenaEnv.weather ?? 'clear');
    this.sceneSystem.setWeather?.(arenaEnv.weather ?? 'clear');
    this.sceneSystem.setSceneFogEnabled?.(arenaEnv.fogEnabled === true);
    this.rendererSystem.setWeather?.(arenaEnv.weather ?? 'clear');
    // Initial haze from level environment (preset may override later).
    if (arenaEnv.fogEnabled && this.sceneSystem?._sceneFog) {
      const density = Number.isFinite(arenaEnv.fogDensity) ? arenaEnv.fogDensity : 0.0065;
      const far = Math.min(160, Math.max(55, 0.55 / Math.max(0.003, density)));
      this.sceneSystem._sceneFog.near = far * 0.32;
      this.sceneSystem._sceneFog.far = far;
      if (Number.isFinite(arenaEnv.fogColor)) {
        this.sceneSystem._sceneFog.color?.setHex?.(arenaEnv.fogColor);
      }
    }

    // Mall LightProbeGrid GI (docs/horde-gi-plan.md). Bake after first frames.
    if (this.levelMode === 'horde') {
      try {
        this.hordeGi?.dispose?.();
        this.hordeGi = createHordeGiController({
          scene: this.sceneSystem.scene,
          renderer: this.rendererSystem.renderer,
          qualityPreset: this.qualityPreset,
          levelGi: this.levelSystem.level?.hordeGi ?? null,
        });
        console.info('[HordeGi] controller created', this.hordeGi.getSnapshot());
        this.hordeGi.scheduleBake();
      } catch (err) {
        console.warn('[GameRuntime] horde GI setup failed', err);
        this.hordeGi = null;
      }
    }
  }

  // Highway: daylight elevated freeway + distance fog for visual recycle horizon.
  if (this.levelMode === 'highway') {
    const spawnYaw = this.levelSystem.level?.spawnYaw;
    if (Number.isFinite(spawnYaw) && this.characterSystem.character) {
      this.characterSystem.character.yaw = spawnYaw;
      this.cameraSystem.yaw = spawnYaw;
    }
    const hwyEnv = this.levelSystem.level?.highwayEnvironment ?? {};
    if (Number.isFinite(hwyEnv.timeOfDay)) {
      this.sceneSystem.skySystem?.setTimeOfDay?.(hwyEnv.timeOfDay);
    }
    this.sceneSystem.skySystem?.setWeather?.(hwyEnv.weather ?? 'clear');
    this.sceneSystem.setWeather?.(hwyEnv.weather ?? 'clear');
    this.sceneSystem.setSceneFogEnabled?.(hwyEnv.fogEnabled !== false);
    this.rendererSystem.setWeather?.(hwyEnv.weather ?? 'clear');
    if (this.sceneSystem?._sceneFog) {
      const near = Number.isFinite(hwyEnv.fogNear) ? hwyEnv.fogNear : 80;
      const far = Number.isFinite(hwyEnv.fogFar) ? hwyEnv.fogFar : 280;
      this.sceneSystem._sceneFog.near = near;
      this.sceneSystem._sceneFog.far = far;
      if (Number.isFinite(hwyEnv.fogColor)) {
        this.sceneSystem._sceneFog.color?.setHex?.(hwyEnv.fogColor);
      }
    }
  }

  // ?fp=1 forces on-foot first person for M3 checks / playground.
  try {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fp') === '1') {
      setOnFootFirstPerson(true);
      this.cameraSystem.setOnFootFirstPerson(true);
    }
  } catch {
    // ignore
  }

  this._systemsReady = true;
  this._setLoadProgress({ phase: 'systems', label: 'Systems ready', sub: { systems: 1 } });
  this._tryEnterRunning();

  await prewarmPromise;
  if (this._aborted(gen)) return;
  this._tryEnterRunning();

  await nearFieldPromise;
  if (this._aborted(gen)) return;
  this._tryEnterRunning();
}

/**
 * Spawn the stage car (+ rally quads). Uses map spawn for rally so custom
 * default rally scenes do not hang ensureGroundCollider at Pine Ridge coords.
 */
async function spawnPlayVehicles(host, character) {
  if (host.levelMode === 'highway') {
    await host._initializeHighwayVehicles(character);
    if (host._highwayDebug) {
      host._spawnHighwayTestPlatform();
      host._spawnHighwayCombatDeck();
    }
    return;
  }
  if (host.levelMode === 'range' || host.levelMode === 'horde' || host.levelMode === 'sims' || host.levelMode === 'dog-park') {
    return;
  }

  // Rally must use the rally default map — active world draft is a different scene.
  const worldMap = host.levelMode === 'rally'
    ? getRallyWorldMapSync()
    : getActiveWorldMapSync();
  if (isCollisionTestMap(worldMap)) {
    await spawnCollisionTestVehicles(host.vehicleSystem);
    return;
  }

  const spawn = host.levelSystem.level?.spawnPoint
    ?? character?.group?.position
    ?? null;
  // World-map yaw is degrees (0–360).
  const spawnYaw = Number.isFinite(worldMap?.spawn?.yaw)
    ? (worldMap.spawn.yaw * Math.PI) / 180
    : (host.levelMode === 'rally' ? -Math.PI / 4 : (host.horseSystem.group?.rotation.y ?? 0));
  const carPosition = host.levelMode === 'rally' && spawn
    ? new THREE.Vector3(spawn.x + 3.2, spawn.y ?? 0, spawn.z + 1.5)
    : carSpawnPosition(host.horseSystem, character?.group.position);
  const carYaw = host.levelMode === 'rally'
    ? spawnYaw
    : (host.horseSystem.group?.rotation.y ?? 0);
  const garageVehicleOptions = spawnVehicleOptions(host.levelMode);
  const VehicleConstructor = garageVehicleOptions.vehicleKind === 'quad'
    ? QuadBikeVehicle
    : BaseVehicle;

  let spawnCar = null;
  try {
    spawnCar = await host.vehicleSystem.spawnVehicle({
      vehicle: new VehicleConstructor({
        ...garageVehicleOptions,
        name: 'Spawn Car',
        position: carPosition,
        rotationY: carYaw,
      }),
    });
  } catch (err) {
    console.error('[RuntimeLoader] spawn car failed', err);
  }

  if (host.levelMode === 'rally' && character && spawnCar) {
    try {
      // Do not await engine sample decode — primes on first drive tick.
      await host.vehicleSystem.enterVehicle(character, spawnCar, { warmup: false });
    } catch (err) {
      console.error('[RuntimeLoader] enter rally car failed', err);
    }
  }

  if (host.levelMode === 'rally' && spawn) {
    const rightX = Math.cos(spawnYaw);
    const rightZ = -Math.sin(spawnYaw);
    const quadSpawns = [
      {
        name: 'Rally Quad 1',
        position: new THREE.Vector3(
          spawn.x + rightX * 6.5,
          spawn.y ?? 0,
          spawn.z + rightZ * 6.5,
        ),
        rotationY: spawnYaw,
      },
      {
        name: 'Rally Quad 2',
        position: new THREE.Vector3(
          spawn.x + rightX * 9.5,
          spawn.y ?? 0,
          spawn.z + rightZ * 9.5,
        ),
        rotationY: spawnYaw,
      },
    ];
    const parkedQuadSpawns = garageVehicleOptions.vehicleKind === 'quad'
      ? quadSpawns.slice(1)
      : quadSpawns;
    for (const spec of parkedQuadSpawns) {
      try {
        await host.vehicleSystem.spawnVehicle({ vehicle: new QuadBikeVehicle(spec) });
      } catch (err) {
        console.error('[RuntimeLoader] spawn rally quad failed', err);
      }
    }
  }
}

export { startRuntime, streamAssetsInBackground };
