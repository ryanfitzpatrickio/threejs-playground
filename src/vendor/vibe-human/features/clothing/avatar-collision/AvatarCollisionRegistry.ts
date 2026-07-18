import * as THREE from 'three/webgpu'
import type {
  ColliderSnapshot,
  CollisionAvatar,
  CollisionAvatarProxy,
  CollisionRegion,
  MeshSurfaceColliderSnapshot,
} from '../simulation/types'
import { buildTriangleBVH, refitTriangleBVH, type TriangleBVH } from '../simulation/collision/triangleBVH'

type Listener = () => void
type RegionSamples = Record<CollisionRegion, THREE.Vector3[]>
type RegionCounts = Partial<Record<CollisionRegion, number>>

type CollisionAvatarBuildOptions = {
  bodyMeshes?: THREE.SkinnedMesh[]
  headMeshes?: THREE.SkinnedMesh[]
  includeLowResMesh?: boolean
  settings?: Partial<CollisionAvatar['settings']>
}

type SnapshotOptions = {
  globalInflate?: number
  normalOffset?: number
  perRegionInflate?: Partial<Record<CollisionRegion, number>>
  skinOffset?: number
  garmentThickness?: number
  includeLowResMesh?: boolean
  showCapsules?: boolean
  showEllipsoids?: boolean
}

type AvatarMeshColliderOptions = {
  id?: string
  skinOffset?: number
  garmentThickness?: number
  friction?: number
  cellSize?: number
  triangleStride?: number
  includeRegions?: Set<CollisionRegion>
  debugPerf?: boolean
}

export type AvatarMeshColliderTopology = {
  meshes: THREE.SkinnedMesh[]
  vertexSources: Uint32Array
  vertices: Float32Array
  indices: Uint32Array
  triangleNormals: Float32Array
  triangleCentroids: Float32Array
  triangleRadii: Float32Array
  triangleVisitMarks: Uint32Array
  cellSize: number
  optionsKey: string
  lastPoseHash: number
  lastSnapshot: MeshSurfaceColliderSnapshot | null
  bvh: TriangleBVH | null
}

export type AvatarMeshColliderRebuild = {
  snapshot: MeshSurfaceColliderSnapshot
  topology: AvatarMeshColliderTopology
}

const DEFAULT_SKIN = 0.012
const TORSO_FRICTION = 0.68
const LIMB_FRICTION = 0.56
const HEAD_FRICTION = 0.52
const BUILD_SAMPLE_STRIDE = 3
const MAX_HASH_CELLS_PER_TRIANGLE = 128
const MIN_COLLIDER_CELL_SIZE = 0.04

export const COLLISION_REGIONS: CollisionRegion[] = [
  'head',
  'neck',
  'chest',
  'abdomen',
  'pelvis',
  'shoulder.L',
  'shoulder.R',
  'upperArm.L',
  'upperArm.R',
  'forearm.L',
  'forearm.R',
  'hand.L',
  'hand.R',
  'hip.L',
  'hip.R',
  'thigh.L',
  'thigh.R',
  'calf.L',
  'calf.R',
  'foot.L',
  'foot.R',
]

const state = {
  version: 0,
  avatar: null as CollisionAvatar | null,
  snapshot: { version: 0, proxies: [] } as ColliderSnapshot,
  listeners: new Set<Listener>(),
}

const _samplePoint = new THREE.Vector3()
const _scratchA = new THREE.Vector3()
const _scratchB = new THREE.Vector3()
const _scratchQ = new THREE.Quaternion()
const _scratchScale = new THREE.Vector3()
const _scratchMatrix = new THREE.Matrix4()

export function getBodyProxySnapshot() {
  return state.snapshot
}

export function getCollisionAvatar() {
  return state.avatar
}

export function getCollisionAvatarStats() {
  return {
    hasAvatar: Boolean(state.avatar),
    proxyCount: state.avatar?.proxies.length ?? 0,
    meshPatchCount: state.avatar?.lowResMeshPatches?.length ?? 0,
    sourceVertexCount: state.avatar?.source.vertexCount ?? 0,
  }
}

export function setCollisionAvatar(avatar: CollisionAvatar | null) {
  state.avatar = avatar
  if (!avatar) {
    setBodyProxySnapshot({ proxies: [] })
    return
  }
  notify()
}

export function setBodyProxySnapshot(snapshot: Omit<ColliderSnapshot, 'version'>) {
  state.version += 1
  state.snapshot = {
    version: state.version,
    proxies: snapshot.proxies,
    meshColliders: snapshot.meshColliders,
    lowResMeshPatches: snapshot.lowResMeshPatches,
  }
  notify()
}

export function clearBodyProxySnapshot() {
  state.avatar = null
  setBodyProxySnapshot({ proxies: [] })
}

