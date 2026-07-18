import { FrameStats } from '../core/FrameStats.js';
import { AllocationSampler } from '../core/AllocationSampler.js';
import { RenderRateLimiter } from '../core/RenderRateLimiter.js';
import { AnimationStateSystem } from '../systems/AnimationStateSystem.js';
import { CameraSystem } from '../systems/CameraSystem.js';
import { CharacterSystem } from '../systems/CharacterSystem.js';
import { CombatSystem } from '../systems/CombatSystem.js';
import { FirstPersonWeaponSystem } from '../systems/FirstPersonWeaponSystem.js';
import { WeaponSystem } from '../systems/WeaponSystem.js';
import { ShootingRangeSystem } from '../systems/ShootingRangeSystem.js';
import { AquariumBreachSystem } from '../systems/AquariumBreachSystem.js';
import { PropaneTankSystem } from '../systems/PropaneTankSystem.js';
import { EnemySystem } from '../systems/EnemySystem.js';
import { HordeProxySystem } from '../systems/HordeProxySystem.js';
import { CrowdSystem } from '../systems/CrowdSystem.js';
import { EnemyCutSystem } from '../systems/EnemyCutSystem.js';
import { DestructiblePropSystem } from '../systems/DestructiblePropSystem.js';
import { HorseSystem } from '../systems/HorseSystem.js';
import { InputSystem } from '../systems/InputSystem.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { BuildingEntrySystem } from '../systems/BuildingEntrySystem.js';
import { LedgeHangSystem } from '../systems/LedgeHangSystem.js';
import { LedgeTraversalSystem } from '../systems/LedgeTraversalSystem.js';
import { MovementSystem } from '../systems/MovementSystem.js';
import { MountSystem } from '../systems/MountSystem.js';
import { PlayerDamageSystem } from '../systems/PlayerDamageSystem.js';
import { PhysicsSystem } from '../systems/PhysicsSystem.js';
import { RendererSystem } from '../systems/RendererSystem.js';
import { RopeSystem } from '../systems/RopeSystem.js';
import { SceneSystem } from '../systems/SceneSystem.js';
import { SlideSystem } from '../systems/SlideSystem.js';
import { TraversalRouterSystem } from '../systems/TraversalRouterSystem.js';
import { VaultSystem } from '../systems/VaultSystem.js';
import { WallClimbSystem } from '../systems/WallClimbSystem.js';
import { WallRunSystem } from '../systems/WallRunSystem.js';
import { TelekinesisSystem } from '../systems/TelekinesisSystem.js';
import { CarryItemSystem } from '../systems/CarryItemSystem.js';
import { HookSwingSystem } from '../systems/HookSwingSystem.js';
import { WingsuitSystem } from '../systems/WingsuitSystem.js';
import { WingsuitFlightSystem } from '../systems/WingsuitFlightSystem.js';
import { AbilitySystem } from '../systems/AbilitySystem.js';
import { RallyCinematicDemo } from '../systems/RallyCinematicDemo.js';
import { VehicleSystem } from '../systems/VehicleSystem.js';
import { VehicleDamageSystem } from '../systems/VehicleDamageSystem.js';
import { PlatformRidingSystem } from '../systems/PlatformRidingSystem.js';
import { CarLeapSystem } from '../systems/CarLeapSystem.js';
import { WeatherSystem } from '../systems/WeatherSystem.js';
import { RemotePlayerSystem } from '../systems/RemotePlayerSystem.js';
import { SimSystem } from '../systems/SimSystem.js';
import { SimCameraSystem } from '../systems/SimCameraSystem.js';
import {
  HORDE_FULL_SHADOW_CASTER_LIMIT,
  HORDE_ATTACK_TOKEN_LIMIT,
} from '../config/hordePerformanceConfig.js';

/**
 * Construct global runtime systems. No startup policy or frame behavior.
 * @param {{ canvas: HTMLCanvasElement, qualityPreset: object, levelMode: string }} options
 */
