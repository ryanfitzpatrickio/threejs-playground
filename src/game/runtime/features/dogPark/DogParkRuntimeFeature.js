import * as THREE from 'three';
import { createProceduralDog } from '../../../characters/dog/createProceduralDog.js';
import {
  isBirdBreed,
  isCatRigBreed,
  isHorseRigBreed,
  isInsectBreed,
  isLadybugBreed,
  normalizeDogBreedId,
} from '../../../characters/dog/dogCatalog.js';
import { createProceduralLadybug } from '../../../characters/insect/createProceduralLadybug.js';
import { createProceduralCat } from '../../../characters/cat/createProceduralCat.js';
import { createProceduralHorse } from '../../../characters/horse/createProceduralHorse.js';
import { plantDogFeet } from '../../../characters/dog/dogFootPlant.js';
import { DogPlayerController } from '../../../characters/dog/DogPlayerController.js';
import { DogClipPlayer, animalUsesDogClipLibrary } from '../../../characters/dog/DogClipPlayer.js';
import { DogMudContactHelper } from '../../../characters/dog/DogMudContactHelper.js';
import { createProceduralGoose } from '../../../characters/goose/createProceduralGoose.js';
import { GoosePlayerController } from '../../../characters/goose/GoosePlayerController.js';
import { DogCameraSystem } from '../../../systems/DogCameraSystem.js';
import { DogActiveRagdoll } from '../../../characters/dog/DogActiveRagdoll.js';
import { DogMudCoatController } from './DogMudCoatController.js';
import { DogParkNpcSystem } from './DogParkNpcSystem.js';
import { DogParkCinematicDirector } from './DogParkCinematicDirector.js';

/**
 * True when the animal animation facade rewrites the outer actor root TRS each
 * frame from its own rootPos (goose/bird, cat, horse, ladybug). Controllers must
 * either setRootPosition after moving, or enable externalRootMotion so the
 * facade samples the outer group instead of stomping it.
 */
function animalOwnsWorldRoot(animal, breedId = animal?.breedId) {
  if (!animal && !breedId) return false;
  const kind = animal?.rigKind ?? animal?.phenotype?.rigKind ?? null;
  return Boolean(
    animal?.isBird
    || kind === 'goose'
    || kind === 'bird'
    || kind === 'cat'
    || kind === 'horse'
    || kind === 'insect'
    || isBirdBreed(breedId)
    || isCatRigBreed(breedId)
    || isHorseRigBreed(breedId)
    || isLadybugBreed(breedId),
  );
}

/** Dog-skeleton mud flop / ragdoll / paw plant only. */
function usesDogSkeletonFeatures(animal, breedId = animal?.breedId) {
  return !animalOwnsWorldRoot(animal, breedId);
}

const CONFIG_EVENT = 'dreamfall:dog-park-config';

/** @param {unknown} value */
function normalizeMouthState(value) {
  if (value === 'open' || value === 'alert' || value === 'closed') return value;
  return 'closed';
}

/**
 * Park camera focus from customize / URL.
 * - `player` — orbit/chase the controllable dog (default)
 * - `squirrel-chase` — dedicated orbit on the grey squirrel mid-chase
 * - `cinematic` — rotating multi-shot park tour (geese, chase, trees, lake, mud)
 * @param {unknown} value
 * @returns {'player' | 'squirrel-chase' | 'cinematic'}
 */
function normalizeCameraMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'cinematic' || raw === 'tour' || raw === 'cinema') {
    return 'cinematic';
  }
  if (
    raw === 'squirrel-chase'
    || raw === 'squirrel'
    || raw === 'chase'
  ) {
    return 'squirrel-chase';
  }
  return 'player';
}

/** Modes that freeze player-dog locomotion and own the chase cam. */
function isSpectacleCameraMode(mode) {
  return mode === 'squirrel-chase' || mode === 'cinematic';
}