export function subscribeBodyProxy(fn: Listener) {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

export function buildCollisionAvatarFromSkinnedMeshes(
  bones: Record<string, THREE.Bone>,
  options: CollisionAvatarBuildOptions = {},
): CollisionAvatar {
  const bodyMeshes = options.bodyMeshes ?? []
  const headMeshes = options.headMeshes ?? []
  const meshes = [...bodyMeshes, ...headMeshes]
  const samples = emptyRegionSamples()
  const counts: RegionCounts = {}
  let vertexCount = 0

  for (const mesh of bodyMeshes) {
    vertexCount += collectRegionSamples(mesh, samples, counts, null)
  }
  for (const mesh of headMeshes) {
    vertexCount += collectRegionSamples(mesh, samples, counts, 'head')
  }

  const proxies: CollisionAvatarProxy[] = []
  addEllipsoidProxy(proxies, 'head', bones, samples.head, ['head', 'rt_head', 'spine006'], { min: [0.105, 0.16, 0.105], fallback: [0, 0.11, 0, 0.16, 0.205, 0.16], friction: HEAD_FRICTION })
  addEllipsoidProxy(proxies, 'neck', bones, samples.neck, ['neck', 'spine006', 'head'], { min: [0.08, 0.08, 0.07], fallback: [0, 0, 0, 0.095, 0.115, 0.08], friction: TORSO_FRICTION })
  addEllipsoidProxy(proxies, 'chest', bones, samples.chest, ['spine004', 'spine005', 'chest'], { min: [0.19, 0.16, 0.12], max: [0.34, 0.34, 0.23], fallback: [0, 0.03, 0, 0.24, 0.22, 0.16], friction: TORSO_FRICTION })
  addEllipsoidProxy(proxies, 'abdomen', bones, samples.abdomen, ['spine002', 'spine003', 'abdomen'], { min: [0.17, 0.15, 0.12], max: [0.31, 0.3, 0.21], fallback: [0, 0, 0, 0.21, 0.2, 0.15], friction: TORSO_FRICTION })
  addEllipsoidProxy(proxies, 'pelvis', bones, samples.pelvis, ['pelvis', 'hips', 'spine'], { min: [0.19, 0.13, 0.12], max: [0.34, 0.24, 0.22], fallback: [0, -0.02, 0, 0.26, 0.17, 0.17], friction: TORSO_FRICTION })

  addBridgeCapsule(proxies, 'shoulder.L', bones, samples['shoulder.L'], ['shoulderl', 'leftshoulder', 'claviclel'], ['upperarml', 'leftupperarm'], 0.075, TORSO_FRICTION)
  addBridgeCapsule(proxies, 'shoulder.R', bones, samples['shoulder.R'], ['shoulderr', 'rightshoulder', 'clavicler'], ['upperarmr', 'rightupperarm'], 0.075, TORSO_FRICTION)
  addBridgeCapsule(proxies, 'hip.L', bones, samples['hip.L'], ['pelvis', 'hips', 'spine'], ['thighl', 'leftupleg'], 0.105, TORSO_FRICTION)
  addBridgeCapsule(proxies, 'hip.R', bones, samples['hip.R'], ['pelvis', 'hips', 'spine'], ['thighr', 'rightupleg'], 0.105, TORSO_FRICTION)

  addBoneCapsule(proxies, 'upperArm.L', bones, samples['upperArm.L'], ['upperarml', 'leftupperarm'], ['forearml001', 'forearml', 'leftforearm'], 0.078, LIMB_FRICTION)
  addBoneCapsule(proxies, 'upperArm.R', bones, samples['upperArm.R'], ['upperarmr', 'rightupperarm'], ['forearmr001', 'forearmr', 'rightforearm'], 0.078, LIMB_FRICTION)
  addBoneCapsule(proxies, 'forearm.L', bones, samples['forearm.L'], ['forearml001', 'forearml', 'leftforearm'], ['handl', 'lefthand'], 0.055, LIMB_FRICTION)
  addBoneCapsule(proxies, 'forearm.R', bones, samples['forearm.R'], ['forearmr001', 'forearmr', 'rightforearm'], ['handr', 'righthand'], 0.055, LIMB_FRICTION)
  addEllipsoidProxy(proxies, 'hand.L', bones, samples['hand.L'], ['handl', 'lefthand'], { min: [0.045, 0.065, 0.028], fallback: [0, -0.025, 0, 0.07, 0.095, 0.035], friction: LIMB_FRICTION })
  addEllipsoidProxy(proxies, 'hand.R', bones, samples['hand.R'], ['handr', 'righthand'], { min: [0.045, 0.065, 0.028], fallback: [0, -0.025, 0, 0.07, 0.095, 0.035], friction: LIMB_FRICTION })

  addBoneCapsule(proxies, 'thigh.L', bones, samples['thigh.L'], ['thighl', 'leftupleg'], ['thighl001', 'shinl', 'calfl', 'leftleg'], 0.105, LIMB_FRICTION)
  addBoneCapsule(proxies, 'thigh.R', bones, samples['thigh.R'], ['thighr', 'rightupleg'], ['thighr001', 'shinr', 'calfr', 'rightleg'], 0.105, LIMB_FRICTION)
  addBoneCapsule(proxies, 'calf.L', bones, samples['calf.L'], ['thighl001', 'shinl', 'calfl', 'leftleg'], ['footl', 'leftfoot'], 0.078, LIMB_FRICTION)
  addBoneCapsule(proxies, 'calf.R', bones, samples['calf.R'], ['thighr001', 'shinr', 'calfr', 'rightleg'], ['footr', 'rightfoot'], 0.078, LIMB_FRICTION)
  addBoneCapsule(proxies, 'foot.L', bones, samples['foot.L'], ['footl', 'leftfoot'], ['toel', 'lefttoe'], 0.065, LIMB_FRICTION)
  addBoneCapsule(proxies, 'foot.R', bones, samples['foot.R'], ['footr', 'rightfoot'], ['toer', 'righttoe'], 0.065, LIMB_FRICTION)

  const settings = {
    globalInflate: options.settings?.globalInflate ?? 0.018,
    normalOffset: options.settings?.normalOffset ?? 0,
    perRegionInflate: options.settings?.perRegionInflate ?? {},
  }

  return {
    version: 1,
    createdAt: Date.now(),
    source: {
      meshCount: meshes.length,
      vertexCount,
      boneCount: Object.keys(bones).length,
    },
    settings,
    proxies,
  }
}

export function buildColliderSnapshotFromCollisionAvatar(
  avatar: CollisionAvatar | null,
  bones: Record<string, THREE.Bone>,
  options: SnapshotOptions = {},
): Omit<ColliderSnapshot, 'version'> {
  if (!avatar) return { proxies: [] }
  const globalInflate = options.globalInflate ?? avatar.settings.globalInflate
  const normalOffset = options.normalOffset ?? avatar.settings.normalOffset
  const perRegionInflate = options.perRegionInflate ?? avatar.settings.perRegionInflate
  const showCapsules = options.showCapsules ?? true
  const showEllipsoids = options.showEllipsoids ?? true
  const proxies: ColliderSnapshot['proxies'] = []

  for (const proxy of avatar.proxies) {
    const bone = getBoneByName(bones, proxy.anchorBone)
    if (!bone) continue
    const skin = proxy.skin + Math.max(0, globalInflate) + Math.max(0, perRegionInflate[proxy.region] ?? 0) + normalOffset
    if (proxy.kind === 'capsule') {
      if (!showCapsules) continue
      const a = localPointToWorld(bone, proxy.ax, proxy.ay, proxy.az, _scratchA)
      const b = localPointToWorld(bone, proxy.bx, proxy.by, proxy.bz, _scratchB)
      const scale = bone.getWorldScale(_scratchScale)
      proxies.push({
        kind: 'capsule',
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: b.x,
        by: b.y,
        bz: b.z,
        r: proxy.r * Math.max(scale.x, scale.y, scale.z),
        friction: proxy.friction,
        skin,
      })
      continue
    }
    if (!showEllipsoids) continue
    const center = localPointToWorld(bone, proxy.cx, proxy.cy, proxy.cz, _scratchA)
    const boneQ = bone.getWorldQuaternion(_scratchQ)
    const localQ = new THREE.Quaternion(proxy.qx, proxy.qy, proxy.qz, proxy.qw)
    const worldQ = boneQ.multiply(localQ)
    const scale = bone.getWorldScale(_scratchScale)
    proxies.push({
      kind: 'ellipsoid',
      cx: center.x,
      cy: center.y,
      cz: center.z,
      rx: proxy.rx * Math.abs(scale.x),
      ry: proxy.ry * Math.abs(scale.y),
      rz: proxy.rz * Math.abs(scale.z),
      qx: worldQ.x,
      qy: worldQ.y,
      qz: worldQ.z,
      qw: worldQ.w,
      friction: proxy.friction,
      skin,
    })
  }

  return {
    proxies,
  }
}

export function buildAvatarMeshColliderSnapshotFromSkinnedMeshes(
  meshes: THREE.SkinnedMesh[],
  options: AvatarMeshColliderOptions = {},
): MeshSurfaceColliderSnapshot | null {
  const triangleStride = Math.max(1, Math.floor(options.triangleStride ?? 1))
  const includeRegions = options.includeRegions
  const vertices: number[] = []
  const indices: number[] = []
  const vertexMap = new Map<string, number>()
  let triangleOrdinal = 0
  const extractionStart = options.debugPerf ? performance.now() : 0

  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex]
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!position) continue
    const index = mesh.geometry.index
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const ia = index ? index.getX(triangle * 3) : triangle * 3
      const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
      const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
      if (includeRegions && !triangleMatchesRegions(mesh, ia, ib, ic, includeRegions)) continue
      if (triangleOrdinal % triangleStride !== 0) {
        triangleOrdinal += 1
        continue
      }
      triangleOrdinal += 1
      const a = pushUniqueSkinnedWorldVertex(vertices, vertexMap, meshIndex, mesh, ia)
      const b = pushUniqueSkinnedWorldVertex(vertices, vertexMap, meshIndex, mesh, ib)
      const c = pushUniqueSkinnedWorldVertex(vertices, vertexMap, meshIndex, mesh, ic)
      indices.push(a, b, c)
    }
  }

  if (indices.length === 0) return null
  if (options.debugPerf) {
    console.debug(`[clothing] posed mesh extraction ${(performance.now() - extractionStart).toFixed(2)}ms`)
  }
  const vertexArray = new Float32Array(vertices)
  const indexArray = new Uint32Array(indices)
  const hashStart = options.debugPerf ? performance.now() : 0
  const hash = buildTriangleSpatialHash(vertexArray, indexArray, options.cellSize ?? 0.09)
  if (options.debugPerf) {
    console.debug(`[clothing] spatial hash build ${(performance.now() - hashStart).toFixed(2)}ms`)
  }
  return {
    kind: 'mesh',
    id: options.id ?? 'avatar.mesh',
    vertices: vertexArray,
    indices: indexArray,
    triangleNormals: hash.triangleNormals,
    cellSize: hash.cellSize,
    cellKeys: hash.cellKeys,
    cellStarts: hash.cellStarts,
    cellCounts: hash.cellCounts,
    cellTriangleIndices: hash.cellTriangleIndices,
    cellIndexLookup: hash.cellIndexLookup,
    triangleVisitMarks: hash.triangleVisitMarks,
    triangleVisitStamp: hash.triangleVisitStamp,
    bounds: hash.bounds,
    skin: options.skinOffset ?? 0.022,
    thickness: options.garmentThickness ?? 0.008,
    friction: options.friction ?? 0.74,
  }
}

