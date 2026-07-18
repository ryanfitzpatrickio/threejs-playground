import * as THREE from 'three';

export const LIMB_KEYS = Object.freeze(['arms', 'legs', 'feet']);
export const LIMB_CUT_ATTRIBUTE = 'outfitLimbCut';
export const ARM_REVEAL_MAX = 2;
const NEVER_CUT_COORDINATE = ARM_REVEAL_MAX + 1;
// Below this share of the outfit's triangles, arm-weighted geometry is usually
// just armhole/strap blending rather than an actual sleeve. Restore body arms.
export const SLEEVELESS_ARM_TRIANGLE_RATIO_MAX = 0.08;

export function suggestLimbRevealFromCoverage(coverageRatios = {}) {
  return Object.freeze({
    arms: Number(coverageRatios.arms ?? 0) < SLEEVELESS_ARM_TRIANGLE_RATIO_MAX ? 1 : 0,
    // Leg/foot topology varies too much across skirts, trousers, and shoes to
    // infer safely yet; keep their existing explicit controls.
    legs: 0,
    feet: 0,
  });
}

/**
 * Convert skin weights into a distal-to-proximal coordinate for each limb.
 * Zero is the tip of the limb; one is the shoulder/hip end. Arms continue from
 * one to two across the upper torso toward clavicle and center chest. Keeping
 * the base limb in bone space makes the cut follow animation instead of being
 * tied to a world axis or the garment's authored pose.
 */
export function computeLimbVertexData(geometry, skeleton, ranges = null) {
  const skinIndex = geometry?.getAttribute?.('skinIndex');
  const skinWeight = geometry?.getAttribute?.('skinWeight');
  const bones = skeleton?.bones ?? [];
  if (!skinIndex || !skinWeight || bones.length === 0) return null;

  const boneRegions = bones.map((bone) => classifyLimbBone(bone?.name));
  const count = Math.min(skinIndex.count, skinWeight.count);
  const result = Object.fromEntries(LIMB_KEYS.map((key) => [key, {
    affinity: new Float32Array(count),
    progress: new Float32Array(count),
    maxReveal: key === 'arms' ? ARM_REVEAL_MAX : 1,
  }]));

  for (let vertex = 0; vertex < count; vertex += 1) {
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight <= 0) continue;
      const boneIndex = Math.round(skinIndex.getComponent(vertex, slot));
      const region = boneRegions[boneIndex];
      if (!region) continue;
      const target = result[region.key];
      target.affinity[vertex] += weight;
      target.progress[vertex] += weight * region.progress;
    }
    for (const key of LIMB_KEYS) {
      const target = result[key];
      if (target.affinity[vertex] > 1e-5) {
        target.progress[vertex] /= target.affinity[vertex];
      }
    }
  }
  if (ranges !== false) {
    // Pass the skeleton so bone bind ranges resolve: without them the torso
    // spatial declassification never runs and shoulder/clavicle-weighted trap
    // skin counts as "arm" — Arm reveal then restores trap triangles at the
    // true surface, poking bare skin spikes over the garment collar.
    applySpatialProgress(geometry, result, ranges ?? inferSpatialRanges([
      { geometry, data: result, mesh: { skeleton } },
    ]));
  }
  return result;
}

/** A triangle belongs to a revealed cut when at least two vertices are limb-weighted. */
export function triangleIsRevealed(limbData, i0, i1, i2, amount) {
  const reveal = clampReveal(amount, limbData?.maxReveal ?? 1);
  if (reveal <= 0 || !limbData) return false;
  const affinities = [
    limbData.affinity[i0] ?? 0,
    limbData.affinity[i1] ?? 0,
    limbData.affinity[i2] ?? 0,
  ].sort((a, b) => a - b);
  // Median affinity: one blended seam vertex cannot erase a torso polygon,
  // while triangles genuinely spanning the limb remain part of the cut.
  if (affinities[1] < 0.35) return false;
  let progress = 0;
  let weight = 0;
  for (const vertex of [i0, i1, i2]) {
    const affinity = limbData.affinity[vertex] ?? 0;
    if (affinity <= 0.05) continue;
    progress += (limbData.progress[vertex] ?? 0) * affinity;
    weight += affinity;
  }
  return weight > 0 && progress / weight <= reveal;
}

