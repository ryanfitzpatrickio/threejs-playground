import type { ClothSimMesh } from '../types'

export function solvePinConstraints(mesh: ClothSimMesh) {
  const { pinConstraints, positions, prevPositions } = mesh
  for (const pin of pinConstraints) {
    const offset = pin.particle * 3
    const stiffness = Math.max(0, Math.min(1, pin.stiffness))
    positions[offset] += (pin.x - positions[offset]) * stiffness
    positions[offset + 1] += (pin.y - positions[offset + 1]) * stiffness
    positions[offset + 2] += (pin.z - positions[offset + 2]) * stiffness
    prevPositions[offset] = positions[offset]
    prevPositions[offset + 1] = positions[offset + 1]
    prevPositions[offset + 2] = positions[offset + 2]
  }
}