export function rebuildAvatarMeshCollider(
  meshes: THREE.SkinnedMesh[],
  cached: AvatarMeshColliderTopology | null,
  options: AvatarMeshColliderOptions = {},
): AvatarMeshColliderRebuild | null {
  const cellSize = options.cellSize ?? 0.09
  const triangleStride = Math.max(1, Math.floor(options.triangleStride ?? 1))
  const optionsKey = `${triangleStride}|${meshes.length}|${meshes.map((m) => m.geometry.uuid).join(',')}|${options.includeRegions ? [...options.includeRegions].sort().join(',') : ''}`
  let topology = cached && cached.optionsKey === optionsKey && cached.meshes.length === meshes.length ? cached : null
  if (topology) {
    for (let i = 0; i < meshes.length; i += 1) {
      if (topology.meshes[i] !== meshes[i]) { topology = null; break }
    }
  }
  if (!topology) {
    topology = extractMeshColliderTopology(meshes, triangleStride, options.includeRegions, optionsKey)
    if (!topology) return null
  }

  const poseHash = computePoseHash(meshes)
  if (topology.lastSnapshot && topology.lastPoseHash === poseHash) {
    const reused = topology.lastSnapshot
    reused.skin = options.skinOffset ?? reused.skin
    reused.thickness = options.garmentThickness ?? reused.thickness
    reused.friction = options.friction ?? reused.friction
    return { snapshot: reused, topology }
  }

  reskinTopologyVertices(topology)
  const hash = buildSpatialHashFast(
    topology.vertices,
    topology.indices,
    cellSize,
    topology.triangleNormals,
    topology.triangleCentroids,
    topology.triangleRadii,
    topology.triangleVisitMarks,
  )

  // BVH broad-phase: build once for a topology, then refit (O(nodes)) each frame
  // from the freshly re-skinned vertices. The grid is still built above as a
  // fallback for any consumer that hasn't migrated to the BVH path.
  if (!topology.bvh) {
    topology.bvh = buildTriangleBVH(topology.vertices, topology.indices)
  } else {
    refitTriangleBVH(topology.bvh, topology.vertices)
  }

  const snapshot: MeshSurfaceColliderSnapshot = {
    kind: 'mesh',
    id: options.id ?? 'avatar.mesh',
    vertices: topology.vertices,
    indices: topology.indices,
    triangleNormals: hash.triangleNormals,
    triangleCentroids: topology.triangleCentroids,
    triangleRadii: topology.triangleRadii,
    cellSize: hash.cellSize,
    cellKeys: hash.cellKeys,
    cellStarts: hash.cellStarts,
    cellCounts: hash.cellCounts,
    cellTriangleIndices: hash.cellTriangleIndices,
    cellIndexLookup: hash.cellIndexLookup,
    triangleVisitMarks: hash.triangleVisitMarks,
    triangleVisitStamp: 0,
    bounds: hash.bounds,
    skin: options.skinOffset ?? 0.022,
    thickness: options.garmentThickness ?? 0.008,
    friction: options.friction ?? 0.74,
    bvh: topology.bvh,
  }
  topology.cellSize = hash.cellSize
  topology.lastPoseHash = poseHash
  topology.lastSnapshot = snapshot
  return { snapshot, topology }
}