/**
 * Install the garment half of limb replacement. Revealed regions are removed
 * from the outfit index; bodyHideUnderOutfit restores the complementary body
 * triangles. Source geometries and their UV/morph buffers remain untouched.
 */
export function installOutfitLimbCuts(meshes, reveal = {}) {
  const backups = [];
  const prepared = [];
  for (const mesh of meshes ?? []) {
    const geometry = mesh?.geometry;
    const sourceIndex = geometry?.getIndex?.();
    const limbData = computeLimbVertexData(geometry, mesh?.skeleton, false);
    if (!geometry || !sourceIndex || !limbData) continue;
    prepared.push({ mesh, geometry, sourceIndex, data: limbData });
  }

  // One bind-pose coordinate range across every submesh prevents a pauldron,
  // cuff, or shoe component from treating its own tiny bounds as a full limb.
  const spatialRanges = inferSpatialRanges(prepared);
  for (const entry of prepared) {
    const { mesh, geometry, sourceIndex, data: limbData } = entry;
    applySpatialProgress(geometry, limbData, spatialRanges);

    const groupRanges = normalizedGroups(geometry, sourceIndex.count);
    const wrapper = createSharedAttributeGeometry(
      geometry,
      sourceIndex.array,
      `${geometry.name || mesh.name}:limbCuts`,
    );
    // Pack all three cut coordinates into ONE vertex buffer. Dense imported
    // outfits already use position/normal/UV/skin/morph buffers; six separate
    // limb attributes exceeded WebGPU's 8-buffer minimum on some adapters.
    const cutCoordinates = new Float32Array(geometry.getAttribute('position').count * 3);
    const componentData = computeConnectedComponents(
      sourceIndex,
      geometry.getAttribute('position'),
    );
    const eligibleByRegion = LIMB_KEYS.map((key) => {
      const eroded = erodeCutBoundary(sourceIndex, limbData[key].affinity);
      const extensionEligible = key === 'arms' ? eroded.slice() : null;
      const eligible = protectSeamComponents(
        key,
        eroded,
        componentData,
        spatialRanges,
      );
      if (extensionEligible) {
        // A shirt/dress torso is normally one shell spanning left-to-right,
        // so the seam protector preserves it at Arm reveal 1. Past 1 the user
        // explicitly asks to cut that shell; restore only the new band.
        for (let vertex = 0; vertex < eligible.length; vertex += 1) {
          if (limbData.arms.progress[vertex] > 1) {
            eligible[vertex] = extensionEligible[vertex];
          }
        }
      }
      return eligible;
    });
    const effectiveLimbData = Object.fromEntries(LIMB_KEYS.map((key, component) => [key, {
      affinity: Float32Array.from(
        limbData[key].affinity,
        (affinity, vertex) => (eligibleByRegion[component][vertex] ? affinity : 0),
      ),
      progress: limbData[key].progress,
      maxReveal: limbData[key].maxReveal,
    }]));
    for (let vertex = 0; vertex < cutCoordinates.length / 3; vertex += 1) {
      for (let component = 0; component < LIMB_KEYS.length; component += 1) {
        const region = limbData[LIMB_KEYS[component]];
        cutCoordinates[vertex * 3 + component] = eligibleByRegion[component][vertex]
          ? region.progress[vertex]
          : NEVER_CUT_COORDINATE;
      }
    }
    wrapper.setAttribute(LIMB_CUT_ATTRIBUTE, new THREE.BufferAttribute(cutCoordinates, 3));
    for (const group of groupRanges) wrapper.addGroup(group.start, group.count, group.materialIndex);
    mesh.geometry = wrapper;
    backups.push({
      mesh,
      geometry,
      sourceIndex,
      limbData: effectiveLimbData,
      sourceTriangles: Math.floor(sourceIndex.count / 3),
      visibleTriangles: Math.floor(sourceIndex.count / 3),
    });
  }

  const sourceTriangles = backups.reduce((sum, entry) => sum + entry.sourceTriangles, 0);
  const coveredTriangles = Object.fromEntries(LIMB_KEYS.map((key) => [key, 0]));
  for (const entry of backups) {
    const index = entry.sourceIndex;
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      const i0 = index.getX(offset) | 0;
      const i1 = index.getX(offset + 1) | 0;
      const i2 = index.getX(offset + 2) | 0;
      for (const key of LIMB_KEYS) {
        if (triangleIsRevealed(entry.limbData[key], i0, i1, i2, 1)) {
          coveredTriangles[key] += 1;
        }
      }
    }
  }
  const coverageRatios = Object.fromEntries(LIMB_KEYS.map((key) => [
    key,
    sourceTriangles > 0 ? coveredTriangles[key] / sourceTriangles : 0,
  ]));
  const suggestedReveal = suggestLimbRevealFromCoverage(coverageRatios);

  const handle = {
    meshCount: backups.length,
    sourceTriangles,
    coveredTriangles: Object.freeze({ ...coveredTriangles }),
    coverageRatios: Object.freeze({ ...coverageRatios }),
    suggestedReveal,
    get visibleTriangles() {
      return backups.reduce((sum, entry) => sum + entry.visibleTriangles, 0);
    },
    setReveal(nextReveal) {
      for (const entry of backups) {
        let removed = 0;
        const index = entry.sourceIndex;
        for (let offset = 0; offset + 2 < index.count; offset += 3) {
          const i0 = index.getX(offset) | 0;
          const i1 = index.getX(offset + 1) | 0;
          const i2 = index.getX(offset + 2) | 0;
          if (LIMB_KEYS.some((key) => triangleIsRevealed(
            entry.limbData[key], i0, i1, i2, nextReveal[key],
          ))) removed += 1;
        }
        entry.visibleTriangles = entry.sourceTriangles - removed;
      }
    },
    dispose() {
      for (const entry of backups) {
        if (entry.mesh.geometry?.name?.endsWith(':limbCuts')) {
          entry.mesh.geometry = entry.geometry;
        }
      }
      backups.length = 0;
    },
  };
  handle.setReveal(reveal);
  return handle;
}

