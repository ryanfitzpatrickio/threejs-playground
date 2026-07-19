/**
 * Headgear meshes (horns / simple antlers) parented to the Head bone.
 * Geometry is procedural; no extra skeleton bones required for MVP.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color as tslColor, float } from 'three/tsl';

/**
 * @param {Map<string, THREE.Bone>} bonesByName
 * @param {object | null} [phenotype]
 */
export function createAnimalHeadgear(bonesByName, phenotype = null) {
  const head = bonesByName.get('Head');
  const type = phenotype?.headgear?.type ?? 'none';
  if (!head || !type || type === 'none') {
    return {
      root: null,
      dispose() {},
    };
  }

  const headScale = phenotype?.skeleton?.headSize ?? 1;
  const skullW = phenotype?.geometry?.skullWidth ?? 1;
  const hg = phenotype.headgear ?? {};
  const length = (hg.length ?? 1) * headScale;
  const curl = hg.curl ?? 0.5;
  const spread = hg.spread ?? 1;
  const thickness = (hg.thickness ?? 1) * headScale;
  const baseColor = hg.color ?? 0xe8dcc8;
  const tipColor = hg.tipColor ?? 0xc4b49a;

  const root = new THREE.Group();
  root.name = 'AnimalHeadgear';
  const disposables = [];

  const mat = (hex) => {
    const m = new MeshBasicNodeMaterial({
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    m.colorNode = tslColor(new THREE.Color(hex));
    m.opacityNode = float(1);
    disposables.push(m);
    return m;
  };

  const baseMat = mat(baseColor);
  const tipMat = mat(tipColor);

  /**
   * Build one curved horn as stacked tapered segments along a spiral path.
   * @param {1 | -1} side
   */
  function buildHorn(side) {
    const hornRoot = new THREE.Group();
    hornRoot.name = side > 0 ? 'HornL' : 'HornR';
    // Sit on the poll, slightly lateral.
    const baseX = side * 0.028 * headScale * skullW * spread;
    const baseY = 0.042 * headScale;
    const baseZ = -0.012 * headScale;
    hornRoot.position.set(baseX, baseY, baseZ);
    // Tip outward and back for caprine / curve more for bovid.
    const outYaw = side * (type === 'horn-bovid' ? 0.55 : 0.35) * spread;
    const backPitch = type === 'horn-bovid' ? -0.55 : -0.35;
    hornRoot.rotation.set(backPitch, outYaw, side * 0.12 * curl);

    const segments = type === 'antler-simple' ? 5 : 7;
    const totalLen = 0.055 * length * (type === 'horn-bovid' ? 1.35 : type === 'antler-simple' ? 1.1 : 1);
    let cursor = new THREE.Vector3(0, 0, 0);
    let dir = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < segments; i += 1) {
      const t = i / Math.max(1, segments - 1);
      const segLen = totalLen / segments;
      const radius = 0.008 * thickness * (1 - t * 0.72);
      const geo = new THREE.CylinderGeometry(
        Math.max(0.0012, radius * 0.72),
        Math.max(0.0015, radius),
        segLen,
        8,
        1,
        false,
      );
      disposables.push(geo);
      // Bend outward/back along the horn.
      const bend = curl * (type === 'horn-bovid' ? 0.42 : 0.28);
      dir.applyAxisAngle(new THREE.Vector3(side, 0, 0), bend * 0.35);
      dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), side * bend * 0.22);
      dir.normalize();

      const mesh = new THREE.Mesh(geo, t > 0.72 ? tipMat : baseMat);
      mesh.position.copy(cursor).addScaledVector(dir, segLen * 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      mesh.renderOrder = 520;
      hornRoot.add(mesh);

      cursor.addScaledVector(dir, segLen);

      // Simple antler: one short tine mid-way.
      if (type === 'antler-simple' && i === 2) {
        const tine = new THREE.CylinderGeometry(0.0025 * thickness, 0.004 * thickness, segLen * 0.85, 6);
        disposables.push(tine);
        const tineMesh = new THREE.Mesh(tine, tipMat);
        tineMesh.position.copy(cursor);
        const tineDir = dir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.9).normalize();
        tineMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tineDir);
        tineMesh.translateY(segLen * 0.35);
        tineMesh.renderOrder = 521;
        hornRoot.add(tineMesh);
      }
    }

    // Blunt tip cap
    const tip = new THREE.SphereGeometry(0.0045 * thickness, 8, 6);
    disposables.push(tip);
    const tipMesh = new THREE.Mesh(tip, tipMat);
    tipMesh.position.copy(cursor);
    tipMesh.renderOrder = 522;
    hornRoot.add(tipMesh);

    return hornRoot;
  }

  /**
   * One tapered cylinder segment from `start` along `dir`, length `len`,
   * radius base→tip. Shared by the antler-rack / tusk builders.
   */
  function cylinderSeg(start, dir, len, radiusBase, radiusTip, material) {
    const geo = new THREE.CylinderGeometry(
      Math.max(0.0012, radiusTip),
      Math.max(0.0015, radiusBase),
      len,
      8,
      1,
      false,
    );
    disposables.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(start).addScaledVector(dir, len * 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.renderOrder = 520;
    return mesh;
  }

  /** Blunt rounded tip cap at the end of a tine / tusk. */
  function tipCap(pos, radius, material) {
    const geo = new THREE.SphereGeometry(Math.max(0.0015, radius), 8, 6);
    disposables.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(pos);
    mesh.renderOrder = 522;
    return mesh;
  }

  /**
   * Branched multi-tine antler (cervid stag): a main beam sweeping up-and-back
   * with a forward brow (bay) tine, an upward tray (surroyal) tine, and a small
   * forked crown at the tip. Richer than the single-tine `antler-simple`.
   * @param {1 | -1} side
   */
  function buildAntlerRack(side) {
    const rackRoot = new THREE.Group();
    rackRoot.name = side > 0 ? 'AntlerL' : 'AntlerR';
    // Pedicle on the poll, slightly lateral.
    const baseX = side * 0.026 * headScale * skullW * spread;
    const baseY = 0.044 * headScale;
    const baseZ = -0.014 * headScale;
    rackRoot.position.set(baseX, baseY, baseZ);
    // Outward yaw + back pitch so the beam sweeps up-and-back over the head.
    rackRoot.rotation.set(-0.3, side * 0.25 * spread, side * 0.05);

    const mainLen = 0.075 * length;
    const r0 = 0.0075 * thickness;
    const segs = 3;
    const segLen = mainLen / segs;
    let cursor = new THREE.Vector3(0, 0, 0);
    let dir = new THREE.Vector3(0, 1, 0).normalize();

    for (let i = 0; i < segs; i += 1) {
      const t = i / Math.max(1, segs - 1);
      const r = r0 * (1 - t * 0.5);
      // Bend the beam backward (pitch around local X).
      dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.26 * (0.5 + curl)).normalize();
      rackRoot.add(cylinderSeg(cursor, dir, segLen, r, r * 0.8, i >= 2 ? tipMat : baseMat));
      cursor = cursor.clone().addScaledVector(dir, segLen);

      // Brow (bay) tine off the first segment — forward & up.
      if (i === 0) {
        const tineDir = dir.clone()
          .applyAxisAngle(new THREE.Vector3(1, 0, 0), 1.1)
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.4)
          .normalize();
        const tineLen = segLen * 1.0;
        const tr = r * 0.6;
        rackRoot.add(cylinderSeg(cursor, tineDir, tineLen, tr, tr * 0.7, tipMat));
        rackRoot.add(tipCap(cursor.clone().addScaledVector(tineDir, tineLen), tr * 0.7, tipMat));
      }
      // Tray (surroyal) tine off the second segment — more vertical.
      if (i === 1) {
        const tineDir = dir.clone()
          .applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.3)
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.5)
          .normalize();
        const tineLen = segLen * 0.95;
        const tr = r * 0.55;
        rackRoot.add(cylinderSeg(cursor, tineDir, tineLen, tr, tr * 0.7, tipMat));
        rackRoot.add(tipCap(cursor.clone().addScaledVector(tineDir, tineLen), tr * 0.7, tipMat));
      }
    }

    // Crown: small fork splaying outward at the beam tip.
    const crownR = r0 * 0.4;
    for (const splay of [-1, 1]) {
      const cdir = dir.clone()
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), side * splay * 0.7)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.2)
        .normalize();
      const cLen = segLen * 0.7;
      rackRoot.add(cylinderSeg(cursor, cdir, cLen, crownR, crownR * 0.7, tipMat));
      rackRoot.add(tipCap(cursor.clone().addScaledVector(cdir, cLen), crownR * 0.7, tipMat));
    }
    return rackRoot;
  }

  /**
   * Paired lower/upper canine tusks (suid / warthog): emerge from the muzzle
   * sides and curl upward then back over the snout. Pointed ivory tips.
   * @param {1 | -1} side
   */
  function buildTusk(side) {
    const tuskRoot = new THREE.Group();
    tuskRoot.name = side > 0 ? 'TuskL' : 'TuskR';
    const muzzleLen = (phenotype?.skeleton?.muzzleLength ?? 1) * headScale;
    const baseX = side * 0.022 * headScale * skullW;
    const baseY = -0.012 * headScale;
    const baseZ = 0.05 * headScale + muzzleLen * 0.04;
    tuskRoot.position.set(baseX, baseY, baseZ);
    tuskRoot.rotation.set(-0.15, side * 0.12, side * 0.1);

    const totalLen = 0.08 * length;
    const r0 = 0.006 * thickness;
    const segs = 5;
    const segLen = totalLen / segs;
    let cursor = new THREE.Vector3(0, 0, 0);
    // Initial dir: forward, slightly up — tusk lifts off the lip.
    let dir = new THREE.Vector3(0, 0.2, 0.98).normalize();
    for (let i = 0; i < segs; i += 1) {
      const t = i / Math.max(1, segs - 1);
      const r = r0 * (1 - t * 0.55);
      // Curl upward (−X pitch) then sweep outward.
      dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.32 + curl * 0.18).normalize();
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), side * 0.08).normalize();
      tuskRoot.add(cylinderSeg(cursor, dir, segLen, r, r * 0.7, t > 0.7 ? tipMat : baseMat));
      cursor = cursor.clone().addScaledVector(dir, segLen);
    }
    // Sharp ivory tip.
    const tipGeo = new THREE.ConeGeometry(Math.max(0.0015, r0 * 0.45), segLen * 0.6, 8);
    disposables.push(tipGeo);
    const tipMesh = new THREE.Mesh(tipGeo, tipMat);
    tipMesh.position.copy(cursor).addScaledVector(dir, segLen * 0.3);
    tipMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    tipMesh.renderOrder = 523;
    tuskRoot.add(tipMesh);
    return tuskRoot;
  }

  if (type === 'horn-caprine' || type === 'horn-bovid' || type === 'antler-simple') {
    root.add(buildHorn(1));
    root.add(buildHorn(-1));
  } else if (type === 'antler-rack') {
    root.add(buildAntlerRack(1));
    root.add(buildAntlerRack(-1));
  } else if (type === 'tusk-boar') {
    root.add(buildTusk(1));
    root.add(buildTusk(-1));
  }

  head.add(root);

  return {
    root,
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
}