function computePoseHash(meshes: THREE.SkinnedMesh[]) {
  let hash = 0x811c9dc5
  for (let i = 0; i < meshes.length; i += 1) {
    const skeleton = meshes[i].skeleton
    if (!skeleton) continue
    const morphInfluences = meshes[i].morphTargetInfluences
    if (morphInfluences?.length) {
      for (let m = 0; m < morphInfluences.length; m += 1) {
        hash = mix32(hash, floatBits(morphInfluences[m] ?? 0))
      }
    }
    const bones = skeleton.bones
    for (let b = 0; b < bones.length; b += 1) {
      const m = bones[b].matrixWorld.elements
      hash = mix32(hash, floatBits(m[12]))
      hash = mix32(hash, floatBits(m[13]))
      hash = mix32(hash, floatBits(m[14]))
      hash = mix32(hash, floatBits(m[0]))
      hash = mix32(hash, floatBits(m[5]))
      hash = mix32(hash, floatBits(m[10]))
    }
  }
  return hash | 0
}

const _floatBits = new Float32Array(1)
const _intBits = new Int32Array(_floatBits.buffer)
function floatBits(value: number) {
  _floatBits[0] = value
  return _intBits[0]
}

function mix32(hash: number, value: number) {
  hash ^= value
  hash = Math.imul(hash, 0x01000193)
  return hash | 0
}

function extractMeshColliderTopology(
  meshes: THREE.SkinnedMesh[],
  triangleStride: number,
  includeRegions: Set<CollisionRegion> | undefined,
  optionsKey: string,
): AvatarMeshColliderTopology | null {
  const sources: number[] = []
  const indices: number[] = []
  const vertexMap = new Map<number, number>()
  let triangleOrdinal = 0
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex]
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!position) continue
    const index = mesh.geometry.index
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const ia = index ? index.getX(triangle * 3) : triangle * 3
      const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
      const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
      if (includeRegions && !triangleMatchesRegions(mesh, ia, ib, ic, includeRegions)) continue
      if (triangleOrdinal % triangleStride !== 0) { triangleOrdinal += 1; continue }
      triangleOrdinal += 1
      indices.push(
        getOrAddSource(vertexMap, sources, meshIndex, ia),
        getOrAddSource(vertexMap, sources, meshIndex, ib),
        getOrAddSource(vertexMap, sources, meshIndex, ic),
      )
    }
  }
  if (indices.length === 0) return null
  const vertexCount = sources.length / 2
  const triangleCount = indices.length / 3
  return {
    meshes: meshes.slice(),
    vertexSources: new Uint32Array(sources),
    vertices: new Float32Array(vertexCount * 3),
    indices: new Uint32Array(indices),
    triangleNormals: new Float32Array(triangleCount * 3),
    triangleCentroids: new Float32Array(triangleCount * 3),
    triangleRadii: new Float32Array(triangleCount),
    triangleVisitMarks: new Uint32Array(triangleCount),
    cellSize: 0,
    optionsKey,
    lastPoseHash: 0,
    lastSnapshot: null,
    bvh: null,
  }
}

function getOrAddSource(map: Map<number, number>, sources: number[], meshIndex: number, vertexIndex: number) {
  const key = (meshIndex << 24) | (vertexIndex & 0xffffff)
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const nextIndex = sources.length / 2
  sources.push(meshIndex, vertexIndex)
  map.set(key, nextIndex)
  return nextIndex
}

function reskinTopologyVertices(topology: AvatarMeshColliderTopology) {
  const { meshes, vertexSources, vertices } = topology
  const vertexCount = vertexSources.length / 2
  const positionAttrs: Array<THREE.BufferAttribute | null> = meshes.map(
    (mesh) => (mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined) ?? null,
  )
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const meshIndex = vertexSources[vertex * 2]
    const vertexIndex = vertexSources[vertex * 2 + 1]
    const mesh = meshes[meshIndex]
    const position = positionAttrs[meshIndex]
    if (!mesh || !position) continue
    copyMorphedLocalVertex(mesh, position, vertexIndex, _samplePoint)
    mesh.applyBoneTransform(vertexIndex, _samplePoint)
    _samplePoint.applyMatrix4(mesh.matrixWorld)
    const offset = vertex * 3
    vertices[offset] = _samplePoint.x
    vertices[offset + 1] = _samplePoint.y
    vertices[offset + 2] = _samplePoint.z
  }
}

