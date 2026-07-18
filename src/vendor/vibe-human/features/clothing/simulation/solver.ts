import type { ClothFrame, ClothSimMesh, ColliderSnapshot, DistanceConstraint, SolverParams } from './types'
import { solveBendConstraintsFlat } from './constraints/solveBendConstraints'
import { solveDistanceConstraintsFlat } from './constraints/solveDistanceConstraints'
import { solvePinConstraints } from './constraints/solvePinConstraints'
import { solveCollisionConstraints } from './collision/solveCollisionConstraints'
import { ClothSelfCollisionSolver } from './collision/solveSelfCollisionConstraints'

type DistanceSet = {
  a: Uint32Array
  b: Uint32Array
  rest: Float32Array
  targetRest: Float32Array
  hasTargetRest: Uint8Array
  compliance: Float32Array
  count: number
}

type BendSet = {
  a: Uint32Array
  b: Uint32Array
  c: Uint32Array
  rest: Float32Array
  compliance: Float32Array
  count: number
}

export class XPBDClothSolver {
  readonly mesh: ClothSimMesh
  readonly params: SolverParams
  private colliders: ColliderSnapshot | null = null
  private elapsed = 0
  private stretchFlat: DistanceSet
  private shearFlat: DistanceSet
  private bendDistanceFlat: DistanceSet
  private seamFlat: DistanceSet
  private bendFlat: BendSet
  private grabParticle = -1
  private grabTargetX = 0
  private grabTargetY = 0
  private grabTargetZ = 0
  private grabVelocityX = 0
  private grabVelocityY = 0
  private grabVelocityZ = 0
  private seamAccumX: Float32Array
  private seamAccumY: Float32Array
  private seamAccumZ: Float32Array
  private seamAccumW: Float32Array
  private seamTouched: Uint8Array
  private seamTouchedList: Uint32Array
  private seamTouchedCount = 0
  private selfCollision: ClothSelfCollisionSolver

  constructor(
    mesh: ClothSimMesh,
    params: SolverParams,
  ) {
    this.mesh = mesh
    this.params = params
    this.stretchFlat = flattenDistanceConstraints(mesh.stretchConstraints)
    this.shearFlat = flattenDistanceConstraints(mesh.shearConstraints)
    this.bendDistanceFlat = flattenDistanceConstraints(mesh.bendDistanceConstraints)
    this.seamFlat = flattenDistanceConstraints(mesh.seamConstraints)
    this.bendFlat = flattenBendConstraints(mesh.bendConstraints)
    this.seamAccumX = new Float32Array(mesh.particleCount)
    this.seamAccumY = new Float32Array(mesh.particleCount)
    this.seamAccumZ = new Float32Array(mesh.particleCount)
    this.seamAccumW = new Float32Array(mesh.particleCount)
    this.seamTouched = new Uint8Array(mesh.particleCount)
    this.seamTouchedList = new Uint32Array(mesh.particleCount)
    this.selfCollision = new ClothSelfCollisionSolver(mesh)
  }

  // ---------------------------------------------------------------------------
  // Live parameter updates — applied to the in-flight solver without rebuilding
  // the constraint mesh or respawning particles. Take effect on the next step
  // (or the next settle()). This is what lets the inspector tweak a running or
  // paused sim the way Marvelous Designer does.
  // ---------------------------------------------------------------------------

  /** Overwrite the compliance of every stretch (structural) constraint. */
  setStretchCompliance(value: number) {
    this.stretchFlat.compliance.fill(value)
  }

  /** Overwrite the compliance of every shear (diagonal) constraint. */
  setShearCompliance(value: number) {
    this.shearFlat.compliance.fill(value)
  }

  /** Overwrite the compliance of every bend constraint. */
  setBendCompliance(value: number) {
    this.bendDistanceFlat.compliance.fill(value)
    this.bendFlat.compliance.fill(value)
  }

  /** Set base velocity damping (0..1). */
  setDamping(value: number) {
    this.params.damping = value
  }

  /** Set XPBD substeps + constraint iterations per fixed step. */
  setSolverIterations(substeps: number, iterations: number) {
    this.params.substeps = Math.max(1, Math.round(substeps))
    this.params.iterations = Math.max(1, Math.round(iterations))
  }

