/**
 * Hide body surface under authored outfits with a filtered index buffer plus
 * ONE continuous recessed skin companion.
 *
 * The old approach classified whole low-poly triangles into hand-tuned
 * neckline bands (trap window / sternum window / neck bib / seam fans). Every
 * band boundary was a sawtooth of triangle edges, and each new garment shape
 * needed new bands. Now:
 *
 * - The body surface keeps only head/neck (and slider-revealed limbs) at the
 *   true surface, exactly as before.
 * - EVERYTHING else on the torso/shoulders/hips moves to a single recessed
 *   companion mesh: the same body triangles, pushed inward along their
 *   normals by a per-vertex distance field. The field is exactly 0 on
 *   vertices shared with the kept surface (watertight join) and ramps to
 *   full depth with geodesic distance from that boundary, so the visible
 *   silhouette of skin inside a collar/neckline is defined by GARMENT DEPTH,
 *   not by body triangle topology. Open collars, deep necklines, straps and
 *   open backs all fill with smooth skin without garment-specific tuning.
 * - Hidden limbs are still dropped outright (a deep recess would punch
 *   through the far side of an arm or calf); only a narrow ring behind an
 *   active limb-reveal cut joins the companion at a shallow depth so the
 *   garment's fragment-precise cut owns the visible seam.
 *
 * Uses BOTH skin-weight hide masks AND bind-pose height bands so chest/back
 * are removed even if bone-name matching fails at runtime. Weight drops
 * outrank the head height band: the shoulder/trap line sits above the band
 * cut on the UBC bodies and would otherwise poke bare skin through collars.
 *
 * The source geometry is NEVER mutated — cloneVibeHumanModel clones share
 * geometry, so an in-place index rewrite would hide the body on every sim
 * using that body template. Instead each mesh gets a wrapper geometry that
 * shares the attribute/morph buffers but owns the filtered index; dispose
 * just restores the original geometry reference.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  Fn,
  normalLocal,
  positionLocal,
  uniform,
} from 'three/tsl';
import { copyStandardMaps } from './outfitInflateMaterial.js';
import {
  LIMB_KEYS,
  computeLimbVertexData,
  triangleIsRevealed,
} from './outfitLimbVisibility.js';
import {
  compileOutfitLoopCuts,
  triangleIsHiddenByLoopCuts,
} from './outfitLoopCuts.js';

const EYE_NAMES = new Set(['Eye_L', 'Eye_R', 'eye_l', 'eye_r']);
// Recessed skin composites with PLAIN DEPTH: pushed inside the fabric it
// loses to exterior cloth, but still beats the interior lining behind it —
// so collar openings genuinely fill with skin. Raw model units (span 3.49).
const TORSO_SKIN_RECESS = 0.085;
// Shallow depth for limb-adjacent skin: an arm or calf is thinner than the
// torso recess, so a deep push would invert the surface through the far side.
const LIMB_SEAM_RECESS = 0.018;
// Geodesic ramp from the kept boundary to full recess, as a fraction of the
// body height span. The back ramp is steeper: tight nape panels sit close to
// the skin, so full depth must be reached within a couple of centimetres.
const RECESS_RAMP_FRONT = 0.05;
const RECESS_RAMP_BACK = 0.02;
const RECESS_ATTRIBUTE = 'bodyHideRecess';
const RECESS_SEAM_ATTRIBUTE = 'bodyHideSeamRecess';

/**
 * @param {object} model createVibeHumanModel / clone result
 * @param {{
 *   threshold?: number,
 *   limbReveal?: { arms?: number, legs?: number, feet?: number },
 *   loopCuts?: Array<object>,
 *   skinTuck?: { torso?: number, seams?: number },
 * }} [options]
 */