function computeConnectedComponents(index, position) {
  const parent = Uint32Array.from({ length: position.count }, (_, vertex) => vertex);
  const find = (vertex) => {
    let root = vertex;
    while (parent[root] !== root) root = parent[root];
    while (parent[vertex] !== vertex) {
      const next = parent[vertex];
      parent[vertex] = root;
      vertex = next;
    }
    return root;
  };
  const join = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    const i0 = index.getX(offset) | 0;
    const i1 = index.getX(offset + 1) | 0;
    const i2 = index.getX(offset + 2) | 0;
    join(i0, i1);
    join(i0, i2);
  }

  // glTF must duplicate vertices at UV/material/normal seams even when those
  // corners occupy the same point on one continuous piece of cloth. Treating
  // index connectivity as physical connectivity made imported Meshy dresses
  // look like dozens of tiny islands (70 on the rose dress), so the limb mask
  // punched individual shoulder/skirt panels into confetti. Join only nearly
  // coincident positions in this classification graph. The rendered geometry,
  // UVs, normals, weights, morph targets, and indices remain completely intact.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    minX = Math.min(minX, position.getX(vertex));
    minY = Math.min(minY, position.getY(vertex));
    minZ = Math.min(minZ, position.getZ(vertex));
    maxX = Math.max(maxX, position.getX(vertex));
    maxY = Math.max(maxY, position.getY(vertex));
    maxZ = Math.max(maxZ, position.getZ(vertex));
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const weldDistance = Math.max(1e-7, span * 3e-6);
  const weldDistanceSq = weldDistance * weldDistance;
  const buckets = new Map();
  const bucketKey = (x, y, z) => `${x},${y},${z}`;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    const cellX = Math.floor(x / weldDistance);
    const cellY = Math.floor(y / weldDistance);
    const cellZ = Math.floor(z / weldDistance);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const candidates = buckets.get(bucketKey(cellX + dx, cellY + dy, cellZ + dz));
          if (!candidates) continue;
          for (const other of candidates) {
            const ox = position.getX(other);
            const oy = position.getY(other);
            const oz = position.getZ(other);
            const distanceSq = (x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2;
            if (distanceSq <= weldDistanceSq) join(vertex, other);
          }
        }
      }
    }
    const key = bucketKey(cellX, cellY, cellZ);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(vertex);
    else buckets.set(key, [vertex]);
  }

  const stats = new Map();
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const root = find(vertex);
    parent[vertex] = root;
    let entry = stats.get(root);
    if (!entry) {
      entry = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      stats.set(root, entry);
    }
    entry.minX = Math.min(entry.minX, position.getX(vertex));
    entry.maxX = Math.max(entry.maxX, position.getX(vertex));
    entry.minY = Math.min(entry.minY, position.getY(vertex));
    entry.maxY = Math.max(entry.maxY, position.getY(vertex));
  }
  return { parent, stats };
}