export class DogParkRuntimeFeature {
  constructor(host) {
    this.host = host;
    this.active = host.levelMode === 'dog-park';
    this.frameInput = null;
    this.dog = null;
    this.controller = null;
    this.clipPlayer = null;
    this.mudContact = null;
    this.mudCoat = null;
    this.npcSystem = null;
    /** @type {DogActiveRagdoll | null} */
    this.ragdoll = null;
    /**
     * Procedural flop (when clip packs are off): timer until impact + hold.
     * @type {{ t: number, impactAt: number, hold: number, impactFired: boolean } | null}
     */
    this._procFlop = null;
    this.camera = new DogCameraSystem();
    this.cinematic = new DogParkCinematicDirector({
      getChasePair: () => this.npcSystem?.chasePair ?? null,
      getGooseFlock: () => this.npcSystem?.gooseFlock ?? null,
      getCatFight: () => this.npcSystem?.catFight ?? null,
      getTreePigeons: () => this.npcSystem?.treePigeons ?? null,
      getPlayerDog: () => this.dog,
      getLake: () => this.host.levelSystem?.level?.lake ?? null,
      getBounds: () => this.host.levelSystem?.level?.parkBounds ?? null,
      getMudPatches: () => this.host.levelSystem?.level?.mudPatches ?? null,
    });
    this.config = readDogConfig();
    this._onConfig = (event) => this.applyConfig(event.detail ?? {});
  }

  async initializeAfterLevel() {
    if (!this.active) return;
    this.host.inputSystem.setPointerLockEnabled(false);
    this.parkMainPlayer();
    await this.spawnDog(this.config);
    this.spawnNpcDogs();
    // NPC chase pair / flock exist after spawnNpcDogs — re-bind spectacle cams.
    const mode = normalizeCameraMode(this.config.cameraMode);
    if (isSpectacleCameraMode(mode)) {
      this.applyCameraMode(mode, { snap: true });
    }
    globalThis.addEventListener?.(CONFIG_EVENT, this._onConfig);
  }

  spawnNpcDogs() {
    const level = this.host.levelSystem?.level;
    if (!level?.parkBounds) return;
    this.npcSystem?.dispose();
    this.npcSystem = new DogParkNpcSystem({
      scene: this.host.sceneSystem.scene,
      levelSystem: this.host.levelSystem,
      mudField: level.mudField,
      mudPatches: level.mudPatches ?? [],
      bounds: level.parkBounds,
      spawnPoint: level.dogSpawnPoint,
      getCamera: () => this.host.cameraSystem?.camera ?? null,
      // Player as high-priority crowd agent so chase/cats part around them.
      getPlayerAgent: () => {
        if (!this.dog?.root) return null;
        const p = this.dog.root.position;
        const yaw = this.dog.animation?.getRootYaw?.() ?? 0;
        const speed = this.controller?.horizontalSpeed ?? 0;
        return {
          x: p.x,
          z: p.z,
          dirX: Math.sin(yaw),
          dirZ: Math.cos(yaw),
          speed,
          radius: this.controller?.radius ?? 0.34,
          maxSpeed: 4.2,
        };
      },
    });
  }