export function installBodyHideUnderOutfit(model, options = {}) {
  const weightThreshold = Number.isFinite(options.threshold) ? options.threshold : 0.18;
  const limbReveal = options.limbReveal ?? {};
  const loopCuts = compileOutfitLoopCuts(options.loopCuts);
  const skinTuckUniforms = createSkinTuckUniforms(options.skinTuck);
  const meshes = (model?.skinnedMeshes ?? []).filter(shouldProcessMesh);
  if (!meshes.length) {
    console.warn('[bodyHideUnderOutfit] no skinned body meshes found on model');
    return null;
  }

  const backups = [];

  for (const mesh of meshes) {
    const skeleton = mesh.skeleton;
    const geometry = mesh.geometry;
    if (!skeleton?.bones?.length || !geometry) continue;

    const indexAttr = geometry.getIndex();
    if (!indexAttr) {
      console.warn(`[bodyHideUnderOutfit] ${mesh.name}: non-indexed — cannot hide`);
      continue;
    }

    const hideTable = buildBoneHideTable(skeleton);
    const headTable = buildBoneHeadTable(skeleton);
    // When the bone tables matched, weights are authoritative and the height
    // band is only a drop-side safety net. The keep-side band rescue exists
    // solely for skeletons whose names we failed to classify.
    const bonesMatched = hideTable.includes(1) && headTable.includes(1);
    const hidePerVert = computeWeightedMask(geometry, hideTable);
    const headPerVert = computeWeightedMask(geometry, headTable);
    const limbData = computeLimbVertexData(geometry, skeleton);
    if (!hidePerVert) {
      console.warn(`[bodyHideUnderOutfit] ${mesh.name}: missing skin attributes`);
      continue;
    }

    const pos = geometry.getAttribute('position');
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    const ySpan = Math.max(1e-6, yMax - yMin);
    // Keep only upper head band by height; everything below is "body" unless extremity.
    const headYCut = yMin + ySpan * 0.78; // ~neck/chin and above
    const footYCut = yMin + ySpan * 0.12; // ankles/feet region

    // Facing direction from the FEET: toes project forward of the heel, so
    // the mean z of the lowest band leans toward the front. (The nose is NOT
    // reliable — on a bald head the skull back sticks out as far.)
    const footBandY = yMin + ySpan * 0.06;
    let footZSum = 0;
    let footZCount = 0;
    for (let i = 0; i < pos.count; i += 1) {
      if (pos.getY(i) > footBandY) continue;
      footZSum += pos.getZ(i);
      footZCount += 1;
    }
    const frontSign = footZCount > 0 ? Math.sign(footZSum) : 0;

    const srcIndex = indexAttr.array;
    const triCount = Math.floor(srcIndex.length / 3);
    const kept = [];
    const recessed = [];
    let droppedLimb = 0;

    for (let t = 0; t < triCount; t += 1) {
      const i0 = srcIndex[t * 3] | 0;
      const i1 = srcIndex[t * 3 + 1] | 0;
      const i2 = srcIndex[t * 3 + 2] | 0;

      // A user-drawn closed loop removes one garment side and restores the
      // matching bind-space side of the body. This outranks the automatic
      // torso/limb ownership rules so sleeve, neckline, and leg handoffs are
      // controlled by the authored curve.
      // Only restore a torso triangle at the true body surface when all three
      // corners are inside the opening. The garment drops the complementary
      // one-vertex straddlers, while this transition row stays on the recessed
      // companion instead of producing body/cloth spikes at coarse necklines.
      if (triangleIsHiddenByLoopCuts(
        loopCuts,
        pos,
        i0,
        i1,
        i2,
        { torsoMinimumHiddenVertices: 3 },
      )) {
        kept.push(i0, i1, i2);
        continue;
      }

      // A coarse neck-weighted face can straddle the authored boundary with
      // only one or two corners inside it. Do not let the automatic neck keep
      // below promote that whole face back to the true surface: that is the
      // jagged mannequin/body fan visible inside low-poly garment necklines.
      // The recessed companion still fills the opening behind the fabric.
      if (triangleIsHiddenByLoopCuts(
        loopCuts,
        pos,
        i0,
        i1,
        i2,
        { torsoMinimumHiddenVertices: 1 },
      )) {
        recessed.push(i0, i1, i2);
        continue;
      }

      // Limb sliders restore body triangles from the tip inward. The outfit
      // applies the inverse cut, so only one of the two surfaces owns a region.
      const revealedLimb = LIMB_KEYS.some((key) => triangleIsRevealed(
        limbData?.[key],
        i0,
        i1,
        i2,
        limbReveal[key],
      ));
      if (revealedLimb) {
        kept.push(i0, i1, i2);
        continue;
      }

      // Always keep head/neck-dominant triangles (face + open necklines).
      // Min, not max: neck-base triangles fan far down the trapezius, so one
      // neck-dominant vertex must not keep a whole triangle of back skin.
      // Back-side tris need a stricter cut: heavy-mass morphs bulge the
      // trapezius past the outfit's back panel, so lower-blend neck skin
      // (0.35..0.6) pokes through fabric behind the collar.
      const headW = Math.min(headPerVert[i0], headPerVert[i1], headPerVert[i2]);
      const cy = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
      const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
      const neckKeep = frontSign !== 0 && cz * frontSign < 0 ? 0.6 : 0.35;
      if (headW >= neckKeep) {
        kept.push(i0, i1, i2);
        continue;
      }

      // Base limb triangles are owned by the garment through reveal 1. The
      // arm's >1 collar/chest band remains recessed torso until its exact
      // coordinate is revealed, so covered chest skin is never dropped. A
      // garment replaces base limbs; a
      // deep recess would punch through the far side of a thin limb. Only a
      // narrow ring behind an active fragment-precise cut joins the recessed
      // companion so the shader cut controls the visible arm/leg seam instead
      // of exposing a black sawtooth.
      const limbOwned = LIMB_KEYS.some((key) => triangleIsRevealed(
        limbData?.[key],
        i0,
        i1,
        i2,
        1,
      ));
      if (limbOwned) {
        const nearCut = LIMB_KEYS.some((key) => {
          const reveal = clamp01(limbReveal[key], 0);
          return reveal > 0 && reveal < 1 && triangleIsRevealed(
            limbData?.[key],
            i0,
            i1,
            i2,
            Math.min(1, reveal + 0.1),
          );
        });
        if (nearCut) recessed.push(i0, i1, i2);
        else droppedLimb += 1;
        continue;
      }

      // Height rescue: keep upper-head geometry ONLY when bone-name matching
      // failed. With matched tables this blanket keep let low-weight trap and
      // shoulder skin above the cut poke through outfit collars.
      if (!bonesMatched && cy >= headYCut) {
        const h = Math.max(hidePerVert[i0], hidePerVert[i1], hidePerVert[i2]);
        if (h < weightThreshold) {
          kept.push(i0, i1, i2);
          continue;
        }
      }

      // Everything else — chest, back, shoulders, hips, odd-weight mid-body
      // skin — recesses. The old triangle drop left holes as its safety net;
      // continuous skin behind the fabric is strictly safer and is what fills
      // necklines and open backs for any garment shape.
      if (cy > footYCut || clamp01(limbReveal.feet, 0) < 1) {
        recessed.push(i0, i1, i2);
        continue;
      }
      kept.push(i0, i1, i2);
    }

    if (kept.length < 3) {
      console.warn(`[bodyHideUnderOutfit] ${mesh.name}: kept almost nothing — abort`);
      continue;
    }

    const needs32 = pos.count > 65535
      || srcIndex instanceof Uint32Array
      || (srcIndex.length > 0 && srcIndex[srcIndex.length - 1] > 65535);
    const IndexArray = needs32 ? Uint32Array : Uint16Array;

    // Wrapper geometry: shares attribute + morph buffers with the source, but
    // owns the filtered index. The source geometry (possibly shared by other
    // model clones) stays untouched.
    const filtered = createIndexWrapperGeometry(
      geometry,
      new IndexArray(kept),
      `${geometry.name || mesh.name}:bodyHide`,
    );
    // Single group over the whole filtered index: the source groups point at
    // the old full index range and would keep drawing dropped triangles.
    filtered.addGroup(0, kept.length, 0);

    mesh.geometry = filtered;

    const recessedMeshes = [];
    const recessedMaterials = [];
    if (recessed.length >= 3) {
      const recessAmounts = computeContinuousRecessField({
        pos,
        kept,
        recessed,
        limbData,
        ySpan,
        frontSign,
      });
      const part = createRecessedSkinMesh({
        sourceMesh: mesh,
        sourceGeometry: geometry,
        index: new IndexArray(recessed),
        suffix: 'recessedSkin',
        recess: {
          amount: (TORSO_SKIN_RECESS / 3.49) * ySpan,
          amountAttribute: new THREE.BufferAttribute(recessAmounts.torso, 1),
          seamAmountAttribute: new THREE.BufferAttribute(recessAmounts.seams, 1),
          skinTuckUniforms,
        },
      });
      mesh.parent?.add(part.mesh);
      recessedMeshes.push(part.mesh);
      recessedMaterials.push(...part.materials);
    }

    backups.push({
      mesh,
      originalGeometry: geometry,
      keptTriangles: Math.floor(kept.length / 3),
      recessedMeshes,
      recessedMaterials,
    });

    console.info(
      `[bodyHideUnderOutfit] ${mesh.name}: kept ${kept.length / 3 | 0}/${triCount} tris, `
      + `recessed ${recessed.length / 3 | 0}, dropped limb ${droppedLimb}, `
      + `y=[${yMin.toFixed(2)},${yMax.toFixed(2)}], `
      + `bones=${bonesMatched ? 'matched' : 'HEIGHT-FALLBACK'}`,
    );
  }

  if (!backups.length) return null;

  return {
    meshCount: backups.length,
    keptTriangleCount: backups.reduce((count, entry) => count + entry.keptTriangles, 0),
    recessedMeshCount: backups.reduce((count, entry) => count + entry.recessedMeshes.length, 0),
    get skinTuck() {
      return {
        torso: skinTuckUniforms.torso.value,
        seams: skinTuckUniforms.seams.value,
      };
    },
    setSkinTuck(next) {
      setSkinTuckUniforms(skinTuckUniforms, next);
    },
    dispose() {
      for (const { mesh, originalGeometry, recessedMeshes, recessedMaterials } of backups) {
        for (const recessedMesh of recessedMeshes) recessedMesh.removeFromParent();
        for (const material of recessedMaterials) material.dispose?.();
        // Do NOT dispose the wrapper: its attributes are shared with the
        // source geometry and disposal would release their GPU buffers.
        if (mesh.geometry?.name?.endsWith(':bodyHide')) {
          mesh.geometry = originalGeometry;
        }
      }
      backups.length = 0;
    },
  };
}