function protectSeamComponents(key, eligible, components, ranges) {
  const protectedRoots = new Set();
  for (const [root, stats] of components.stats) {
    if (
      key === 'arms'
      && ranges.arms.down
      && (
        (stats.maxY > ranges.arms.root && stats.minY > ranges.legs.knee * 1.35)
        // Front/back shirt shells span both sides of the torso; real arm
        // islands are unilateral. Protect spanning shells even when their
        // transferred weights and vertical bounds are badly contaminated.
        || (stats.minX < -ranges.arms.core && stats.maxX > ranges.arms.core)
      )
    ) {
      protectedRoots.add(root);
    }
    if (
      key === 'legs'
      && stats.maxY > ranges.legs.root
      && stats.minY > ranges.legs.knee
    ) {
      protectedRoots.add(root);
    }
  }
  for (let vertex = 0; vertex < eligible.length; vertex += 1) {
    if (protectedRoots.has(components.parent[vertex])) eligible[vertex] = 0;
  }
  return eligible;
}

function erodeCutBoundary(index, affinity) {
  const eligible = Uint8Array.from(affinity, (value) => (value > 0.62 ? 1 : 0));
  const boundary = new Uint8Array(eligible.length);
  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    const i0 = index.getX(offset) | 0;
    const i1 = index.getX(offset + 1) | 0;
    const i2 = index.getX(offset + 2) | 0;
    if (eligible[i0] && eligible[i1] && eligible[i2]) continue;
    // Protect the full mixed triangle. This leaves a one-ring garment seam
    // instead of interpolating a discard wedge deep into the shirt/shorts.
    boundary[i0] = 1;
    boundary[i1] = 1;
    boundary[i2] = 1;
  }
  for (let vertex = 0; vertex < eligible.length; vertex += 1) {
    if (boundary[vertex]) eligible[vertex] = 0;
  }
  return eligible;
}

