import type { ClothSimMesh, DistanceConstraint } from '../types'
import type { DistanceSet } from '../solver'

type DistanceSolveOptions = {
  seamRestScale?: number
  seamStiffness?: number
}

export function solveDistanceConstraints(
  mesh: ClothSimMesh,
  constraints: DistanceConstraint[],
  dt: number,
  options: DistanceSolveOptions = {},
) {
  const dtSq = dt * dt
  const { positions, invMass } = mesh
  const seamRestScale = options.seamRestScale ?? 0
  const seamStiffness = options.seamStiffness ?? 1
  for (let i = 0; i < constraints.length; i += 1) {
    const c = constraints[i]
    solveOne(positions, invMass, c.a, c.b, c.rest, c.targetRest, c.compliance, dtSq, seamRestScale, seamStiffness)
  }
}

export function solveDistanceConstraintsFlat(
  positions: Float32Array,
  invMass: Float32Array,
  set: DistanceSet,
  dt: number,
  seamRestScale: number,
  seamStiffness = 1,
) {
  const dtSq = dt * dt
  const { a, b, rest, targetRest, hasTargetRest, compliance, count } = set
  for (let i = 0; i < count; i += 1) {
    const aIdx = a[i]
    const bIdx = b[i]
    const ia = aIdx * 3
    const ib = bIdx * 3
    const dx = positions[ib] - positions[ia]
    const dy = positions[ib + 1] - positions[ia + 1]
    const dz = positions[ib + 2] - positions[ia + 2]
    const lengthSq = dx * dx + dy * dy + dz * dz
    if (lengthSq < 1e-14) continue
    const wa = invMass[aIdx]
    const wb = invMass[bIdx]
    const wsum = wa + wb
    if (wsum < 1e-9) continue

    let r = rest[i]
    if (hasTargetRest[i]) {
      const tr = targetRest[i]
      const scale = seamRestScale < 0 ? 0 : seamRestScale > 1 ? 1 : seamRestScale
      r = tr + (r - tr) * scale
    }

    const length = Math.sqrt(lengthSq)
    const C = length - r
    const alpha = compliance[i] / dtSq
    const lambda = (-C / (wsum + alpha)) * (seamStiffness < 0 ? 0 : seamStiffness > 1 ? 1 : seamStiffness)
    const invLength = 1 / length
    const gx = dx * invLength
    const gy = dy * invLength
    const gz = dz * invLength

    if (wa > 0) {
      positions[ia] -= wa * lambda * gx
      positions[ia + 1] -= wa * lambda * gy
      positions[ia + 2] -= wa * lambda * gz
    }
    if (wb > 0) {
      positions[ib] += wb * lambda * gx
      positions[ib + 1] += wb * lambda * gy
      positions[ib + 2] += wb * lambda * gz
    }
  }
}

function solveOne(
  positions: Float32Array,
  invMass: Float32Array,
  aIdx: number,
  bIdx: number,
  restValue: number,
  targetRestValue: number | undefined,
  compliance: number,
  dtSq: number,
  seamRestScale: number,
  seamStiffness = 1,
) {
  const ia = aIdx * 3
  const ib = bIdx * 3
  const dx = positions[ib] - positions[ia]
  const dy = positions[ib + 1] - positions[ia + 1]
  const dz = positions[ib + 2] - positions[ia + 2]
  const lengthSq = dx * dx + dy * dy + dz * dz
  if (lengthSq < 1e-14) return
  const wa = invMass[aIdx]
  const wb = invMass[bIdx]
  const wsum = wa + wb
  if (wsum < 1e-9) return
  let r = restValue
  if (targetRestValue !== undefined) {
    const scale = seamRestScale < 0 ? 0 : seamRestScale > 1 ? 1 : seamRestScale
    r = targetRestValue + (restValue - targetRestValue) * scale
  }
  const length = Math.sqrt(lengthSq)
  const C = length - r
  const alpha = compliance / dtSq
  const stiffness = seamStiffness < 0 ? 0 : seamStiffness > 1 ? 1 : seamStiffness
  const lambda = (-C / (wsum + alpha)) * stiffness
  const invLength = 1 / length
  const gx = dx * invLength
  const gy = dy * invLength
  const gz = dz * invLength
  if (wa > 0) {
    positions[ia] -= wa * lambda * gx
    positions[ia + 1] -= wa * lambda * gy
    positions[ia + 2] -= wa * lambda * gz
  }
  if (wb > 0) {
    positions[ib] += wb * lambda * gx
    positions[ib + 1] += wb * lambda * gy
    positions[ib + 2] += wb * lambda * gz
  }
}