/**
 * Per-vertex recess distance in raw model units. Zero on every vertex shared
 * with the kept surface (the join is watertight by construction), ramping
 * smoothly to full depth with geodesic distance from that boundary across the
 * recessed region. Coincident glTF seam duplicates share one distance so UV
 * seams cannot crack the companion.
 */
function computeContinuousRecessField({ pos, kept, recessed, limbData, ySpan, frontSign }) {
  const count = pos.count;
  const rep = buildCoincidentVertexReps(pos);

  const usedByKept = new Uint8Array(count);
  for (const i of kept) usedByKept[rep[i]] = 1;
  const usedByRecessed = new Uint8Array(count);
  for (const i of recessed) usedByRecessed[rep[i]] = 1;

  // Multi-source Dijkstra over the recessed triangles' edges, seeded at the
  // kept/recessed boundary. Unreached islands (no kept neighbour anywhere,
  // e.g. a fully covered back panel) stay at full depth. Distances MUST be
  // float64: a float32 store rounds candidates up, so the same relaxation
  // keeps "improving" it and the heap grows without bound. Vertices past the
  // longest ramp are full-depth regardless, so stop expanding there.
  const distance = new Float64Array(count).fill(Infinity);
  const maxDistance = ySpan * RECESS_RAMP_FRONT;
  const heap = createMinHeap();
  for (let v = 0; v < count; v += 1) {
    if (rep[v] === v && usedByKept[v] && usedByRecessed[v]) {
      distance[v] = 0;
      heap.push(v, 0);
    }
  }
  const adjacency = buildEdgeAdjacency(pos, rep, recessed);
  while (heap.size() > 0) {
    const { vertex, priority } = heap.pop();
    if (priority > distance[vertex]) continue;
    const edges = adjacency.get(vertex);
    if (!edges) continue;
    for (let e = 0; e < edges.length; e += 2) {
      const next = edges[e];
      const throughDistance = priority + edges[e + 1];
      if (throughDistance < distance[next]) {
        distance[next] = throughDistance;
        if (throughDistance < maxDistance) heap.push(next, throughDistance);
      }
    }
  }

  const rampFront = ySpan * RECESS_RAMP_FRONT;
  const rampBack = ySpan * RECESS_RAMP_BACK;
  const unitScale = ySpan / 3.49;
  const torsoAmounts = new Float32Array(count);
  const seamAmounts = new Float32Array(count);
  for (let v = 0; v < count; v += 1) {
    if (!usedByRecessed[rep[v]]) continue;
    // Tight nape panels sit close to the skin: reach full depth faster on
    // the back so only a centimetre-scale band near the boundary can clip.
    const backness = frontSign === 0
      ? 0
      : Math.min(1, Math.max(0, (pos.getZ(v) * -frontSign) / (ySpan * 0.015)));
    const ramp = rampFront + (rampBack - rampFront) * backness;
    const d = distance[rep[v]];
    const s = Number.isFinite(d) ? Math.min(1, d / Math.max(ramp, 1e-6)) : 1;
    const eased = s * s * (3 - 2 * s);
    // Thin limb-adjacent skin (near-cut rings, shoulder balls, ankles) takes
    // the shallow depth; the torso takes the full one.
    const limbness = Math.min(1, Math.max(
      0,
      (sumLimbAffinity(limbData, v) - 0.25) / 0.5,
    ));
    // Keep torso and thin-limb contributions separate so their depth can be
    // tuned live with shader uniforms. Their sum at 1.00/1.00 is exactly the
    // legacy continuous recess field.
    torsoAmounts[v] = eased * TORSO_SKIN_RECESS * unitScale * (1 - limbness);
    seamAmounts[v] = eased * LIMB_SEAM_RECESS * unitScale * limbness;
  }
  return { torso: torsoAmounts, seams: seamAmounts };
}

