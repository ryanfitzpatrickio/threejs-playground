import * as THREE from 'three';
import { HighwayTrafficSystem } from '../../systems/HighwayTrafficSystem.js';
import { BaseVehicle } from '../../vehicles/BaseVehicle.js';
import { QuadBikeVehicle } from '../../vehicles/QuadBikeVehicle.js';
import { spawnVehicleOptions } from '../../vehicles/garageBuilds.js';
import {
  DEFAULT_HIGHWAY_SEED,
  FLOW_SPEED,
  HIGHWAY_Y,
  PLAYER_SPAWN_S,
  cruiseWorldVelocity,
  laneWorldX,
  sToWorldZ,
} from '../../config/highwayRunManifest.js';
import { bindRuntimeHost } from '../bindRuntimeHost.js';

/** Highway mode: player vehicle, traffic, protected set, debug platforms/encounters. */
export class HighwayModeController {
  constructor(host) {
    this._host = host;
    this.id = 'highway';
    return bindRuntimeHost(this, host);
  }


  async _initializeHighwayVehicles(character) {
    const level = this.levelSystem.level;
    const spawnPos = level?.vehicleSpawnPoint
      ? level.vehicleSpawnPoint.clone()
      : (level?.spawnPoint?.clone?.() ?? new THREE.Vector3(0, 12, -12));
    const spawnYaw = Number.isFinite(level?.vehicleSpawnYaw)
      ? level.vehicleSpawnYaw
      : (Number.isFinite(level?.spawnYaw) ? level.spawnYaw : 0);

    const garageVehicleOptions = spawnVehicleOptions(this.levelMode);
    const VehicleConstructor = garageVehicleOptions.vehicleKind === 'quad'
      ? QuadBikeVehicle
      : BaseVehicle;
    const playerCar = await this.vehicleSystem.spawnVehicle({
      vehicle: new VehicleConstructor({
        ...garageVehicleOptions,
        name: 'Highway Player Car',
        position: spawnPos,
        rotationY: spawnYaw,
      }),
    });
    this._highwayPlayerVehicle = playerCar;

    // M6: seed player chassis at flow so the first second matches convoy speed.
    if (playerCar) {
      const flowVel = cruiseWorldVelocity(0);
      playerCar.parkedMode = false;
      playerCar._parkedPose = null;
      playerCar.speed = FLOW_SPEED;
      if (playerCar.linearVelocity?.set) {
        playerCar.linearVelocity.set(flowVel.x, flowVel.y, flowVel.z);
      }
      const body = this.physicsSystem?.getFreshBody?.(playerCar.bodyHandle);
      if (body) {
        body.setLinvel(flowVel, true);
        body.wakeUp?.();
      }
    }

    // M0 acceptance is driveable highway — seat the player like rally so they
    // start rolling on the ribbon instead of standing on-foot with the sword.
    if (character && playerCar) {
      await this.vehicleSystem.enterVehicle(character, playerCar, { warmup: true });
      if (Number.isFinite(spawnYaw)) {
        character.yaw = spawnYaw;
        this.cameraSystem.yaw = spawnYaw;
      }
    }

    const focusPosition = playerCar?.group?.position
      ?? character?.group?.position
      ?? spawnPos;

    this.highwayTrafficSystem = new HighwayTrafficSystem({
      physics: this.physicsSystem,
      vehicleSystem: this.vehicleSystem,
      platformRiding: this.platformRidingSystem,
      scene: this.sceneSystem?.scene,
      enemySystem: this.enemySystem,
      // Gang on trailer decks when combat assets are loaded (?highwayDebug=1).
      spawnSemiGuards: Boolean(this._highwayDebug),
      seed: DEFAULT_HIGHWAY_SEED,
    });
    await this.highwayTrafficSystem.initialize({
      focusPosition,
      protectedVehicles: this._highwayProtectedVehicles(),
    });

    // Player car roof is a leap source/target surface while on the ribbon.
    if (playerCar) {
      this.platformRidingSystem.registerVehicleRoof?.(playerCar, { hijackable: false });
    }
  }

  /** Vehicles the traffic pool must never recycle (player car + active driver). */

