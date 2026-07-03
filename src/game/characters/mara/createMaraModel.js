import * as THREE from 'three';

const MATERIALS = {
  coat: new THREE.MeshStandardMaterial({ color: 0x4a2d27, roughness: 0.78 }),
  harness: new THREE.MeshStandardMaterial({ color: 0x14110d, roughness: 0.68 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xb87954, roughness: 0.7 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x27312e, roughness: 0.76 }),
  pitch: new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.92 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x8c8679, roughness: 0.4, metalness: 0.65 }),
  wax: new THREE.MeshStandardMaterial({ color: 0xd0a15c, roughness: 0.64 }),
};

export function createMaraModel() {
  const group = new THREE.Group();
  group.name = 'Mara Vey Placeholder Model';

  const root = new THREE.Group();
  root.name = 'Mara Animation Root';
  root.scale.setScalar(0.92);
  group.add(root);

  const torso = createTorso();
  const head = createHead();
  const leftArm = createArm({ name: 'Left Arm', side: -1 });
  const rightArm = createArm({ name: 'Right Arm', side: 1 });
  const leftLeg = createLeg({ name: 'Left Leg', side: -1 });
  const rightLeg = createLeg({ name: 'Right Leg', side: 1 });
  const hook = createHookSpear();

  torso.position.y = 1.08;
  head.position.y = 1.68;
  leftArm.position.set(-0.29, 1.34, 0);
  rightArm.position.set(0.29, 1.34, 0);
  leftLeg.position.set(-0.13, 0.77, 0);
  rightLeg.position.set(0.13, 0.77, 0);
  hook.position.set(0.36, 1.02, 0.18);

  root.add(torso, head, leftArm, rightArm, leftLeg, rightLeg, hook);

  const shadow = createGroundShadow();
  group.add(shadow);

  return {
    group,
    velocity: new THREE.Vector3(),
    rig: {
      root,
      torso,
      head,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      hook,
    },
  };
}

function createTorso() {
  const torso = new THREE.Group();
  torso.name = 'Torso Rig';

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.68, 0.3), MATERIALS.coat);
  body.name = 'Short Field Coat';
  body.scale.set(0.9, 1, 0.86);
  body.castShadow = true;

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.12, 12), MATERIALS.pitch);
  collar.name = 'Pitch Collar';
  collar.position.y = 0.38;
  collar.castShadow = true;

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.1, 0.34), MATERIALS.harness);
  belt.name = 'Grip Harness Belt';
  belt.position.y = -0.16;
  belt.castShadow = true;

  const harness = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.055, 0.05), MATERIALS.harness);
  harness.name = 'Grip Harness';
  harness.position.set(0, 0.08, 0.16);
  harness.rotation.z = 0.64;
  harness.castShadow = true;

  const pitchMark = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.035), MATERIALS.pitch);
  pitchMark.name = 'Black Pitch Cloth Mark';
  pitchMark.position.set(0.13, 0.02, 0.17);
  pitchMark.rotation.z = -0.12;

  torso.add(body, collar, belt, harness, pitchMark);

  return torso;
}

function createHead() {
  const head = new THREE.Group();
  head.name = 'Head Rig';

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 14), MATERIALS.skin);
  skull.castShadow = true;

  const scarf = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.1, 16), MATERIALS.pitch);
  scarf.name = 'Salt Scarf';
  scarf.position.y = -0.13;
  scarf.castShadow = true;

  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.155, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.63), MATERIALS.coat);
  hood.name = 'Low Hood';
  hood.position.y = -0.012;
  hood.rotation.x = Math.PI;
  hood.castShadow = true;

  head.add(skull, scarf, hood);
  return head;
}

function createArm({ name, side }) {
  const arm = new THREE.Group();
  arm.name = `${name} Rig`;

  const upper = createCapsuleSegment({
    name: `${name} Upper`,
    length: 0.34,
    radius: 0.052,
    material: MATERIALS.coat,
  });
  upper.position.set(side * 0.035, -0.18, 0.01);
  upper.rotation.z = side * 0.16;

  const forearm = createCapsuleSegment({
    name: `${name} Forearm`,
    length: 0.31,
    radius: 0.047,
    material: MATERIALS.coat,
  });
  forearm.position.set(side * 0.075, -0.5, 0.02);
  forearm.rotation.z = side * -0.2;

  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), MATERIALS.pitch);
  glove.name = `${name} Glove`;
  glove.position.set(side * 0.1, -0.66, 0.02);
  glove.scale.set(0.85, 1, 0.75);
  glove.castShadow = true;

  arm.rotation.z = side * -0.22;
  arm.add(upper, forearm, glove);

  return arm;
}

function createLeg({ name, side }) {
  const leg = new THREE.Group();
  leg.name = `${name} Rig`;

  const thigh = createCapsuleSegment({
    name: `${name} Thigh`,
    length: 0.36,
    radius: 0.064,
    material: MATERIALS.cloth,
  });
  thigh.position.set(side * 0.012, -0.2, 0);
  thigh.rotation.z = side * -0.04;

  const shin = createCapsuleSegment({
    name: `${name} Shin`,
    length: 0.34,
    radius: 0.055,
    material: MATERIALS.cloth,
  });
  shin.position.set(side * 0.018, -0.53, 0.015);
  shin.rotation.z = side * 0.035;

  const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.23), MATERIALS.pitch);
  boot.name = `${name} Boot`;
  boot.position.set(side * 0.022, -0.73, -0.045);
  boot.castShadow = true;

  leg.add(thigh, shin, boot);

  return leg;
}

function createCapsuleSegment({ name, length, radius, material }) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
  mesh.name = name;
  mesh.position.y = -length * 0.5;
  mesh.castShadow = true;

  return mesh;
}

function createHookSpear() {
  const hook = new THREE.Group();
  hook.name = 'Hook Spear Rig';

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.88, 8), MATERIALS.metal);
  shaft.rotation.z = Math.PI * 0.5;
  shaft.castShadow = true;

  const point = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.15, 12), MATERIALS.wax);
  point.position.x = 0.52;
  point.rotation.z = -Math.PI * 0.5;
  point.castShadow = true;

  const barb = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.011, 8, 20, Math.PI * 1.25), MATERIALS.metal);
  barb.position.x = 0.42;
  barb.position.y = -0.05;
  barb.rotation.set(0, Math.PI * 0.5, -0.7);
  barb.castShadow = true;

  hook.rotation.z = -0.08;
  hook.add(shaft, point, barb);

  return hook;
}

function createGroundShadow() {
  const material = new THREE.MeshBasicMaterial({
    color: 0x15120f,
    opacity: 0.16,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.58, 32), material);
  shadow.name = 'Mara Contact Shadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.021;

  return shadow;
}