/**
 * Representative vertex per coincident bind-pose position. glTF duplicates
 * vertices along UV/material seams; the distance field must treat those
 * duplicates as one point or the companion cracks along every seam.
 */
function buildCoincidentVertexReps(pos) {
  const rep = new Uint32Array(pos.count);
  const byPosition = new Map();
  for (let v = 0; v < pos.count; v += 1) {
    const key = `${pos.getX(v)}|${pos.getY(v)}|${pos.getZ(v)}`;
    const existing = byPosition.get(key);
    if (existing === undefined) {
      byPosition.set(key, v);
      rep[v] = v;
    } else {
      rep[v] = existing;
    }
  }
  return rep;
}

function buildEdgeAdjacency(pos, rep, index) {
  const adjacency = new Map();
  const addEdge = (a, b) => {
    const ra = rep[a];
    const rb = rep[b];
    if (ra === rb) return;
    const length = Math.hypot(
      pos.getX(a) - pos.getX(b),
      pos.getY(a) - pos.getY(b),
      pos.getZ(a) - pos.getZ(b),
    );
    let edges = adjacency.get(ra);
    if (!edges) adjacency.set(ra, edges = []);
    edges.push(rb, length);
    let back = adjacency.get(rb);
    if (!back) adjacency.set(rb, back = []);
    back.push(ra, length);
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    addEdge(index[t], index[t + 1]);
    addEdge(index[t + 1], index[t + 2]);
    addEdge(index[t + 2], index[t]);
  }
  return adjacency;
}

