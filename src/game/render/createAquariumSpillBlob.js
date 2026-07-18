/**
 * Catastrophic tank dump: a *thick* soft water volume that bursts from the
 * open face and flops onto the floor (meatball / heightfield spirit).
 *
 * Mesh is a subdivided solid box (real depth), not a flat card. Vertices are
 * a soft lattice springing toward an animated rest shape:
 *   t=0 → fat vertical slab filling the open side (remaining water size)
 *   t=1 → thick pancake puddle outside the tank on the floor
 */

import * as THREE from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  attribute,
  color,
  float,
  mix,
  normalView,
  positionViewDirection,
  smoothstep,
} from 'three/tsl';

// Lattice resolution (W × H × D) — enough for a chunky blob.
const NW = 10;
const NH = 9;
const ND = 6;

const _v = new THREE.Vector3();

function faceBasis(face) {
  if (face === '+x') {
    return {
      n: new THREE.Vector3(1, 0, 0),
      u: new THREE.Vector3(0, 0, 1),
      origin: (cx, cz, half) => new THREE.Vector3(cx + half, 0, cz),
    };
  }
  if (face === '-x') {
    return {
      n: new THREE.Vector3(-1, 0, 0),
      u: new THREE.Vector3(0, 0, -1),
      origin: (cx, cz, half) => new THREE.Vector3(cx - half, 0, cz),
    };
  }
  if (face === '+z') {
    return {
      n: new THREE.Vector3(0, 0, 1),
      u: new THREE.Vector3(-1, 0, 0),
      origin: (cx, cz, half) => new THREE.Vector3(cx, 0, cz + half),
    };
  }
  return {
    n: new THREE.Vector3(0, 0, -1),
    u: new THREE.Vector3(1, 0, 0),
    origin: (cx, cz, half) => new THREE.Vector3(cx, 0, cz - half),
  };
}

function createSpillMaterial() {
  const aAmount = attribute('aAmount', 'float');
  const edge = smoothstep(float(0.05), float(0.35), aAmount);
  const fill = smoothstep(float(0.1), float(0.85), aAmount);
  const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.0);

  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    roughness: 0.12,
    metalness: 0.02,
    ior: 1.33,
    transmission: 0.22,
    thickness: 0.55,
    specularIntensity: 1,
  });
  material.toneMapped = true;
  material.opacity = 1;
  // Clear-but-visible body (not invisible film, not solid tank blue).
  const body = mix(color(0x9eb8be), color(0xd0e4e8), fill.mul(0.55));
  material.colorNode = mix(body, color(0xf6fcff), fresnel.mul(0.65));
  // Much more present than the floor film so the dump is obvious.
  material.opacityNode = edge.mul(float(0.28).add(fill.mul(0.42)).add(fresnel.mul(0.18))).clamp(0, 0.78);
  material.userData.aquariumSpillBlob = true;
  return material;
}

/**
 * Build a solid hex lattice mesh (box of cells) and return positions/indices
 * plus mapping of lattice coords → vertex index for surface verts only.
 * We render the outer shell of a NW×NH×ND grid for a volumetric look.
 */
