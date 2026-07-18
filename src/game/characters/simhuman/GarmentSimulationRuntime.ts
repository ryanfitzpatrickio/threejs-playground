import * as THREE from 'three'
import { compileGarmentRuntime } from '../../../vendor/vibe-human/features/clothing/compiler/compileGarmentRuntime'
import type { CompileQuality } from '../../../vendor/vibe-human/features/clothing/compiler/types'
import type { PatternDocument, PatternPanel } from '../../../vendor/vibe-human/features/clothing/document/types'
import { XPBDClothSolver } from '../../../vendor/vibe-human/features/clothing/simulation/solver'
import type {
  ColliderSnapshot,
  GarmentRuntime,
  RenderPanelRuntime,
  SolverParams,
} from '../../../vendor/vibe-human/features/clothing/simulation/types'
import {
  rebuildAvatarMeshCollider,
  type AvatarMeshColliderTopology,
} from '../../../vendor/vibe-human/features/clothing/avatar-collision/AvatarCollisionRegistry'

const FIXED_DT = 1 / 60
const MAX_FRAME_STEPS = 2
const UPSTREAM_MODEL_BASE_Y = -3.1
const PATTERN_UNIT_SCALE = 0.004

const SOLVER_PRESETS: Record<CompileQuality, SolverParams> = {
  low: { gravity: -9.81, damping: 0.09, substeps: 1, iterations: 4, dt: FIXED_DT, groundY: -0.02, maxVelocity: 6, selfCollisionRadius: 0.007, selfCollisionStiffness: 0.3, sewingTime: 0.65, gravityDelayTime: 0.05, gravityRampTime: 0.2 },
  medium: { gravity: -9.81, damping: 0.08, substeps: 2, iterations: 5, dt: FIXED_DT, groundY: -0.02, maxVelocity: 6, selfCollisionRadius: 0.008, selfCollisionStiffness: 0.36, sewingTime: 0.65, gravityDelayTime: 0.05, gravityRampTime: 0.2 },
  high: { gravity: -9.81, damping: 0.07, substeps: 2, iterations: 7, dt: FIXED_DT, groundY: -0.02, maxVelocity: 7, selfCollisionRadius: 0.009, selfCollisionStiffness: 0.42, sewingTime: 0.65, gravityDelayTime: 0.05, gravityRampTime: 0.2 },
  ultra: { gravity: -9.81, damping: 0.06, substeps: 3, iterations: 8, dt: FIXED_DT, groundY: -0.02, maxVelocity: 8, selfCollisionRadius: 0.01, selfCollisionStiffness: 0.5, sewingTime: 0.65, gravityDelayTime: 0.05, gravityRampTime: 0.2 },
}

type AvatarBinding = {
  root: THREE.Object3D
  skinnedMeshes: THREE.SkinnedMesh[]
  modelScale: number
}

type RenderPanelEntry = {
  panelId: string
  panel: RenderPanelRuntime
  geometry: THREE.BufferGeometry
  mesh: THREE.Mesh
  positions: Float32Array
  normals: Float32Array
}

/**
 * React-free owner for one compiled garment. Each instance keeps its own
 * solver, accumulator, posed-avatar BVH and render buffers so multiple sims do
 * not fight over vibe-human's original singleton collision registry.
 */
export class GarmentSimulationRuntime {
  readonly group = new THREE.Group()
  readonly document: PatternDocument
  readonly quality: CompileQuality
  readonly runtime: GarmentRuntime
  readonly issues
  readonly renderPanels: RenderPanelEntry[]
  solver: XPBDClothSolver | null = null

  private avatar: AvatarBinding | null = null
  private colliderTopology: AvatarMeshColliderTopology | null = null
  private accumulator = 0
  private colliderVersion = 0
  private previousPositions: Float32Array
  private disposed = false
  private stepCount = 0
  private movedVertexCount = 0
  private lastStepMs = 0
  private totalStepMs = 0

