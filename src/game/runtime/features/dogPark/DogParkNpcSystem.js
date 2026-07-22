import * as THREE from 'three';
import {
  CHASE_DOG_BREED,
  CHASE_PAIR_COUNT,
  CHASE_SQUIRREL_BREED,
  DogParkChasePair,
} from './DogParkChasePair.js';
import {
  DogParkGooseFlock,
  FLOCK_COUNT,
  FLOCK_SHELL_COUNT,
} from './DogParkGooseFlock.js';
import {
  CAT_FIGHT_COUNT,
  CAT_FIGHT_SHELL_COUNT,
  DogParkCatFight,
} from './DogParkCatFight.js';
import {
  DogParkTreePigeons,
  TREE_PIGEON_COUNT,
  TREE_PIGEON_SHELL_COUNT,
} from './DogParkTreePigeons.js';
import { pickFurDetailLevel } from '../../../characters/dog/dogFurLod.js';
import { DogParkCrowd } from './DogParkCrowd.js';
import { DogParkNav } from './DogParkNav.js';

/**
 * Spectacle-only NPC budget for the dog park.
 * Ambient random dogs were the main draw-call killer; cinematic only needs
 * the chase pair, goose V, cat fight, and tree pigeons.
 */
/** @deprecated Ambient pack removed — kept at 0 for verify scripts / callers. */
export const MAX_NPC_DOGS = 0;
/** Fixed golden-retriever ↔ grey-squirrel chase pair (always on). */
export { CHASE_PAIR_COUNT, CHASE_DOG_BREED, CHASE_SQUIRREL_BREED };
/** Fur shells per chase-pair actor. */
export const NPC_SHELL_COUNT = 2;

const _camPos = new THREE.Vector3();
const _subjectPos = new THREE.Vector3();

/**
 * @deprecated Ambient pack removed. Kept so older verifies importing the helper
 * still resolve; always returns [].
 */
export function pickNpcBreedIds(_allIds, max = MAX_NPC_DOGS) {
  void _allIds;
  void max;
  return [];
}

/**
 * Park NPC layer: chase pair + cinematic spectacles (no ambient dog pack).
 */