  /**
   * Run a single fixed step in isolation so a parameter change is visible while
   * the sim is paused. Mirrors MD's "tweak during pause" feel. Returns the
   * frame so the caller can refresh the render mesh.
   */
  settle(snapshot?: ColliderSnapshot | null): ClothFrame {
    return this.step(snapshot)
  }

  setGrab(particle: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    this.grabParticle = particle
    this.grabTargetX = x
    this.grabTargetY = y
    this.grabTargetZ = z
    this.grabVelocityX = vx
    this.grabVelocityY = vy
    this.grabVelocityZ = vz
  }

  releaseGrab() {
    this.grabParticle = -1
  }

  step(snapshot?: ColliderSnapshot | null): ClothFrame {
    if (snapshot !== undefined) this.colliders = snapshot
    const dt = this.params.dt / this.params.substeps

    for (let substep = 0; substep < this.params.substeps; substep += 1) {
      const sewingProgress = this.sewingProgress()
      const gravityScale = this.gravityProgress()
      const damping = this.dampingForAssembly(sewingProgress)
      this.integrate(dt, damping, this.params.gravity * gravityScale)
      this.clampSubstepDisplacement(sewingProgress)
      const seamRestScale = 1 - sewingProgress
      const seamStiffness = this.seamAssemblyStiffness(sewingProgress)
      const bendBlend = this.bendAssemblyBlend(sewingProgress)
      for (let iteration = 0; iteration < this.params.iterations; iteration += 1) {
        solveDistanceConstraintsFlat(this.mesh.positions, this.mesh.invMass, this.stretchFlat, dt, 0)
        solveDistanceConstraintsFlat(this.mesh.positions, this.mesh.invMass, this.shearFlat, dt, 0)
        solveDistanceConstraintsFlat(this.mesh.positions, this.mesh.invMass, this.seamFlat, dt, seamRestScale, seamStiffness)
        if (bendBlend > 0 && (iteration & 1) === 0) {
          solveBendConstraintsFlat(this.mesh.positions, this.mesh.invMass, this.bendFlat, dt * bendBlend)
        }
        solvePinConstraints(this.mesh)
        this.applyGrabPin(dt)
      }
      this.solveSelfCollision(sewingProgress)
      solveCollisionConstraints(this.mesh, this.colliders)
      if (sewingProgress >= 1) this.weldSeamPairs()
      this.deriveVelocities(dt, this.velocityRetentionForAssembly(sewingProgress))
      this.applyGround()
      this.elapsed += dt
    }

    return { positions: this.mesh.positions }
  }

  refreshSeamRests() {
    const seamConstraints = this.mesh.seamConstraints
    const rest = this.seamFlat.rest
    for (let i = 0; i < seamConstraints.length; i += 1) rest[i] = seamConstraints[i].rest
  }

  private integrate(dt: number, damping: number, gravity: number) {
    const dampPerStep = Math.pow(1 - damping, dt)
    const { positions, prevPositions, velocities, invMass, particleCount } = this.mesh
    const gravityStep = gravity * dt
    for (let particle = 0; particle < particleCount; particle += 1) {
      const offset = particle * 3
      if (invMass[particle] === 0) {
        prevPositions[offset] = positions[offset]
        prevPositions[offset + 1] = positions[offset + 1]
        prevPositions[offset + 2] = positions[offset + 2]
        velocities[offset] = 0
        velocities[offset + 1] = 0
        velocities[offset + 2] = 0
        continue
      }
      const vx = velocities[offset] * dampPerStep
      const vy = velocities[offset + 1] * dampPerStep + gravityStep
      const vz = velocities[offset + 2] * dampPerStep
      prevPositions[offset] = positions[offset]
      prevPositions[offset + 1] = positions[offset + 1]
      prevPositions[offset + 2] = positions[offset + 2]
      positions[offset] += vx * dt
      positions[offset + 1] += vy * dt
      positions[offset + 2] += vz * dt
    }
  }