function createMinHeap() {
  const vertices = [];
  const priorities = [];
  const swap = (a, b) => {
    [vertices[a], vertices[b]] = [vertices[b], vertices[a]];
    [priorities[a], priorities[b]] = [priorities[b], priorities[a]];
  };
  return {
    size: () => vertices.length,
    push(vertex, priority) {
      vertices.push(vertex);
      priorities.push(priority);
      let node = vertices.length - 1;
      while (node > 0) {
        const parent = (node - 1) >> 1;
        if (priorities[parent] <= priorities[node]) break;
        swap(parent, node);
        node = parent;
      }
    },
    pop() {
      const top = { vertex: vertices[0], priority: priorities[0] };
      const lastVertex = vertices.pop();
      const lastPriority = priorities.pop();
      if (vertices.length > 0) {
        vertices[0] = lastVertex;
        priorities[0] = lastPriority;
        let node = 0;
        for (;;) {
          const left = node * 2 + 1;
          const right = left + 1;
          let smallest = node;
          if (left < vertices.length && priorities[left] < priorities[smallest]) smallest = left;
          if (right < vertices.length && priorities[right] < priorities[smallest]) smallest = right;
          if (smallest === node) break;
          swap(node, smallest);
          node = smallest;
        }
      }
      return top;
    },
  };
}

