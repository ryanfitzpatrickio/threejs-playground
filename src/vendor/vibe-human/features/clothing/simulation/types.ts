import type { PatternDocument, PatternPlacement } from '../document/types'
import type { TriangleBVH } from './collision/triangleBVH'

export type ClothConstraintKind = 'stretch' | 'shear' | 'bend' | 'seam' | 'pin'

export type DistanceConstraint = {
  a: number
  b: number
  rest: number
  targetRest?: number
  compliance: number
  kind: Extract<ClothConstraintKind, 'stretch' | 'shear' | 'seam'>
}

export type BendConstraint = {
  a: number
  b: number
  c: number
  rest: number
  compliance: number
  kind: 'bend'
}

export type PinConstraint = {
  particle: number
  x: number
  y: number
  z: number
  stiffness: number
  kind: 'pin'
}

export type ClothSimMesh = {
  particleCount: number
  positions: Float32Array
  prevPositions: Float32Array
  velocities: Float32Array
  invMass: Float32Array
  panelIds: string[]
  particleFrictions: Float32Array
  panelUvs: Float32Array
  panelLocalPositions: Float32Array
  triangles: Uint32Array
  stretchConstraints: DistanceConstraint[]
  shearConstraints: DistanceConstraint[]
  bendDistanceConstraints: DistanceConstraint[]
  bendConstraints: BendConstraint[]
  seamConstraints: DistanceConstraint[]
  pinConstraints: PinConstraint[]
}

export type SphereProxy = {
  kind: 'sphere'
  cx: number
  cy: number
  cz: number
  r: number
  friction: number
  skin: number
}

export type CapsuleProxy = {
  kind: 'capsule'
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  r: number
  friction: number
  skin: number
}

export type EllipsoidProxy = {
  kind: 'ellipsoid'
  cx: number
  cy: number
  cz: number
  rx: number
  ry: number
  rz: number
  qx: number
  qy: number
  qz: number
  qw: number
  friction: number
  skin: number
}

export type ColliderProxy = SphereProxy | CapsuleProxy | EllipsoidProxy

export type CollisionRegion =
  | 'head'
  | 'neck'
  | 'chest'
  | 'abdomen'
  | 'pelvis'
  | 'upperArm.L'
  | 'upperArm.R'
  | 'forearm.L'
  | 'forearm.R'
  | 'hand.L'
  | 'hand.R'
  | 'thigh.L'
  | 'thigh.R'
  | 'calf.L'
  | 'calf.R'
  | 'foot.L'
  | 'foot.R'
  | 'shoulder.L'
  | 'shoulder.R'
  | 'hip.L'
  | 'hip.R'

export type CollisionProxyBase = {
  id: string
  region: CollisionRegion
  anchorBone: string
  friction: number
  skin: number
}

export type CollisionCapsuleProxy = CollisionProxyBase & {
  kind: 'capsule'
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  r: number
}

export type CollisionEllipsoidProxy = CollisionProxyBase & {
  kind: 'ellipsoid'
  cx: number
  cy: number
  cz: number
  rx: number
  ry: number
  rz: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export type CollisionAvatarProxy = CollisionCapsuleProxy | CollisionEllipsoidProxy

export type CollisionMeshPatch = {
  id: string
  region: CollisionRegion
  anchorBone: string
  vertices: number[]
  indices: number[]
}

export type CollisionAvatar = {
  version: 1
  createdAt: number
  source: {
    meshCount: number
    vertexCount: number
    boneCount: number
  }
  settings: {
    globalInflate: number
    normalOffset: number
    perRegionInflate: Partial<Record<CollisionRegion, number>>
  }
  proxies: CollisionAvatarProxy[]
  lowResMeshPatches?: CollisionMeshPatch[]
}

export type CollisionBounds = {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

type TriangleColliderAcceleration = {
  triangleNormals: Float32Array
  triangleCentroids?: Float32Array
  triangleRadii?: Float32Array
  cellSize: number
  cellKeys: Int32Array
  cellStarts: Uint32Array
  cellCounts: Uint32Array
  cellTriangleIndices: Uint32Array
  cellIndexLookup: ReadonlyMap<number, number>
  cellHashKeys?: Int32Array
  cellHashValues?: Int32Array
  cellHashMask?: number
  triangleVisitMarks: Uint32Array
  triangleVisitStamp: number
  bounds: CollisionBounds
}

export type CollisionMeshPatchSnapshot = {
  id: string
  region: CollisionRegion
  vertices: Float32Array
  indices: Uint32Array
  skin: number
  thickness: number
  friction: number
} & TriangleColliderAcceleration

export type MeshSurfaceColliderSnapshot = {
  kind: 'mesh'
  id: string
  vertices: Float32Array
  indices: Uint32Array
  skin: number
  thickness: number
  friction: number
  // Optional BVH broad-phase. When present, the collision solver uses it instead
  // of the cell grid: tighter pruning, far fewer narrow-phase tests per particle.
  // Refit (not rebuilt) each frame from the re-skinned vertices.
  bvh?: TriangleBVH
} & TriangleColliderAcceleration

export type ColliderSnapshot = {
  version: number
  proxies: ColliderProxy[]
  meshColliders?: MeshSurfaceColliderSnapshot[]
  lowResMeshPatches?: CollisionMeshPatchSnapshot[]
}

export type SolverParams = {
  gravity: number
  damping: number
  substeps: number
  iterations: number
  dt: number
  groundY: number
  maxVelocity?: number
  selfCollisionRadius?: number
  selfCollisionStiffness?: number
  sewingTime?: number
  gravityDelayTime?: number
  gravityRampTime?: number
}

export type ClothFrame = {
  positions: Float32Array
}

export type PanelRuntimeInfo = {
  panelId: string
  placement: PatternPlacement
  particleIndices: number[]
  triangleIndices: Uint32Array
}

export type RenderEmbedding = {
  simTriangles: Uint32Array
  barycentrics: Float32Array
}

export type RenderPanelRuntime = {
  panelId: string
  indices: Uint32Array
  panelUvs: Float32Array
  embedding: RenderEmbedding
}

export type GarmentRuntime = {
  document: PatternDocument
  simMesh: ClothSimMesh
  renderPanels: RenderPanelRuntime[]
  panelInfo: Record<string, PanelRuntimeInfo>
}