  constructor({
    document,
    quality = 'low',
    color = '#6f91d8',
  }: {
    document: PatternDocument
    quality?: CompileQuality
    color?: string
  }) {
    this.document = document
    this.quality = quality
    const compiled = compileGarmentRuntime(document, { quality, seamSamples: 18 })
    this.runtime = compiled.value
    this.issues = compiled.issues
    const errors = compiled.issues.filter((issue) => issue.severity === 'error')
    if (errors.length > 0) throw new Error(`Garment compile failed: ${errors.map((issue) => issue.message).join('; ')}`)

    this.group.name = `Sim Garment:${document.id}`
    this.renderPanels = this.runtime.renderPanels.map((panel) => {
      const entry = createRenderPanelEntry(panel, document.panels[panel.panelId]?.color ?? color)
      this.group.add(entry.mesh)
      return entry
    })
    this.previousPositions = new Float32Array(this.runtime.simMesh.positions)
    updateRenderPanels(this.renderPanels, this.runtime.simMesh.positions)
  }

  bindAvatar(binding: AvatarBinding) {
    this.avatar = binding
    binding.root.updateMatrixWorld(true)
    normalizeGarmentToAvatar(this.runtime, this.document, binding)
    this.solver = new XPBDClothSolver(this.runtime.simMesh, { ...SOLVER_PRESETS[this.quality] })
    this.solver.params.groundY = binding.root.getWorldPosition(new THREE.Vector3()).y - 0.02
    this.previousPositions.set(this.runtime.simMesh.positions)
    updateRenderPanels(this.renderPanels, this.runtime.simMesh.positions)
  }

  step(delta: number) {
    if (this.disposed || !this.avatar || !this.solver || this.runtime.simMesh.particleCount === 0) return
    this.accumulator += Math.min(Math.max(delta, 0), 1 / 20)
    let steps = 0
    let snapshot: ColliderSnapshot | null = null
    while (this.accumulator >= FIXED_DT && steps < MAX_FRAME_STEPS) {
      if (!snapshot) snapshot = this.updateAvatarCollider()
      const started = performance.now()
      const frame = this.solver.step(snapshot)
      this.lastStepMs = performance.now() - started
      this.totalStepMs += this.lastStepMs
      this.stepCount += 1
      this.movedVertexCount = countMovedVertices(this.previousPositions, frame.positions)
      this.previousPositions.set(frame.positions)
      this.accumulator -= FIXED_DT
      steps += 1
    }
    if (steps === MAX_FRAME_STEPS && this.accumulator >= FIXED_DT) this.accumulator %= FIXED_DT
    updateRenderPanels(this.renderPanels, this.runtime.simMesh.positions)
  }