function sumLimbAffinity(limbData, vertex) {
  if (!limbData) return 0;
  let sum = 0;
  for (const key of LIMB_KEYS) {
    const region = limbData[key];
    // The arm extension is torso skin, not a thin limb. Keep its unrevealed
    // companion at full torso recess so clothing remains safely in front.
    if ((region?.progress[vertex] ?? 0) <= 1) sum += region?.affinity[vertex] ?? 0;
  }
  return sum;
}

function createRecessedSkinMesh({
  sourceMesh,
  sourceGeometry,
  index,
  suffix,
  recess,
}) {
  const geometry = createIndexWrapperGeometry(
    sourceGeometry,
    index,
    `${sourceGeometry.name || sourceMesh.name}:${suffix}`,
  );
  geometry.addGroup(0, index.length, 0);
  // Wrapper-only attribute (the shared source geometry stays untouched).
  geometry.setAttribute(RECESS_ATTRIBUTE, recess.amountAttribute);
  geometry.setAttribute(RECESS_SEAM_ATTRIBUTE, recess.seamAmountAttribute);
  const sources = Array.isArray(sourceMesh.material) ? sourceMesh.material : [sourceMesh.material];
  const materials = sources.map((source) => createRecessedSkinMaterial(source, recess));
  const material = Array.isArray(sourceMesh.material) ? materials : materials[0];
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = `${sourceMesh.name || 'Body'}:${suffix}`;
  mesh.bindMode = sourceMesh.bindMode;
  mesh.bind(sourceMesh.skeleton, sourceMesh.bindMatrix);
  mesh.position.copy(sourceMesh.position);
  mesh.quaternion.copy(sourceMesh.quaternion);
  mesh.scale.copy(sourceMesh.scale);
  mesh.matrix.copy(sourceMesh.matrix);
  mesh.matrixAutoUpdate = sourceMesh.matrixAutoUpdate;
  mesh.morphTargetDictionary = sourceMesh.morphTargetDictionary;
  // Share the live influence array so body modeling morphs affect the
  // companion exactly like the source without registering a second mesh.
  mesh.morphTargetInfluences = sourceMesh.morphTargetInfluences;
  mesh.castShadow = sourceMesh.castShadow;
  mesh.receiveShadow = sourceMesh.receiveShadow;
  mesh.frustumCulled = sourceMesh.frustumCulled;
  mesh.renderOrder = sourceMesh.renderOrder;
  mesh.layers.mask = sourceMesh.layers.mask;
  return { mesh, materials };
}

function createIndexWrapperGeometry(source, index, name) {
  const wrapper = new THREE.BufferGeometry();
  wrapper.name = name;
  for (const [attributeName, attribute] of Object.entries(source.attributes)) {
    wrapper.setAttribute(attributeName, attribute);
  }
  for (const [attributeName, targets] of Object.entries(source.morphAttributes)) {
    wrapper.morphAttributes[attributeName] = targets.slice();
  }
  wrapper.morphTargetsRelative = source.morphTargetsRelative;
  wrapper.setIndex(new THREE.BufferAttribute(index, 1));
  return wrapper;
}

function createRecessedSkinMaterial(source, recess) {
  const material = new MeshStandardNodeMaterial();
  copyStandardMaps(source, material);
  // Keep the base body atlas as painted — including UBC female bra/underwear.
  // Recess only moves geometry inward for collar depth; do not reskin non-skin
  // texels to a flat skin tone (that made the bra read as flesh at necklines).
  material.positionNode = recessedSkinPositionNode(recess.skinTuckUniforms);
  // Plain depth compositing: recessed inside the fabric the skin loses to
  // exterior cloth, but still occludes the interior lining behind it — so
  // open collars genuinely fill with skin.
  material.depthWrite = true;
  // Only the outward-facing skin should show through a real collar opening.
  material.side = THREE.FrontSide;
  material.userData.bodyRecessedSkin = true;
  material.userData.bodyRecess = recess;
  material.needsUpdate = true;
  return material;
}

