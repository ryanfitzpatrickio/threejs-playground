import * as THREE from 'three';

const HISTORY_SIZE = 120;

const BUCKET_DEFS = [
  { id: 'terrain', label: 'Terrain', match: /terrain|wilds|zone tint|world map overlay|DreamfallTerrain|entity pad/i },
  { id: 'city', label: 'City', match: /generator city|skyscraper|sidewalk|wet asphalt|street light|merged skyscrapers/i },
  { id: 'roads', label: 'Roads & track', match: /roadworks|road ribbon|road pier|intersection|trackside|blueprint platform/i },
  { id: 'water', label: 'Water', match: /river|riverworks|\bwater\b/i },
  { id: 'character', label: 'Character', match: /mara|character|horse|saddle|rider|contact shadow/i },
  { id: 'vehicles', label: 'Vehicles', match: /vehicle|muscle|chassis|\bcar\b|\bvan\b/i },
  { id: 'enemies', label: 'Enemies', match: /enemy|crowd|ragdoll|corpse/i },
  { id: 'props', label: 'Props', match: /prop|blueprint entities|entity |cut prop|telekinesis chunk/i },
  { id: 'fx', label: 'FX', match: /rope|hook|blade|neon|particle|vfx|slash/i },
];

const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
const worldSphere = new THREE.Sphere();

function isDrawable(object) {
  return Boolean(
    object?.isMesh
    || object?.isInstancedMesh
    || object?.isSkinnedMesh
    || object?.isSprite
    || object?.isLine
    || object?.isLineSegments,
  );
}

function shouldSkip(object) {
  if (!object?.visible) return true;
  if (object.userData?.noStats) return true;
  const name = object.name ?? '';
  if (/^helper|^debug|^stats|^gizmo/i.test(name)) return true;
  return false;
}

function classifyBucket(object) {
  let node = object;
  while (node) {
    const name = node.name ?? '';
    if (name) {
      for (const bucket of BUCKET_DEFS) {
        if (bucket.match.test(name)) {
          return bucket.id;
        }
      }
    }
    node = node.parent;
  }
  return 'other';
}

function countTriangles(object) {
  const geometry = object.geometry;
  if (!geometry) return 0;

  let verts = 0;
  if (geometry.index) {
    verts = geometry.index.count;
  } else {
    verts = geometry.attributes?.position?.count ?? 0;
  }

  let primitives = 0;
  if (object.isLineSegments) {
    primitives = verts / 2;
  } else if (object.isLine) {
    primitives = Math.max(0, verts - 1);
  } else if (object.isPoints) {
    primitives = verts;
  } else {
    primitives = verts / 3;
  }

  const instances = object.isInstancedMesh ? (object.count ?? 1) : 1;
  return Math.round(primitives * instances);
}

function intersectsFrustum(object) {
  const geometry = object.geometry;
  if (!geometry) return true;

  if (!geometry.boundingSphere) {
    geometry.computeBoundingSphere();
  }
  if (!geometry.boundingSphere) return true;

  worldSphere.copy(geometry.boundingSphere).applyMatrix4(object.matrixWorld);
  return frustum.intersectsSphere(worldSphere);
}

export class DrawCallProfiler {
  constructor() {
    this.history = new Uint16Array(HISTORY_SIZE);
    this.historyIndex = 0;
    this.historyFilled = false;
    this.buckets = Object.fromEntries([
      ...BUCKET_DEFS.map(({ id, label }) => [id, { id, label, draws: 0, tris: 0 }]),
      ['other', { id: 'other', label: 'Other', draws: 0, tris: 0 }],
      ['pipeline', { id: 'pipeline', label: 'Shadows & pipeline', draws: 0, tris: 0 }],
    ]);
    this.lastBreakdown = [];
  }

  resetBuckets() {
    for (const bucket of Object.values(this.buckets)) {
      bucket.draws = 0;
      bucket.tris = 0;
    }
  }

  recordFrame(drawCalls) {
    this.history[this.historyIndex] = Math.min(65535, Math.max(0, drawCalls | 0));
    this.historyIndex = (this.historyIndex + 1) % HISTORY_SIZE;
    if (this.historyIndex === 0) {
      this.historyFilled = true;
    }
  }

  profileScene({ scene, camera, totalDrawCalls = 0, totalTriangles = 0 }) {
    this.resetBuckets();

    if (scene && camera) {
      projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreenMatrix);

      scene.traverseVisible((object) => {
        if (!isDrawable(object) || shouldSkip(object)) {
          return;
        }
        if (!intersectsFrustum(object)) {
          return;
        }

        const bucketId = classifyBucket(object);
        const bucket = this.buckets[bucketId] ?? this.buckets.other;
        bucket.draws += 1;
        bucket.tris += countTriangles(object);
      });
    }

    let profiledDraws = 0;
    let profiledTris = 0;
    for (const bucket of Object.values(this.buckets)) {
      if (bucket.id === 'pipeline') continue;
      profiledDraws += bucket.draws;
      profiledTris += bucket.tris;
    }

    this.buckets.pipeline.draws = Math.max(0, totalDrawCalls - profiledDraws);
    this.buckets.pipeline.tris = Math.max(0, totalTriangles - profiledTris);

    this.lastBreakdown = this.buildBreakdown(totalDrawCalls);
    return this.lastBreakdown;
  }

  buildBreakdown(totalDrawCalls = 0) {
    const rows = Object.values(this.buckets)
      .filter((bucket) => bucket.draws > 0)
      .sort((a, b) => b.draws - a.draws);

    const denom = totalDrawCalls > 0 ? totalDrawCalls : rows.reduce((sum, row) => sum + row.draws, 0) || 1;

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      draws: row.draws,
      tris: row.tris,
      pct: Math.round((row.draws / denom) * 100),
    }));
  }

  getHistoryArray() {
    const len = this.historyFilled ? HISTORY_SIZE : this.historyIndex;
    if (len === 0) return [];
    const out = new Array(len);
    const start = this.historyFilled ? this.historyIndex : 0;
    for (let i = 0; i < len; i += 1) {
      out[i] = this.history[(start + i) % HISTORY_SIZE];
    }
    return out;
  }

  snapshot({ totalDrawCalls = 0, totalTriangles = 0 } = {}) {
    return {
      history: this.getHistoryArray(),
      breakdown: this.lastBreakdown.length > 0
        ? this.lastBreakdown
        : this.buildBreakdown(totalDrawCalls),
      profiledDraws: this.lastBreakdown
        .filter((row) => row.id !== 'pipeline')
        .reduce((sum, row) => sum + row.draws, 0),
      totalDrawCalls,
      totalTriangles,
    };
  }
}

export function buildSparklinePath(values, width, height, padding = 2) {
  if (!values?.length) {
    return '';
  }

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;

  return values
    .map((value, index) => {
      const x = padding + index * step;
      const y = padding + innerH - (value / max) * innerH;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