  async spawnDog(config, { preservePose = false } = {}) {
    const previousPosition = preservePose && this.dog ? this.dog.root.position.clone() : null;
    const previousYaw = preservePose && this.dog ? this.dog.animation.getRootYaw() : 0;
    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;
    this.mudCoat?.dispose?.();
    this.mudCoat = null;
    this.mudContact = null;
    this.ragdoll?.dispose?.();
    this.ragdoll = null;
    this.dog?.dispose?.();

    const mouthState = normalizeMouthState(config.mouthState);
    // Non-mesh insects fall back to golden; ladybug-rig builds the procedural bug.
    const requestedBreedId = normalizeDogBreedId(config.breedId);
    const breedId = (isInsectBreed(requestedBreedId) && !isLadybugBreed(requestedBreedId))
      ? normalizeDogBreedId('golden-retriever')
      : requestedBreedId;
    const seed = Number.isFinite(Number(config.seed)) ? Number(config.seed) : 1;
    const shellCount = Number.isFinite(Number(config.shellCount)) ? Number(config.shellCount) : undefined;
    // Factory routing mirrors DogSimScene.rebuildDog: birds → goose body,
    // cat-rig → createProceduralCat, horse-rig → createProceduralHorse,
    // ladybug-rig → createProceduralLadybug; everything else stays dog-skeleton.
    let dog;
    if (isBirdBreed(breedId)) {
      dog = await createProceduralGoose({
        breedId,
        seed,
        variantId: config.variantId,
        shellCount,
      });
    } else if (isCatRigBreed(breedId)) {
      dog = createProceduralCat({
        breedId,
        seed,
        variantId: config.variantId,
        shellCount,
      });
    } else if (isHorseRigBreed(breedId)) {
      dog = createProceduralHorse({
        breedId,
        seed,
        variantId: config.variantId,
        shellCount,
      });
    } else if (isLadybugBreed(breedId)) {
      dog = createProceduralLadybug({
        breedId,
        seed,
        variantId: config.variantId,
        shellCount: shellCount != null ? Math.min(shellCount, 16) : undefined,
      });
    } else {
      dog = createProceduralDog({
        breedId,
        seed,
        variantId: config.variantId,
        shellCount,
      });
    }

    dog.setNakedBody?.(Boolean(config.naked));
    dog.setShowFur?.(config.showFur !== false);
    dog.animation.setMouthState?.(mouthState);

    const spawn = previousPosition
      ?? this.host.levelSystem.level?.dogSpawnPoint
      ?? { x: 0, y: 0, z: 0 };
    const birdLike = isBirdBreed(breedId) || dog.isBird || dog.rigKind === 'goose';
    const ownsWorldRoot = animalOwnsWorldRoot(dog, breedId);
    if (ownsWorldRoot) {
      // Facades that rewrite outer root TRS from rootPos each frame need the
      // world spawn baked into rootPos — otherwise the first update snaps to 0.
      dog.root.position.set(spawn.x, spawn.y, spawn.z);
      dog.animation.setRootPosition(spawn.x, spawn.y, spawn.z);
      dog.animation.setFlightAltitudeOverride?.(0);
    } else {
      dog.root.position.copy(spawn);
      dog.animation.setRootPosition(0, 0, 0);
    }
    dog.animation.setRootYaw(previousYaw);
    this.host.sceneSystem.scene.add(dog.root);

    this.dog = dog;

    // Clips / mud / ragdoll are dog-skeleton features — skip bespoke rigs.
    if (usesDogSkeletonFeatures(dog, breedId) && animalUsesDogClipLibrary(dog)) {
      this.clipPlayer = new DogClipPlayer(dog);
      void this.clipPlayer.initialize();
    }

    // Hero active ragdoll — may be deferred until physics world exists
    // (park feature boots before PhysicsSystem.initialize).
    this.ragdoll = null;
    this._ensureRagdoll();

    const wantsGooseController = birdLike;
    const hasGooseController = this.controller instanceof GoosePlayerController;
    if (wantsGooseController) {
      if (hasGooseController) this.controller.setGoose(dog);
      else {
        this.controller = new GoosePlayerController({
          goose: dog,
          levelSystem: this.host.levelSystem,
          camera: this.host.cameraSystem.camera,
        });
      }
    } else if (hasGooseController || !this.controller) {
      this.controller = new DogPlayerController({
        dog,
        levelSystem: this.host.levelSystem,
        camera: this.host.cameraSystem.camera,
      });
    } else {
      this.controller.setDog(dog);
    }

    const level = this.host.levelSystem?.level;
    // Mud coat needs dog fur mud uniforms — horse/cat/goose coats omit them.
    const mudUniforms = dog.furUniforms?.mudLowerCoverage ? dog.furUniforms : null;
    if (usesDogSkeletonFeatures(dog, breedId) && mudUniforms) {
      this.mudCoat = new DogMudCoatController({
        uniforms: mudUniforms,
        parent: this.host.sceneSystem.scene,
        camera: this.host.cameraSystem.camera,
        seed: dog.seed,
        groundHeightAt: (x, z, y) => level?.getGroundHeightAt?.({ x, y, z }, 0.02, {
          maxStepUp: 2,
          maxSnapDown: 4,
        }) ?? 0.055,
      });
      if (level?.mudField) {
        this.mudContact = new DogMudContactHelper({
          dog,
          levelSystem: this.host.levelSystem,
          mudField: level.mudField,
          onPawStamp: (stamp) => {
            if (level.addDogPawVisual?.(stamp)) this.mudCoat?.depositPawMud?.(stamp);
          },
        });
      }
    }

    const framingScale = dog.phenotype?.skeleton?.scale
      ?? dog.presentation?.scale
      ?? (ownsWorldRoot ? 1.15 : 1);
    this.camera.initialize(this.host.cameraSystem.camera, dog.rig.root, {
      yaw: previousYaw + Math.PI,
      subjectMode: 'player',
      framingScale,
    });
    this.config = {
      ...this.config,
      ...config,
      breedId: dog.breedId,
      seed: dog.seed,
      shellCount: dog.shellCount,
      mouthState,
      cameraMode: normalizeCameraMode(config.cameraMode ?? this.config.cameraMode),
    };
    if (isSpectacleCameraMode(this.config.cameraMode)) {
      this.applyCameraMode(this.config.cameraMode, { snap: true });
    }
  }