function buildSpatialHashFast(
  vertices: Float32Array,
  indices: Uint32Array,
  cellSize: number,
  triangleNormals: Float32Array,
  triangleCentroids: Float32Array,
  triangleRadii: Float32Array,
  triangleVisitMarks: Uint32Array,
) {
  const safeCellSize = Math.max(MIN_COLLIDER_CELL_SIZE, cellSize)
  const triangleCount = indices.length / 3
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  const triCellMinX = new Int32Array(triangleCount)
  const triCellMinY = new Int32Array(triangleCount)
  const triCellMinZ = new Int32Array(triangleCount)
  const triCellMaxX = new Int32Array(triangleCount)
  const triCellMaxY = new Int32Array(triangleCount)
  const triCellMaxZ = new Int32Array(triangleCount)
  const triSkip = new Uint8Array(triangleCount)
  let totalRefs = 0

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = indices[triangle * 3] * 3
    const ib = indices[triangle * 3 + 1] * 3
    const ic = indices[triangle * 3 + 2] * 3
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2]
    const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2]
    const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2]
    if (ax < minX) minX = ax
    if (bx < minX) minX = bx
    if (cx < minX) minX = cx
    if (ay < minY) minY = ay
    if (by < minY) minY = by
    if (cy < minY) minY = cy
    if (az < minZ) minZ = az
    if (bz < minZ) minZ = bz
    if (cz < minZ) minZ = cz
    if (ax > maxX) maxX = ax
    if (bx > maxX) maxX = bx
    if (cx > maxX) maxX = cx
    if (ay > maxY) maxY = ay
    if (by > maxY) maxY = by
    if (cy > maxY) maxY = cy
    if (az > maxZ) maxZ = az
    if (bz > maxZ) maxZ = bz
    if (cz > maxZ) maxZ = cz

    const abx = bx - ax, aby = by - ay, abz = bz - az
    const acx = cx - ax, acy = cy - ay, acz = cz - az
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz)
    const normalOffset = triangle * 3
    if (normalLength > 1e-9) {
      const inv = 1 / normalLength
      triangleNormals[normalOffset] = nx * inv
      triangleNormals[normalOffset + 1] = ny * inv
      triangleNormals[normalOffset + 2] = nz * inv
    } else {
      triangleNormals[normalOffset] = 0
      triangleNormals[normalOffset + 1] = 0
      triangleNormals[normalOffset + 2] = 0
    }

    const centroidX = (ax + bx + cx) / 3
    const centroidY = (ay + by + cy) / 3
    const centroidZ = (az + bz + cz) / 3
    triangleCentroids[normalOffset] = centroidX
    triangleCentroids[normalOffset + 1] = centroidY
    triangleCentroids[normalOffset + 2] = centroidZ
    const dax = ax - centroidX, day = ay - centroidY, daz = az - centroidZ
    const dbx = bx - centroidX, dby = by - centroidY, dbz = bz - centroidZ
    const dcx = cx - centroidX, dcy = cy - centroidY, dcz = cz - centroidZ
    const rA = dax * dax + day * day + daz * daz
    const rB = dbx * dbx + dby * dby + dbz * dbz
    const rC = dcx * dcx + dcy * dcy + dcz * dcz
    const maxRSq = rA > rB ? (rA > rC ? rA : rC) : (rB > rC ? rB : rC)
    triangleRadii[triangle] = Math.sqrt(maxRSq)

    const triMinX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx)
    const triMinY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy)
    const triMinZ = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz)
    const triMaxX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx)
    const triMaxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy)
    const triMaxZ = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz)
    const cMinX = Math.floor(triMinX / safeCellSize)
    const cMinY = Math.floor(triMinY / safeCellSize)
    const cMinZ = Math.floor(triMinZ / safeCellSize)
    const cMaxX = Math.floor(triMaxX / safeCellSize)
    const cMaxY = Math.floor(triMaxY / safeCellSize)
    const cMaxZ = Math.floor(triMaxZ / safeCellSize)
    const span = (cMaxX - cMinX + 1) * (cMaxY - cMinY + 1) * (cMaxZ - cMinZ + 1)
    if (!Number.isFinite(span) || span > MAX_HASH_CELLS_PER_TRIANGLE) {
      triSkip[triangle] = 1
      continue
    }
    triCellMinX[triangle] = cMinX
    triCellMinY[triangle] = cMinY
    triCellMinZ[triangle] = cMinZ
    triCellMaxX[triangle] = cMaxX
    triCellMaxY[triangle] = cMaxY
    triCellMaxZ[triangle] = cMaxZ
    totalRefs += span
  }

  const cellEntries = new Int32Array(totalRefs)
  const cellTriangles = new Uint32Array(totalRefs)
  let cursor = 0
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (triSkip[triangle]) continue
    const cMinX = triCellMinX[triangle], cMaxX = triCellMaxX[triangle]
    const cMinY = triCellMinY[triangle], cMaxY = triCellMaxY[triangle]
    const cMinZ = triCellMinZ[triangle], cMaxZ = triCellMaxZ[triangle]
    for (let cx = cMinX; cx <= cMaxX; cx += 1) {
      for (let cy = cMinY; cy <= cMaxY; cy += 1) {
        for (let cz = cMinZ; cz <= cMaxZ; cz += 1) {
          cellEntries[cursor] = hashCell(cx, cy, cz)
          cellTriangles[cursor] = triangle
          cursor += 1
        }
      }
    }
  }

  const order = new Uint32Array(cursor)
  for (let i = 0; i < cursor; i += 1) order[i] = i
  const sorted = Array.from(order).sort((a, b) => cellEntries[a] - cellEntries[b])

  let uniqueCells = 0
  for (let i = 0; i < cursor; i += 1) {
    if (i === 0 || cellEntries[sorted[i]] !== cellEntries[sorted[i - 1]]) uniqueCells += 1
  }

  const cellKeys = new Int32Array(uniqueCells)
  const cellStarts = new Uint32Array(uniqueCells)
  const cellCounts = new Uint32Array(uniqueCells)
  const cellTriangleIndices = new Uint32Array(cursor)
  const cellIndexLookup = new Map<number, number>()

  let writeIdx = -1
  let lastKey = 0
  for (let i = 0; i < cursor; i += 1) {
    const sortedIndex = sorted[i]
    const key = cellEntries[sortedIndex]
    if (writeIdx === -1 || key !== lastKey) {
      writeIdx += 1
      cellKeys[writeIdx] = key
      cellStarts[writeIdx] = i
      cellIndexLookup.set(key, writeIdx)
      lastKey = key
    }
    cellTriangleIndices[i] = cellTriangles[sortedIndex]
    cellCounts[writeIdx] += 1
  }

  if (!Number.isFinite(minX)) { minX = minY = minZ = maxX = maxY = maxZ = 0 }

  triangleVisitMarks.fill(0)

  const { cellHashKeys, cellHashValues, cellHashMask } = buildOpenAddressedCellHash(cellKeys)

  return {
    cellSize: safeCellSize,
    triangleNormals,
    cellKeys,
    cellStarts,
    cellCounts,
    cellTriangleIndices,
    cellIndexLookup,
    cellHashKeys,
    cellHashValues,
    cellHashMask,
    triangleVisitMarks,
    triangleVisitStamp: 0,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
  }
}

