import * as THREE from 'three';

const STORAGE_PREFIX = 'threejs-playground:cloth-colliders:';
const COLLIDER_COLOR = 0x42c8ff;
const SELECTED_COLOR = 0xffb347;
const DEFAULT_JACKET_TRANSFORM = Object.freeze({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

const DEFAULT_COLLIDERS = [
  { bone: 'mixamorigSpine', radius: 0.32, offset: [0, 0.05, 0] },
  { bone: 'mixamorigSpine1', radius: 0.28, offset: [0, 0, 0] },
  { bone: 'mixamorigSpine2', radius: 0.26, offset: [0, 0.05, 0] },
  { bone: 'mixamorigHips', radius: 0.3, offset: [0, 0, 0] },
  { bone: 'mixamorigLeftArm', radius: 0.13, offset: [0, 0, 0] },
  { bone: 'mixamorigRightArm', radius: 0.13, offset: [0, 0, 0] },
  { bone: 'mixamorigLeftForeArm', radius: 0.1, offset: [0, 0, 0] },
  { bone: 'mixamorigRightForeArm', radius: 0.1, offset: [0, 0, 0] },
];

export class ClothColliderEditorRuntime {
  constructor({ modelRoot, clothMesh, jacketSocket, skinTransferStats, modelId = 'player', skeletonSource = 'mixamo' }) {
    this.modelRoot = modelRoot;
    this.modelId = modelId;
    this.clothMesh = clothMesh;
    this.jacketSocket = jacketSocket;
    this.skinTransferStats = skinTransferStats ?? null;
    this.skeletonSource = skeletonSource;
    this.enabled = false;
    this.selectedId = null;
    this.cloth = null;
    this.records = [];
    this.nextId = 1;
    this.bones = collectBones(modelRoot);

    const saved = readStoredProfile(modelId);
    this.jacketTransform = normalizeJacketTransform(saved?.jacketTransform);
    this.applyJacketTransform();
    const initial = saved?.colliders?.length ? saved.colliders : DEFAULT_COLLIDERS;
    for (const spec of initial) this.add(spec, { persist: false });
    this.selectedId = this.records[0]?.id ?? null;
    this.refreshVisuals();
  }

  bindCloth(cloth) {
    this.cloth = cloth;
    for (const record of this.records) this.syncClothCollider(record);
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    this.refreshVisuals();
    return this.snapshot();
  }

  select(id) {
    if (this.records.some((record) => record.id === id)) this.selectedId = id;
    this.refreshVisuals();
    return this.snapshot();
  }

  add(spec = {}, { persist = true } = {}) {
    const boneName = spec.bone ?? this.bones[0]?.name;
    const bone = findBone(this.modelRoot, boneName);
    if (!bone) return this.snapshot();

    const radius = clampNumber(spec.radius, 0.02, 1.5, 0.2);
    const offset = vectorArray(spec.offset);
    const collider = createColliderMesh();
    const id = spec.id ?? `collider-${this.nextId++}`;
    collider.name = `ClothCollider_${id}`;
    collider.userData = {
      clothCollider: true,
      stickto: bone.name,
      colliderEditorId: id,
    };
    bone.add(collider);
    collider.position.fromArray(offset);

    const record = { id, bone: bone.name, radius, offset, object: collider };
    this.records.push(record);
    this.applyRadius(record);
    this.selectedId = id;

    if (this.cloth?.colliders) {
      this.cloth.colliders.push({ position: collider, radius });
    }
    this.refreshVisuals();
    if (persist) this.persist();
    return this.snapshot();
  }

  update(id, patch = {}) {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) return this.snapshot();

    if (patch.bone && patch.bone !== record.bone) {
      const bone = findBone(this.modelRoot, patch.bone);
      if (bone) {
        record.bone = bone.name;
        record.object.removeFromParent();
        bone.add(record.object);
        record.object.userData.stickto = bone.name;
      }
    }
    if (patch.offset) record.offset = vectorArray(patch.offset);
    if (patch.radius != null) record.radius = clampNumber(patch.radius, 0.02, 1.5, record.radius);

    record.object.position.fromArray(record.offset);
    this.applyRadius(record);
    this.syncClothCollider(record);
    this.persist();
    return this.snapshot();
  }

  remove(id) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return this.snapshot();
    const [record] = this.records.splice(index, 1);
    const clothIndex = this.cloth?.colliders?.findIndex((entry) => entry.position === record.object) ?? -1;
    if (clothIndex >= 0) this.cloth.colliders.splice(clothIndex, 1);
    record.object.geometry.dispose();
    record.object.material.dispose();
    record.object.removeFromParent();
    this.selectedId = this.records[Math.min(index, this.records.length - 1)]?.id ?? null;
    this.refreshVisuals();
    this.persist();
    return this.snapshot();
  }

  async resetCloth() {
    await this.cloth?.reset?.();
    return this.snapshot();
  }

  updateJacketTransform(patch = {}) {
    this.jacketTransform = normalizeJacketTransform({
      ...this.jacketTransform,
      ...patch,
    });
    this.applyJacketTransform();
    this.persist();
    this.resetCloth();
    return this.snapshot();
  }

  importProfile(profile) {
    const colliders = Array.isArray(profile?.colliders) ? profile.colliders : null;
    if (!colliders) throw new Error('Collider profile must contain a colliders array.');
    for (const record of [...this.records]) this.remove(record.id);
    for (const spec of colliders) this.add(spec, { persist: false });
    this.jacketTransform = normalizeJacketTransform(profile.jacketTransform);
    this.applyJacketTransform();
    this.persist();
    this.resetCloth();
    return this.snapshot();
  }

  exportProfile() {
    return {
      version: 2,
      modelId: this.modelId,
      skeletonSource: this.skeletonSource,
      jacketTransform: {
        position: this.jacketTransform.position.map(round),
        rotation: this.jacketTransform.rotation.map(round),
        scale: this.jacketTransform.scale.map(round),
      },
      colliders: this.records.map(({ id, bone, radius, offset }) => ({
        id,
        bone,
        radius: round(radius),
        offset: offset.map(round),
      })),
    };
  }

  snapshot() {
    return {
      enabled: this.enabled,
      modelId: this.modelId,
      skeletonSource: this.skeletonSource,
      selectedId: this.selectedId,
      bones: this.bones,
      clothWeights: summarizeClothWeights(this.clothMesh),
      skinTransfer: this.skinTransferStats ? {
        vertices: this.skinTransferStats.vertices,
        medianDistance: round(this.skinTransferStats.medianDistance),
        p95Distance: round(this.skinTransferStats.p95Distance),
        maxDistance: round(this.skinTransferStats.maxDistance),
      } : null,
      jacketTransform: this.exportProfile().jacketTransform,
      colliders: this.exportProfile().colliders,
    };
  }

  dispose() {
    clearTimeout(this.clothResetTimer);
    for (const record of this.records) {
      record.object.geometry.dispose();
      record.object.material.dispose();
      record.object.removeFromParent();
    }
    this.records.length = 0;
    this.cloth = null;
  }

  persist() {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${this.modelId}`, JSON.stringify(this.exportProfile()));
    } catch {}
  }

  refreshVisuals() {
    for (const record of this.records) {
      record.object.material.visible = this.enabled;
      record.object.material.color.setHex(record.id === this.selectedId ? SELECTED_COLOR : COLLIDER_COLOR);
    }
  }

  applyRadius(record) {
    const boneScale = record.object.parent?.getWorldScale(new THREE.Vector3()).x || 1;
    record.object.scale.setScalar(record.radius / Math.abs(boneScale));
  }

  syncClothCollider(record) {
    const entry = this.cloth?.colliders?.find((candidate) => candidate.position === record.object);
    if (entry) entry.radius = record.radius;
  }

  applyJacketTransform() {
    if (!this.jacketSocket) return;
    this.jacketSocket.position.fromArray(this.jacketTransform.position);
    this.jacketSocket.rotation.set(
      THREE.MathUtils.degToRad(this.jacketTransform.rotation[0]),
      THREE.MathUtils.degToRad(this.jacketTransform.rotation[1]),
      THREE.MathUtils.degToRad(this.jacketTransform.rotation[2]),
    );
    this.jacketSocket.scale.fromArray(this.jacketTransform.scale);
    this.jacketSocket.updateMatrixWorld(true);
    this.clothMesh?.updateMatrixWorld?.(true);
  }
}

function createColliderMesh() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({
      color: COLLIDER_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      visible: false,
    }),
  );
}

function collectBones(root) {
  const bones = [];
  root.traverse((object) => {
    if (object.isBone) bones.push({ name: object.name, label: readableBoneName(object.name) });
  });
  return bones.sort((a, b) => a.label.localeCompare(b.label));
}

function findBone(root, requestedName) {
  const normalized = normalizeBoneName(requestedName);
  let found = null;
  root.traverse((object) => {
    if (!found && object.isBone && normalizeBoneName(object.name) === normalized) found = object;
  });
  return found;
}

function normalizeBoneName(name) {
  return String(name).replace(/^mixamorig:?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function readableBoneName(name) {
  return String(name).replace(/^mixamorig:?/i, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function readStoredProfile(modelId) {
  try {
    return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${modelId}`));
  } catch {
    return null;
  }
}