  _highwayProtectedVehicles() {
    const set = new Set();
    if (this._highwayPlayerVehicle) set.add(this._highwayPlayerVehicle);
    if (this.vehicleSystem?.activeVehicle) set.add(this.vehicleSystem.activeVehicle);
    return set;
  }

  /**
   * O6: test platforms / combat deck behind ?highwayDebug=1.
   * Also honors localStorage dreamfall:highwayDebug=1 for persistent sessions.
   */

  _resolveHighwayDebugFlag() {
    try {
      if (typeof location !== 'undefined') {
        const q = new URLSearchParams(location.search);
        if (q.get('highwayDebug') === '1' || q.get('highwayDebug') === 'true') return true;
      }
      if (typeof localStorage !== 'undefined') {
        if (localStorage.getItem('dreamfall:highwayDebug') === '1') return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * M1: scripted kinematic platform cruising along −Z near spawn so the player
   * can exit the car and verify fixed-step carry + jump inheritance in-world.
   * Behind highwayDebug (O6).
   */

  _spawnHighwayTestPlatform() {
    if (!this.platformRidingSystem || this.platformRidingSystem.status !== 'ready') return null;
    // Lane 0, ahead of player spawn — clear of early traffic at s=40 lane 1.
    const s = PLAYER_SPAWN_S + 28;
    const flowVel = cruiseWorldVelocity(0);
    const platform = this.platformRidingSystem.spawnScriptedTestPlatform({
      name: 'Highway Test Platform',
      position: new THREE.Vector3(laneWorldX(0), HIGHWAY_Y + 0.35, sToWorldZ(s)),
      size: [3.2, 0.5, 8.5],
      // M6: match convoy FLOW_SPEED so roof-surf / leap relative motion is honest.
      velocity: { ...flowVel },
      color: 0xd4652a,
    });
    this._highwayTestPlatform = platform;
    // Leap target close enough to be in CAR_LEAP_RANGE from the orange deck / spawn car.
    this.platformRidingSystem.spawnScriptedTestPlatform({
      name: 'Highway Leap Target',
      position: new THREE.Vector3(laneWorldX(0), HIGHWAY_Y + 0.35, sToWorldZ(s + 10)),
      size: [3.2, 0.5, 8.5],
      velocity: { ...flowVel },
      color: 0x4a9fd4,
    });
    return platform;
  }

  /**
   * M5 greybox fight deck: larger moving platform with highway gang members.
   * Stand-in for a semi trailer bed until articulated trailers land.
   */

  _spawnHighwayCombatDeck() {
    if (!this.platformRidingSystem || this.platformRidingSystem.status !== 'ready') return null;
    if (this.enemySystem.status !== 'ready') return null;

    const s = PLAYER_SPAWN_S + 55;
    const deck = this.platformRidingSystem.spawnScriptedTestPlatform({
      name: 'Highway Combat Deck',
      position: new THREE.Vector3(laneWorldX(3), HIGHWAY_Y + 0.4, sToWorldZ(s)),
      size: [3.6, 0.55, 12],
      velocity: { ...cruiseWorldVelocity(0) },
      color: 0x6b4a3a,
    });
    this._highwayCombatDeck = deck;

    const surfaceY = deck.position.y + deck.size[1] * 0.5;
    const handle = deck.bodyHandle;
    const spawns = [
      { x: -0.7, z: -2.5 },
      { x: 0.7, z: 1.5 },
    ];
    const spawned = [];
    for (let i = 0; i < spawns.length; i += 1) {
      const local = spawns[i];
      const pos = new THREE.Vector3(
        deck.position.x + local.x,
        surfaceY,
        deck.position.z + local.z,
      );
      const enemy = this.enemySystem.spawnEnemy('highwayGangMember', pos, {
        yaw: Math.PI, // face roughly toward player approach (+Z relative to -Z highway)
        platformBodyHandle: handle,
        id: `highway-gang-${i}`,
      });
      if (enemy) {
        this.physicsSystem.addEnemyCollider?.(enemy);
        spawned.push(enemy);
      }
    }
    return { deck, enemies: spawned };
  }

}
