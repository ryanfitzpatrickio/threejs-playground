import * as THREE from 'three';

export const OUTFIT_LOOP_TARGETS = Object.freeze([
  Object.freeze({ id: 'torso', label: 'Neck / torso' }),
  Object.freeze({ id: 'leftArm', label: 'Left sleeve' }),
  Object.freeze({ id: 'rightArm', label: 'Right sleeve' }),
  Object.freeze({ id: 'leftLeg', label: 'Left leg' }),
  Object.freeze({ id: 'rightLeg', label: 'Right leg' }),
]);
export const OUTFIT_LOOP_EDGE_MIN = -0.3;
export const OUTFIT_LOOP_EDGE_MAX = 0.3;
export const OUTFIT_LOOP_RADIAL_MIN = 0;
export const OUTFIT_LOOP_RADIAL_MAX = 0.5;
/** New torso cuts default to a tube around the drawn ring (see radialReach). */
export const OUTFIT_LOOP_RADIAL_DEFAULT = 0.1;

const TARGET_IDS = new Set(OUTFIT_LOOP_TARGETS.map((target) => target.id));
const MAX_LOOP_CUTS = 8;
const MAX_LOOP_POINTS = 64;

export function sanitizeOutfitLoopCuts(raw) {
  if (!Array.isArray(raw)) return [];
  const cuts = [];
  for (const entry of raw.slice(0, MAX_LOOP_CUTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const target = TARGET_IDS.has(entry.target) ? entry.target : 'torso';
    const frame = sanitizeFrame(entry.frame, target);
    const points = Array.isArray(entry.points)
      ? entry.points.slice(0, MAX_LOOP_POINTS).map(sanitizePoint).filter(Boolean)
      : [];
    if (points.length < 3) continue;
    cuts.push({
      id: sanitizeId(entry.id) || `loop-${cuts.length + 1}`,
      target,
      interpolation: entry.interpolation === 'sharp' ? 'sharp' : 'smooth',
      hideSide: entry.hideSide === 'negative' ? 'negative' : 'positive',
      // Positive always means "keep more garment", regardless of which side
      // is hidden. Units are bind-space model units (body height is ~3.5).
      edgeInset: clampEdgeInset(entry.edgeInset),
      radialReach: sanitizeRadialReach(entry.radialReach),
      frame,
      points,
    });
  }
  return cuts;
}

export function createOutfitLoopCut({
  id,
  target = 'torso',
  interpolation = 'smooth',
  hideSide = 'positive',
  edgeInset = 0,
  radialReach,
  frame,
  points,
} = {}) {
  return sanitizeOutfitLoopCuts([{
    id: id || `loop-${Date.now().toString(36)}`,
    target,
    interpolation,
    hideSide,
    edgeInset,
    radialReach,
    frame,
    points,
  }])[0] ?? null;
}

/** Bind-space anatomical frame shared by garment and body loop classification. */
export function createOutfitLoopFrame(target, skeleton) {
  if (target === 'torso') return defaultFrame(target);
  const binds = collectBindJoints(skeleton);
  const side = target.startsWith('left') ? 'left' : 'right';
  const isArm = target.endsWith('Arm');
  const start = binds.find((joint) => joint.side === side && (
    isArm ? joint.kind === 'upperArm' : joint.kind === 'upperLeg'
  ));
  const end = binds.find((joint) => joint.side === side && (
    isArm ? joint.kind === 'forearm' : joint.kind === 'lowerLeg'
  ));
  if (!start || !end || start.position.distanceToSquared(end.position) < 1e-8) {
    return defaultFrame(target);
  }
  const axis = end.position.clone().sub(start.position).normalize();
  const reference = Math.abs(axis.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const u = reference.addScaledVector(axis, -reference.dot(axis)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return {
    origin: start.position.toArray(),
    axis: axis.toArray(),
    u: u.toArray(),
    v: v.toArray(),
  };
}

export function compileOutfitLoopCuts(raw) {
  return sanitizeOutfitLoopCuts(raw).map((cut) => {
    const { origin, axis, u, v } = cut.frame;
    const knots = cut.points.map((point) => {
      const dx = point[0] - origin[0];
      const dy = point[1] - origin[1];
      const dz = point[2] - origin[2];
      const radialU = dx * u[0] + dy * u[1] + dz * u[2];
      const radialV = dx * v[0] + dy * v[1] + dz * v[2];
      return {
        angle: normalizeAngle(
          Math.atan2(radialV, radialU),
        ),
        axial: dx * axis[0] + dy * axis[1] + dz * axis[2],
        radius: Math.hypot(radialU, radialV),
      };
    }).sort((a, b) => a.angle - b.angle);
    const radii = knots.map((knot) => knot.radius).sort((a, b) => a - b);
    const medianRadius = radii[Math.floor(radii.length / 2)] ?? 0;
    // Arm/leg loops are local rings, not infinite clipping cylinders. A
    // generous envelope retains flared sleeves/boots while excluding torso,
    // waist, skirt, and the opposite limb from the same axial half-space.
    const radialLimit = cut.target === 'torso'
      ? Infinity
      : Math.max(0.08, medianRadius * 1.8 + 0.035);
    return { ...cut, knots, radialLimit };
  });
}

export function pointIsHiddenByLoopCuts(compiledCuts, x, y, z) {
  for (const cut of compiledCuts ?? []) {
    if (pointIsHiddenByLoopCut(cut, x, y, z)) return true;
  }
  return false;
}

export function triangleIsHiddenByLoopCuts(
  compiledCuts,
  position,
  i0,
  i1,
  i2,
  { torsoMinimumHiddenVertices = 2 } = {},
) {
  if (!compiledCuts?.length || !position) return false;
  const vertices = [i0, i1, i2];
  for (const cut of compiledCuts) {
    let hidden = 0;
    for (const vertex of vertices) {
      if (pointIsHiddenByLoopCut(
        cut,
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex),
      )) hidden += 1;
    }
    const minimum = cut.target === 'torso'
      ? Math.min(3, Math.max(1, torsoMinimumHiddenVertices | 0))
      : 2;
    if (hidden >= minimum) return true;
  }
  return false;
}

/** Filter garment triangles; bodyHideUnderOutfit restores the matching body side. */
export function installOutfitLoopCuts(meshes, initialCuts = []) {
  const entries = [];
  for (const mesh of meshes ?? []) {
    const geometry = mesh?.geometry;
    const index = geometry?.getIndex?.();
    const position = geometry?.getAttribute?.('position');
    if (!geometry || !index || !position) continue;
    entries.push({
      mesh,
      geometry,
      index,
      position,
      groups: normalizedGroups(geometry, index.count),
      sourceTriangles: Math.floor(index.count / 3),
      visibleTriangles: Math.floor(index.count / 3),
    });
  }

  let cuts = [];
  const handle = {
    meshCount: entries.length,
    get cuts() { return cuts; },
    get sourceTriangles() {
      return entries.reduce((sum, entry) => sum + entry.sourceTriangles, 0);
    },
    get visibleTriangles() {
      return entries.reduce((sum, entry) => sum + entry.visibleTriangles, 0);
    },
    setCuts(nextCuts) {
      cuts = sanitizeOutfitLoopCuts(nextCuts);
      const compiled = compileOutfitLoopCuts(cuts);
      for (const entry of entries) {
        const nextIndex = [];
        const nextGroups = [];
        for (const group of entry.groups) {
          const start = nextIndex.length;
          const end = Math.min(entry.index.count, group.start + group.count);
          for (let offset = group.start; offset + 2 < end; offset += 3) {
            const i0 = entry.index.getX(offset) | 0;
            const i1 = entry.index.getX(offset + 1) | 0;
            const i2 = entry.index.getX(offset + 2) | 0;
            // Torso imports often contain a coarse donor/mannequin neck shell.
            // Drop every triangle that enters the discarded side of the loop;
            // otherwise a single hidden vertex can pull a long surviving face
            // through the neckline after skinning. Body restoration uses the
            // inverse conservative rule and leaves the transition recessed.
            if (triangleIsHiddenByLoopCuts(
              compiled,
              entry.position,
              i0,
              i1,
              i2,
              { torsoMinimumHiddenVertices: 1 },
            )) continue;
            nextIndex.push(i0, i1, i2);
          }
          if (nextIndex.length > start) {
            nextGroups.push({
              start,
              count: nextIndex.length - start,
              materialIndex: group.materialIndex,
            });
          }
        }
        const IndexArray = entry.position.count > 65535 ? Uint32Array : Uint16Array;
        const wrapper = createSharedAttributeGeometry(
          entry.geometry,
          new IndexArray(nextIndex),
          `${entry.geometry.name || entry.mesh.name}:loopCuts`,
        );
        for (const group of nextGroups) wrapper.addGroup(group.start, group.count, group.materialIndex);
        entry.mesh.geometry = wrapper;
        entry.visibleTriangles = Math.floor(nextIndex.length / 3);
      }
    },
    dispose() {
      for (const entry of entries) {
        if (entry.mesh.geometry?.name?.endsWith(':loopCuts')) entry.mesh.geometry = entry.geometry;
      }
      entries.length = 0;
    },
  };
  handle.setCuts(initialCuts);
  return handle;
}

function pointIsHiddenByLoopCut(cut, x, y, z) {
  const { origin, axis, u, v } = cut.frame;
  const dx = x - origin[0];
  const dy = y - origin[1];
  const dz = z - origin[2];
  const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
  const radialU = dx * u[0] + dy * u[1] + dz * u[2];
  const radialV = dx * v[0] + dy * v[1] + dz * v[2];
  const radius = Math.hypot(radialU, radialV);
  if (radius > cut.radialLimit) return false;
  const angle = normalizeAngle(
    Math.atan2(radialV, radialU),
  );
  // Torso cuts may be bounded to a tube around the drawn ring. Without it the
  // axial threshold is radius-blind: at the neck's side angles, shoulder tops
  // sit at the same height as donor-shell cruft inside the neck hole, so the
  // loop could not remove one without eating the other.
  if (Number.isFinite(cut.radialReach)) {
    const ringRadius = samplePeriodicBoundary(cut.knots, angle, cut.interpolation, 'radius');
    if (radius > ringRadius + cut.radialReach) return false;
  }
  const boundary = samplePeriodicBoundary(cut.knots, angle, cut.interpolation);
  const adjustedBoundary = cut.hideSide === 'negative'
    ? boundary - cut.edgeInset
    : boundary + cut.edgeInset;
  return cut.hideSide === 'negative' ? axial <= adjustedBoundary : axial >= adjustedBoundary;
}

function samplePeriodicBoundary(knots, angle, interpolation, field = 'axial') {
  if (!knots?.length) return 0;
  if (knots.length === 1) return knots[0][field];
  let rightIndex = knots.findIndex((knot) => knot.angle >= angle);
  if (rightIndex < 0) rightIndex = 0;
  const leftIndex = (rightIndex - 1 + knots.length) % knots.length;
  const left = knots[leftIndex];
  const right = knots[rightIndex];
  const leftAngle = left.angle;
  const rightAngle = rightIndex === 0 ? right.angle + Math.PI * 2 : right.angle;
  const sampleAngle = rightIndex === 0 && angle < leftAngle ? angle + Math.PI * 2 : angle;
  const span = Math.max(1e-6, rightAngle - leftAngle);
  let t = Math.min(1, Math.max(0, (sampleAngle - leftAngle) / span));
  if (interpolation === 'smooth') t = t * t * (3 - 2 * t);
  return left[field] + (right[field] - left[field]) * t;
}

function collectBindJoints(skeleton) {
  const joints = [];
  for (let index = 0; index < (skeleton?.bones?.length ?? 0); index += 1) {
    const bone = skeleton.bones[index];
    const inverse = skeleton.boneInverses?.[index];
    if (!bone || !inverse) continue;
    const raw = String(bone.name || '').toLowerCase();
    const name = raw.replace(/[-._\s]/g, '');
    const side = /left|(?:[._-]l)(?:[._-]|$)|(?:upperarm|forearm|thigh|calf|shin)l(?:001)?$/.test(raw)
      || /(?:upperarm|forearm|thigh|calf|shin)l(?:001)?$/.test(name)
      ? 'left'
      : (/right|(?:[._-]r)(?:[._-]|$)|(?:upperarm|forearm|thigh|calf|shin)r(?:001)?$/.test(raw)
        || /(?:upperarm|forearm|thigh|calf|shin)r(?:001)?$/.test(name) ? 'right' : null);
    let kind = null;
    if (/upperarm/.test(name)) kind = 'upperArm';
    else if (/forearm|lowerarm/.test(name)) kind = 'forearm';
    else if (/thigh/.test(name) && !/thigh[lr]001/.test(name)) kind = 'upperLeg';
    else if (/calf|shin|lowerleg|thigh[lr]001/.test(name)) kind = 'lowerLeg';
    if (!side || !kind) continue;
    const elements = inverse.clone().invert().elements;
    joints.push({ side, kind, position: new THREE.Vector3(elements[12], elements[13], elements[14]) });
  }
  return joints;
}

function defaultFrame(target) {
  if (target === 'leftArm') return orthogonalFrame([0.3, 2.8, -0.1], [1, 0, 0]);
  if (target === 'rightArm') return orthogonalFrame([-0.3, 2.8, -0.1], [-1, 0, 0]);
  if (target === 'leftLeg') return orthogonalFrame([0.18, 1.9, 0], [0, -1, 0]);
  if (target === 'rightLeg') return orthogonalFrame([-0.18, 1.9, 0], [0, -1, 0]);
  return orthogonalFrame([0, 0, 0], [0, 1, 0]);
}

function orthogonalFrame(origin, axisArray) {
  const axis = new THREE.Vector3().fromArray(axisArray).normalize();
  const reference = Math.abs(axis.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const u = reference.addScaledVector(axis, -reference.dot(axis)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return { origin: [...origin], axis: axis.toArray(), u: u.toArray(), v: v.toArray() };
}

function sanitizeFrame(raw, target) {
  const fallback = defaultFrame(target);
  if (!raw || typeof raw !== 'object') return fallback;
  const origin = sanitizeVector(raw.origin);
  const axis = sanitizeVector(raw.axis);
  const u = sanitizeVector(raw.u);
  const v = sanitizeVector(raw.v);
  if (!origin || !axis || !u || !v) return fallback;
  return { origin, axis, u, v };
}

function sanitizePoint(raw) {
  return sanitizeVector(raw);
}

function sanitizeVector(raw) {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const vector = raw.slice(0, 3).map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

function sanitizeId(raw) {
  const id = String(raw ?? '').trim().slice(0, 64);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
}

function clampEdgeInset(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(OUTFIT_LOOP_EDGE_MAX, Math.max(OUTFIT_LOOP_EDGE_MIN, value));
}

// Infinity = legacy radius-blind behavior (also what JSON `null` round-trips
// to). Only an explicit finite number narrows the cut to the drawn ring.
function sanitizeRadialReach(raw) {
  if (raw === null || raw === undefined || raw === '') return Infinity;
  const value = Number(raw);
  if (!Number.isFinite(value)) return Infinity;
  return Math.min(OUTFIT_LOOP_RADIAL_MAX, Math.max(OUTFIT_LOOP_RADIAL_MIN, value));
}

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function normalizedGroups(geometry, indexCount) {
  if (geometry.groups?.length) return geometry.groups.map((group) => ({ ...group }));
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
