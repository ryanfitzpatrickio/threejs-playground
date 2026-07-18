import * as THREE from 'three';
import { rainWind } from '../systems/weatherUniforms.js';
import { PHYSICS_FIXED_STEP, VEHICLE_PHYSICS_FIXED_STEP } from '../systems/PhysicsSystem.js';
import {
  HORDE_FULL_ACTOR_LIMIT,
  HORDE_MAX_DETAILED_RAGDOLLS,
  HORDE_SPAWN_BATCH_PER_FRAME,
} from '../config/hordePerformanceConfig.js';
import { getOnFootFirstPerson } from '../config/cameraComfort.js';
import { resolveJacketMode } from '../characters/mara/jacketConfig.js';
import { updateRuntimeCameraFrame } from './updateRuntimeCameraFrame.js';

/**
 * Executes the ordered frame update. Host provides systems and feature methods.
 * Frame order is a contract — see runtimeFramePlan.js.
 */
export class RuntimeFramePipeline {
  constructor(host) {
    this._host = host;
  }

  update(timeMs) {
    return frameUpdate.call(this._host, timeMs);
  }
}

function frameUpdate(timeMs) {
  if (this._visibilityPaused) {
    this.lastFrameAt = timeMs;
    return;
  }
  if (this.renderCap60) {
    if (!this.renderRateLimiter.shouldRun(timeMs)) return;
  }
  const frameMs = timeMs - this.lastFrameAt;
  const delta = Math.min(Math.max(frameMs / 1000, 0), 0.05);
  this.lastFrameAt = timeMs;

  if (!this.characterSystem?.character) {
    this.emitSnapshot();
    return;
  }
  if (this.stage === 'loading') {
    this.emitSnapshot();
    return;
  }

  // During prewarming: pump streaming + full render so city near-field and
  // pipeline batches advance. Gameplay sim/input stay off until play-ready.
  if (this.stage === 'prewarming' && this.simEnabled === false) {
    this._updatePrewarmingFrame(timeMs, delta, frameMs);
    return;
  }

  let input = this.inputSystem.getState();
  if (!this.inputEnabled) {
    input = {
      ...input,
      moveX: 0,
      moveZ: 0,
      jump: false,
      jumpPressed: false,
      brace: false,
      bracePressed: false,
      slide: false,
      slidePressed: false,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      drawSheathePressed: false,
      shoulderThrowPressed: false,
      cutModePressed: false,
      telekinesisPressed: false,
      hookFirePressed: false,
      hookAimHeld: false,
      abilityPressed: false,
      abilityDoubleTapped: false,
      wingsuitTogglePressed: false,
      dodgeDirection: null,
      mountPressed: false,
      lookX: 0,
      lookY: 0,
      photoModePressed: false,
      collisionDebugPressed: false,
      gunSlotPressed: null,
    };
  }
  input = this.simsFeature.prepareInput(input);
  input = this.dogParkFeature.prepareInput(input);
  if (
    this.inputEnabled
    && !this._forestAmbienceAwake
    && (input.forward || input.backward || input.left || input.right || input.jumpPressed)
  ) {
    if (this.levelSystem.level?.wakeForestAmbience?.()) {
      this._forestAmbienceAwake = true;
    }
  }
  const character = this.characterSystem.character;
  if (this.inputEnabled && input.photoModePressed) {
    this.setPhotoMode(!this.cameraSystem.photoMode);
  }
  if (this.cameraSystem.photoMode) {
    // Free-fly always owns look/WASD while photo mode is active.
    this.cameraSystem.updatePhotoMode({ delta, input });
    if (!this.cameraSystem.photoModeLive) {
      // Default: pause simulation, render from free camera only.
      this.rendererSystem.resizeIfNeeded((viewport) => this.cameraSystem.resize(viewport));
      if (this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
        this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
      }
      this.rendererSystem.render({
        scene: this.sceneSystem.scene,
        camera: this.cameraSystem.camera,
      });
      this.emitSnapshot(timeMs);
      return;
    }
    // Live: sim + animation/IK continue, but player control is fully locked
    // (no movement, rotation, combat, or vehicle drive from freecam keys).
    input = this._photoModeLockedInput(input);
  }
  // Building enter/exit. Handled before the movement/ability pipeline so the E
  // (mount/interact) press is consumed here (returning early skips vehicle mount
  // and ability use this frame; the input edge is already cleared by getState()).
  // `prompt` is last frame's detection — one frame stale is imperceptible.
  if (this.insideBuilding) {
    if (this._elevatorTransition) {
      this._tickElevatorTransition(delta, character);
      this.emitSnapshot(timeMs);
      return;
    }
    this.insideBuilding.atDoor = this._isAtInteriorDoor(character);
    this.insideBuilding.atElevator = this._isAtElevator(character);
    this.insideBuilding.interior.updateDoors?.(delta);
    this.insideBuilding.nearbyDoor = this.insideBuilding.interior.getNearbyDoor?.(character.group.position) ?? null;
    if (this.insideBuilding.atDoor && input.mountPressed) {
      this._exitBuilding(character);
      this.emitSnapshot();
      return;
    }
    if (this.insideBuilding.atElevator && !this.insideBuilding.atDoor
      && this.insideBuilding.interior.floorCount > 1) {
      const floorPick = this._readElevatorFloorInput(input);
      if (floorPick != null) {
        this._startElevatorRide(character, floorPick);
        this.emitSnapshot();
        return;
      }
      if (input.mountPressed) {
        const fc = this.insideBuilding.interior.floorCount;
        const next = (this.insideBuilding.currentFloor + 1) % fc;
        this._startElevatorRide(character, next);
        this.emitSnapshot();
        return;
      }
      if (input.bracePressed) {
        const fc = this.insideBuilding.interior.floorCount;
        const prev = (this.insideBuilding.currentFloor - 1 + fc) % fc;
        this._startElevatorRide(character, prev);
        this.emitSnapshot();
        return;
      }
    }
    if (!this.insideBuilding.atDoor && !this.insideBuilding.atElevator
      && this.insideBuilding.nearbyDoor && input.mountPressed) {
      this.insideBuilding.interior.toggleDoor(
        this.insideBuilding.nearbyDoor.door,
        character.group.position,
      );
      this.emitSnapshot();
      return;
    }
  } else if (this.buildingEntrySystem.state.prompt && input.mountPressed) {
    this._enterBuilding(character);
    this.emitSnapshot();
    return;
  }

  this.weatherSystem.update(delta, character.group.position, {
    inVehicle: Boolean(this.vehicleSystem?.activeVehicle),
  });

  this.levelSystem.level?.updateForestEnvironment?.({
    sunDirection: this.sceneSystem.skySystem?.sunDirection,
    windVector: rainWind.value,
  });

  const ambPos = this.vehicleSystem?.activeVehicle?.group?.position
    ?? character?.group?.position;
  if (ambPos) {
    this.levelSystem.level?.updateForestAmbience?.(ambPos, delta);
  }

  if (input.collisionDebugPressed) {
    this.levelSystem.toggleCollisionDebug();
  }

  let streamingMs = 0;
  let streamingActive = false;
  if (character) {
    const streamStart = performance.now();
    const mountedHorse = this.mountSystem?.state !== 'idle'
      ? this.horseSystem?.group
      : null;
    const streamingFocus = this.simsFeature.active
      ? this.simCameraSystem.target
      : this.dogParkFeature.active
        ? this.dogParkFeature.dog?.root?.position ?? character.group.position
        : this.vehicleSystem?.activeVehicle?.group?.position ?? mountedHorse?.position ?? character.group.position;
    const viewPos = this.cameraSystem?.camera?.position ?? streamingFocus;
    const streamingChanges = this.levelSystem.updateStreaming(streamingFocus, {
      viewPosition: viewPos,
    });
    const builtColliders = this.physicsSystem.applyStreamingChanges(streamingChanges);
    streamingMs = performance.now() - streamStart;
    streamingActive =
      builtColliders > 0 ||
      (streamingChanges?.addedChunks?.length ?? 0) > 0 ||
      (streamingChanges?.removedChunkKeys?.length ?? 0) > 0 ||
      (streamingChanges?.terrainVisualChanges ?? 0) > 0;

    // Pre-warm render pipelines for freshly attached chunks. WebGPU compiles pipelines
    // asynchronously; kicking this off at attach time (while the chunk is still offscreen,
    // prefetched seconds ahead) lets compilation land during the prefetch window instead of
    // stalling the chunk's first on-screen render.
    if ((streamingChanges?.addedChunks?.length ?? 0) > 0) {
      this.queueStreamingCompile(streamingChanges.addedChunks.map((chunk) => chunk.group));
    }

    // Drive the shadow volume to follow the active locomotion root (the sun is otherwise locked to
    // the origin, so shadows disappear once you walk away from spawn). Placed here
    // so both render paths (cut-mode + normal) are covered by one call; the one-frame
    // lag behind movement is invisible because the follow point is texel-snapped.
    this.sceneSystem.updateShadowFollow(streamingFocus);
    this.sceneSystem.updateStreetLights(streamingFocus);
  }
  this.frameStats.recordSystem('streaming', streamingMs);

  // Always run a little BVH warmup (even during streaming). Newly attached chunks
  // enqueue their meshes; this prevents raycasts (hook, ledge, avoidance) from
  // hitting computeBoundsTree on the hot path.
  this.frameStats.start('bvh');
  this.levelSystem.warmupGeometryRaycasts({
    maxMs: streamingActive ? 1 : 2,
    maxCount: streamingActive ? 2 : 8,
  });
  this.frameStats.endSection();

  // Crowd update early (after streaming, before heavy systems). Phase 1/2 stub is trivial cost.
  // No side effects on enemy/cut/physics/streaming (internal status guard).
  this.frameStats.start('crowd');
  if (this.crowdSystem) {
    this.crowdSystem.update({
      delta,
      playerPosition: character?.group?.position,
      level: this.levelSystem,
    });
  }
  this.frameStats.endSection();

  // Update the cut system. Pass unscaled delta so aiming remains responsive.
  this.frameStats.start('cut');
  const cutMode = this.enemyCutSystem.update({
    delta,
    input,
    character,
    camera: this.cameraSystem.camera,
    enemies: this.getCutTargets(),
    enemySystem: this.enemySystem,
    propSystem: this.propSystem,
    physicsSystem: this.physicsSystem,
  });
  this.frameStats.endSection();

  // The arc cut has already committed on V release; the sword animation is
  // immediate impact feedback and no longer gates the geometry operation.
  if (cutMode?.startSwing) {
    this.combatSystem.beginAimCut({
      combat: character.combat,
      orientation: cutMode.orientation,
    });
  }

  // Cut state is an edge for diagnostics only. Sword cuts no longer alter time.
  if (this.enemyCutSystem.justCut) {
    this.enemyCutSystem.justCut = false;
  }

  // Calculate time scale solely from M3 car-leap bullet-time.
  // Bullet-time meter drains on real frame delta so hold feel stays stable.
  const leapBt = this.carLeapSystem?.updateBulletTime?.({
    delta,
    input,
    character,
    platforms: this.platformRidingSystem,
    vehicleSystem: this.vehicleSystem,
  }) ?? { timeScale: 1, aiming: false };

  const timeScale = leapBt.timeScale < 1 ? leapBt.timeScale : 1;

  const scaledDelta = delta * timeScale;

  // Plan this frame's fixed physics steps from the REAL frame delta, so sim
  // speed no longer depends on the display refresh rate (a 120 Hz monitor runs
  // steps every other frame; a 30 fps stall catches up with extra steps).
  // Car-leap slow-mo scales time entering the accumulator while the solver step
  // remains fixed. Nothing steps before the movement system, so planning here
  // (after timeScale is known) is safe.
  this.physicsSystem.beginFrame({
    delta,
    timeScale,
    fixedStep: this.vehicleSystem?.activeVehicle
      ? VEHICLE_PHYSICS_FIXED_STEP
      : PHYSICS_FIXED_STEP,
  });

  // Deathmatch M3: apply server corrections / teleports before predicted movement.
  this.deathmatchFeature?.applyAuthoritative?.({
    character,
    physics: this.physicsSystem,
  });

  // Construct gameplay input: lock locomotion/combat while choosing the live arc angle.
  let gameplayInput = input;
  if (this.cameraSystem.photoMode && this.cameraSystem.photoModeLive) {
    // Already locked at frame start; keep a hard lock after any later input mutation.
    gameplayInput = this._photoModeLockedInput(input);
  } else if (this.rallyCinematicDemo?.active) {
    gameplayInput = {
      ...input,
      moveX: 0,
      moveZ: 0,
      jump: false,
      jumpPressed: false,
      brace: false,
      bracePressed: false,
      slide: false,
      slidePressed: false,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      drawSheathePressed: false,
      shoulderThrowPressed: false,
      cutModePressed: false,
      telekinesisPressed: false,
      hookFirePressed: false,
      hookAimHeld: false,
      abilityPressed: false,
      abilityDoubleTapped: false,
      wingsuitTogglePressed: false,
      dodgeDirection: null,
      mountPressed: false,
      lookX: 0,
      lookY: 0,
      gunSlotPressed: null,
    };
  } else if (this.enemyCutSystem.state === 'aiming') {
    gameplayInput = {
      ...input,
      moveX: 0,
      moveZ: 0,
      jump: false,
      slide: false,
      brace: false,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      drawSheathePressed: false,
    };
  }

  // Weapon loadout first: 1 sword / 2 pistol / 3 random rifle, Z holsters/draws.
  // Sword starts drawn; guns join the same list after the great sword.
  gameplayInput = this.weaponSystem.processLoadout({
    input: gameplayInput,
    character,
    combatSystem: this.combatSystem,
    firstPersonWeaponSystem: this.firstPersonWeaponSystem,
  }) ?? gameplayInput;

  // M4 hijack takes F before AbilitySystem maps it to swing/wingsuit.
  {
    const hijackEarly = this.vehicleSystem.tryHijack?.({
      character,
      input: gameplayInput,
      platforms: this.platformRidingSystem,
      trafficSystem: this.highwayTrafficSystem,
    });
    if (hijackEarly?.hijacked) {
      gameplayInput = hijackEarly.input ?? gameplayInput;
      if (hijackEarly.vehicle) this._highwayPlayerVehicle = hijackEarly.vehicle;
    }
  }

  // Equip/activate traversal abilities (swing, wingsuit) before vehicle/mount/FP.
  // F maps onto hook/wingsuit flags for the equipped ability.
  gameplayInput = this.abilitySystem.processInput({
    input: gameplayInput,
    firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    weaponSystem: this.weaponSystem,
  }) ?? gameplayInput;

  this.horseSystem.update({ delta: scaledDelta });
  this.simsFeature.updateActors(scaledDelta);
  this.dogParkFeature.updateDog(scaledDelta);

  // Level-local interactables (e.g. horde boxcar sliding doors on E).
  // Highway: wraps recycled road visuals + slides the physics road slab.
  {
    const highwayFocus = this.vehicleSystem?.activeVehicle?.group?.position
      ?? character?.group?.position
      ?? null;
    const levelUpdate = this.levelSystem.level?.update?.({
      delta: scaledDelta,
      character,
      input: gameplayInput,
      physics: this.physicsSystem,
      focusPosition: highwayFocus,
    });
    // Horde boxcar doors: restamp dynamic nav obstacles + flow when open/close
    // crosses the blocking threshold (static nav bake keeps bays open).
    if (
      levelUpdate?.doorsChanged
      && this.isHordePlaygroundActive()
      && this.hordeProxySystem?.ready
    ) {
      this.hordeProxySystem.syncDoorObstacles?.({
        doors: this.levelSystem.level?.boxcarDoors ?? null,
        colliders: this.levelSystem.level?.colliders ?? null,
      });
    }
  }

  // Highway traffic window recycle (recover/park only — never spawn here).
  if (this.highwayTrafficSystem?.status === 'ready') {
    const trafficFocus = this.vehicleSystem?.activeVehicle?.group?.position
      ?? character?.group?.position
      ?? null;
    if (trafficFocus) {
      this.highwayTrafficSystem.updateWindow({
        focusPosition: trafficFocus,
        protectedVehicles: this._highwayProtectedVehicles(),
      });
    }
    // TSL instanced fleet tracks chassis poses (cheap matrix writes).
    this.highwayTrafficSystem.syncVisuals?.();
  }

  // Advance damage timers / regen BEFORE enemies deal damage this frame (so a
  // reaction set last frame decays, and a fresh one set this frame isn't).
  this.playerDamageSystem.update({ delta: scaledDelta, player: character });
  this.frameStats.start('enemy');
  if (this.isHordePlaygroundActive() && this.hordeProxySystem?.ready) {
    const playerPosition = character.group.position;
    // Free far full actors only when a nearer proxy needs the slot (queue empty).
    // Spawn queue has priority so burst construction still fills to the full cap first.
    if (this._hordePendingSpawnCount() === 0) {
      this._processHordeDemotions(playerPosition);
    }
    const availableFullSlots = this._hordePendingSpawnCount() === 0
      ? Math.max(0, HORDE_FULL_ACTOR_LIMIT - this.enemySystem.enemies.length)
      : 0;
    this.hordeProxySystem.update({
      delta: scaledDelta,
      playerPosition,
      availableFullSlots,
      promote: (descriptor) => this._spawnFullHordeDescriptor(descriptor, {
        countAsSpawn: false,
        replacingProxy: true,
      }),
    });
    // Front-arc attack slots face the mob: bearing = player → proxy centroid.
    this._updateHordeFrontArc(playerPosition);
  } else if (this._hordeFrontArcActive) {
    // Playground torn down — restore the full 360° ring for normal enemies.
    this.enemySystem.setHordeFrontArc({ enabled: false });
    this._hordeFrontArcActive = false;
  }
  this._processHordeSpawnQueue();
  this.enemySystem.update({
    delta: scaledDelta,
    player: character,
    level: this.levelSystem,
    platforms: this.platformRidingSystem,
    // Tip full-actors clamp to the same navcat mesh as proxies (horde only).
    navClamp: this.isHordePlaygroundActive() && this.hordeProxySystem?.navQuery
      ? (fromX, fromZ, toX, toZ, y) => this.hordeProxySystem.clampMoveToNav(
        fromX, fromZ, toX, toZ, y,
      )
      : null,
  });
  this.physicsSystem.syncEnemyColliders(this.getCutTargets());
  this.frameStats.endSection();

  this.frameStats.start('movement');

  // M3 car leap commit/active BEFORE vehicle seat-lock so L-release can detach
  // from roof-surf without being snapped back into the seat the same frame.
  let movement = this.carLeapSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement: {
      moving: false,
      wantsMove: false,
      speed: 0,
      grounded: character.grounded !== false,
      airborne: character.grounded === false,
      driving: Boolean(character.vehicle?.active),
    },
    character,
    platforms: this.platformRidingSystem,
    vehicleSystem: this.vehicleSystem,
    physics: this.physicsSystem,
  });

  // Vehicles run before mount/horse so they can claim E, and so chassis forces
  // land before the fixed step. Skip drive/seat-lock while a car leap owns the rider.
  if (!character.carLeap?.active) {
    const routedVehicle = this.vehicleSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      level: this.levelSystem,
      camera: this.cameraSystem.camera,
      cameraSystem: this.cameraSystem,
    });
    gameplayInput = routedVehicle.input ?? gameplayInput;
  }

  // Run enemies down: the driven car ragdolls + launches any enemy it ploughs into.
  // Runs after the vehicle update (chassis pose/velocity are current) and before
  // the world step so the new ragdoll bodies simulate this frame.
  this._applyVehicleRunOver();
  this.vehicleDamageSystem.update({
    delta: scaledDelta,
    // O1: skip dormant pool members in the damage scan.
    vehicles: this.vehicleSystem.simulatedVehicles ?? this.vehicleSystem.vehicles,
  });

  if (!character.carLeap?.active) {
    this.mountSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      horseSystem: this.horseSystem,
      level: this.levelSystem,
    });
  }

  // Carry pickups (propane tank, etc.) — E near item / E to drop. Sets
  // character.carrying so AnimationStateSystem layers the hold pose.
  this.carryItemSystem?.update?.({
    character,
    input: gameplayInput,
    movement,
    weaponSystem: this.weaponSystem,
  });

  // FP weapon stance gates traversal intent before the router / combat consume it.
  // Only active when the loadout firearm is drawn (not sword / not holstered).
  gameplayInput = this.firstPersonWeaponSystem.processInput({
    input: gameplayInput,
    character,
    cameraSystem: this.cameraSystem,
    weaponSystem: this.weaponSystem,
  }) ?? gameplayInput;

  const routedTraversal = this.traversalRouterSystem.update({
    input: gameplayInput,
    character,
    level: this.levelSystem,
    wallClimbSystem: this.wallClimbSystem,
  });
  gameplayInput = routedTraversal.input ?? gameplayInput;

  gameplayInput = this.combatSystem.processInput({ input: gameplayInput, character, enemies: this.enemySystem.enemies });

  if (!movement.carLeaping && !character.carLeap?.active) {
    movement = this.movementSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      level: this.levelSystem,
      physics: this.physicsSystem,
      cameraBasis: this.cameraSystem.getMovementBasis(),
      platforms: this.platformRidingSystem,
    });
  }

  movement = this.ledgeHangSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
    wallClimbSystem: this.wallClimbSystem,
    cameraBasis: this.cameraSystem.getMovementBasis(),
  });

  movement = this.ledgeTraversalSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    cameraBasis: this.cameraSystem.getMovementBasis(),
  });

  movement = this.wallRunSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
  });

  movement = this.slideSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
  });

  movement = this.vaultSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
  });

  movement = this.wallClimbSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
    ledgeHangSystem: this.ledgeHangSystem,
  });

  movement = this.ropeSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
    physics: this.physicsSystem,
  });

  // Wingsuit before hook so grappling out of a glide can exit the wingsuit first,
  // then let the hook fire on the same frame off the boosted velocity.
  movement = this.wingsuitFlightSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
    physics: this.physicsSystem,
  });

  movement = this.hookSwingSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
    camera: this.cameraSystem.camera,
  });
  this.frameStats.endSection();

  // Deathmatch M3: sample predicted pose and send player_state at movement cadence.
  this.deathmatchFeature?.sampleAndSend?.({
    character,
    animationStateSystem: this.animationStateSystem,
    cameraSystem: this.cameraSystem,
  });

  // FP weapon locomotion override (M3) — sets animationOverride before anim system.
  this.firstPersonWeaponSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    cameraSystem: this.cameraSystem,
    weaponSystem: this.weaponSystem,
  });

  this.frameStats.start('animation');
  this.animationStateSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    movement,
    character,
    level: this.levelSystem,
  });
  // Deathmatch M3: remote puppet interpolation (animation labels + weapon stub).
  this.deathmatchFeature?.updateRemotes?.({ delta: scaledDelta });
  this.frameStats.endSection();

  // Spine aim → weapon anchor → hand IK (same order as dust-and-bullets playerBody).
  this.firstPersonWeaponSystem.postAnimation({
    character,
    cameraSystem: this.cameraSystem,
    delta: scaledDelta,
  });

  // Carried props attach after mixer/IK settle so the tank rides the spine and
  // both hands can IK onto its grip markers.
  this.carryItemSystem?.postAnimation?.({
    character,
    firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    delta: scaledDelta,
  });

  // Bone-driven visuals read final bone poses after animation has settled.
  this.frameStats.start('wingsuit');
  this.wingsuitSystem.update({ delta: scaledDelta, character });
  this.frameStats.endSection();

  if (resolveJacketMode() !== 'off') {
    this.frameStats.start('jacket');
    this.characterSystem.updateProceduralJacket(scaledDelta);
    this.frameStats.endSection();

    // Jacket cloth simulation (three-simplecloth). Update *after* the animation mixer
    // has written the current bone matrices so the cloth can read the live body pose.
    if (character?.jacketCloth?.update) {
      try {
        character.jacketCloth.update(scaledDelta);
      } catch (e) {
        // Fail-soft; cloth is purely visual.
      }
    }
  }
  this.simsFeature.updateGarments(scaledDelta);

  // Telekinesis after animation (to read fresh hand bone), before physics step.
  // Phase 1: basic grab + orbit on loose cut chunks. Input consumed internally.
  this.frameStats.start('telekinesis');
  this.telekinesisSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    character,
    physicsSystem: this.physicsSystem,
    propSystem: this.propSystem,
    enemyCutSystem: this.enemyCutSystem,
    enemySystem: this.enemySystem,
    camera: this.cameraSystem.camera,
    enemies: this.enemySystem.enemies,
  });
  this.frameStats.endSection();

  this.frameStats.start('combat');
  const combatFocus = character?.group?.position ?? null;
  this.combatSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    character,
    enemies: this.getHordeCombatTargets({ focus: combatFocus, radius: 22 }),
    physicsSystem: this.physicsSystem,
    enemySystem: this.enemySystem,
    propSystem: this.propSystem,
    enemyCutSystem: this.enemyCutSystem,
    resolveHordeTarget: (target, opts) => this.resolveHordeCombatTarget(target, opts),
  });
  this.frameStats.endSection();

  this.ropeSystem.alignCharacterHandsToSocket({ character });
  this.frameStats.start('physics');
  // Run this frame's planned fixed steps if the on-foot movement path hasn't
  // already (moveCharacter steps mid-frame, preserving the old ordering for the
  // traversal systems' post-step queries). Vehicle force integration, the
  // legacy high-speed slicing, and interpolation pose capture all run inside
  // via physicsSystem.stepHooks.
  this.physicsSystem.stepPlanned();
  // O4: close platform carry window so the next frame's first capture opens cleanly.
  this.platformRidingSystem?.endCarryWindow?.();
  this.frameStats.endSection();
  // Move vehicle visuals to the pose interpolated between the last two physics
  // steps (alpha = fraction of a step accumulated but not yet simulated) and
  // re-seat the rider on it, so the camera and render track a smooth car at any
  // display refresh rate.
  this.vehicleSystem?.syncVisualPoses(this.physicsSystem.interpolationAlpha, character);
  // Mud/wet tyre ruts: stamp from FRESH wheel contact telemetry (post-integrate),
  // follow the car with deformCenter, upload the deform DataTexture.
  this.vehicleSystem?.syncMudFieldAfterPhysics?.(character, scaledDelta);
  this.frameStats.start('cutProps');
  this.enemyCutSystem.syncPhysicsProps(this.physicsSystem, this.physicsSystem.interpolationAlpha);
  this.frameStats.endSection();
  this.telekinesisSystem.updateThrownImpacts({
    enemies: this.enemySystem.enemies,
    physicsSystem: this.physicsSystem,
    enemySystem: this.enemySystem,
    enemyCutSystem: this.enemyCutSystem,
    propSystem: this.propSystem,
  });
  this.ropeSystem.syncRopeVisuals({
    level: this.levelSystem,
    physics: this.physicsSystem,
    character,
  });
  this.hookSwingSystem.syncVisuals({
    character,
    animationController: character.animationController,
  });

  updateRuntimeCameraFrame(this, scaledDelta, input, character);

  // M5–M7 hitscan fire / ADS / damage after camera so the ray matches look.
  // Propane updates first so the hitscan callback has current damage/carry/
  // camera seams; a bullet-triggered detonation still resolves this same frame.
  this.propaneTankSystem?.update?.({
    delta: scaledDelta,
    camera: this.cameraSystem.camera,
    character,
    playerDamageSystem: this.playerDamageSystem,
    cameraSystem: this.cameraSystem,
    carryItemSystem: this.carryItemSystem,
    enemyCutSystem: this.enemyCutSystem,
    physicsSystem: this.physicsSystem,
    applyHordeExplosion: this.isHordePlaygroundActive()
      ? (options) => this.applyHordeExplosion(options)
      : null,
  });

  this.frameStats.start('weapon');
  this.weaponSystem.update({
    delta: scaledDelta,
    input: gameplayInput,
    character,
    cameraSystem: this.cameraSystem,
    physicsSystem: this.physicsSystem,
    enemySystem: this.enemySystem,
    enemyCutSystem: this.enemyCutSystem,
    propSystem: this.propSystem,
    firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    vehicleDamageSystem: this.vehicleDamageSystem,
    vehicleSystem: this.vehicleSystem,
    shootingRangeSystem: this.shootingRangeSystem,
    aquariumBreachSystem: this.aquariumBreachSystem,
    propaneTankSystem: this.propaneTankSystem,
    hordeProxySystem: this.isHordePlaygroundActive() ? this.hordeProxySystem : null,
    resolveHordeTarget: this.isHordePlaygroundActive()
      ? (target, opts) => this.resolveHordeCombatTarget(target, opts)
      : null,
    maxDetailedRagdolls: this.isHordePlaygroundActive() ? HORDE_MAX_DETAILED_RAGDOLLS : Infinity,
    fallbackHordeDeath: this.isHordePlaygroundActive()
      ? (enemy) => this.convertHordeDeathToProxyCorpse(enemy)
      : null,
  });
  this.frameStats.endSection();

  if (this.shootingRangeSystem.enabled) {
    this.shootingRangeSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      gunId: this.firstPersonWeaponSystem.equippedGunId,
      character,
      level: this.levelSystem.level,
      cameraSystem: this.cameraSystem,
    });
  }

  // Aquarium breach drain + jets / glass shatter (inert without level.aquarium).
  this.aquariumBreachSystem?.update?.({
    delta: scaledDelta,
    level: this.levelSystem.level,
    camera: this.cameraSystem?.camera,
    scene: this.sceneSystem?.scene,
    physicsSystem: this.physicsSystem,
  });

  this.rendererSystem.resizeIfNeeded((viewport) => {
    this.cameraSystem.resize(viewport);
  });

  // Detect a nearby enterable building (on-foot only) and raise the HUD prompt.
  this.buildingEntrySystem.update({
    level: this.levelSystem.level,
    position: character.group.position,
    camera: this.cameraSystem.camera,
    enabled: !this.vehicleSystem?.activeVehicle && this.mountSystem?.state !== 'mounted',
  });

  // Skip the sky/env advance while inside a building so the suppressed interior
  // lighting isn't re-installed each frame.
  if (!this.insideBuilding && this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
    this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
  }
  this._syncTerrainEnvironment(delta);

  const spectatorCrowd = this.levelSystem.level?.spectatorCrowd;
  if (spectatorCrowd?.update) {
    const activeVehicle = this.vehicleSystem?.activeVehicle;
    const focus = activeVehicle
      ? {
        position: activeVehicle.model?.position ?? character.group.position,
        speed: activeVehicle.speed ?? 0,
      }
      : character.group.position;
    spectatorCrowd.update(delta, this.cameraSystem.camera, focus);
  }

  const renderStart = performance.now();
  this.rendererSystem.render({
    scene: this.sceneSystem.scene,
    camera: this.cameraSystem.camera,
    scopeViewport: this.firstPersonWeaponSystem.gunView?.scopeViewport ?? null,
    // SSAO's nested scene pre-pass is the worst possible companion to a
    // first-seen terrain object. Reuse the previous AO target until the
    // bounded streaming/compile queue is quiet.
    deferExpensivePasses: streamingActive || this._streamingCompileActive,
  });
  spectatorCrowd?.onAfterRender?.();
  const renderMs = performance.now() - renderStart;

  this.frameStats.recordSystem('render', renderMs);
  this.frameStats.record(frameMs, streamingMs, renderMs, streamingActive);

  // Temporary: vehicle vertical-jump diagnostic. Toggle from the console with
  // __DREAMFALL_DEBUG__.vehicleJumpDiag(true), drive until a jump, then
  // __DREAMFALL_DEBUG__.dumpVehicleJumpDiag(). Records every frame whose chassis
  // vy changed sharply, with the context that would explain a TIMING-based jump
  // (long frame / GC), a STREAMING-based one, or a SNAPSHOT/React stall.
  if (this._jumpDiagEnabled) {
    const veh = this.vehicleSystem?.activeVehicle;
    const vy = veh ? veh.linearVelocity.y : 0;
    const dVy = vy - (this._jumpDiagPrevVy ?? vy);
    this._jumpDiagPrevVy = vy;
    const snapped = this.shouldEmitSnapshot(timeMs);
    if (veh && Math.abs(dVy) > (this._jumpDiagThreshold ?? 0.25)) {
      (this._jumpDiagLog ??= []).push({
        t: +(timeMs / 1000).toFixed(2),
        frameMs: +frameMs.toFixed(1),
        dVy: +dVy.toFixed(3),
        vy: +vy.toFixed(3),
        spd: +veh.speed.toFixed(1),
        streaming: !!streamingActive,
        builtColliders: streamingActive ? 1 : 0,
        willSnapshot: snapped,
      });
      if (this._jumpDiagLog.length > 200) this._jumpDiagLog.shift();
    }
  }

  this.emitSnapshot(timeMs);
}

export { frameUpdate };