  private deriveVelocities(dt: number, velocityRetention: number) {
    const maxVelocity = this.params.maxVelocity ?? 8
    const maxVelocitySq = maxVelocity * maxVelocity
    const invDt = 1 / dt
    const { positions, prevPositions, velocities, particleCount } = this.mesh
    for (let particle = 0; particle < particleCount; particle += 1) {
      const offset = particle * 3
      let vx = (positions[offset] - prevPositions[offset]) * invDt * velocityRetention
      let vy = (positions[offset + 1] - prevPositions[offset + 1]) * invDt * velocityRetention
      let vz = (positions[offset + 2] - prevPositions[offset + 2]) * invDt * velocityRetention
      const speedSq = vx * vx + vy * vy + vz * vz
      if (speedSq > maxVelocitySq) {
        const scale = maxVelocity / Math.sqrt(speedSq)
        vx *= scale
        vy *= scale
        vz *= scale
        prevPositions[offset] = positions[offset] - vx * dt
        prevPositions[offset + 1] = positions[offset + 1] - vy * dt
        prevPositions[offset + 2] = positions[offset + 2] - vz * dt
      }
      velocities[offset] = vx
      velocities[offset + 1] = vy
      velocities[offset + 2] = vz
    }
  }

  private applyGrabPin(dt: number) {
    if (this.grabParticle < 0) return
    const offset = this.grabParticle * 3
    const { positions, prevPositions } = this.mesh
    positions[offset] = this.grabTargetX
    positions[offset + 1] = this.grabTargetY
    positions[offset + 2] = this.grabTargetZ
    prevPositions[offset] = this.grabTargetX - this.grabVelocityX * dt
    prevPositions[offset + 1] = this.grabTargetY - this.grabVelocityY * dt
    prevPositions[offset + 2] = this.grabTargetZ - this.grabVelocityZ * dt
  }

  private weldSeamPairs() {
    const { positions, prevPositions, invMass } = this.mesh
    const seamA = this.seamFlat.a
    const seamB = this.seamFlat.b
    const count = this.seamFlat.count
    const accumX = this.seamAccumX
    const accumY = this.seamAccumY
    const accumZ = this.seamAccumZ
    const accumW = this.seamAccumW
    const touched = this.seamTouched
    const touchedList = this.seamTouchedList
    let touchedCount = 0

    const touch = (particle: number) => {
      if (touched[particle] !== 0) return
      touched[particle] = 1
      touchedList[touchedCount] = particle
      touchedCount += 1
    }

    for (let i = 0; i < count; i += 1) {
      const a = seamA[i]
      const b = seamB[i]
      const ia = a * 3
      const ib = b * 3
      const wa = invMass[a]
      const wb = invMass[b]
      const wsum = wa + wb
      if (wsum < 1e-9) continue
      const tA = wa / wsum
      const tB = wb / wsum
      const mx = positions[ia] * tB + positions[ib] * tA
      const my = positions[ia + 1] * tB + positions[ib + 1] * tA
      const mz = positions[ia + 2] * tB + positions[ib + 2] * tA
      const contribution = Math.max(wa, wb)
      if (wa > 0) {
        touch(a)
        accumX[a] += mx * contribution
        accumY[a] += my * contribution
        accumZ[a] += mz * contribution
        accumW[a] += contribution
      }
      if (wb > 0) {
        touch(b)
        accumX[b] += mx * contribution
        accumY[b] += my * contribution
        accumZ[b] += mz * contribution
        accumW[b] += contribution
      }
    }

    for (let index = 0; index < touchedCount; index += 1) {
      const particle = touchedList[index]
      const weight = accumW[particle]
      touched[particle] = 0
      if (weight <= 1e-9) continue
      const invWeight = 1 / weight
      const offset = particle * 3
      const x = accumX[particle] * invWeight
      const y = accumY[particle] * invWeight
      const z = accumZ[particle] * invWeight
      positions[offset] = x
      positions[offset + 1] = y
      positions[offset + 2] = z
      prevPositions[offset] = x
      prevPositions[offset + 1] = y
      prevPositions[offset + 2] = z
      accumX[particle] = 0
      accumY[particle] = 0
      accumZ[particle] = 0
      accumW[particle] = 0
    }

    for (let index = touchedCount; index < this.seamTouchedCount; index += 1) {
      const particle = touchedList[index]
      touched[particle] = 0
      accumX[particle] = 0
      accumY[particle] = 0
      accumZ[particle] = 0
      accumW[particle] = 0
    }
    this.seamTouchedCount = touchedCount
  }