function inferSpatialRanges(entries) {
  const ranges = {
    arms: {
      min: Infinity,
      max: -Infinity,
      yMin: Infinity,
      yMax: -Infinity,
      root: Infinity,
      elbow: Infinity,
      jointY: -Infinity,
      extensionOuter: -Infinity,
      extensionBottom: Infinity,
      extensionTop: -Infinity,
      down: false,
      core: 0,
    },
    legs: { min: Infinity, max: -Infinity, root: -Infinity, knee: -Infinity },
  };
  for (const entry of entries) {
    const bones = entry.mesh?.skeleton?.bones ?? [];
    const inverses = entry.mesh?.skeleton?.boneInverses ?? [];
    for (let index = 0; index < bones.length; index += 1) {
      const name = String(bones[index]?.name || '').toLowerCase().replace(/[-._\s]/g, '');
      const inverse = inverses[index];
      if (!inverse) continue;
      const bind = inverse.clone().invert().elements;
      if (/upperarm/.test(name)) {
        ranges.arms.root = Math.min(ranges.arms.root, Math.abs(bind[12]));
        ranges.arms.jointY = Math.max(ranges.arms.jointY, bind[13]);
      }
      if (/forearm|lowerarm/.test(name)) {
        ranges.arms.elbow = Math.min(ranges.arms.elbow, Math.abs(bind[12]));
      }
      // Base thigh is the hip joint. The .001 Rigify child is the knee.
      if (/thigh/.test(name) && !/thigh[lr]001/.test(name)) {
        ranges.legs.root = Math.max(ranges.legs.root, bind[13]);
      }
      if (/calf|shin|lowerleg|thigh[lr]001/.test(name)) {
        ranges.legs.knee = Math.max(ranges.legs.knee, bind[13]);
      }
    }
    const pos = entry.geometry?.getAttribute?.('position');
    if (!pos) continue;
    for (let vertex = 0; vertex < pos.count; vertex += 1) {
      if ((entry.data.arms.affinity[vertex] ?? 0) >= 0.35) {
        const coordinate = Math.abs(pos.getX(vertex));
        ranges.arms.min = Math.min(ranges.arms.min, coordinate);
        ranges.arms.max = Math.max(ranges.arms.max, coordinate);
        ranges.arms.yMin = Math.min(ranges.arms.yMin, pos.getY(vertex));
        ranges.arms.yMax = Math.max(ranges.arms.yMax, pos.getY(vertex));
      }
      if ((entry.data.legs.affinity[vertex] ?? 0) >= 0.35) {
        const coordinate = pos.getY(vertex);
        ranges.legs.min = Math.min(ranges.legs.min, coordinate);
        ranges.legs.max = Math.max(ranges.legs.max, coordinate);
      }
    }
  }
  if (Number.isFinite(ranges.arms.root)) {
    const segment = Number.isFinite(ranges.arms.elbow)
      ? Math.max(0.15, ranges.arms.elbow - ranges.arms.root)
      : 0.35;
    if (Number.isFinite(ranges.arms.jointY)) {
      // Reveal 1 stops at the normal sleeve/shoulder seam. The second band is
      // based on bind joints rather than garment bounds, so outfit and body
      // agree on one shoulder-to-sternum coordinate.
      ranges.arms.extensionOuter = ranges.arms.root + segment * 0.45;
      ranges.arms.extensionBottom = ranges.arms.jointY - segment * 0.95;
      ranges.arms.extensionTop = ranges.arms.jointY + segment * 0.55;
    }
    const horizontalSpan = ranges.arms.max - ranges.arms.min;
    const verticalSpan = ranges.arms.yMax - ranges.arms.yMin;
    // Imported Meshy sources can be baked with arms down even though their
    // skeleton bind matrices are T-pose. Detect that from the weighted vertex
    // cloud and choose the actual garment axis.
    ranges.arms.down = (
      verticalSpan > horizontalSpan * 1.2
      || (Number.isFinite(ranges.arms.elbow) && ranges.arms.max < ranges.arms.elbow * 0.75)
    );
    if (ranges.arms.down) {
      ranges.arms.core = ranges.arms.root * 0.74;
      ranges.arms.root = Number.isFinite(ranges.arms.jointY)
        // Meshy arms-down bakes frequently smear the shirt chest into the arm
        // group. Use a conservative short-sleeve seam around the upper bicep;
        // this still reveals the visible arm while keeping the whole shirt.
        ? ranges.arms.jointY - segment * 2
        : ranges.arms.yMax;
      ranges.arms.min = ranges.arms.yMin;
      ranges.arms.max = ranges.arms.root;
    } else {
      // Stop a little below the shoulder joint. This preserves cap/short
      // sleeves and the shirt's armhole even at Arm reveal 1.0.
      ranges.arms.root += segment * 0.26;
      ranges.arms.min = ranges.arms.root;
    }
  }
  if (Number.isFinite(ranges.legs.root)) {
    // Likewise preserve the shorts/waist seam instead of cutting into torso.
    ranges.legs.root = Number.isFinite(ranges.legs.knee)
      ? ranges.legs.root - (ranges.legs.root - ranges.legs.knee) * 0.2
      : ranges.legs.root;
    ranges.legs.max = ranges.legs.root;
  }
  return ranges;
}

