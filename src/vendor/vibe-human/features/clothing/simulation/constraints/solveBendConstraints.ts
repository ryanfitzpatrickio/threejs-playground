import type { ClothSimMesh } from '../types'
import type { BendSet } from '../solver'

export function solveBendConstraints(mesh: ClothSimMesh, dt: number) {
  const dtSq = dt * dt
  const { positions, invMass, bendConstraints } = mesh
  for (let i = 0; i < bendConstraints.length; i += 1) {
    const constraint = bendConstraints[i]
    solveOne(positions, invMass, constraint.a, constraint.b, constraint.c, constraint.rest, constraint.compliance, dtSq)
  }
}

export function solveBendConstraintsFlat(
  positions: Float32Array,
  invMass: Float32Array,
  set: BendSet,
  dt: number,
) {
  const dtSq = dt * dt
  const { a, b, c, rest, compliance, count } = set
  for (let i = 0; i < count; i += 1) {
    const aIdx = a[i]
    const bIdx = b[i]
    const cIdx = c[i]
    const ia = aIdx * 3
    const ib = bIdx * 3
    const ic = cIdx * 3
    const mx = (positions[ia] + positions[ic]) * 0.5
    const my = (positions[ia + 1] + positions[ic + 1]) * 0.5
    const mz = (positions[ia + 2] + positions[ic + 2]) * 0.5
    const dx = positions[ib] - mx
    const dy = positions[ib + 1] - my
    const dz = positions[ib + 2] - mz
    const lengthSq = dx * dx + dy * dy + dz * dz
    if (lengthSq < 1e-14) continue

    const wa = invMass[aIdx]
    const wb = invMass[bIdx]
    const wc = invMass[cIdx]
    const wsum = wb + 0.25 * (wa + wc)
    if (wsum < 1e-9) continue

    const length = Math.sqrt(lengthSq)
    const C = length - rest[i]
    const alpha = compliance[i] / dtSq
    const lambda = -C / (wsum + alpha)
    const invLength = 1 / length
    const gx = dx * invLength
    const gy = dy * invLength
    const gz = dz * invLength

    if (wb > 0) {
      positions[ib] += wb * lambda * gx
      positions[ib + 1] += wb * lambda * gy
      positions[ib + 2] += wb * lambda * gz
    }
    if (wa > 0) {
      positions[ia] -= 0.5 * wa * lambda * gx
      positions[ia + 1] -= 0.5 * wa * lambda * gy
      positions[ia + 2] -= 0.5 * wa * lambda * gz
    }
    if (wc > 0) {
      positions[ic] -= 0.5 * wc * lambda * gx
      positions[ic + 1] -= 0.5 * wc * lambda * gy
      positions[ic + 2] -= 0.5 * wc * lambda * gz
    }
  }
}

function solveOne(
  positions: Float32Array,
  invMass: Float32Array,
  aIdx: number,
  bIdx: number,
  cIdx: number,
  rest: number,
  compliance: number,
  dtSq: number,
) {
  const ia = aIdx * 3
  const ib = bIdx * 3
  const ic = cIdx * 3
  const mx = (positions[ia] + positions[ic]) * 0.5
  const my = (positions[ia + 1] + positions[ic + 1]) * 0.5
  const mz = (positions[ia + 2] + positions[ic + 2]) * 0.5
  const dx = positions[ib] - mx
  const dy = positions[ib + 1] - my
  const dz = positions[ib + 2] - mz
  const lengthSq = dx * dx + dy * dy + dz * dz
  if (lengthSq < 1e-14) return
  const wa = invMass[aIdx]
  const wb = invMass[bIdx]
  const wc = invMass[cIdx]
  const wsum = wb + 0.25 * (wa + wc)
  if (wsum < 1e-9) return
  const length = Math.sqrt(lengthSq)
  const C = length - rest
  const alpha = compliance / dtSq
  const lambda = -C / (wsum + alpha)
  const invLength = 1 / length
  const gx = dx * invLength
  const gy = dy * invLength
  const gz = dz * invLength
  if (wb > 0) {
    positions[ib] += wb * lambda * gx
    positions[ib + 1] += wb * lambda * gy
    positions[ib + 2] += wb * lambda * gz
  }
  if (wa > 0) {
    positions[ia] -= 0.5 * wa * lambda * gx
    positions[ia + 1] -= 0.5 * wa * lambda * gy
    positions[ia + 2] -= 0.5 * wa * lambda * gz
  }
  if (wc > 0) {
    positions[ic] -= 0.5 * wc * lambda * gx
    positions[ic + 1] -= 0.5 * wc * lambda * gy
    positions[ic + 2] -= 0.5 * wc * lambda * gz
  }
}