  applyConfig(next) {
    if (!this.active || !next || typeof next !== 'object') return;
    const prevCameraMode = normalizeCameraMode(this.config.cameraMode);
    const merged = {
      ...this.config,
      ...next,
      mouthState: normalizeMouthState(next.mouthState ?? next.faceState ?? this.config.mouthState),
      cameraMode: normalizeCameraMode(
        next.cameraMode ?? next.dogCamera ?? this.config.cameraMode,
      ),
    };
    const needsRebuild = merged.breedId !== this.config.breedId
      || Number(merged.seed) !== Number(this.config.seed)
      || Number(merged.shellCount) !== Number(this.config.shellCount);
    if (needsRebuild) void this.spawnDog(merged, { preservePose: true });
    else {
      this.config = merged;
      this.dog?.setNakedBody?.(Boolean(merged.naked));
      this.dog?.setShowFur?.(merged.showFur !== false);
      if (merged.behavior) this.dog?.animation?.setBehavior?.(merged.behavior);
      this.dog?.animation?.setMouthState?.(merged.mouthState);
    }
    if (normalizeCameraMode(this.config.cameraMode) !== prevCameraMode) {
      this.applyCameraMode(this.config.cameraMode, { snap: true });
    }
  }

  /**
   * Point the park cam at the player dog, the squirrel chase, or the cinematic tour.
   * @param {'player' | 'squirrel-chase' | 'cinematic'} mode
   * @param {{ snap?: boolean }} [opts]
   */
  applyCameraMode(mode, { snap = true } = {}) {
    if (!this.active || !this.camera) return;
    const resolved = normalizeCameraMode(mode);
    this.config = { ...this.config, cameraMode: resolved };

    if (resolved === 'cinematic') {
      this.camera.active = true;
      this.cinematic.start({
        snapCamera: this.host.cameraSystem?.camera ?? null,
      });
      return;
    }

    this.cinematic.stop();

    if (resolved === 'squirrel-chase') {
      const target = this.npcSystem?.chasePair?.getSquirrelCameraTarget?.() ?? null;
      if (!target) {
        // Chase pair not ready — stay on player until it is.
        this.config.cameraMode = 'player';
        this._bindPlayerCamera({ snap });
        return;
      }
      const motion = this.npcSystem.chasePair.getSquirrelCameraMotion?.();
      const yaw = (motion?.headingYaw ?? 0) + Math.PI;
      this.camera.active = true;
      this.camera.setTarget(target, {
        yaw,
        subjectMode: 'cinematic',
        snap,
      });
      return;
    }

    this.camera.active = true;
    this._bindPlayerCamera({ snap });
  }

  _bindPlayerCamera({ snap = true } = {}) {
    if (!this.dog?.rig?.root || !this.camera) return;
    const yaw = (this.dog.animation?.getRootYaw?.() ?? 0) + Math.PI;
    this.camera.setTarget(this.dog.rig.root, {
      yaw,
      subjectMode: 'player',
      framingScale: this.dog.phenotype?.skeleton?.scale ?? 1,
      snap,
    });
  }

  parkMainPlayer() {
    if (!this.active) return;
    const character = this.host.characterSystem?.character;
    if (!character) return;
    character.hiddenForDogPark = true;
    const park = this.host.levelSystem?.level?.spawnPoint;
    if (park && character.group) {
      character.group.position.copy(park);
      character.velocity?.set?.(0, 0, 0);
      if (typeof character.verticalVelocity === 'number') character.verticalVelocity = 0;
    }
    if (character.group) character.group.visible = false;
    if (character.wingsuitRig?.group) character.wingsuitRig.group.visible = false;
    if (character.proceduralJacket?.group) character.proceduralJacket.group.visible = false;
    const clothMesh = character.jacketCloth?.mesh ?? character.jacketCloth?.object ?? null;
    if (clothMesh) clothMesh.visible = false;
  }