function buildVolumeShell(nw, nh, nd) {
  // Only emit outer-surface vertices so we get a closed shell with thickness.
  const keyToIndex = new Map();
  const lattice = []; // {i,j,k, idx}
  const positions = [];
  const amounts = [];

  const isSurface = (i, j, k) => (
    i === 0 || i === nw - 1 || j === 0 || j === nh - 1 || k === 0 || k === nd - 1
  );

  let idx = 0;
  for (let k = 0; k < nd; k += 1) {
    for (let j = 0; j < nh; j += 1) {
      for (let i = 0; i < nw; i += 1) {
        if (!isSurface(i, j, k)) continue;
        const key = `${i},${j},${k}`;
        keyToIndex.set(key, idx);
        lattice.push({ i, j, k, idx });
        positions.push(0, 0, 0);
        amounts.push(1);
        idx += 1;
      }
    }
  }

  const indices = [];
  const face = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    indices.push(a, b, c, a, c, d);
  };
  const id = (i, j, k) => {
    const v = keyToIndex.get(`${i},${j},${k}`);
    return v === undefined ? -1 : v;
  };

  // Faces on each exterior side of the lattice.
  for (let j = 0; j < nh - 1; j += 1) {
    for (let i = 0; i < nw - 1; i += 1) {
      // k = 0 (back / tank side) and k = nd-1 (front)
      face(id(i, j, 0), id(i + 1, j, 0), id(i + 1, j + 1, 0), id(i, j + 1, 0));
      face(id(i, j, nd - 1), id(i, j + 1, nd - 1), id(i + 1, j + 1, nd - 1), id(i + 1, j, nd - 1));
    }
  }
  for (let k = 0; k < nd - 1; k += 1) {
    for (let i = 0; i < nw - 1; i += 1) {
      // j = 0 bottom, j = nh-1 top
      face(id(i, 0, k), id(i, 0, k + 1), id(i + 1, 0, k + 1), id(i + 1, 0, k));
      face(id(i, nh - 1, k), id(i + 1, nh - 1, k), id(i + 1, nh - 1, k + 1), id(i, nh - 1, k + 1));
    }
  }
  for (let k = 0; k < nd - 1; k += 1) {
    for (let j = 0; j < nh - 1; j += 1) {
      // i = 0 and i = nw-1 sides
      face(id(0, j, k), id(0, j + 1, k), id(0, j + 1, k + 1), id(0, j, k + 1));
      face(id(nw - 1, j, k), id(nw - 1, j, k + 1), id(nw - 1, j + 1, k + 1), id(nw - 1, j + 1, k));
    }
  }

  return {
    lattice,
    positions: new Float32Array(positions),
    amounts: new Float32Array(amounts),
    indices,
    count: lattice.length,
  };
}

/**
 * @param {object} opts
 */