function buildOpenAddressedCellHash(cellKeys: Int32Array) {
  const n = cellKeys.length
  if (n === 0) {
    return { cellHashKeys: new Int32Array(1), cellHashValues: new Int32Array(1).fill(-1), cellHashMask: 0 }
  }
  let capacity = 1
  while (capacity < n * 2) capacity *= 2
  const mask = capacity - 1
  const keys = new Int32Array(capacity)
  const values = new Int32Array(capacity).fill(-1)
  for (let i = 0; i < n; i += 1) {
    const key = cellKeys[i]
    let slot = scrambleKey(key) & mask
    while (values[slot] !== -1) slot = (slot + 1) & mask
    keys[slot] = key
    values[slot] = i
  }
  return { cellHashKeys: keys, cellHashValues: values, cellHashMask: mask }
}

function scrambleKey(key: number) {
  let x = key | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x
}

export function buildBodyProxySnapshotFromBones(
  bones: Record<string, THREE.Bone>,
  options: CollisionAvatarBuildOptions = {},
): Omit<ColliderSnapshot, 'version'> {
  const avatar = buildCollisionAvatarFromSkinnedMeshes(bones, options)
  return buildColliderSnapshotFromCollisionAvatar(avatar, bones)
}

function notify() {
  state.listeners.forEach((listener) => listener())
}

function emptyRegionSamples(): RegionSamples {
  return Object.fromEntries(COLLISION_REGIONS.map((region) => [region, []])) as unknown as RegionSamples
}

function collectRegionSamples(
  mesh: THREE.SkinnedMesh,
  out: RegionSamples,
  counts: RegionCounts,
  fallbackRegion: CollisionRegion | null,
) {
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position) return 0
  for (let index = 0; index < position.count; index += 1) {
    const region = classifySkinnedVertex(mesh, index) ?? fallbackRegion
    if (!region) continue
    counts[region] = (counts[region] ?? 0) + 1
    if (index % BUILD_SAMPLE_STRIDE !== 0) continue
    copySkinnedWorldVertex(mesh, position, index, _samplePoint)
    _samplePoint.applyMatrix4(mesh.matrixWorld)
    out[region].push(_samplePoint.clone())
  }
  return position.count
}

function pushUniqueSkinnedWorldVertex(
  vertices: number[],
  vertexMap: Map<string, number>,
  meshIndex: number,
  mesh: THREE.SkinnedMesh,
  vertexIndex: number,
) {
  const key = `${meshIndex}:${vertexIndex}`
  const existing = vertexMap.get(key)
  if (existing !== undefined) return existing
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position) return 0
  const nextIndex = vertices.length / 3
  copySkinnedWorldVertex(mesh, position, vertexIndex, _samplePoint)
  _samplePoint.applyMatrix4(mesh.matrixWorld)
  vertices.push(_samplePoint.x, _samplePoint.y, _samplePoint.z)
  vertexMap.set(key, nextIndex)
  return nextIndex
}

function copySkinnedWorldVertex(
  mesh: THREE.SkinnedMesh,
  position: THREE.BufferAttribute,
  vertexIndex: number,
  target: THREE.Vector3,
) {
  copyMorphedLocalVertex(mesh, position, vertexIndex, target)
  mesh.applyBoneTransform(vertexIndex, target)
  return target
}

function copyMorphedLocalVertex(
  mesh: THREE.SkinnedMesh,
  position: THREE.BufferAttribute,
  vertexIndex: number,
  target: THREE.Vector3,
) {
  target.fromBufferAttribute(position, vertexIndex)
  const morphPositions = mesh.geometry.morphAttributes.position ?? []
  const influences = mesh.morphTargetInfluences ?? []
  if (!morphPositions.length || !influences.length) return target

  _scratchA.copy(target)
  for (let i = 0; i < morphPositions.length; i += 1) {
    const influence = influences[i] ?? 0
    if (Math.abs(influence) <= 1e-6) continue
    _scratchB.fromBufferAttribute(morphPositions[i] as THREE.BufferAttribute, vertexIndex)
    if (mesh.geometry.morphTargetsRelative) target.addScaledVector(_scratchB, influence)
    else target.addScaledVector(_scratchB.sub(_scratchA), influence)
  }
  return target
}

function triangleMatchesRegions(
  mesh: THREE.SkinnedMesh,
  a: number,
  b: number,
  c: number,
  includeRegions: Set<CollisionRegion>,
) {
  const ra = classifySkinnedVertex(mesh, a)
  const rb = classifySkinnedVertex(mesh, b)
  const rc = classifySkinnedVertex(mesh, c)
  return Boolean((ra && includeRegions.has(ra)) || (rb && includeRegions.has(rb)) || (rc && includeRegions.has(rc)))
}

function classifySkinnedVertex(mesh: THREE.SkinnedMesh, vertexIndex: number): CollisionRegion | null {
  const skinIndex = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined
  const skinWeight = mesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined
  if (!skinIndex || !skinWeight) return null
  const scores = new Map<CollisionRegion, number>()
  const itemSize = Math.min(skinIndex.itemSize, skinWeight.itemSize, 4)
  for (let item = 0; item < itemSize; item += 1) {
    const boneIndex = getAttrComponent(skinIndex, vertexIndex, item)
    const weight = getAttrComponent(skinWeight, vertexIndex, item)
    if (weight <= 1e-5) continue
    const bone = mesh.skeleton.bones[boneIndex]
    if (!bone) continue
    const region = classifyBoneRegion(bone.name)
    if (!region) continue
    scores.set(region, (scores.get(region) ?? 0) + weight)
  }
  let best: CollisionRegion | null = null
  let bestWeight = 0
  scores.forEach((weight, region) => {
    if (weight > bestWeight) {
      best = region
      bestWeight = weight
    }
  })
  return best
}