function vectorArray(value) {
  return [0, 1, 2].map((index) => clampNumber(value?.[index], -3, 3, 0));
}

function normalizeJacketTransform(value) {
  const source = value ?? DEFAULT_JACKET_TRANSFORM;
  return {
    position: [0, 1, 2].map((index) => clampNumber(source.position?.[index], -5, 5, 0)),
    rotation: [0, 1, 2].map((index) => clampNumber(source.rotation?.[index], -180, 180, 0)),
    scale: [0, 1, 2].map((index) => clampNumber(source.scale?.[index], 0.05, 5, 1)),
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? THREE.MathUtils.clamp(number, min, max) : fallback;
}

function round(value) {
  return Number(Number(value).toFixed(4));
}

function summarizeClothWeights(mesh) {
  const attribute = mesh?.geometry?.getAttribute?.('clothWeight');
  if (!attribute) return null;
  let simulated = 0;
  let blended = 0;
  let pinned = 0;
  let sum = 0;

  for (let index = 0; index < attribute.count; index += 1) {
    const weight = attribute.getY(index);
    sum += weight;
    if (weight <= 0.1) simulated += 1;
    else if (weight >= 0.9) pinned += 1;
    else blended += 1;
  }

  return {
    attribute: 'clothWeight',
    vertices: attribute.count,
    simulated,
    blended,
    pinned,
    averagePin: round(sum / Math.max(1, attribute.count)),
  };
}