  prepareInput(input) {
    if (!this.active) return input;
    const photoMode = Boolean(this.host.cameraSystem?.photoMode);
    const cameraMode = normalizeCameraMode(this.config?.cameraMode);
    const spectacle = isSpectacleCameraMode(cameraMode);
    // Freecam (K) and spectacle cams freeze the player dog so look/orbit
    // input isn't fighting locomotion. frameInput still carries look for the cam.
    const lockDog = photoMode || spectacle;
    this.frameInput = lockDog
      ? {
          ...input,
          moveX: 0,
          moveZ: 0,
          jump: false,
          jumpPressed: false,
          brace: false,
          bracePressed: false,
          crouchHeld: false,
          crouchPressed: false,
          drawSheathePressed: false,
          mountPressed: false,
          cutModePressed: false,
        }
      : input;

    if (photoMode) {
      // Pass freecam controls through; strip combat so Mara stays inert.
      return {
        ...input,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        mousePrimaryPressed: false,
        drawSheathePressed: false,
        shoulderThrowPressed: false,
        cutModePressed: false,
        telekinesisPressed: false,
        hookFirePressed: false,
        abilityPressed: false,
        abilityDoubleTapped: false,
        wingsuitTogglePressed: false,
        mountPressed: false,
        gunSlotPressed: null,
        dodgeDirection: null,
      };
    }

    // Spectacle cams: keep look/zoom/orbit edges for DogCameraSystem, strip Mara.
    if (spectacle) {
      return {
        ...input,
        moveX: 0,
        moveZ: 0,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        mousePrimaryPressed: false,
        drawSheathePressed: false,
        shoulderThrowPressed: false,
        cutModePressed: false,
        telekinesisPressed: false,
        hookFirePressed: false,
        abilityPressed: false,
        abilityDoubleTapped: false,
        wingsuitTogglePressed: false,
        dodgeDirection: null,
        mountPressed: false,
        gunSlotPressed: null,
      };
    }

    return {
      ...input,
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      zoomDelta: 0,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      mousePrimaryHeld: false,
      mouseSecondaryHeld: false,
      mouseMiddleHeld: false,
      jump: false,
      jumpPressed: false,
      brace: false,
      bracePressed: false,
      crouchHeld: false,
      crouchPressed: false,
      slide: false,
      slidePressed: false,
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
      gunSlotPressed: null,
    };
  }

  /**
   * Physics boots after dog-park feature init — create ragdoll on demand.
   * @returns {DogActiveRagdoll | null}
   */
  _ensureRagdoll() {
    if (this.ragdoll) {
      if (this.dog && this.ragdoll.dog !== this.dog) this.ragdoll.setDog(this.dog);
      return this.ragdoll;
    }
    // Dog-skeleton flop only — horse/cat/bird/insect bones don't match the graph.
    if (!this.dog || !usesDogSkeletonFeatures(this.dog)) return null;
    if (!this.host.physicsSystem?.world || !this.host.physicsSystem?.RAPIER) return null;
    this.ragdoll = new DogActiveRagdoll(this.dog, this.host.physicsSystem);
    this.ragdoll.setGroundSampler((x, z) => {
      const y = this.host.levelSystem?.getGroundHeightAt?.(
        { x, y: 0, z },
        0.28,
        { maxStepUp: 2, maxSnapDown: 4 },
      );
      return Number.isFinite(y) ? y : 0;
    });
    return this.ragdoll;
  }

  /**
   * Mud impact + hero ragdoll handoff (clip Death impact or procedural flop).
   * @param {{ headingX: number, headingZ: number }} heading
   */
  _triggerFlopImpact(heading) {
    const headingX = heading.headingX ?? 0;
    const headingZ = heading.headingZ ?? 1;
    const accepted = this.host.levelSystem?.level?.applyDogFlopImpact?.({
      position: this.dog.root.position,
      headingX,
      headingZ,
    });
    if (accepted) {
      this.mudCoat?.depositFlopMud?.({
        position: this.dog.root.position,
        headingX,
        headingZ,
        scale: this.dog.phenotype?.skeleton?.scale ?? 1,
      });
    }
    const ragdoll = this._ensureRagdoll();
    if (ragdoll) {
      // Sample flop pose into world matrices, then hand bones to physics.
      this.dog.root?.updateMatrixWorld?.(true);
      const ok = ragdoll.activate({
        headingX,
        headingZ,
        // Soft — procedural pose already did the roll.
        impulse: accepted ? 1.6 : 1.1,
        // Stay limp until time's up (no spring recover), then pose-lerp to stand.
        limpDuration: 1.9,
        blendDuration: 0.85,
      });
      if (!ok) {
        console.warn('[dog-park] ragdoll activate failed (physics not ready?)');
      }
    } else {
      console.warn('[dog-park] ragdoll unavailable — no physics world yet');
    }
    this._procFlop = null;
    this.dog.animation?.clearFlop?.();
  }