  private clampSubstepDisplacement(sewingProgress: number) {
    const skin = this.colliders?.meshColliders?.[0]?.skin ?? 0.022
    const thickness = this.colliders?.meshColliders?.[0]?.thickness ?? 0.008
    const baseLimit = Math.max(0.02, (skin + thickness) * 1.35)
    const sewingTighten = 0.6 + 0.4 * sewingProgress
    const limit = baseLimit * sewingTighten
    const limitSq = limit * limit
    const { positions, prevPositions, particleCount } = this.mesh
    for (let particle = 0; particle < particleCount; particle += 1) {
      const offset = particle * 3
      const dx = positions[offset] - prevPositions[offset]
      const dy = positions[offset + 1] - prevPositions[offset + 1]
      const dz = positions[offset + 2] - prevPositions[offset + 2]
      const distSq = dx * dx + dy * dy + dz * dz
      if (distSq <= limitSq) continue
      const scale = limit / Math.sqrt(distSq)
      positions[offset] = prevPositions[offset] + dx * scale
      positions[offset + 1] = prevPositions[offset + 1] + dy * scale
      positions[offset + 2] = prevPositions[offset + 2] + dz * scale
    }
  }

  private applyGround() {
    const { positions, prevPositions, particleCount } = this.mesh
    const groundY = this.params.groundY
    for (let particle = 0; particle < particleCount; particle += 1) {
      const offset = particle * 3 + 1
      if (positions[offset] >= groundY) continue
      positions[offset] = groundY
      prevPositions[offset] = groundY
    }
  }

  private solveSelfCollision(sewingProgress: number) {
    const radius = this.params.selfCollisionRadius ?? 0
    const stiffness = this.params.selfCollisionStiffness ?? 0
    if (radius <= 0 || stiffness <= 0) return
    const ramp = smooth01((sewingProgress - 0.12) / 0.38)
    if (ramp <= 0) return
    this.selfCollision.solve(this.mesh, {
      radius: radius * (0.65 + 0.35 * ramp),
      stiffness: stiffness * ramp,
      surfaceContacts: false,
    })
  }

  private sewingProgress() {
    const duration = this.params.sewingTime ?? 1.2
    if (duration <= 0) return 1
    return smooth01(this.elapsed / duration)
  }

  private gravityProgress() {
    const sewingDuration = this.params.sewingTime ?? 1.2
    const delay = this.params.gravityDelayTime ?? sewingDuration * 0.85
    const duration = this.params.gravityRampTime ?? 0.45
    if (duration <= 0) return 1
    return smooth01((this.elapsed - delay) / duration)
  }

  private dampingForAssembly(sewingProgress: number) {
    const base = clamp01(this.params.damping)
    const assemblyDamping = 0.22
    return base + (assemblyDamping - base) * (1 - sewingProgress)
  }

  private velocityRetentionForAssembly(sewingProgress: number) {
    return 0.05 + 0.95 * sewingProgress * sewingProgress
  }

  private seamAssemblyStiffness(sewingProgress: number) {
    // Avoid violent early seam snap: start soft so panels translate toward one
    // another first, then lock seam strength near the end of assembly.
    return 0.2 + 0.8 * smooth01((sewingProgress - 0.2) / 0.8)
  }

  private bendAssemblyBlend(sewingProgress: number) {
    // Keep cloth relatively flat while seam distances are still closing so
    // assembly behaves more like MD (pull together first, wrinkle second).
    // Starts activating around 55% progress and reaches full bend response by
    // the end of the sewing phase.
    return smooth01((sewingProgress - 0.55) / 0.45)
  }
}

function flattenDistanceConstraints(source: DistanceConstraint[]): DistanceSet {
  const count = source.length
  const a = new Uint32Array(count)
  const b = new Uint32Array(count)
  const rest = new Float32Array(count)
  const targetRest = new Float32Array(count)
  const hasTargetRest = new Uint8Array(count)
  const compliance = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const c = source[i]
    a[i] = c.a
    b[i] = c.b
    rest[i] = c.rest
    if (c.targetRest !== undefined) {
      hasTargetRest[i] = 1
      targetRest[i] = c.targetRest
    }
    compliance[i] = c.compliance
  }
  return { a, b, rest, targetRest, hasTargetRest, compliance, count }
}

function flattenBendConstraints(source: ClothSimMesh['bendConstraints']): BendSet {
  const count = source.length
  const a = new Uint32Array(count)
  const b = new Uint32Array(count)
  const c = new Uint32Array(count)
  const rest = new Float32Array(count)
  const compliance = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const k = source[i]
    a[i] = k.a
    b[i] = k.b
    c[i] = k.c
    rest[i] = k.rest
    compliance[i] = k.compliance
  }
  return { a, b, c, rest, compliance, count }
}

function smooth01(value: number) {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export type { DistanceSet, BendSet }