/**
 * Bind-pose inward offset along the body surface normal by the baked
 * per-vertex distance: exactly zero at the kept boundary so the companion
 * joins the body mesh watertight, ramping to full depth further in. Inset
 * along the actual normal — radial-only recession works on the sternum but
 * moves shoulder-top vertices sideways, letting them spill over straps.
 */
export function recessedSkinPositionNode(skinTuckUniforms = null) {
  const torsoTuck = skinTuckUniforms?.torso ?? float(1);
  const seamTuck = skinTuckUniforms?.seams ?? float(1);
  return Fn(() => positionLocal.sub(
    normalLocal.mul(
      attribute(RECESS_ATTRIBUTE, 'float').mul(torsoTuck)
        .add(attribute(RECESS_SEAM_ATTRIBUTE, 'float').mul(seamTuck)),
    ),
  ))();
}

function createSkinTuckUniforms(raw) {
  const controls = {
    torso: uniform(1),
    seams: uniform(1),
  };
  setSkinTuckUniforms(controls, raw);
  return controls;
}

function setSkinTuckUniforms(controls, raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  controls.torso.value = clampTuckMultiplier(source.torso, controls.torso.value);
  controls.seams.value = clampTuckMultiplier(source.seams, controls.seams.value);
}

function clampTuckMultiplier(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1.5, Math.max(0.1, number));
}


export function shouldHideBoneUnderOutfit(boneName) {
  const name = String(boneName || '');
  if (!name) return false;
  if (isExtremityBone(name) || isHeadBone(name)) return false;
  if (name === 'root') return false;
  // GLTFLoader sanitizes node names (dots stripped): match both
  // 'DEF-spine.001' (raw glTF) and 'DEF-spine001' (three runtime).
  if (name === 'DEF-spine' || /^DEF-spine\.?00[1-3]$/i.test(name)) return true;
  if (/shoulder|upper_arm|forearm|thigh/i.test(name)) return true;
  // UE names if reparent didn't run
  if (/pelvis|spine_0|clavicle|calf/i.test(name)) return true;
  return false;
}

function isHeadBone(name) {
  // Neck bones count as head: open necklines show neck skin on purpose.
  // Dot-agnostic — see shouldHideBoneUnderOutfit.
  if (/^DEF-spine\.?00[4-6]$/i.test(name)) return true;
  return /head|neck/i.test(name);
}

function isExtremityBone(name) {
  return /hand|foot|toe|thumb|f_index|f_middle|f_ring|f_pinky|leaf|ball_leaf/i.test(name);
}

function buildBoneHideTable(skeleton) {
  return skeleton.bones.map((b) => (shouldHideBoneUnderOutfit(b.name) ? 1 : 0));
}

function buildBoneHeadTable(skeleton) {
  return skeleton.bones.map((b) => (isHeadBone(b.name) ? 1 : 0));
}

function computeWeightedMask(geometry, weightTable) {
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return null;
  const table = weightTable instanceof Float32Array
    ? weightTable
    : Float32Array.from(weightTable);
  const count = Math.min(skinIndex.count, skinWeight.count);
  const data = new Float32Array(count);
  const boneCount = table.length;
  for (let i = 0; i < count; i += 1) {
    let h = 0;
    for (let s = 0; s < 4; s += 1) {
      const w = skinWeight.getComponent(i, s);
      if (w <= 0) continue;
      const bi = Math.round(skinIndex.getComponent(i, s));
      if (bi < 0 || bi >= boneCount) continue;
      h += w * table[bi];
    }
    data[i] = h;
  }
  return data;
}

function clamp01(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function shouldProcessMesh(mesh) {
  if (!mesh?.isSkinnedMesh) return false;
  if (isEyeMesh(mesh)) return false;
  const name = String(mesh.name || '');
  if (/eye|eyebrow|brow|lash|hair|teeth|icosphere/i.test(name)) return false;
  // Skip tiny non-body accessories (real UBC body is thousands of verts).
  const pos = mesh.geometry?.getAttribute('position');
  if (pos && pos.count < 200) return false;
  return true;
}

function isEyeMesh(object) {
  for (let node = object; node; node = node.parent) {
    if (EYE_NAMES.has(node.name)) return true;
  }
  return false;
}