function addBoneCapsule(
  proxies: CollisionAvatarProxy[],
  region: CollisionRegion,
  bones: Record<string, THREE.Bone>,
  samples: THREE.Vector3[],
  anchorAliases: string[],
  endAliases: string[],
  fallbackRadius: number,
  friction: number,
) {
  const anchor = getBone(bones, anchorAliases)
  const end = getBone(bones, endAliases)
  if (!anchor || !end) return
  addCapsuleFromWorldSegment(proxies, region, anchor, end, samples, fallbackRadius, friction)
}

function addBridgeCapsule(
  proxies: CollisionAvatarProxy[],
  region: CollisionRegion,
  bones: Record<string, THREE.Bone>,
  samples: THREE.Vector3[],
  anchorAliases: string[],
  endAliases: string[],
  fallbackRadius: number,
  friction: number,
) {
  addBoneCapsule(proxies, region, bones, samples, anchorAliases, endAliases, fallbackRadius, friction)
}

function addCapsuleFromWorldSegment(
  proxies: CollisionAvatarProxy[],
  region: CollisionRegion,
  anchor: THREE.Bone,
  end: THREE.Bone,
  samples: THREE.Vector3[],
  fallbackRadius: number,
  friction: number,
) {
  const startWorld = anchor.getWorldPosition(_scratchA).clone()
  const endWorld = end.getWorldPosition(_scratchB).clone()
  if (startWorld.distanceToSquared(endWorld) < 1e-8) return
  const radius = fitCapsuleRadius(samples, startWorld, endWorld, fallbackRadius)
  const startLocal = anchor.worldToLocal(startWorld.clone())
  const endLocal = anchor.worldToLocal(endWorld.clone())
  proxies.push({
    kind: 'capsule',
    id: `${region}.capsule`,
    region,
    anchorBone: anchor.name,
    ax: startLocal.x,
    ay: startLocal.y,
    az: startLocal.z,
    bx: endLocal.x,
    by: endLocal.y,
    bz: endLocal.z,
    r: radius,
    friction,
    skin: DEFAULT_SKIN,
  })
}

function fitCapsuleRadius(samples: THREE.Vector3[], start: THREE.Vector3, end: THREE.Vector3, fallbackRadius: number) {
  if (samples.length < 8) return fallbackRadius
  const axisX = end.x - start.x
  const axisY = end.y - start.y
  const axisZ = end.z - start.z
  const lengthSq = axisX * axisX + axisY * axisY + axisZ * axisZ
  if (lengthSq < 1e-8) return fallbackRadius
  const distances = new Array<number>(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index]
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * axisX + (point.y - start.y) * axisY + (point.z - start.z) * axisZ) / lengthSq))
    const closestX = start.x + axisX * t
    const closestY = start.y + axisY * t
    const closestZ = start.z + axisZ * t
    distances[index] = Math.hypot(point.x - closestX, point.y - closestY, point.z - closestZ)
  }
  return Math.max(fallbackRadius * 0.75, Math.min(fallbackRadius * 1.5, quantile(distances, 0.84) + 0.012))
}

function addEllipsoidProxy(
  proxies: CollisionAvatarProxy[],
  region: CollisionRegion,
  bones: Record<string, THREE.Bone>,
  samples: THREE.Vector3[],
  aliases: string[],
  options: {
    min: [number, number, number]
    max?: [number, number, number]
    fallback: [number, number, number, number, number, number]
    friction: number
  },
) {
  const anchor = getBone(bones, aliases)
  if (!anchor) return
  const inv = _scratchMatrix.copy(anchor.matrixWorld).invert()
  const localPoints = samples.map((point) => point.clone().applyMatrix4(inv))
  const fitted = fitEllipsoid(localPoints, options.min, options.max)
  const [fcx, fcy, fcz, frx, fry, frz] = options.fallback
  proxies.push({
    kind: 'ellipsoid',
    id: `${region}.ellipsoid`,
    region,
    anchorBone: anchor.name,
    cx: fitted?.cx ?? fcx,
    cy: fitted?.cy ?? fcy,
    cz: fitted?.cz ?? fcz,
    rx: fitted?.rx ?? frx,
    ry: fitted?.ry ?? fry,
    rz: fitted?.rz ?? frz,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    friction: options.friction,
    skin: DEFAULT_SKIN,
  })
}

function fitEllipsoid(points: THREE.Vector3[], min: [number, number, number], max?: [number, number, number]) {
  if (points.length < 12) return null
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const zs = points.map((point) => point.z)
  const minX = quantile(xs, 0.08)
  const maxX = quantile(xs, 0.92)
  const minY = quantile(ys, 0.06)
  const maxY = quantile(ys, 0.94)
  const minZ = quantile(zs, 0.08)
  const maxZ = quantile(zs, 0.92)
  return {
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    cz: (minZ + maxZ) * 0.5,
    rx: clampRadius((maxX - minX) * 0.5 + 0.012, min[0], max?.[0]),
    ry: clampRadius((maxY - minY) * 0.5 + 0.012, min[1], max?.[1]),
    rz: clampRadius((maxZ - minZ) * 0.5 + 0.012, min[2], max?.[2]),
  }
}

function localPointToWorld(bone: THREE.Bone, x: number, y: number, z: number, target: THREE.Vector3) {
  return target.set(x, y, z).applyMatrix4(bone.matrixWorld)
}

function getAttrComponent(attribute: THREE.BufferAttribute, index: number, component: number) {
  switch (component) {
    case 0:
      return attribute.getX(index)
    case 1:
      return attribute.getY(index)
    case 2:
      return attribute.getZ(index)
    default:
      return attribute.getW(index)
  }
}