  updateDog(delta) {
    if (!this.active || !this.dog) return;
    this.parkMainPlayer();
    // Paused freecam freezes the sim earlier in the frame; live freecam still
    // advances the dog but locks player-driven actions (see frameInput above).
    if (this.host.cameraSystem?.photoMode && !this.host.cameraSystem?.photoModeLive) {
      return;
    }
    this.npcSystem?.update(delta);
    // Physics may finish init after first frames — keep trying.
    this._ensureRagdoll();

    const input = this.frameInput ?? {};
    const photoMode = Boolean(this.host.cameraSystem?.photoMode);
    const isGoose = this.dog.isBird
      || this.dog.rigKind === 'goose'
      || this.dog.phenotype?.rigKind === 'goose'
      || isBirdBreed(this.dog.breedId)
      || this.controller instanceof GoosePlayerController;
    const dogSkeleton = usesDogSkeletonFeatures(this.dog);
    const ragdollActive = Boolean(this.ragdoll?.active);

    // Z → flop: always procedural side-flop → ragdoll. Never the Death clip —
    // locomotion stays clip-driven; flop/dead is procedural-only special case.
    if (
      dogSkeleton
      && !ragdollActive
      && input.drawSheathePressed
      && !this.dog.animation?.isFlopping?.()
      && !this._procFlop
    ) {
      this.clipPlayer?.suspendForProcedural?.();
      this.dog.animation?.setClipDriven?.(false);
      this.dog.animation?.startFlop?.();
      this._procFlop = {
        t: 0,
        // Hand off after a calm crouch+tip — not mid-flail.
        impactAt: 0.58,
        hold: 2.8,
        impactFired: false,
        // Slower procedural roll (~1.2s) reads as a flop, not a spasm.
        duration: 1.2,
      };
    }

    // Advance procedural flop pose + fire impact once (mud + ragdoll handoff).
    let procImpact = false;
    if (this._procFlop && !ragdollActive) {
      const progress = this.dog.animation?.advanceFlop?.(delta, this._procFlop.duration)
        ?? (this._procFlop.t / this._procFlop.duration);
      this._procFlop.t += delta;
      if (!this._procFlop.impactFired && progress >= this._procFlop.impactAt) {
        this._procFlop.impactFired = true;
        procImpact = true;
      }
      // If ragdoll never starts, end flop after hold and restore clips.
      if (this._procFlop.t >= this._procFlop.hold && !this.ragdoll?.active) {
        this.dog.animation?.clearFlop?.();
        this._procFlop = null;
        if (this.clipPlayer?.ready) {
          this.clipPlayer.resumeFromProcedural?.('Idle');
          this.dog.animation?.setClipDriven?.(true);
        }
      }
    }

    const clipBusy = Boolean(this.clipPlayer?.isBusy?.());
    const procBusy = Boolean(this._procFlop) || Boolean(this.dog.animation?.isFlopping?.());
    // Hard-lock only flop/ragdoll/photo — Jump/Bark one-shots must NOT zero
    // move or block re-jump setup (that made run+jump impossible).
    const actionLocked = procBusy || photoMode || ragdollActive;
    // Mixer owns locomotion when ready; flop/ragdoll always reclaim the skeleton.
    if (dogSkeleton) {
      if (ragdollActive || procBusy) {
        this.dog.animation?.setClipDriven?.(false);
      } else {
        this.dog.animation?.setClipDriven?.(Boolean(this.clipPlayer?.ready));
      }
    }

    if (ragdollActive) {
      this.ragdoll.update(delta);
      if (!this.ragdoll?.active) {
        this._procFlop = null;
        this.dog.animation?.clearFlop?.();
        // Hand locomotion back to skeleton clips when available.
        if (this.clipPlayer?.ready) {
          this.clipPlayer.resumeFromProcedural?.('Idle');
          this.dog.animation?.setClipDriven?.(true);
        } else {
          this.dog.animation?.setClipDriven?.(false);
        }
      }
    } else if (procBusy) {
      // Drive flop pose without player stick or mixer fighting it.
      this.controller.enabled = false;
      this.dog.update?.(delta, {
        fixed: false,
        plantFeet: false,
        skipFurDynamics: false,
      });
      this.controller.enabled = true;
    } else {
      this.controller?.update(delta, {
        ...input,
        actionLocked,
        deferFootPlant: Boolean(this.clipPlayer?.ready),
      });
      if (dogSkeleton && !actionLocked && this.clipPlayer?.ready) {
        if (this.controller?.jumpStartedThisFrame) {
          // Recover into current gait so a run-jump lands back into Run/Walk.
          const behavior = this.dog.animation?.getBehavior?.() ?? 'idle';
          const recoverTo = behavior === 'trot' ? 'Run'
            : behavior === 'walk' ? 'Walk'
              : 'Idle';
          this.clipPlayer.playOneShot?.('Jump', {
            recoverTo,
            holdEnd: 0,
            recoverFade: 0.22,
            fadeIn: 0.06,
          });
        } else if (input.mountPressed && !clipBusy) {
          this.clipPlayer.playOneShot?.('Bark', {
            recoverTo: 'Idle',
            holdEnd: 0,
            recoverFade: 0.28,
            fadeIn: 0.08,
          });
        }
      }
      this.clipPlayer?.update?.(delta, this.dog.animation.getBehavior());
      if (this.clipPlayer?.ready) {
        this.dog.animation?.applyPostClipOverlays?.();
      }
      // Plant while grounded — dog skeleton only; bespoke rigs plant internally.
      if (dogSkeleton && this.controller?.jumpPhase !== 'air') {
        const pos = this.dog.root.position;
        const radius = this.controller.radius ?? 0.34;
        const probe = new THREE.Vector3();
        plantDogFeet(this.dog, {
          getGroundHeight: (x, z) => {
            probe.set(x, pos.y, z);
            const y = this.host.levelSystem?.getGroundHeightAt?.(probe, radius * 0.45, {
              maxStepUp: 0.48,
              maxSnapDown: 1.2,
              requiredInset: Math.min(radius * 0.25, 0.1),
            });
            return Number.isFinite(y) ? y : pos.y;
          },
        });
      }
    }

    const yaw = this.dog.animation.getRootYaw();
    const headingX = Math.sin(yaw);
    const headingZ = Math.cos(yaw);
    // Mud + ragdoll only from procedural flop impact — never Death-clip edges.
    if (dogSkeleton && procImpact) {
      this._triggerFlopImpact({ headingX, headingZ });
    }
    if (dogSkeleton) {
      this.mudContact?.update?.(delta, {
        moving: !actionLocked && !ragdollActive && (this.controller.horizontalSpeed > 0.12
          || ['walk', 'trot'].includes(this.dog.animation.getBehavior())),
        airborne: ragdollActive || this.controller.jumpPhase !== 'none',
        surfaceClass: this.controller.surfaceClass,
        headingX,
        headingZ,
        movementIntensity: Math.min(1, (this.controller.horizontalSpeed ?? 0) / 4.5),
      });
      this.mudCoat?.update?.(delta, { camera: this.host.cameraSystem.camera });
      this.host.levelSystem?.level?.updateMud?.(delta, this.dog.root.position);
    }
  }

