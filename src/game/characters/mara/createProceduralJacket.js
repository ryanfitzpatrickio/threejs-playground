import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, normalLocal, positionLocal, sin, time, uv, vec3 } from 'three/tsl';

const torsoOffset = new THREE.Vector3(0, -0.23, 0.025);
const leftArmOffset = new THREE.Vector3(0, -0.02, 0);
const rightArmOffset = new THREE.Vector3(0, -0.02, 0);
const worldPosition = new THREE.Vector3();
const worldQuaternion = new THREE.Quaternion();
const worldScale = new THREE.Vector3();

export function createProceduralJacket(character) {
  const modelRoot = character?.animationController?.modelRoot;
  if (!modelRoot) return null;

  const bones = {
    spine: findBone(modelRoot, 'mixamorigSpine1') ?? findBone(modelRoot, 'mixamorigSpine'),
    chest: findBone(modelRoot, 'mixamorigSpine2') ?? findBone(modelRoot, 'mixamorigSpine1'),
    leftArm: findBone(modelRoot, 'mixamorigLeftArm'),
    rightArm: findBone(modelRoot, 'mixamorigRightArm'),
  };

  if (!bones.spine || !bones.chest) {
    console.warn('[jacket] Procedural jacket needs spine/chest bones.');
    return null;
  }

  const material = createFabricMaterial();
  const group = new THREE.Group();
  group.name = `ProceduralJacket_${character.modelId ?? 'player'}`;

  const torso = createTorsoShell(material);
  torso.name = 'ProceduralJacketTorso';
  group.add(torso);

  const leftSleeve = bones.leftArm ? createSleeve(material.clone(), 'left') : null;
  const rightSleeve = bones.rightArm ? createSleeve(material.clone(), 'right') : null;
  if (leftSleeve) group.add(leftSleeve);
  if (rightSleeve) group.add(rightSleeve);

  const rig = {
    type: 'procedural',
    group,
    material,
    bones,
    torso,
    leftSleeve,
    rightSleeve,
    elapsed: 0,
    update(delta = 0) {
      this.elapsed += delta;
      updateTorso(this);
      if (this.leftSleeve) updateSleeve(this.leftSleeve, this.bones.leftArm, leftArmOffset, this.elapsed, 1);
      if (this.rightSleeve) updateSleeve(this.rightSleeve, this.bones.rightArm, rightArmOffset, this.elapsed, -1);
    },
    dispose() {
      group.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      group.removeFromParent();
    },
  };

  rig.update(0);
  return rig;
}

function createTorsoShell(material) {
  const geometry = new THREE.CylinderGeometry(
    0.28,
    0.34,
    0.78,
    56,
    18,
    true,
    0.56,
    Math.PI * 2 - 1.12,
  );
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

function createSleeve(material, side) {
  const geometry = new THREE.CylinderGeometry(0.085, 0.12, 0.5, 28, 12, true, 0.2, Math.PI * 2 - 0.4);
  geometry.rotateZ(Math.PI / 2);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `ProceduralJacket${side === 'left' ? 'Left' : 'Right'}Sleeve`;
  mesh.frustumCulled = false;
  return mesh;
}

function createFabricMaterial() {
  const material = new MeshStandardNodeMaterial({
    color: 0x1f2933,
    roughness: 0.88,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });

  material.positionNode = Fn(() => {
    const p = positionLocal;
    const hem = uv().y.oneMinus();
    const waveA = sin(p.x.mul(18).add(time.mul(4.2))).mul(0.012);
    const waveB = sin(p.z.mul(13).add(p.y.mul(5)).add(time.mul(2.8))).mul(0.009);
    const flutter = sin(time.mul(5.6).add(p.x.mul(4))).mul(hem.mul(0.02));
    return p.add(normalLocal.mul(waveA.add(waveB).add(flutter)));
  })();
  material.normalNode = normalLocal.add(vec3(0.01, 0.006, 0.014).mul(sin(time.mul(4.4))));
  material.needsUpdate = true;

  return material;
}

function updateTorso(rig) {
  rig.bones.chest.updateWorldMatrix(true, false);
  rig.bones.chest.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);

  rig.torso.position.copy(worldPosition).add(torsoOffset.applyQuaternion(worldQuaternion));
  rig.torso.quaternion.copy(worldQuaternion);
  rig.torso.scale.setScalar(1);
  rig.torso.updateMatrixWorld(true);
  torsoOffset.set(0, -0.23, 0.025);
}

function updateSleeve(mesh, bone, offset, elapsed, side) {
  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);

  mesh.position.copy(worldPosition).add(offset.applyQuaternion(worldQuaternion));
  mesh.quaternion.copy(worldQuaternion);
  mesh.rotateZ(side * 0.12);
  mesh.rotateX(Math.sin(elapsed * 5 + side) * 0.035);
  mesh.scale.setScalar(1);
  mesh.updateMatrixWorld(true);
  offset.set(0, -0.02, 0);
}

function findBone(root, name) {
  const direct = root.getObjectByName(name);
  if (direct?.isBone) return direct;

  const normalized = normalizeBoneName(name);
  let found = null;
  root.traverse((child) => {
    if (!found && child.isBone && normalizeBoneName(child.name) === normalized) {
      found = child;
    }
  });
  return found;
}

function normalizeBoneName(name) {
  return String(name).replace(/^mixamorig:?/i, '').toLowerCase();
}