function classifyBoneRegion(name: string): CollisionRegion | null {
  const normalized = normalizeBoneName(name)
  const side = boneSide(normalized)

  if (matchesAny(normalized, ['head', 'brow', 'forehead', 'temple', 'ear', 'cheek', 'jaw', 'chin', 'nose', 'lip', 'teeth', 'eye'])) return 'head'
  if (matchesAny(normalized, ['neck']) || normalized.includes('spine006')) return 'neck'
  if (matchesAny(normalized, ['shoulder', 'clavicle']) && side) return `shoulder.${side}`
  if (matchesAny(normalized, ['upperarm', 'uparm']) && side) return `upperArm.${side}`
  if (matchesAny(normalized, ['forearm', 'lowerarm']) && side) return `forearm.${side}`
  if (matchesAny(normalized, ['hand', 'thumb', 'finger', 'findex', 'fmiddle', 'fring', 'fpinky']) && side) return `hand.${side}`
  if (matchesAny(normalized, ['thigh', 'upleg']) && side) return `thigh.${side}`
  if (matchesAny(normalized, ['shin', 'calf', 'leg']) && side) return `calf.${side}`
  if (matchesAny(normalized, ['foot', 'toe']) && side) return `foot.${side}`
  if (matchesAny(normalized, ['hip']) && side) return `hip.${side}`
  if (matchesAny(normalized, ['breast', 'chest']) || normalized.includes('spine004') || normalized.includes('spine005')) return 'chest'
  if (matchesAny(normalized, ['abdomen', 'belly']) || normalized.includes('spine002') || normalized.includes('spine003')) return 'abdomen'
  if (matchesAny(normalized, ['pelvis', 'hips']) || normalized === 'spine' || normalized.includes('spine001')) return 'pelvis'
  return null
}

function boneSide(normalized: string): 'L' | 'R' | null {
  if (normalized.includes('left') || /l\d*$/.test(normalized)) return 'L'
  if (normalized.includes('right') || /r\d*$/.test(normalized)) return 'R'
  return null
}

function getBone(bones: Record<string, THREE.Bone>, aliases: string[]) {
  const wanted = aliases.map(normalizeBoneName)
  return Object.values(bones).find((bone) => wanted.includes(normalizeBoneName(bone.name))) ?? null
}

function getBoneByName(bones: Record<string, THREE.Bone>, name: string) {
  const normalized = normalizeBoneName(name)
  return bones[name] ?? Object.values(bones).find((bone) => normalizeBoneName(bone.name) === normalized) ?? null
}

function normalizeBoneName(name: string) {
  return name.replace(/^DEF-/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function matchesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle))
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

function clampRadius(value: number, min: number, max?: number) {
  return Math.min(max ?? Infinity, Math.max(min, value))
}

function buildTriangleSpatialHash(vertices: Float32Array, indices: Uint32Array, cellSize: number) {
  const safeCellSize = Math.max(MIN_COLLIDER_CELL_SIZE, cellSize)
  const cells = new Map<number, number[]>()
  const triangleCount = indices.length / 3
  const triangleNormals = new Float32Array(triangleCount * 3)
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = indices[triangle * 3] * 3
    const ib = indices[triangle * 3 + 1] * 3
    const ic = indices[triangle * 3 + 2] * 3
    const ax = vertices[ia]
    const ay = vertices[ia + 1]
    const az = vertices[ia + 2]
    const bx = vertices[ib]
    const by = vertices[ib + 1]
    const bz = vertices[ib + 2]
    const cx = vertices[ic]
    const cy = vertices[ic + 1]
    const cz = vertices[ic + 2]
    minX = Math.min(minX, ax, bx, cx)
    minY = Math.min(minY, ay, by, cy)
    minZ = Math.min(minZ, az, bz, cz)
    maxX = Math.max(maxX, ax, bx, cx)
    maxY = Math.max(maxY, ay, by, cy)
    maxZ = Math.max(maxZ, az, bz, cz)

    const abx = bx - ax
    const aby = by - ay
    const abz = bz - az
    const acx = cx - ax
    const acy = cy - ay
    const acz = cz - az
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const normalLength = Math.hypot(nx, ny, nz)
    const normalOffset = triangle * 3
    if (normalLength > 1e-9) {
      const invNormalLength = 1 / normalLength
      triangleNormals[normalOffset] = nx * invNormalLength
      triangleNormals[normalOffset + 1] = ny * invNormalLength
      triangleNormals[normalOffset + 2] = nz * invNormalLength
    }

    const triMinX = Math.min(ax, bx, cx)
    const triMinY = Math.min(ay, by, cy)
    const triMinZ = Math.min(az, bz, cz)
    const triMaxX = Math.max(ax, bx, cx)
    const triMaxY = Math.max(ay, by, cy)
    const triMaxZ = Math.max(az, bz, cz)
    const minCx = Math.floor(triMinX / safeCellSize)
    const minCy = Math.floor(triMinY / safeCellSize)
    const minCz = Math.floor(triMinZ / safeCellSize)
    const maxCx = Math.floor(triMaxX / safeCellSize)
    const maxCy = Math.floor(triMaxY / safeCellSize)
    const maxCz = Math.floor(triMaxZ / safeCellSize)
    const cellSpan =
      (maxCx - minCx + 1) *
      (maxCy - minCy + 1) *
      (maxCz - minCz + 1)
    if (!Number.isFinite(cellSpan) || cellSpan > MAX_HASH_CELLS_PER_TRIANGLE) continue
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        for (let cz = minCz; cz <= maxCz; cz += 1) {
          const key = hashCell(cx, cy, cz)
          const bucket = cells.get(key)
          if (bucket) bucket.push(triangle)
          else cells.set(key, [triangle])
        }
      }
    }
  }

  const sorted = [...cells.entries()].sort((a, b) => a[0] - b[0])
  const cellKeys = new Int32Array(sorted.length)
  const cellStarts = new Uint32Array(sorted.length)
  const cellCounts = new Uint32Array(sorted.length)
  const cellIndexLookup = new Map<number, number>()
  const triangleRefs: number[] = []
  sorted.forEach(([key, triangles], index) => {
    cellKeys[index] = key
    cellStarts[index] = triangleRefs.length
    cellCounts[index] = triangles.length
    cellIndexLookup.set(key, index)
    triangleRefs.push(...triangles)
  })

  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    minZ = 0
    maxX = 0
    maxY = 0
    maxZ = 0
  }

  return {
    cellSize: safeCellSize,
    triangleNormals,
    cellKeys,
    cellStarts,
    cellCounts,
    cellTriangleIndices: new Uint32Array(triangleRefs),
    cellIndexLookup,
    triangleVisitMarks: new Uint32Array(triangleCount),
    triangleVisitStamp: 0,
    bounds: {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    },
  }
}

function hashCell(x: number, y: number, z: number) {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
}
