/**
 * Procedural propane tank pickup — household cylinder with collar, valve, and
 * side grips for two-hand carry IK.
 *
 * Units are real-world metres. Pivot is at the base centre (sits on the floor).
 * Grip markers live on the shell so hands can IK onto them while carried.
 */

import * as THREE from 'three';

const BODY_R = 0.155;
const BODY_H = 0.72;
const COLLAR_R = 0.12;
const COLLAR_H = 0.09;
const FOOT_R = 0.16;
const FOOT_H = 0.035;

/**
 * @param {{ seed?: number }} [opts]
 * @returns {{
 *   group: THREE.Group,
 *   leftGrip: THREE.Object3D,
 *   rightGrip: THREE.Object3D,
 *   height: number,
 *   radius: number,
 *   kind: 'propaneTank',
 *   dispose: () => void,
 * }}
 */
export function createPropaneTank(opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed : 1;
  const hueShift = ((seed * 17) % 7) * 0.01;

  const shellMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.08 + hueShift, 0.04, 0.78),
    roughness: 0.38,
    metalness: 0.55,
    envMapIntensity: 1.05,
  });
  const bandMat = new THREE.MeshStandardMaterial({
    color: 0x1e4a8c,
    roughness: 0.45,
    metalness: 0.35,
    envMapIntensity: 0.9,
  });
  const collarMat = new THREE.MeshStandardMaterial({
    color: 0x3a3e44,
    roughness: 0.55,
    metalness: 0.7,
    envMapIntensity: 1.0,
  });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xb08a3a,
    roughness: 0.32,
    metalness: 0.85,
    envMapIntensity: 1.15,
  });
  const rubberMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c1e,
    roughness: 0.9,
    metalness: 0.05,
  });
  const labelMat = new THREE.MeshStandardMaterial({
    color: 0xc4281c,
    roughness: 0.55,
    metalness: 0.15,
    envMapIntensity: 0.7,
  });

  const materials = [shellMat, bandMat, collarMat, brassMat, rubberMat, labelMat];
  const group = new THREE.Group();
  group.name = 'PropaneTank';
  group.userData.noStaticMerge = true;
  group.userData.pickupKind = 'propaneTank';
  group.userData.propaneSeed = seed;
  group.userData.interactive = true;

  const bodyY = FOOT_H + BODY_H * 0.5;

  // Foot ring
  const foot = new THREE.Mesh(
    new THREE.CylinderGeometry(FOOT_R, FOOT_R * 0.92, FOOT_H, 20),
    collarMat,
  );
  foot.position.y = FOOT_H * 0.5;
  foot.castShadow = true;
  foot.receiveShadow = true;
  group.add(foot);

  // Main cylinder body
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 28, 1, false),
    shellMat,
  );
  body.position.y = bodyY;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Domed shoulder
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(BODY_R * 0.98, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
    shellMat,
  );
  dome.position.y = FOOT_H + BODY_H;
  dome.castShadow = true;
  group.add(dome);

  // Blue hazard band mid-body
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R + 0.004, BODY_R + 0.004, 0.1, 28, 1, true),
    bandMat,
  );
  band.position.y = bodyY - 0.04;
  group.add(band);

  // Red warning stripe
  const stripe = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R + 0.005, BODY_R + 0.005, 0.035, 28, 1, true),
    labelMat,
  );
  stripe.position.y = bodyY + 0.12;
  group.add(stripe);

  // Protective collar / handle cage
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(COLLAR_R, COLLAR_R * 1.05, COLLAR_H, 18, 1, true),
    collarMat,
  );
  collar.position.y = FOOT_H + BODY_H + BODY_R * 0.55 + COLLAR_H * 0.35;
  collar.castShadow = true;
  group.add(collar);

  // Collar top rim
  const collarRim = new THREE.Mesh(
    new THREE.TorusGeometry(COLLAR_R, 0.012, 8, 20),
    collarMat,
  );
  collarRim.rotation.x = Math.PI * 0.5;
  collarRim.position.y = collar.position.y + COLLAR_H * 0.45;
  group.add(collarRim);

  // Valve stem + handwheel
  const valveBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.032, 0.06, 10),
    brassMat,
  );
  valveBase.position.y = FOOT_H + BODY_H + BODY_R * 0.35;
  group.add(valveBase);

  const valveStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.08, 8),
    brassMat,
  );
  valveStem.position.y = valveBase.position.y + 0.06;
  group.add(valveStem);

  const handwheel = new THREE.Mesh(
    new THREE.TorusGeometry(0.045, 0.008, 6, 16),
    brassMat,
  );
  handwheel.position.y = valveStem.position.y + 0.04;
  group.add(handwheel);
  const wheelHub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8),
    brassMat,
  );
  wheelHub.position.copy(handwheel.position);
  group.add(wheelHub);

  // Side rubber pads where hands rest
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.14, 0.06),
      rubberMat,
    );
    pad.position.set(side * (BODY_R + 0.01), bodyY + 0.02, 0);
    pad.castShadow = true;
    group.add(pad);
  }

  // Grip markers for two-hand IK (world-space after attach).
  // Slightly outboard of the shell, mid-height — natural two-hand carry.
  const leftGrip = new THREE.Object3D();
  leftGrip.name = 'PropaneTankLeftGrip';
  leftGrip.position.set(-(BODY_R + 0.02), bodyY + 0.02, 0.02);
  leftGrip.rotation.set(0, 0, THREE.MathUtils.degToRad(12));
  group.add(leftGrip);

  const rightGrip = new THREE.Object3D();
  rightGrip.name = 'PropaneTankRightGrip';
  rightGrip.position.set(BODY_R + 0.02, bodyY + 0.02, 0.02);
  rightGrip.rotation.set(0, 0, THREE.MathUtils.degToRad(-12));
  group.add(rightGrip);

  // Carry attach point — mid body, used when parenting to the character spine.
  const carryAnchor = new THREE.Object3D();
  carryAnchor.name = 'PropaneTankCarryAnchor';
  carryAnchor.position.set(0, bodyY, 0);
  group.add(carryAnchor);

  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.userData.noStaticMerge = true;
      obj.frustumCulled = true;
    }
  });

  const height = FOOT_H + BODY_H + BODY_R * 0.55 + COLLAR_H + 0.05;

  return {
    group,
    leftGrip,
    rightGrip,
    carryAnchor,
    height,
    radius: BODY_R,
    kind: 'propaneTank',
    seed,
    materials,
    dispose() {
      group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
      });
      for (const mat of materials) mat.dispose?.();
    },
  };
}