export class DogParkNpcSystem {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   levelSystem: object,
   *   mudField?: object,
   *   mudPatches?: object[],
   *   bounds?: object,
   *   spawnPoint?: { x: number, y?: number, z: number },
   *   getCamera?: () => THREE.Camera | null | undefined,
   *   getPlayerAgent?: () => {
   *     x: number, z: number, dirX?: number, dirZ?: number,
   *     speed?: number, radius?: number, maxSpeed?: number,
   *   } | null,
   *   maxDogs?: number,
   *   shellCount?: number,
   * }} opts
   */
  constructor({
    scene,
    levelSystem,
    mudPatches = [],
    bounds,
    spawnPoint,
    getCamera = null,
    getPlayerAgent = null,
    shellCount = NPC_SHELL_COUNT,
  }) {
    this.scene = scene;
    this.levelSystem = levelSystem;
    this.getCamera = typeof getCamera === 'function' ? getCamera : null;
    this.getPlayerAgent = typeof getPlayerAgent === 'function' ? getPlayerAgent : null;
    /** Ambient pack removed — empty for snapshot / director compatibility. */
    this.npcs = [];
    this.chasePair = null;
    /** @type {DogParkGooseFlock | null} */
    this.gooseFlock = null;
    /** @type {DogParkCatFight | null} */
    this.catFight = null;
    /** @type {DogParkTreePigeons | null} */
    this.treePigeons = null;
    this.crowd = new DogParkCrowd();
    /** Navcat bake around fence/lake/play structure for path following. */
    this.nav = bounds
      ? new DogParkNav({
        colliders: levelSystem?.level?.colliders ?? levelSystem?.colliders ?? [],
        bounds,
        lake: levelSystem?.level?.lake ?? null,
        floorY: 0,
      })
      : null;
    this._lodFrame = 0;
    this._flockSpawn = null;
    this._pigeonSpawn = null;

    // Signature scene bit: golden retriever never quite catches the grey squirrel.
    this.chasePair = new DogParkChasePair({
      scene,
      levelSystem,
      bounds,
      spawnPoint,
      shellCount,
    });
    this.chasePair.setNav?.(this.nav);

    // Cat spar near the west lawn / mud — cinematic “cat fight” beat.
    const mud = mudPatches[0];
    const catCenter = mud
      ? { x: mud.x + 4.5, z: mud.z - 2.5 }
      : { x: -16, z: -7 };
    try {
      this.catFight = new DogParkCatFight({
        scene,
        levelSystem,
        center: catCenter,
        shellCount: CAT_FIGHT_SHELL_COUNT,
      });
    } catch (error) {
      console.warn('[dog-park] cat fight spawn failed', error);
      this.catFight = null;
    }

    // Canada-goose V in the sky — async mesh build so park boot stays snappy.
    const parkCenter = bounds
      ? {
          x: (bounds.minX + bounds.maxX) * 0.5,
          z: (bounds.minZ + bounds.maxZ) * 0.5,
        }
      : spawnPoint
        ? { x: spawnPoint.x, z: spawnPoint.z }
        : undefined;
    this._flockSpawn = DogParkGooseFlock.create({
      scene,
      bounds,
      center: parkCenter,
      shellCount: FLOCK_SHELL_COUNT,
      count: FLOCK_COUNT,
    }).then((flock) => {
      this.gooseFlock = flock;
      return flock;
    }).catch((error) => {
      console.warn('[dog-park] goose flock spawn failed', error);
      this.gooseFlock = null;
      return null;
    });

    // Rock pigeons in the north canopy (bugs stand-in).
    this._pigeonSpawn = DogParkTreePigeons.create({
      scene,
      count: TREE_PIGEON_COUNT,
      shellCount: TREE_PIGEON_SHELL_COUNT,
    }).then((group) => {
      this.treePigeons = group;
      return group;
    }).catch((error) => {
      console.warn('[dog-park] tree pigeon spawn failed', error);
      this.treePigeons = null;
      return null;
    });
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    this._lodFrame = (this._lodFrame + 1) % 3;
    const camera = this.getCamera?.() ?? null;
    if (camera) camera.getWorldPosition(_camPos);
    const dt = Math.min(Math.max(delta || 0, 0), 0.05);

    // --- Crowd phase: register preferred velocities, solve ORCA-lite ---
    this.crowd.begin();
    const player = this.getPlayerAgent?.() ?? null;
    if (player && Number.isFinite(player.x) && Number.isFinite(player.z)) {
      this.crowd.register({
        id: 'player-dog',
        x: player.x,
        z: player.z,
        dirX: player.dirX ?? 0,
        dirZ: player.dirZ ?? 0,
        speed: player.speed ?? 0,
        radius: player.radius ?? 0.34,
        maxSpeed: player.maxSpeed ?? 4,
        // High priority: NPCs yield; player stick still wins via not consuming result.
        priority: 3.2,
        group: 'player',
      });
    }
    this.chasePair?.registerCrowd?.(this.crowd);
    this.catFight?.registerCrowd?.(this.crowd);
    this.crowd.solve(dt);

    if (this.chasePair) {
      this.chasePair.updateLod(camera, this._lodFrame);
      const chaseFar = (this.chasePair.dog?.detailLevel ?? 1) <= 0
        && (this.chasePair.squirrel?.detailLevel ?? 1) <= 0;
      this.chasePair.update(delta, {
        skipFurDynamics: chaseFar,
        skipClips: chaseFar,
        crowd: this.crowd,
      });
    }

    this.gooseFlock?.update(delta);
    this.treePigeons?.update(delta);

    if (this.catFight) {
      let catFar = false;
      if (camera && this._lodFrame === 0) {
        this.catFight.getMidpoint(_subjectPos);
        const dist = _subjectPos.distanceTo(_camPos);
        for (const cat of this.catFight.cats) {
          const prev = cat.getDetailLevel?.() ?? 2;
          const level = pickFurDetailLevel(dist, prev);
          catFar = catFar || level <= 0;
          if (level !== prev) cat.setDetailLevel?.(level);
        }
      } else {
        catFar = (this.catFight.cats[0]?.getDetailLevel?.() ?? 1) <= 0;
      }
      // Thin cat stacks keep all shells; far only skips fur dynamics.
      this.catFight.update(delta, { skipFurDynamics: catFar, crowd: this.crowd });
    }
  }

  snapshot() {
    return {
      count: CHASE_PAIR_COUNT
        + (this.catFight?.cats?.length ?? 0)
        + (this.gooseFlock?.birds?.length ?? 0)
        + (this.treePigeons?.birds?.length ?? 0),
      ambient: 0,
      max: MAX_NPC_DOGS,
      shells: NPC_SHELL_COUNT,
      chase: this.chasePair?.snapshot?.() ?? null,
      gooseFlock: this.gooseFlock?.snapshot?.() ?? { ready: false, count: 0 },
      catFight: this.catFight?.snapshot?.() ?? null,
      treePigeons: this.treePigeons?.snapshot?.() ?? { ready: false, count: 0 },
      crowd: this.crowd?.snapshot?.() ?? null,
      nav: this.nav?.snapshot?.() ?? null,
      spectacle: {
        chase: CHASE_PAIR_COUNT,
        cats: CAT_FIGHT_COUNT,
        geese: FLOCK_COUNT,
        pigeons: TREE_PIGEON_COUNT,
        catShells: CAT_FIGHT_SHELL_COUNT,
        gooseShells: FLOCK_SHELL_COUNT,
        pigeonShells: TREE_PIGEON_SHELL_COUNT,
      },
      dogs: [],
    };
  }

  dispose() {
    this.chasePair?.dispose?.();
    this.chasePair = null;
    this.gooseFlock?.dispose?.();
    this.gooseFlock = null;
    this.catFight?.dispose?.();
    this.catFight = null;
    this.treePigeons?.dispose?.();
    this.treePigeons = null;
    this.nav?.dispose?.();
    this.nav = null;
    this._flockSpawn = null;
    this._pigeonSpawn = null;
    this.npcs = [];
  }
}
