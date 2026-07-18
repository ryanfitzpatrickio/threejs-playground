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
export function createCombatDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    cutNearestSoldier: ({ heightFactor = 0.5, enemyId = null, normal = [0, 1, 0] } = {}) => {
      const character = this.characterSystem.character;
      const enemies = this.enemySystem?.enemies ?? [];
      const origin = character?.group?.position ?? new THREE.Vector3();

      // Accept classic soldiers and mixamo-humanoid horde bots (faceless/tessy/cyclop).
      const isCuttable = (enemy) => Boolean(
        enemy?.model
        && (enemy.archetype === 'soldier' || enemy.limbLossProfile === 'mixamo-humanoid'),
      );

      let target = null;
      if (enemyId != null) {
        target = enemies.find((e) => e?.id === enemyId && isCuttable(e)) ?? null;
      } else {
        let nearestDistSq = Infinity;
        for (const enemy of enemies) {
          if (!isCuttable(enemy)) continue;
          const distSq = enemy.model.position.distanceToSquared(origin);
          if (distSq < nearestDistSq) {
            nearestDistSq = distSq;
            target = enemy;
          }
        }
      }
      if (!target) {
        return { cut: false, reason: 'no soldier found' };
      }

      const box = new THREE.Box3().setFromObject(target.model, true);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
      // Horizontal plane: place it at the requested body-height fraction
      // (waist cut). Anything else: run it through the body center so the cut
      // bisects the soldier cleanly (heightFactor is ignored).
      const constant = Math.abs(n.y) > 0.9
        ? -(box.min.y + size.y * heightFactor)
        : -center.dot(n);
      const plane = new THREE.Plane(n, constant);
      const ok = this.enemyCutSystem.applyDirectCut({
        enemy: target,
        plane,
        physicsSystem: this.physicsSystem,
        enemySystem: this.enemySystem,
        propSystem: this.propSystem,
        cutSystem: this.enemyCutSystem,
      });
      return {
        cut: !!ok,
        enemyId: target.id,
        archetype: target.archetype ?? null,
        position: { x: Number(target.model.position.x.toFixed(2)), y: Number(target.model.position.y.toFixed(2)), z: Number(target.model.position.z.toFixed(2)) },
        normal: [Number(n.x.toFixed(2)), Number(n.y.toFixed(2)), Number(n.z.toFixed(2))],
        constant: Number(constant.toFixed(2)),
        result: this.enemyCutSystem.lastResult,
        timing: this.enemyCutSystem.lastCutMs,
      };
    },
    gunSeverNearest: ({ region = 'armL', enemyId = null } = {}) => {
      const character = this.characterSystem.character;
      const origin = character?.group?.position ?? new THREE.Vector3();
      const candidates = (this.enemySystem?.enemies ?? []).filter(
        (enemy) => enemy?.model && enemy.limbLossProfile === 'mixamo-humanoid',
      );
      const target = enemyId != null
        ? candidates.find((enemy) => enemy.id === enemyId)
        : candidates.sort(
          (a, b) => a.model.position.distanceToSquared(origin) - b.model.position.distanceToSquared(origin),
        )[0];
      const plane = target ? buildLimbSeverPlane(target, region) : null;
      const cut = plane && this.enemyCutSystem.applyGunLimbSever({
        enemy: target,
        region,
        plane,
        physicsSystem: this.physicsSystem,
        enemySystem: this.enemySystem,
      });
      return {
        cut: Boolean(cut),
        enemyId: target?.id ?? null,
        archetype: target?.archetype ?? null,
        region,
        result: this.enemyCutSystem.lastResult,
        timing: this.enemyCutSystem.lastCutMs,
      };
    },
    cutProps: () => {
      const props = this.enemyCutSystem?.props ?? [];
      return props.map((prop) => {
        let position = null;
        if (prop.type === 'rigRagdoll') {
          const first = prop.ragdollBodies?.[0]?.body;
          if (first) {
            try {
              const w = prop.physicsWorld;
              const f = (w && first.handle != null) ? w.bodies.get(first.handle) : first;
              const t = f ? f.translation() : null;
              if (t) position = { x: Number(t.x.toFixed(2)), y: Number(t.y.toFixed(2)), z: Number(t.z.toFixed(2)) };
            } catch {}
          }
        } else if (prop.body) {
          try {
            const w = prop.physicsWorld;
            const f = (w && prop.body.handle != null) ? w.bodies.get(prop.body.handle) : prop.body;
            const t = f ? f.translation() : null;
            if (t) position = { x: Number(t.x.toFixed(2)), y: Number(t.y.toFixed(2)), z: Number(t.z.toFixed(2)) };
          } catch {}
        }
        return {
          type: prop.type,
          region: prop.region?.primary ?? null,
          verts: prop.ownedGeometries?.reduce((sum, g) => sum + (g?.attributes?.position?.count ?? 0), 0) ?? null,
          position,
          age: Number((prop.age ?? 0).toFixed(2)),
          visible: prop.root?.visible ?? prop.mesh?.visible ?? null,
        };
      });
    },
    equipGun: (gunId) => this.equipGun(gunId),
    equipWeapon: (weaponId, opts) => this.equipWeapon(weaponId, opts),
    equipAbility: (abilityId) => this.equipAbility(abilityId),
    cycleAbility: (dir) => this.cycleAbility(dir),
    ability: () => this.abilitySystem.snapshot(),
    firstPersonWeapon: () => this.firstPersonWeaponSystem.snapshot(),
    weapon: () => this.weaponSystem.snapshot(),
  };
}
