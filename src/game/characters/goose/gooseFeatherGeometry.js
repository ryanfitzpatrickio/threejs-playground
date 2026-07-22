/**
 * Explicit flight feathers — skinned vane cards (rachis + bilateral vanes).
 *
 * Shell fur alone cannot render the layered packing of flight feathers (the
 * folded primary stack crossing over the tail, big pale-edged tertials, the
 * rectrix fan). These are real geometry: per-feather cambered cards with
 * geometric rounded tips (no alpha cutouts → no sorting artifacts), skinned to
 * the wing/tail chains, packed in the folded bind pose and fanned in-shader.
 *
 * Fan mechanism: every vertex carries its feather's root position and a fan
 * axis whose LENGTH encodes the fan weight. The vertex shader applies a
 * Rodrigues rotation of angle uniform×weight around the axis — primaries
 * spread when the wing opens (uSpread), rectrices fan on uTailFan.
 *
 * Vertex attrs (8 buffers — WebGPU cap):
 *   position/normal/uv(vaneUV: x=-1..1 across, y=0..1 along)/skinIndex/skinWeight
 *   fData  float — role*100 + featherIndex  (0 primary, 1 secondary, 2 tertial, 3 rectrix)
 *   fRoot  vec3  — feather root (bind space)
 *   fAxis  vec3  — fan rotation axis × fanWeight
 */