export function createRuntimeServices({ canvas, qualityPreset, levelMode }) {
  const sceneSystem = new SceneSystem();
  const rendererSystem = new RendererSystem({ canvas, qualityPreset });
  const cameraSystem = new CameraSystem();
  const inputSystem = new InputSystem({ target: canvas });
  const levelSystem = new LevelSystem();
  const buildingEntrySystem = new BuildingEntrySystem();
  const characterSystem = new CharacterSystem();
  const combatSystem = new CombatSystem();
  const firstPersonWeaponSystem = new FirstPersonWeaponSystem();
  const weaponSystem = new WeaponSystem();
  const shootingRangeSystem = new ShootingRangeSystem();
  const aquariumBreachSystem = new AquariumBreachSystem();
  const propaneTankSystem = new PropaneTankSystem({ qualityPreset });
  const enemySystem = new EnemySystem();
  enemySystem.setHordeShadowCasterLimit(
    levelMode === 'horde' ? HORDE_FULL_SHADOW_CASTER_LIMIT : Infinity,
  );
  enemySystem.attackTokenLimit = levelMode === 'horde'
    ? HORDE_ATTACK_TOKEN_LIMIT
    : Infinity;
  const hordeProxySystem = new HordeProxySystem();
  const crowdSystem = new CrowdSystem();
  const enemyCutSystem = new EnemyCutSystem();
  const propSystem = new DestructiblePropSystem({
    cutPieceLifetime: qualityPreset.destructiblePropCutLifetime ?? 45,
  });
  const playerDamageSystem = new PlayerDamageSystem();
  enemySystem.playerDamageSystem = playerDamageSystem;
  const horseSystem = new HorseSystem();
  const physicsSystem = new PhysicsSystem();
  const ledgeHangSystem = new LedgeHangSystem();
  const ledgeTraversalSystem = new LedgeTraversalSystem();
  const wallRunSystem = new WallRunSystem();
  const wallClimbSystem = new WallClimbSystem();
  const ropeSystem = new RopeSystem();
  const vaultSystem = new VaultSystem();
  const slideSystem = new SlideSystem();
  const mountSystem = new MountSystem();
  const movementSystem = new MovementSystem();
  const traversalRouterSystem = new TraversalRouterSystem();
  const animationStateSystem = new AnimationStateSystem();
  const telekinesisSystem = new TelekinesisSystem();
  const carryItemSystem = new CarryItemSystem();
  const hookSwingSystem = new HookSwingSystem();
  const wingsuitSystem = new WingsuitSystem();
  const wingsuitFlightSystem = new WingsuitFlightSystem();
  const abilitySystem = new AbilitySystem();
  const vehicleSystem = new VehicleSystem();
  const platformRidingSystem = new PlatformRidingSystem();
  const carLeapSystem = new CarLeapSystem();
  const rallyCinematicDemo = new RallyCinematicDemo();
  const vehicleDamageSystem = new VehicleDamageSystem();
  const weatherSystem = new WeatherSystem();
  // Deathmatch M3: always constructed; only updated when deathmatch feature is active.
  const remotePlayerSystem = new RemotePlayerSystem();
  const simSystem = new SimSystem();
  const simCameraSystem = new SimCameraSystem();
  const frameStats = new FrameStats();
  const allocationSampler = new AllocationSampler();
  const renderRateLimiter = new RenderRateLimiter(60);

  return {
    sceneSystem,
    rendererSystem,
    cameraSystem,
    inputSystem,
    levelSystem,
    buildingEntrySystem,
    characterSystem,
    combatSystem,
    firstPersonWeaponSystem,
    weaponSystem,
    shootingRangeSystem,
    aquariumBreachSystem,
    propaneTankSystem,
    enemySystem,
    hordeProxySystem,
    crowdSystem,
    enemyCutSystem,
    propSystem,
    playerDamageSystem,
    horseSystem,
    physicsSystem,
    ledgeHangSystem,
    ledgeTraversalSystem,
    wallRunSystem,
    wallClimbSystem,
    ropeSystem,
    vaultSystem,
    slideSystem,
    mountSystem,
    movementSystem,
    traversalRouterSystem,
    animationStateSystem,
    telekinesisSystem,
    carryItemSystem,
    hookSwingSystem,
    wingsuitSystem,
    wingsuitFlightSystem,
    abilitySystem,
    vehicleSystem,
    platformRidingSystem,
    carLeapSystem,
    highwayTrafficSystem: null,
    _highwayPlayerVehicle: null,
    _highwayTestPlatform: null,
    rallyCinematicDemo,
    vehicleDamageSystem,
    weatherSystem,
    remotePlayerSystem,
    simSystem,
    simCameraSystem,
    frameStats,
    allocationSampler,
    renderRateLimiter,
  };
}