  updateCamera(delta) {
    if (!this.active) return;
    // Camera mode freecam owns the view — do not fight it with chase cam.
    if (this.host.cameraSystem?.photoMode) return;
    this.parkMainPlayer();

    const cameraMode = normalizeCameraMode(this.config?.cameraMode);
    if (cameraMode === 'cinematic') {
      if (!this.cinematic.active) {
        this.cinematic.start({
          snapCamera: this.host.cameraSystem?.camera ?? null,
        });
      }
      this.cinematic.update(delta, {
        camera: this.host.cameraSystem.camera,
        chaseCamera: this.camera,
        frameInput: this.frameInput ?? {},
      });
      return;
    }

    if (this.cinematic.active) this.cinematic.stop();

    if (cameraMode === 'squirrel-chase') {
      const chase = this.npcSystem?.chasePair;
      const target = chase?.getSquirrelCameraTarget?.() ?? null;
      if (!target) {
        // Pair despawned/missing — fall back so we never freeze the cam.
        if (this.config.cameraMode !== 'player') {
          this.config.cameraMode = 'player';
          this.camera.active = true;
          this._bindPlayerCamera({ snap: false });
        }
      } else if (this.camera.targetObject !== target) {
        this.applyCameraMode('squirrel-chase', { snap: false });
      }
      this.camera.active = true;
      const motion = chase?.getSquirrelCameraMotion?.() ?? {
        headingYaw: 0,
        yawRate: 0,
        moving: true,
        speed: 2.5,
        forwardIntent: 1,
      };
      this.camera.update(delta, this.frameInput ?? {}, motion);
      return;
    }

    // Ensure we stay bound to the player dog after leaving spectacle modes.
    this.camera.active = true;
    if (this.dog?.rig?.root && this.camera.targetObject !== this.dog.rig.root) {
      this._bindPlayerCamera({ snap: false });
    }
    const anim = this.dog?.animation;
    const controller = this.controller;
    const behavior = anim?.getBehavior?.() ?? '';
    const flying = this.controller instanceof GoosePlayerController
      && this.controller.flightPhase !== 'grounded';
    this.camera.update(delta, this.frameInput ?? {}, {
      headingYaw: anim?.getRootYaw?.() ?? 0,
      yawRate: anim?.getYawRate?.() ?? controller?.yawRate ?? 0,
      moving: (controller?.horizontalSpeed ?? 0) > 0.08
        || behavior === 'walk'
        || behavior === 'trot'
        || flying
        || behavior.startsWith?.('fly_')
        || behavior === 'takeoff',
      speed: controller?.horizontalSpeed
        ?? anim?.getMoveSpeed?.()
        ?? 0,
      forwardIntent: controller?.forwardIntent ?? (flying ? 1 : 0),
    });
  }

