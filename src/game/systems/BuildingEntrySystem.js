// BuildingEntrySystem — P0 detection for "walk up to any building and enter"
// (docs/office-interior-wfc-plan.md). Read-only for now: each frame it finds the
// nearest enterable building near the player and, when the player is close and
// roughly facing it, raises a prompt the HUD renders. The actual enter/exit swap
// is wired separately. All the geometry lives in world/office/buildingEntry.js so
// it stays node-testable (verify:office-entry).

import * as THREE from 'three';
import {
  findNearestEnterableBuilding,
  computeDoorAnchor,
  isFacingDoor,
} from '../world/office/buildingEntry.js';

// Gather colliders within this disc around the player, then test the big ones.
const CANDIDATE_RADIUS = 10;
// Prompt when the building footprint edge is within this many metres.
const ENTER_RANGE = 3.5;
// Lenient facing gate: camera forward only needs to lean toward the wall.
const FACING_MIN_DOT = 0.1;

export class BuildingEntrySystem {
  constructor() {
    this.state = { prompt: false, building: null, doorAnchor: null, distance: Infinity };
    this._forward = new THREE.Vector3();
    this._candidates = [];
  }

  /**
   * @param {object} args
   * @param {object} args.level   the active level (needs `colliders` / `colliderIndex`)
   * @param {THREE.Vector3} args.position  player feet position
   * @param {THREE.Camera} [args.camera]   for the facing test
   * @param {boolean} [args.enabled]  false while driving/mounted/etc.
   */
  update({ level, position, camera, enabled = true } = {}) {
    this.state.prompt = false;
    this.state.building = null;
    this.state.doorAnchor = null;
    this.state.distance = Infinity;
    if (!enabled || !level || !position) return this.state;

    // Candidate colliders near the player (spatial index where available, else
    // the flat list). isEnterableBuilding() then filters out roads/props by size.
    const candidates = this._candidates;
    candidates.length = 0;
    const index = level.colliderIndex;
    if (index?.forEachInPointRadius) {
      index.forEachInPointRadius(position.x, position.z, CANDIDATE_RADIUS, (c) => candidates.push(c));
    } else if (Array.isArray(level.colliders)) {
      for (const c of level.colliders) candidates.push(c);
    }
    if (candidates.length === 0) return this.state;

    const nearest = findNearestEnterableBuilding({
      colliders: candidates,
      position,
      range: ENTER_RANGE,
    });
    if (!nearest) return this.state;

    const door = computeDoorAnchor({
      building: nearest.building,
      position,
      groundY: position.y,
    });

    if (camera) {
      camera.getWorldDirection(this._forward);
      if (!isFacingDoor({ x: this._forward.x, z: this._forward.z }, door.inwardNormal, FACING_MIN_DOT)) {
        return this.state;
      }
    }

    this.state.prompt = true;
    this.state.building = nearest.building;
    this.state.doorAnchor = door;
    this.state.distance = nearest.distance;
    return this.state;
  }

  snapshot() {
    return {
      prompt: this.state.prompt,
      distance: this.state.prompt ? Number(this.state.distance.toFixed(2)) : null,
      building: this.state.building?.name ?? null,
      facade: this.state.doorAnchor?.facade ?? null,
    };
  }
}