import * as THREE from 'three';
import {
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  Fn,
  hash,
  max,
  mix,
  modelWorldMatrix,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sub,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import {
  DEFAULT_GOOSE_MORPH,
  morphBodyYZ,
  resolveGooseMorph,
} from './gooseMorph.js';

export const FEATHER_ROLE = Object.freeze({
  primary: 0,
  secondary: 1,
  tertial: 2,
  rectrix: 3,
});

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Build one cambered feather card into the shared arrays.
 * @param {object} ctx accumulation arrays + bone index resolver
 * @param {{
 *   root: THREE.Vector3, tip: THREE.Vector3,
 *   width: number, role: number, id: number,
 *   bones: [string, string], camber?: number, bow?: number,
 *   fanAxis?: THREE.Vector3, fanWeight?: number,
 * }} f
 */
function addFeather(ctx, f) {
  const { positions, normals, uvs, skinIndices, skinWeights, fData, fRoot, fAxis, indices, bi } = ctx;
  const along = 7;
  const across = 4; // -1..1 → 5 columns

  const shaft = f.tip.clone().sub(f.root);
  const len = shaft.length();
  const dir = shaft.clone().normalize();
  // Side dir: perpendicular to shaft, mostly horizontal (vane plane ~ flat)
  let side = new THREE.Vector3().crossVectors(dir, _up);
  if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const flat = new THREE.Vector3().crossVectors(side, dir).normalize(); // "up" of card

  const camber = f.camber ?? 0.35;
  const bow = f.bow ?? 0.12;
  const axis = (f.fanAxis ?? flat).clone().normalize().multiplyScalar(f.fanWeight ?? 0);
  const startIdx = positions.length / 3;

  for (let i = 0; i <= along; i += 1) {
    const v = i / along;
    // Rounded tip: taper width over the last third.
    const taper = 1 - Math.pow(Math.max(0, (v - 0.68) / 0.32), 1.6) * 0.92;
    // slight width build from calamus
    const grow = THREE.MathUtils.smoothstep(v, 0, 0.18);
    const w = f.width * 0.5 * taper * (0.25 + 0.75 * grow);
    for (let j = 0; j <= across; j += 1) {
      const uNorm = (j / across) * 2 - 1;
      const p = f.root.clone()
        .addScaledVector(dir, v * len)
        .addScaledVector(side, uNorm * w)
        // camber: vane edges droop; bow: shaft arcs down toward the tip
        .addScaledVector(flat, -(camber * uNorm * uNorm * w) - bow * v * v * f.width);
      positions.push(p.x, p.y, p.z);
      normals.push(flat.x, flat.y, flat.z);
      uvs.push(uNorm, v);
      const [rootBone, tipBone] = f.bones;
      const tipW = THREE.MathUtils.smoothstep(v, 0.35, 1) * 0.55;
      skinIndices.push(bi(rootBone), bi(tipBone), 0, 0);
      skinWeights.push(1 - tipW, tipW, 0, 0);
      fData.push(f.role * 100 + f.id);
      fRoot.push(f.root.x, f.root.y, f.root.z);
      fAxis.push(axis.x, axis.y, axis.z);
    }
  }
  const cols = across + 1;
  for (let i = 0; i < along; i += 1) {
    for (let j = 0; j < across; j += 1) {
      const a = startIdx + i * cols + j;
      const b = startIdx + (i + 1) * cols + j;
      // double-sided: two windings (opaque material, FrontSide is fine both ways)
      indices.push(a, b, b + 1, a, b + 1, a + 1);
      indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
}

/**
 * @param {Map<string, number>} boneIndex
 * @param {import('./gooseMorph.js').GooseMorphInput | import('./gooseMorph.js').GooseMorph} [morphInput]
 * @returns {{ geometry: THREE.BufferGeometry }}
 */
export function buildGooseFeatherGeometry(boneIndex, morphInput = DEFAULT_GOOSE_MORPH) {
  const morph = /** @type {import('./gooseMorph.js').GooseMorph} */ (
    morphInput.dims ? morphInput : resolveGooseMorph(morphInput)
  );
  /** Map canonical feather point through body morph (keep lateral X). */
  const mapP = (x, y, z) => {
    const [my, mz] = morphBodyYZ(y, z, morph);
    return new THREE.Vector3(x, my, mz);
  };

  const ctx = {
    positions: [], normals: [], uvs: [],
    skinIndices: [], skinWeights: [],
    fData: [], fRoot: [], fAxis: [],
    indices: [],
    bi: (name) => {
      const i = boneIndex.get(name);
      if (i == null) throw new Error(`goose feathers: unknown bone ${name}`);
      return i;
    },
  };

  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const wrist = mapP(s * 0.100, 0.500, -0.160);
    const handEnd = mapP(s * 0.076, 0.466, -0.286);
    const elbow = mapP(s * 0.106, 0.458, -0.008);
    // Fan axis roughly chord-normal so open remiges stay in a wing plane
    // rather than cartwheeling into a vertical rake.
    const wingFanAxis = new THREE.Vector3(0, 0.35, s * 0.15).normalize();

    // ---- primaries (12): denser folded stack, tips cross over the tail ------
    // Wide vanes + modest fanWeight so open pose still reads as a solid hand.
    const primaryCount = 12;
    for (let i = 0; i < primaryCount; i += 1) {
      const t = i / (primaryCount - 1); // 0 inner → 1 outer
      const root = wrist.clone().lerp(handEnd, t);
      root.x += s * 0.004 * (1 - t);
      // Slight stagger so cards layer instead of coplanar z-fight.
      root.y += 0.0012 * (i % 2 === 0 ? 1 : -1);
      const tip = mapP(
        s * THREE.MathUtils.lerp(0.042, 0.004, t),
        THREE.MathUtils.lerp(0.418, 0.352, t),
        THREE.MathUtils.lerp(-0.365, -0.468, t),
      );
      addFeather(ctx, {
        root, tip,
        // Wide enough that ~12° total outer fan still overlaps.
        width: THREE.MathUtils.lerp(0.058, 0.040, t),
        role: FEATHER_ROLE.primary, id: i,
        bones: [`wing_2_${side}`, `wing_tip_${side}`],
        camber: 0.18, bow: 0.08,
        fanAxis: wingFanAxis,
        // Gentle outer-only splay (was 0.15+0.85*t → ~66° rake at full open).
        fanWeight: s * (0.06 + 0.38 * t * t),
      });
    }

    // ---- secondaries (14): solid trailing edge along the forearm -----------
    const secondaryCount = 14;
    for (let i = 0; i < secondaryCount; i += 1) {
      const t = i / (secondaryCount - 1); // 0 at wrist → 1 at elbow
      const root = wrist.clone().lerp(elbow, t);
      root.y += 0.0008 * ((i % 2) * 2 - 1);
      const tipBase = new THREE.Vector3(
        root.x + s * THREE.MathUtils.lerp(0.012, 0.022, t),
        root.y - THREE.MathUtils.lerp(0.048, 0.038, t),
        root.z - THREE.MathUtils.lerp(0.125, 0.095, t),
      );
      addFeather(ctx, {
        root, tip: tipBase,
        width: THREE.MathUtils.lerp(0.055, 0.048, t),
        role: FEATHER_ROLE.secondary, id: i,
        bones: [`wing_1_${side}`, `wing_2_${side}`],
        camber: 0.26, bow: 0.12,
        fanAxis: wingFanAxis,
        fanWeight: s * 0.14 * (1 - t * 0.55),
      });
    }

    // ---- greater coverts (8): short wide cards fill the wing arm surface ---
    for (let i = 0; i < 8; i += 1) {
      const t = i / 7;
      const root = elbow.clone().lerp(wrist, t * 0.92);
      root.x += s * 0.006;
      root.y += 0.006;
      const tip = root.clone().add(new THREE.Vector3(
        s * 0.008,
        -0.028 - 0.01 * t,
        -0.055 - 0.02 * t,
      ));
      addFeather(ctx, {
        root, tip,
        width: THREE.MathUtils.lerp(0.048, 0.042, t),
        // Reuse secondary role/palette (short coverts match wing base color).
        role: FEATHER_ROLE.secondary, id: 20 + i,
        bones: [`wing_0_${side}`, `wing_1_${side}`],
        camber: 0.32, bow: 0.08,
        fanAxis: wingFanAxis,
        fanWeight: s * 0.06,
      });
    }

    // ---- tertials (6): big pale-edged cards over the rear back -------------
    for (let i = 0; i < 6; i += 1) {
      const t = i / 5;
      const root = mapP(
        s * THREE.MathUtils.lerp(0.098, 0.058, t),
        THREE.MathUtils.lerp(0.480, 0.460, t),
        THREE.MathUtils.lerp(-0.070, -0.160, t),
      );
      const tip = mapP(
        s * THREE.MathUtils.lerp(0.072, 0.028, t),
        THREE.MathUtils.lerp(0.432, 0.400, t),
        THREE.MathUtils.lerp(-0.240, -0.340, t),
      );
      addFeather(ctx, {
        root, tip,
        width: THREE.MathUtils.lerp(0.062, 0.048, t),
        role: FEATHER_ROLE.tertial, id: i,
        bones: [`wing_1_${side}`, `wing_2_${side}`],
        camber: 0.35, bow: 0.08,
        fanAxis: wingFanAxis,
        fanWeight: s * 0.08,
      });
    }
  }

  // ---- rectrices (16): black tail fan from the pygostyle --------------------
  const rectrixCount = 16;
  for (let i = 0; i < rectrixCount; i += 1) {
    const t = i / (rectrixCount - 1); // 0 left … 1 right
    const spread = (t - 0.5) * 2;     // -1..1
    const sideName = spread < 0 ? 'rectrix_L' : 'rectrix_R';
    const root = mapP(spread * 0.052, 0.386, -0.288);
    const tip = mapP(
      spread * 0.118,
      0.352 - 0.012 * Math.abs(spread),
      -0.442 + 0.028 * Math.abs(spread) * Math.abs(spread),
    );
    addFeather(ctx, {
      root, tip,
      width: 0.042,
      role: FEATHER_ROLE.rectrix, id: i,
      bones: [sideName, 'tail_2'],
      camber: 0.22, bow: 0.05,
      fanAxis: new THREE.Vector3(0, 1, 0),
      fanWeight: spread * 0.55,
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ctx.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(ctx.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(ctx.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(ctx.skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(ctx.skinWeights, 4));
  geometry.setAttribute('fData', new THREE.Float32BufferAttribute(ctx.fData, 1));
  geometry.setAttribute('fRoot', new THREE.Float32BufferAttribute(ctx.fRoot, 3));
  geometry.setAttribute('fAxis', new THREE.Float32BufferAttribute(ctx.fAxis, 3));
  geometry.setIndex(ctx.indices);
  geometry.computeBoundingSphere();
  return { geometry };
}

/**
 * Vane material: rachis line, barb striations, role palette, pale tertial
 * edges, wrap + hemi + sheen + thin-vane backlight, ACES. Opaque (geometric
 * tips) so depth just works against 56 transparent shells.
 *
 * @param {import('./goosePlumage.js').GooseUniforms} u shared uniforms
 * @returns {{ material: MeshBasicNodeMaterial, uniforms: { spread: any, tailFan: any } }}
 */
export function createGooseFeatherMaterial(u) {
  const uSpread = uniform(0);
  const uTailFan = uniform(0);

  const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });

  const fData = attribute('fData', 'float');
  const fRoot = attribute('fRoot', 'vec3');
  const fAxis = attribute('fAxis', 'vec3');
  const role = floor(fData.div(100.0));
  const fid = fData.sub(role.mul(100.0));

  // ---- fan rotation (Rodrigues) around fRoot --------------------------------
  const isRectrix = smoothstep(float(2.5), float(2.55), role);
  // Soft fan: full open still keeps remiges overlapping (cards are wide).
  // Was 1.15 with outer fanWeight ~1 → ~66° splay and a stick-rake wing.
  const angle = mix(uSpread, uTailFan, isRectrix).mul(fAxis.length()).mul(0.72);
  const axisN = normalize(fAxis.add(vec3(0, 1e-5, 0)));
  const rel = positionLocal.sub(fRoot);
  const cosA = cos(angle);
  const sinA = sin(angle);
  const rotated = rel.mul(cosA)
    .add(cross(axisN, rel).mul(sinA))
    .add(axisN.mul(dot(axisN, rel)).mul(sub(float(1.0), cosA)));
  material.positionNode = fRoot.add(rotated);

  const vUv = varying(uv(), 'vFeatherUv');
  const vRole = varying(role, 'vFeatherRole');
  const vFid = varying(fid, 'vFeatherId');
  const vNormalW = varying(
    normalize(modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz),
    'vFeatherNormalW',
  );
  const vPosW = varying(positionWorld, 'vFeatherPosW');

  material.colorNode = Fn(() => {
    const uAcross = vUv.x; // -1..1
    const vAlong = vUv.y;

    const roleIs = (id) => smoothstep(float(id - 0.45), float(id - 0.35), vRole)
      .mul(smoothstep(float(id + 0.45), float(id + 0.35), vRole));
    const isPrimary = roleIs(0);
    const isSecondary = roleIs(1);
    const isTertial = roleIs(2);
    const isTail = roleIs(3);

    // Role palette from shared plumage uniforms so varieties recolor remiges too.
    let base = u.cPrimary.mul(isPrimary)
      .add(u.cWingBase.mul(isSecondary))
      .add(u.cWingEdge.mul(isTertial))
      .add(u.cTail.mul(isTail));

    // Pale leading edge on tertials/secondaries (photo: cream crescents).
    const edge = smoothstep(float(0.72), float(0.94), uAcross.abs());
    const edgeCol = u.cVent;
    base = mix(base, edgeCol, edge.mul(isTertial.mul(0.9).add(isSecondary.mul(0.45))));

    // Rachis: thin shaft line down the center.
    const rachis = smoothstep(float(0.10), float(0.03), uAcross.abs());
    const rachisCol = mix(base.mul(0.55), u.cWingEdge.mul(0.9), isTertial.mul(0.5));
    base = mix(base, rachisCol, rachis.mul(0.75));

    // Barb striations: fine slanted lines off the shaft.
    const barb = sin(uAcross.abs().mul(90.0).add(vAlong.mul(140.0)))
      .mul(0.5).add(0.5);
    const barbJitter = hash(vFid.mul(17.0).add(floor(vAlong.mul(30.0))));
    base = base.mul(mix(float(0.92), float(1.05), barb.mul(0.7).add(barbJitter.mul(0.3))));

    // Per-feather luminance variance.
    base = base.mul(mix(float(0.93), float(1.07), hash(vFid.add(vRole.mul(31.0)))));

    // ---- lighting: wrap + hemi + backlight transmission ----------------------
    const nW = normalize(vNormalW);
    const L = normalize(u.keyDir);
    const NdotL = dot(nW, L);
    const wrap = NdotL.mul(0.45).add(0.55);
    const diffuse = base.mul(u.keyColor).mul(wrap.mul(0.8).add(0.12));
    const hemi = mix(u.hemiGround, u.hemiSky, nW.y.mul(0.5).add(0.5));
    const ambient = base.mul(hemi).mul(0.4);
    // thin vane translucency when lit from behind
    const trans = base.mul(u.keyColor).mul(max(float(0.0), NdotL.negate())).mul(0.22);
    const V = normalize(cameraPosition.sub(vPosW));
    const rim = pow(sub(float(1.0), max(float(0.0), dot(nW, V))), float(3.0));
    const rimCol = base.mul(1.5).add(vec3(0.015)).mul(rim).mul(0.25);

    const acesA = float(2.51); const acesB = float(0.03);
    const acesC = float(2.43); const acesD = float(0.59); const acesE = float(0.14);
    const x = diffuse.add(ambient).add(trans).add(rimCol).mul(u.exposure);
    return clamp(x.mul(acesA.mul(x).add(acesB)).div(x.mul(acesC.mul(x).add(acesD)).add(acesE)), 0.0, 1.0);
  })();

  material.userData.featherUniforms = { spread: uSpread, tailFan: uTailFan };
  return { material, uniforms: { spread: uSpread, tailFan: uTailFan } };
}