function applySpatialProgress(geometry, data, ranges) {
  const pos = geometry?.getAttribute?.('position');
  if (!pos) return;
  const armSpan = ranges.arms.max - ranges.arms.min;
  const legSpan = ranges.legs.max - ranges.legs.min;
  for (let vertex = 0; vertex < pos.count; vertex += 1) {
    const absX = Math.abs(pos.getX(vertex));
    const y = pos.getY(vertex);
    const armInsideTorso = Number.isFinite(ranges.arms.root) && (
      ranges.arms.down
        ? y > ranges.arms.root || absX < ranges.arms.core
        : absX < ranges.arms.root * 0.98
    );
    const misplacedLimbWeight = Math.max(
      data.arms.affinity[vertex],
      data.legs.affinity[vertex],
      data.feet.affinity[vertex],
    );
    const inDownArmLane = ranges.arms.down
      && !armInsideTorso
      && y >= Math.max(0, ranges.legs.knee * 0.85)
      && misplacedLimbWeight > 0.5;
    const inUpperTorsoExtension = Number.isFinite(ranges.arms.extensionOuter)
      && absX <= ranges.arms.extensionOuter
      && y >= ranges.arms.extensionBottom
      && y <= ranges.arms.extensionTop;
    let extendedArm = false;
    if (inDownArmLane) {
      // Some imported bakes carry thigh weights on the hanging arms. Spatially
      // reclassify the lateral arm lane so Leg reveal cannot punch the sleeves.
      data.arms.affinity[vertex] = 1;
      data.legs.affinity[vertex] = 0;
      data.feet.affinity[vertex] = 0;
    } else if (inUpperTorsoExtension) {
      // Coordinate 1..2 sweeps medially from the shoulder edge to center
      // chest. Spatial assignment also covers spine/breast-weighted vertices
      // that have no arm bone influence.
      data.arms.affinity[vertex] = 1;
      data.arms.progress[vertex] = 1 + clamp01(
        (ranges.arms.extensionOuter - absX) / ranges.arms.extensionOuter,
      );
      data.legs.affinity[vertex] = 0;
      data.feet.affinity[vertex] = 0;
      extendedArm = true;
    } else if (armInsideTorso || data.arms.affinity[vertex] < 0.12) {
      data.arms.affinity[vertex] = 0;
    }
    if (!extendedArm && data.arms.affinity[vertex] > 0.05 && Number.isFinite(armSpan) && armSpan > 1e-5) {
      data.arms.progress[vertex] = ranges.arms.down
        // Arms-down import: hands are lowest, shoulder seam is highest.
        ? clamp01((y - ranges.arms.min) / armSpan)
        // T/A bind: fingertips have greatest |x|, shoulders the least.
        : clamp01((ranges.arms.max - absX) / armSpan);
    }
    const legAboveHip = Number.isFinite(ranges.legs.root) && y > ranges.legs.root;
    if (legAboveHip || data.legs.affinity[vertex] < 0.12) {
      data.legs.affinity[vertex] = 0;
    }
    if (data.legs.affinity[vertex] > 0.05 && Number.isFinite(legSpan) && legSpan > 1e-5) {
      // Feet-to-hip coordinate in bind-pose model space.
      data.legs.progress[vertex] = clamp01(
        (y - ranges.legs.min) / legSpan,
      );
    }
  }
}

function classifyLimbBone(rawName) {
  const name = String(rawName || '').toLowerCase().replace(/[-._\s]/g, '');
  if (!name || /root|spine|pelvis|breast|neck|head/.test(name)) return null;

  if (/toe|ball/.test(name)) return { key: 'feet', progress: 0.08 };
  if (/foot|ankle/.test(name)) return { key: 'feet', progress: 0.72 };

  if (/thumb|index|middle|ring|pinky|finger|hand|wrist/.test(name)) {
    return { key: 'arms', progress: /hand|wrist/.test(name) ? 0.2 : 0.04 };
  }
  if (/forearm|lowerarm|elbow/.test(name)) return { key: 'arms', progress: 0.5 };
  if (/upperarm|armtwist|shoulder|clavicle/.test(name)) return { key: 'arms', progress: 0.9 };

  if (/calf|shin|lowerleg|knee|thigh[lr]001/.test(name)) return { key: 'legs', progress: 0.38 };
  if (/thigh|upperleg/.test(name)) return { key: 'legs', progress: 0.88 };
  return null;
}

function normalizedGroups(geometry, indexCount) {
  if (geometry.groups?.length) {
    return geometry.groups.map((group) => ({
      start: Math.max(0, group.start | 0),
      count: Math.max(0, group.count | 0),
      materialIndex: group.materialIndex | 0,
    }));
  }
  return [{ start: 0, count: indexCount, materialIndex: 0 }];
}

function createSharedAttributeGeometry(source, index, name) {
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

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function clampReveal(value, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(max, Math.max(0, number));
}