  snapshot() {
    return {
      active: this.active,
      breedId: this.dog?.breedId ?? this.config.breedId,
      familyId: this.dog?.familyId ?? null,
      speciesId: this.dog?.speciesId
        ?? this.dog?.phenotype?.speciesId
        ?? null,
      seed: this.dog?.seed ?? this.config.seed,
      shellCount: this.dog?.shellCount ?? this.config.shellCount,
      mouthState: this.dog?.animation?.getMouthState?.() ?? this.config.mouthState ?? 'closed',
      naked: this.dog?.getNakedBody?.() ?? Boolean(this.config.naked),
      cameraMode: normalizeCameraMode(this.config?.cameraMode),
      dog: this.controller?.snapshot?.() ?? null,
      animationClips: this.clipPlayer?.snapshot?.() ?? {
        enabled: false,
        ready: false,
        clip: null,
        clips: 0,
        library: 'procedural',
        procedural: true,
      },
      // Clips when mixer ready; procedural only while loading or as explicit fallback.
      animationMode: this.clipPlayer?.ready ? 'clips' : 'procedural',
      ragdoll: this.ragdoll?.snapshot?.() ?? { active: false, mode: 'inactive', bodies: 0 },
      mud: this.host.levelSystem?.level?.snapshot?.()?.mud ?? null,
      mudCoat: this.mudCoat?.snapshot?.() ?? null,
      camera: {
        ...this.camera.snapshot(),
        mode: normalizeCameraMode(this.config?.cameraMode),
        cinematic: this.cinematic?.snapshot?.() ?? null,
      },
      npc: this.npcSystem?.snapshot?.() ?? null,
      isGoose: Boolean(
        this.dog?.isBird
        || this.dog?.rigKind === 'goose'
        || this.dog?.phenotype?.rigKind === 'goose'
        || isBirdBreed(this.dog?.breedId)
        || this.controller instanceof GoosePlayerController
      ),
      rigKind: this.dog?.rigKind
        ?? this.dog?.phenotype?.rigKind
        ?? (isHorseRigBreed(this.dog?.breedId) ? 'horse'
          : isCatRigBreed(this.dog?.breedId) ? 'cat'
            : isLadybugBreed(this.dog?.breedId) ? 'insect'
              : isBirdBreed(this.dog?.breedId) ? 'goose'
                : 'dog'),
      boneCount: this.dog?.boneCount ?? this.dog?.rig?.boneCount ?? null,
    };
  }

  dispose() {
    globalThis.removeEventListener?.(CONFIG_EVENT, this._onConfig);
    this.cinematic?.stop?.();
    this.camera.dispose();
    this.controller = null;
    this.mudContact = null;
    this.mudCoat?.dispose?.();
    this.mudCoat = null;
    this.ragdoll?.dispose?.();
    this.ragdoll = null;
    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;
    this.dog?.dispose?.();
    this.dog = null;
    this.npcSystem?.dispose?.();
    this.npcSystem = null;
  }
}

function readDogConfig() {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  return {
    breedId: normalizeDogBreedId(params.get('breed') ?? 'golden-retriever'),
    variantId: params.get('variant') ?? params.get('dogVariant') ?? undefined,
    seed: Number(params.get('dogSeed') ?? params.get('seed') ?? 1) || 1,
    // Default 12 shells — 18+ looks richer but multiplies transparent skinned draws.
    shellCount: Number(params.get('dogShells') ?? 12) || 12,
    mouthState: normalizeMouthState(params.get('dogMouth') ?? params.get('mouth') ?? 'closed'),
    naked: params.get('dogNaked') === '1',
    showFur: params.get('dogFur') !== '0',
    cameraMode: normalizeCameraMode(
      params.get('dogCamera') ?? params.get('parkCamera') ?? 'player',
    ),
  };
}
