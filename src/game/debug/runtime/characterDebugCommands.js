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
export function createCharacterDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    adjustSaddle: (boneNameOrOptions = {}, options = {}) => {
      this.horseSystem.adjustSaddle(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    setSaddle: (boneNameOrOptions = {}, options = {}) => {
      this.horseSystem.setSaddle(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    adjustSaddleOffset: (boneNameOrOptions = {}, options = {}) => {
      this.horseSystem.adjustSaddleOffset(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    setSaddleOffset: (boneNameOrOptions = {}, options = {}) => {
      this.horseSystem.setSaddleOffset(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    dumpHorseBones: (filter) => this.horseSystem.dumpBones(filter),
    adjustHorseBone: (boneNameOrOptions = {}, options = {}) => {
      return this.horseSystem.adjustBone(normalizeHorseBoneCommandOptions(boneNameOrOptions, options));
    },
    setHorseBone: (boneNameOrOptions = {}, options = {}) => {
      return this.horseSystem.setBone(normalizeHorseBoneCommandOptions(boneNameOrOptions, options));
    },
    resetHorseBone: (boneNameOrOptions = {}) => {
      return this.horseSystem.resetBone(normalizeHorseBoneCommandOptions(boneNameOrOptions));
    },
    setHorseFrontLegBend: (options = {}) => {
      this.horseSystem.setFrontLegBendCorrection(options);
      return this.snapshot();
    },
    resetHorseFrontLegBend: () => {
      this.horseSystem.resetFrontLegBendCorrection();
      return this.snapshot();
    },
    setHorseFrontLegIk: (options = {}) => {
      this.horseSystem.setFrontLegIk(options);
      return this.snapshot();
    },
    resetHorseFrontLegIk: () => {
      this.horseSystem.resetFrontLegIk();
      return this.snapshot();
    },
    setRiderSocket: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.setRiderSocket(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    adjustRiderSocket: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.adjustRiderSocket(normalizeSaddleCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    resetRiderSocket: () => {
      this.mountSystem.resetRiderSocket();
      return this.snapshot();
    },
    setRiderGrip: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.setRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    adjustRiderGrip: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.adjustRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    resetRiderGrip: () => {
      this.mountSystem.resetRiderGrip();
      return this.snapshot();
    },
    dumpSwordSocket: () => {
      const character = this.characterSystem.character;
      const sword = character?.sword;
      if (!sword?.group) {
        return { error: 'no sword attached' };
      }
      const g = sword.group;
      const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
      return {
        position: { x: g.position.x, y: g.position.y, z: g.position.z },
        rotationDegrees: {
          x: THREE.MathUtils.radToDeg(e.x),
          y: THREE.MathUtils.radToDeg(e.y),
          z: THREE.MathUtils.radToDeg(e.z),
        },
        scale: g.scale.x,
        quaternion: [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w],
      };
    },
    setSwordSocket: (options = {}) => {
      const character = this.characterSystem.character;
      const sword = character?.sword;
      if (!sword?.group) {
        console.warn('No sword attached');
        return this.snapshot();
      }
      const g = sword.group;
      if (options.position) {
        g.position.set(
          Number.isFinite(options.position.x) ? options.position.x : g.position.x,
          Number.isFinite(options.position.y) ? options.position.y : g.position.y,
          Number.isFinite(options.position.z) ? options.position.z : g.position.z
        );
      }
      if (options.rotationDegrees) {
        const current = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
        const rd = options.rotationDegrees;
        const e = new THREE.Euler(
          Number.isFinite(rd.x) ? THREE.MathUtils.degToRad(rd.x) : current.x,
          Number.isFinite(rd.y) ? THREE.MathUtils.degToRad(rd.y) : current.y,
          Number.isFinite(rd.z) ? THREE.MathUtils.degToRad(rd.z) : current.z,
          'XYZ'
        );
        g.quaternion.setFromEuler(e);
      }
      if (Number.isFinite(options.scale)) {
        g.scale.setScalar(options.scale);
      }
      return this.snapshot();
    },
    adjustSwordSocket: (options = {}) => {
      const character = this.characterSystem.character;
      const sword = character?.sword;
      if (!sword?.group) {
        console.warn('No sword attached');
        return this.snapshot();
      }
      const g = sword.group;
      if (options.position) {
        g.position.x += Number(options.position.x) || 0;
        g.position.y += Number(options.position.y) || 0;
        g.position.z += Number(options.position.z) || 0;
      }
      if (options.rotationDegrees) {
        const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
        const rd = options.rotationDegrees;
        e.x += Number.isFinite(rd.x) ? THREE.MathUtils.degToRad(rd.x) : 0;
        e.y += Number.isFinite(rd.y) ? THREE.MathUtils.degToRad(rd.y) : 0;
        e.z += Number.isFinite(rd.z) ? THREE.MathUtils.degToRad(rd.z) : 0;
        g.quaternion.setFromEuler(e);
      }
      if (Number.isFinite(options.scale)) {
        g.scale.multiplyScalar(options.scale);
      }
      return this.snapshot();
    },
    resetSwordSocket: () => {
      const character = this.characterSystem.character;
      const sword = character?.sword;
      if (!sword?.group) {
        console.warn('No sword attached');
        return this.snapshot();
      }
      const g = sword.group;
      // Match the baked defaults
      g.position.set(0, 5, 2);
      g.quaternion.setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(180),
        0,
        THREE.MathUtils.degToRad(-44),
        'XYZ'
      ));
      return this.snapshot();
    },
    forceMount: () => {
      const character = this.characterSystem.character;
      if (character && this.mountSystem.state === 'idle' && this.horseSystem.status === 'ready') {
        this.mountSystem.startMount(character);
      }
      return this.snapshot();
    },
    setHorseYaw: (degrees = 0) => {
      if (this.horseSystem.group) {
        this.horseSystem.group.rotation.set(
          0,
          THREE.MathUtils.degToRad(degrees),
          0,
        );
      }
      return this.snapshot();
    },
    setRiderTimeScale: (scale = 1) => {
      const action = this.characterSystem.character?.animationController?.currentAction;
      if (action) {
        action.setEffectiveTimeScale(scale);
      }
      return this.snapshot();
    },
    dumpRiderBones: () => riderBoneDump(this.characterSystem.character),
  };
}
