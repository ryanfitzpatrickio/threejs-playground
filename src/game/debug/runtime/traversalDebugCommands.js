import * as THREE from 'three';
import {
  getShaderDebugSnapshot,
  applyShaderDebugSnapshot,
  clearOverridesForFolders,
  clearAllUserOverrides,
  clearLutDirty,
} from '../shaderDebugRegistry.js';
import { setPhotorealismPresetId } from '../../config/photorealismPresets.js';
import {
  findChassisDebugVehicle,
  normalizeHorseBoneCommandOptions,
  normalizeSaddleCommandOptions,
  normalizeGripCommandOptions,
  vectorFromObject,
  riderTransformEuler,
  riderBoneDump,
} from '../../runtime/runtimeHelpers.js';
import { buildLimbSeverPlane } from '../../systems/soldierPartialCut.js';

/** Domain debug commands for __DREAMFALL_DEBUG__. @param {object} rt */
export function createTraversalDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    forceHang: ({ ledgeName, mode, along } = {}) => {
      const character = this.characterSystem.character;
      const ledges = this.levelSystem.level?.ledges ?? [];
      const hangableLedges = ledges.filter((entry) => entry.y >= 1.7);
      const ledge =
        hangableLedges.find((entry) => entry.name === ledgeName) ??
        hangableLedges.find((entry) => entry.face === 'front') ??
        hangableLedges[0] ??
        ledges.find((entry) => entry.name === ledgeName) ??
        ledges[0];

      if (!character || !ledge) {
        return this.snapshot();
      }

      this.ledgeHangSystem.attachToLedge({
        character,
        ledge: {
          ...ledge,
          along: Number.isFinite(along) ? along : (ledge.min + ledge.max) * 0.5,
        },
        mode,
      });

      return this.snapshot();
    },
    forceWallClimb: ({ surfaceName, u = 0, v = 2.2 } = {}) => {
      const character = this.characterSystem.character;
      const surface =
        this.levelSystem.level?.climbSurfaces?.find((entry) => entry.name === surfaceName) ??
        this.levelSystem.level?.climbSurfaces?.[0];

      if (!character || !surface) {
        return this.snapshot();
      }

      this.wallClimbSystem.attach({
        character,
        surface: {
          ...surface,
          origin: vectorFromObject(surface.origin),
          normal: vectorFromObject(surface.normal),
          tangent: vectorFromObject(surface.tangent),
          up: vectorFromObject(surface.up),
          u,
          v,
        },
        input: { brace: false },
      });
      this.wallClimbSystem.snapActiveClimbToSurface(character);

      return this.snapshot();
    },
    forceWallRun: ({ surfaceName, u, v = 1.45, direction = 1 } = {}) => {
      const character = this.characterSystem.character;
      const surface =
        this.levelSystem.level?.wallRunSurfaces?.find((entry) => entry.name === surfaceName || `${entry.blockName} Wall Run Surface` === surfaceName) ??
        this.levelSystem.level?.wallRunSurfaces?.[0];

      if (!character || !surface) {
        return this.snapshot();
      }

      const hydratedSurface = {
        ...surface,
        origin: vectorFromObject(surface.origin),
        normal: vectorFromObject(surface.normal),
        tangent: vectorFromObject(surface.tangent),
        up: vectorFromObject(surface.up),
        u: Number.isFinite(u) ? u : (surface.minU + surface.maxU) * 0.5,
        v,
      };
      this.wallRunSystem.attach({
        character,
        surface: hydratedSurface,
        direction: direction < 0 ? -1 : 1,
      });

      return this.snapshot();
    },
    forceRope: ({ ropeName } = {}) => {
      const character = this.characterSystem.character;
      const rope =
        this.levelSystem.level?.ropes?.find((entry) => entry.name === ropeName) ??
        this.levelSystem.level?.ropes?.[0];

      if (!character || !rope) {
        return this.snapshot();
      }

      character.group.position.set(rope.anchor.x, rope.anchor.y - 2.65, rope.anchor.z);
      this.ropeSystem.attach({
        character,
        rope: {
          ...rope,
          anchor: vectorFromObject(rope.anchor),
          point: new THREE.Vector3(rope.anchor.x, rope.anchor.y - 2.65, rope.anchor.z),
          grabDistance: 2.65,
          swingTangent: vectorFromObject(rope.swingTangent),
        },
      });

      return this.snapshot();
    },
    forceHookSwing: () => {
      const character = this.characterSystem.character;
      if (!character) {
        return this.snapshot();
      }

      const candidate = this.levelSystem.findHookAttachCandidate({
        camera: this.cameraSystem.camera,
        playerPosition: character.group.position,
      });

      if (!candidate) {
        return { error: 'no hook candidate', snapshot: this.snapshot() };
      }

      this.hookSwingSystem.fireHook({
        character,
        candidate,
        movement: { direction: new THREE.Vector3(0, 0, -1), verticalVelocity: 0 },
      });
      return this.snapshot();
    },
  };
}