  snapshot() {
    return {
      id: this.document.id,
      panels: this.renderPanels.length,
      particles: this.runtime.simMesh.particleCount,
      renderVertices: this.renderPanels.reduce((sum, panel) => sum + panel.positions.length / 3, 0),
      steps: this.stepCount,
      movedVertices: this.movedVertexCount,
      lastStepMs: this.lastStepMs,
      averageStepMs: this.stepCount > 0 ? this.totalStepMs / this.stepCount : 0,
      hasBvh: Boolean(this.colliderTopology?.bvh),
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.group.removeFromParent()
    for (const entry of this.renderPanels) {
      entry.geometry.dispose()
      const material = entry.mesh.material
      if (Array.isArray(material)) material.forEach((value) => value.dispose())
      else material.dispose()
    }
    this.colliderTopology = null
    this.avatar = null
  }

  private updateAvatarCollider(): ColliderSnapshot {
    const avatar = this.avatar!
    avatar.root.updateMatrixWorld(true)
    const rebuilt = rebuildAvatarMeshCollider(avatar.skinnedMeshes, this.colliderTopology, {
      id: `${this.document.id}.avatar`,
      skinOffset: 0.009,
      garmentThickness: 0.005,
      friction: 0.66,
      cellSize: 0.08,
      triangleStride: 3,
    })
    this.colliderTopology = rebuilt?.topology ?? null
    this.colliderVersion += 1
    return {
      version: this.colliderVersion,
      proxies: [],
      meshColliders: rebuilt ? [rebuilt.snapshot] : undefined,
    }
  }
}

function normalizeGarmentToAvatar(runtime: GarmentRuntime, document: PatternDocument, avatar: AvatarBinding) {
  const mesh = runtime.simMesh
  const scale = avatar.modelScale
  const vector = new THREE.Vector3()
  for (let particle = 0; particle < mesh.particleCount; particle += 1) {
    const offset = particle * 3
    vector.set(
      mesh.positions[offset] * scale,
      (mesh.positions[offset + 1] - UPSTREAM_MODEL_BASE_Y) * scale,
      mesh.positions[offset + 2] * scale,
    )
    avatar.root.localToWorld(vector)
    mesh.positions[offset] = vector.x
    mesh.positions[offset + 1] = vector.y
    mesh.positions[offset + 2] = vector.z
    mesh.prevPositions[offset] = vector.x
    mesh.prevPositions[offset + 1] = vector.y
    mesh.prevPositions[offset + 2] = vector.z
    mesh.velocities[offset] = 0
    mesh.velocities[offset + 1] = 0
    mesh.velocities[offset + 2] = 0
  }
  for (const constraint of [
    ...mesh.stretchConstraints,
    ...mesh.shearConstraints,
    ...mesh.bendDistanceConstraints,
    ...mesh.seamConstraints,
  ]) {
    constraint.rest *= scale
    if (constraint.targetRest !== undefined) constraint.targetRest *= scale
  }
  for (const pin of mesh.pinConstraints) {
    vector.set(pin.x * scale, (pin.y - UPSTREAM_MODEL_BASE_Y) * scale, pin.z * scale)
    avatar.root.localToWorld(vector)
    pin.x = vector.x
    pin.y = vector.y
    pin.z = vector.z
  }
  // Panel friction remains an authoring property and does not scale.
  for (let particle = 0; particle < mesh.particleCount; particle += 1) {
    mesh.particleFrictions[particle] = document.panels[mesh.panelIds[particle]]?.friction ?? 1
  }
}

function createRenderPanelEntry(panel: RenderPanelRuntime, color: string): RenderPanelEntry {
  const vertexCount = panel.panelUvs.length / 2
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(panel.panelUvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(panel.indices, 1))
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `Garment Panel:${panel.panelId}`
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return { panelId: panel.panelId, panel, geometry, mesh, positions, normals }
}

function updateRenderPanels(entries: RenderPanelEntry[], simPositions: Float32Array) {
  for (const entry of entries) {
    const { simTriangles, barycentrics } = entry.panel.embedding
    for (let vertex = 0; vertex < entry.positions.length / 3; vertex += 1) {
      const base = vertex * 3
      const ia = simTriangles[base] * 3
      const ib = simTriangles[base + 1] * 3
      const ic = simTriangles[base + 2] * 3
      const wa = barycentrics[base]
      const wb = barycentrics[base + 1]
      const wc = barycentrics[base + 2]
      entry.positions[base] = simPositions[ia] * wa + simPositions[ib] * wb + simPositions[ic] * wc
      entry.positions[base + 1] = simPositions[ia + 1] * wa + simPositions[ib + 1] * wb + simPositions[ic + 1] * wc
      entry.positions[base + 2] = simPositions[ia + 2] * wa + simPositions[ib + 2] * wb + simPositions[ic + 2] * wc
    }
    computeVertexNormalsFlat(entry.positions, entry.panel.indices, entry.normals)
    ;(entry.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(entry.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true
    entry.geometry.boundingSphere = null
  }
}

export function computeVertexNormalsFlat(positions: Float32Array, indices: Uint32Array, normals: Float32Array) {
  normals.fill(0)
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3
    const ib = indices[i + 1] * 3
    const ic = indices[i + 2] * 3
    const cbx = positions[ic] - positions[ib]
    const cby = positions[ic + 1] - positions[ib + 1]
    const cbz = positions[ic + 2] - positions[ib + 2]
    const abx = positions[ia] - positions[ib]
    const aby = positions[ia + 1] - positions[ib + 1]
    const abz = positions[ia + 2] - positions[ib + 2]
    const nx = cby * abz - cbz * aby
    const ny = cbz * abx - cbx * abz
    const nz = cbx * aby - cby * abx
    for (const offset of [ia, ib, ic]) {
      normals[offset] += nx
      normals[offset + 1] += ny
      normals[offset + 2] += nz
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= length
    normals[i + 1] /= length
    normals[i + 2] /= length
  }
}

function countMovedVertices(previous: Float32Array, next: Float32Array) {
  let count = 0
  for (let i = 0; i < next.length; i += 3) {
    if (Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]) > 1e-5) count += 1
  }
  return count
}

export const GARMENT_PATTERN_UNIT_SCALE = PATTERN_UNIT_SCALE
