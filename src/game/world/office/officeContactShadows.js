// officeContactShadows.js — soft blob shadows under furniture (M0).

import * as THREE from 'three';

const BLOB_Y_OFFSET = 0.035;

let _blobTexture = null;
let _blobMaterial = null;

function radialBlobTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, 1 - r * r);
      const alpha = Math.round(255 * a * a * 0.42);
      const i = (y * size + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = alpha;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function getBlobShadowMaterial() {
  if (_blobMaterial) return _blobMaterial;
  _blobTexture = radialBlobTexture();
  _blobMaterial = new THREE.MeshBasicMaterial({
    map: _blobTexture,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  _blobMaterial.name = 'Office Blob Shadow';
  return _blobMaterial;
}

const BLOB_FOOTPRINTS = {
  desk: { w: 1.38, d: 0.71 },
  table: { w: 2.18, d: 1.21 },
  sofa2: { w: 1.84, d: 0.83 },
  sofa3: { w: 2.53, d: 0.83 },
  coffee: { w: 1.04, d: 0.58 },
  plant: { w: 0.46, d: 0.46 },
};

export function addBlobShadowInstanced(floorGroup, blobEntries, floorY, name = 'Office Blob Shadows') {
  if (!blobEntries?.length) return null;
  const mat = getBlobShadowMaterial();
  const geom = new THREE.PlaneGeometry(1, 1);
  geom.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geom, mat, blobEntries.length);
  mesh.name = name;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  for (let i = 0; i < blobEntries.length; i += 1) {
    const { matrix, kind } = blobEntries[i];
    const fp = BLOB_FOOTPRINTS[kind] ?? BLOB_FOOTPRINTS.desk;
    matrix.decompose(p, q, s);
    m.compose(
      p.set(p.x, floorY + BLOB_Y_OFFSET, p.z),
      q,
      s.set(fp.w * 1.15, 1, fp.d * 1.15),
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  floorGroup.add(mesh);
  return mesh;
}

export { BLOB_Y_OFFSET };
