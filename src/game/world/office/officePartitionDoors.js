// officePartitionDoors.js — dark trim, wood + glass doors, visible cove light strips.

import * as THREE from 'three';
import { doorMountFrame, doorEdgeWorld, PARTITION_THICKNESS } from './generateOfficeLayout.js';
import { getOfficeAluminumMaterial, getOfficeGlassMaterial } from './officeGlassMaterial.js';

const TRIM_FRAME_MATERIAL = getOfficeAluminumMaterial();
const MEETING_GLASS_MATERIAL = getOfficeGlassMaterial();
const FROSTED_INSERT_MATERIAL = getOfficeGlassMaterial({ insert: true });
const HANDLE_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xc8d0d8, roughness: 0.2, metalness: 0.9,
});

function doorFrameOuterCorners(door, originMinX, originMinZ, cw, cd) {
  const dw = doorEdgeWorld(door, originMinX, originMinZ, cw, cd);
  const { roomGx, roomGz, axis } = door;
  const z0 = originMinZ + roomGz * cd;
  const z1 = originMinZ + (roomGz + 1) * cd;
  const x0 = originMinX + roomGx * cw;
  const x1 = originMinX + (roomGx + 1) * cw;
  if (axis === 'x') {
    return [
      { x: dw.x, z: z0, yaw: dw.yaw },
      { x: dw.x, z: z1, yaw: dw.yaw },
    ];
  }
  return [
    { x: x0, z: dw.z, yaw: dw.yaw },
    { x: x1, z: dw.z, yaw: dw.yaw },
  ];
}

function sharedDoorFrameCorners(doorEdges, originMinX, originMinZ, cw, cd) {
  const hits = new Map();
  for (const door of doorEdges) {
    if (door.zone === 'elevator') continue;
    for (const c of doorFrameOuterCorners(door, originMinX, originMinZ, cw, cd)) {
      const key = `${Math.round(c.x * 1000)},${Math.round(c.z * 1000)}`;
      if (!hits.has(key)) hits.set(key, []);
      hits.get(key).push(c);
    }
  }
  const shared = [];
  for (const group of hits.values()) {
    if (group.length < 2) continue;
    let nx = 0;
    let nz = 0;
    for (const g of group) {
      nx += Math.sin(g.yaw);
      nz += Math.cos(g.yaw);
    }
    const len = Math.hypot(nx, nz) || 1;
    shared.push({
      x: group[0].x + (nx / len) * (PARTITION_THICKNESS * 0.5 + 0.055),
      z: group[0].z + (nz / len) * (PARTITION_THICKNESS * 0.5 + 0.055),
      yaw: Math.atan2(nx, nz),
    });
  }
  return shared;
}

function frameBox(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

function doorLeafGeometry(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h * 0.5, 0);
  return g;
}

export function addPartitionDoors({
  floorGroup,
  layout,
  originMinX,
  originMinZ,
  floorY,
  wallHeight,
  cw,
  cd,
  lightBudget = null,
  doors = [],
  colliders = [],
}) {
  const root = new THREE.Group();
  root.name = 'Office Partition Doors';

  for (const door of layout.doorEdges ?? []) {
    if (door.zone === 'elevator') continue;

    const m = doorMountFrame(door, originMinX, originMinZ, cw, cd, wallHeight);
    const frame = new THREE.Group();
    frame.position.set(m.faceX, floorY, m.faceZ);
    frame.rotation.y = m.yaw;

    const frameD = 0.1;
    const halfEdge = m.edgeLen * 0.5;
    const frontZ = frameD * 0.5 + 0.018;
    const leafW = m.opening - 0.06;
    const leafH = m.doorH - 0.04;

    const header = frameBox(m.opening, m.headerH, frameD, TRIM_FRAME_MATERIAL);
    header.position.set(0, m.doorH + m.headerH * 0.5, 0);
    frame.add(header);

    const sill = frameBox(m.opening, 0.05, frameD, TRIM_FRAME_MATERIAL);
    sill.position.set(0, 0.025, 0);
    frame.add(sill);

    if (m.jambW > 0.04) {
      const jambL = frameBox(m.jambW, wallHeight, frameD, TRIM_FRAME_MATERIAL);
      jambL.position.set(-halfEdge + m.jambW * 0.5, wallHeight * 0.5, 0);
      frame.add(jambL);

      const jambR = frameBox(m.jambW, wallHeight, frameD, TRIM_FRAME_MATERIAL);
      jambR.position.set(halfEdge - m.jambW * 0.5, wallHeight * 0.5, 0);
      frame.add(jambR);
    }

    // Every office/breakout door is a physically solid glass leaf. The pivot is
    // at the left jamb and the mesh is offset by half its width, so rotation is
    // a real hinge rather than a spin around the centre.
    const pivot = new THREE.Group();
    pivot.position.set(-leafW * 0.5, 0, frontZ);
    pivot.name = `Office Door Hinge ${doors.length}`;
    const leafMaterial = door.zone === 'meeting' ? MEETING_GLASS_MATERIAL : FROSTED_INSERT_MATERIAL;
    const leaf = new THREE.Mesh(doorLeafGeometry(leafW, leafH, 0.045), leafMaterial);
    leaf.position.x = leafW * 0.5;
    leaf.name = `Office Glass Door ${doors.length}`;
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    pivot.add(leaf);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.18, 0.065), HANDLE_MATERIAL);
    handle.position.set(leafW * 0.82, leafH * 0.48, 0.045);
    pivot.add(handle);
    frame.add(pivot);

    const along = new THREE.Vector2(Math.cos(m.yaw), -Math.sin(m.yaw));
    const normal = new THREE.Vector2(Math.sin(m.yaw), Math.cos(m.yaw));
    const halfX = Math.abs(along.x) * leafW * 0.5 + Math.abs(normal.x) * 0.07;
    const halfZ = Math.abs(along.y) * leafW * 0.5 + Math.abs(normal.y) * 0.07;
    const collider = {
      name: `Office Door Collider ${doors.length}`,
      minX: m.faceX - halfX,
      maxX: m.faceX + halfX,
      minZ: m.faceZ - halfZ,
      maxZ: m.faceZ + halfZ,
      bottomY: floorY,
      topY: floorY + leafH,
      disabled: false,
      interactive: true,
    };
    colliders.push(collider);
    doors.push({
      pivot,
      collider,
      x: m.faceX,
      y: floorY + leafH * 0.5,
      z: m.faceZ,
      yaw: m.yaw,
      open: false,
      angle: 0,
      targetAngle: 0,
      zone: door.zone,
    });

    for (const part of frame.children) {
      part.castShadow = true;
      part.receiveShadow = true;
    }

    root.add(frame);
  }

  const frameD = 0.1;
  for (const corner of sharedDoorFrameCorners(layout.doorEdges ?? [], originMinX, originMinZ, cw, cd)) {
    const post = new THREE.Group();
    post.position.set(corner.x, floorY, corner.z);
    post.rotation.y = corner.yaw;
    const filler = frameBox(
      PARTITION_THICKNESS + 0.05,
      wallHeight,
      frameD,
      TRIM_FRAME_MATERIAL,
    );
    filler.position.set(0, wallHeight * 0.5, 0);
    post.add(filler);
    root.add(post);
  }

  if (root.children.length > 0) floorGroup.add(root);
  return root;
}