export function createAquariumSpillBlob({
  face,
  cx,
  cz,
  halfSize,
  waterBottomY,
  waterTopY,
  initialFill01 = 1,
  floorY = 0,
  parent = null,
  tankId = null,
  onSeep = null,
} = {}) {
  const basis = faceBasis(face);
  const faceOrigin = basis.origin(cx, cz, halfSize);
  const fill0 = THREE.MathUtils.clamp(initialFill01, 0.12, 1);
  const fullH = Math.max(0.5, waterTopY - waterBottomY);
  const waterH = Math.max(0.8, fullH * fill0); // chunky even if half-full
  const slabBottom = waterBottomY;
  const slabHalfW = halfSize * 0.95;
  // Thick volume — this is the whole remaining water mass, not a film.
  const slabDepth = 1.1 + fill0 * 1.4;

  const shell = buildVolumeShell(NW, NH, ND);
  const { lattice, positions, amounts, indices, count } = shell;

  // Soft-body state in local (u, y, zOut)
  const uArr = new Float32Array(count);
  const yArr = new Float32Array(count);
  const zArr = new Float32Array(count);
  const vu = new Float32Array(count);
  const vy = new Float32Array(count);
  const vz = new Float32Array(count);
  const ru = new Float32Array(count);
  const ry = new Float32Array(count);
  const rz = new Float32Array(count);
  // Lattice coords for neighbor coupling
  const li = new Int16Array(count);
  const lj = new Int16Array(count);
  const lk = new Int16Array(count);
  const keyToIdx = new Map();

  for (let n = 0; n < count; n += 1) {
    const { i, j, k, idx } = lattice[n];
    li[idx] = i;
    lj[idx] = j;
    lk[idx] = k;
    keyToIdx.set(`${i},${j},${k}`, idx);

    const su = (i / (NW - 1)) * 2 - 1;
    const sv = j / (NH - 1);
    const sw = k / (ND - 1);

    // Fat vertical slab sitting in the open face.
    uArr[idx] = su * slabHalfW * (0.9 + 0.1 * (1 - Math.abs(su)));
    yArr[idx] = slabBottom + sv * waterH;
    zArr[idx] = 0.05 + sw * slabDepth * (0.85 + 0.15 * Math.cos(su * 1.1));
    // Bulge the middle outward (pressure).
    zArr[idx] += (1 - su * su) * (1 - (sv - 0.5) * (sv - 0.5) * 4) * slabDepth * 0.22;

    amounts[idx] = 0.75 + fill0 * 0.25;
    ru[idx] = uArr[idx];
    ry[idx] = yArr[idx];
    rz[idx] = zArr[idx];
  }

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const amtAttr = new THREE.BufferAttribute(amounts, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  amtAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAmount', amtAttr);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(cx, slabBottom + waterH * 0.5, cz),
    halfSize * 4 + waterH + slabDepth + 6,
  );

  const material = createSpillMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `Aquarium Spill ${tankId ?? ''} ${face}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.userData.noStaticMerge = true;
  mesh.userData.skipLevelRaycast = true;
  mesh.userData.aquariumSpillBlob = true;
  if (parent) parent.add(mesh);

  let age = 0;
  let live = true;
  let fill01 = fill0;
  let landedVolume = 0;

  function localToWorld(u, y, zOut, target) {
    target.set(
      faceOrigin.x + basis.u.x * u + basis.n.x * zOut,
      y,
      faceOrigin.z + basis.u.z * u + basis.n.z * zOut,
    );
    return target;
  }

  function writePositions() {
    for (let idx = 0; idx < count; idx += 1) {
      localToWorld(uArr[idx], yArr[idx], zArr[idx], _v);
      positions[idx * 3] = _v.x;
      positions[idx * 3 + 1] = _v.y;
      positions[idx * 3 + 2] = _v.z;
    }
    posAttr.needsUpdate = true;
    amtAttr.needsUpdate = true;
  }

  function updateRestShape(t, fill) {
    const ease = t * t * (3 - 2 * t);
    const puddleR = halfSize * (1.4 + fill * 2.0 + ease * 2.2);
    // Keep a real dome on the floor — never collapse to a film.
    const puddleH = 0.45 + fill * 0.85 * (1 - ease * 0.25);
    const slabH = Math.max(0.5, waterH * Math.max(fill, 0.25));

    for (let idx = 0; idx < count; idx += 1) {
      const i = li[idx];
      const j = lj[idx];
      const k = lk[idx];
      const su = (i / (NW - 1)) * 2 - 1;
      const sv = j / (NH - 1);
      const sw = k / (ND - 1);

      // --- Slab rest: tall, deep mass in the doorway ---
      const slabU = su * slabHalfW * (0.95 + fill * 0.05);
      const slabY = slabBottom + sv * slabH;
      const midBulge = (1 - su * su) * (1 - (sv - 0.5) ** 2 * 3.2);
      const slabZ = 0.08 + sw * (1.0 + fill * 1.5) * (0.9 + midBulge * 0.45)
        + midBulge * 0.35;

      // --- Puddle rest: thick dome outside the face ---
      const ang = su * Math.PI * 0.65;
      const rad = (0.25 + sv * 0.75) * puddleR * (0.7 + sw * 0.5);
      const pudU = Math.sin(ang) * rad;
      // Dome height — highest near center of the spill.
      const dome = Math.max(0, 1 - (su * su * 0.85 + (sv - 0.3) * (sv - 0.3)));
      // Bottom skin near floor, top skin raised — real thickness via sw.
      const pudY = floorY + 0.05
        + puddleH * (0.25 + dome * 1.1) * (0.25 + sw * 0.85);
      const pudZ = 0.35 + ease * 0.5 + sv * (1.6 + fill * 2.4) + sw * (0.9 + fill * 0.5);

      ru[idx] = THREE.MathUtils.lerp(slabU, pudU, ease);
      ry[idx] = THREE.MathUtils.lerp(slabY, pudY, ease);
      rz[idx] = THREE.MathUtils.lerp(slabZ, pudZ, ease);

      const absorb = THREE.MathUtils.clamp(landedVolume * 0.08, 0, 0.65);
      amounts[idx] = Math.max(0.15, (0.55 + fill * 0.45) * (1 - absorb * 0.7));
    }
  }

  writePositions();
  updateRestShape(0, fill0);

  function neighbor(idx, di, dj, dk) {
    return keyToIdx.get(`${li[idx] + di},${lj[idx] + dj},${lk[idx] + dk}`);
  }

  /**
   * @param {number} dt
   * @param {{ fill01?: number }} [state]
   */
  function update(dt = 0, state = {}) {
    if (!live) return;
    const step = Math.min(0.033, Math.max(0, dt));
    age += step;
    if (Number.isFinite(state.fill01)) {
      fill01 = THREE.MathUtils.clamp(state.fill01, 0, 1);
    }

    // Slightly slower morph so the fat slab is readable before it flops.
    const morphT = Math.min(1, age / (1.35 + fill0 * 0.9));
    updateRestShape(morphT, Math.max(fill01, fill0 * (1 - morphT * 0.7)));

    const kSpring = 22;
    const damp = 0.88;
    const kNeighbor = 18;
    const grav = 18;

    for (let idx = 0; idx < count; idx += 1) {
      vu[idx] += (ru[idx] - uArr[idx]) * kSpring * step;
      vy[idx] += (ry[idx] - yArr[idx]) * kSpring * step;
      vz[idx] += (rz[idx] - zArr[idx]) * kSpring * step;
      // Strong outward surge + fall so it doesn't just lerp.
      if (morphT < 0.92) {
        vy[idx] -= grav * step * (0.5 + morphT);
        vz[idx] += (14 + fill0 * 16) * step * (1.1 - morphT * 0.6);
      }
    }

    // Neighbor coupling on the lattice graph.
    for (let idx = 0; idx < count; idx += 1) {
      let lu = 0;
      let ly = 0;
      let lz = 0;
      let nCount = 0;
      const offs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (const [di, dj, dk] of offs) {
        const nIdx = neighbor(idx, di, dj, dk);
        if (nIdx === undefined) continue;
        lu += uArr[nIdx] - uArr[idx];
        ly += yArr[nIdx] - yArr[idx];
        lz += zArr[nIdx] - zArr[idx];
        nCount += 1;
      }
      if (nCount > 0) {
        vu[idx] += (lu / nCount) * kNeighbor * step;
        vy[idx] += (ly / nCount) * kNeighbor * step;
        vz[idx] += (lz / nCount) * kNeighbor * step;
      }
    }

    let floorHits = 0;
    for (let idx = 0; idx < count; idx += 1) {
      vu[idx] *= damp;
      vy[idx] *= damp;
      vz[idx] *= damp;
      uArr[idx] += vu[idx] * step;
      yArr[idx] += vy[idx] * step;
      zArr[idx] += vz[idx] * step;

      if (zArr[idx] < 0.04) {
        zArr[idx] = 0.04;
        vz[idx] = Math.max(0, vz[idx]) * 0.3;
      }
      if (yArr[idx] < floorY + 0.04) {
        yArr[idx] = floorY + 0.04;
        if (vy[idx] < 0) vy[idx] *= -0.2;
        vu[idx] *= 0.9;
        vz[idx] *= 0.9;
        floorHits += 1;
      }
      const maxU = slabHalfW * (1.3 + morphT * 2.8);
      if (uArr[idx] > maxU) { uArr[idx] = maxU; vu[idx] *= -0.25; }
      if (uArr[idx] < -maxU) { uArr[idx] = -maxU; vu[idx] *= -0.25; }
    }

    // Feed floor puddles as the mass lands.
    if (onSeep && floorHits > count * 0.08 && morphT > 0.2) {
      for (let s = 0; s < 5; s += 1) {
        const idx = Math.floor(Math.random() * count);
        if (yArr[idx] > floorY + 0.2) continue;
        localToWorld(uArr[idx], yArr[idx], zArr[idx], _v);
        const vol = step * (0.07 + fill01 * 0.12) * fill0;
        onSeep(_v.x, _v.z, vol, 1.2 + fill01 * 1.6);
        landedVolume += vol;
      }
    }

    writePositions();
    if (age > 0.1) geometry.computeVertexNormals();

    if (fill01 < 0.02 && morphT > 0.98 && age > 3.2) {
      live = false;
      mesh.visible = false;
    }
  }

  function snapshot() {
    return {
      tankId,
      face,
      age: Number(age.toFixed(2)),
      fill01: Number(fill01.toFixed(3)),
      live,
      morph: Number(Math.min(1, age / (1.35 + fill0 * 0.9)).toFixed(2)),
      landedVolume: Number(landedVolume.toFixed(3)),
      verts: count,
      volumetric: true,
    };
  }

  function dispose() {
    live = false;
    mesh.parent?.remove(mesh);
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    tankId,
    face,
    update,
    snapshot,
    dispose,
    get live() { return live; },
  };
}
