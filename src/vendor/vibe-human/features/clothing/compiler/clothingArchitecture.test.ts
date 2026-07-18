import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoGarment } from '../demo/createDemoGarment'
import { toPatternDocument } from '../document/legacyAdapter'
import type { PatternPlacement } from '../document/types'
import { resolveSeamSamples } from '../geometry/seamUtils'
import { XPBDClothSolver } from '../simulation/solver'
import { samplePanelEdge } from './buildPanelSimMesh'
import { orientSeamSamples } from './buildSeamConstraints'
import { compileGarmentRuntime } from './compileGarmentRuntime'
import { validatePatternDocument } from './validatePatternDocument'
import type { PatternDocument, PatternPanel } from '../document/types'

describe('clothing compiler architecture', () => {
  test('invalid seam references are rejected', () => {
    const document = buildDocument()
    const seam = Object.values(document.seams)[0]
    seam.a.edgeId = 'missing-edge'
    const issues = validatePatternDocument(document)
    assert.equal(issues.some((issue) => issue.code === 'invalid-seam-edge-a'), true)
  })

  test('seam sample counts match', () => {
    const document = buildDocument()
    const seam = Object.values(document.seams)[0]
    const pointsA = samplePanelEdge(document.panels[seam.a.panelId], seam.a.edgeId, 12, seam.a.reversed)
    const pointsB = samplePanelEdge(document.panels[seam.b.panelId], seam.b.edgeId, 12, seam.b.reversed)
    assert.equal(pointsA.length, pointsB.length)
  })

  test('panel discretization outputs particles with panel ids and panel uvs', () => {
    const runtime = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    assert.equal(runtime.simMesh.particleCount > 0, true)
    assert.equal(runtime.simMesh.panelIds.length, runtime.simMesh.particleCount)
    assert.equal(runtime.simMesh.panelUvs.length, runtime.simMesh.particleCount * 2)
    assert.deepEqual(new Set(runtime.simMesh.panelIds), new Set(['torso-front', 'torso-back']))
  })

  test('panel pattern height is placed vertically', () => {
    const runtime = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    let minY = Infinity
    let maxY = -Infinity
    for (let index = 1; index < runtime.simMesh.positions.length; index += 3) {
      minY = Math.min(minY, runtime.simMesh.positions[index])
      maxY = Math.max(maxY, runtime.simMesh.positions[index])
    }
    assert.equal(maxY - minY > 0.9, true)
  })

  test('seams start at placed distance and sew toward zero', () => {
    const runtime = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    assert.equal(Object.keys(runtime.document.seams).length > 6, true)
    assert.equal(runtime.simMesh.seamConstraints.length > 0, true)
    for (const seam of runtime.simMesh.seamConstraints) {
      assert.equal(seam.kind, 'seam')
      assert.equal(seam.targetRest, 0)
      assert.equal(seam.rest > 0, true)
    }
  })

  test('render embedding references valid sim triangles', () => {
    const runtime = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    for (const panel of runtime.renderPanels) {
      const triangles = runtime.panelInfo[panel.panelId].triangleIndices
      const validKeys = new Set<string>()
      for (let index = 0; index < triangles.length; index += 3) {
        validKeys.add(`${triangles[index]}:${triangles[index + 1]}:${triangles[index + 2]}`)
      }
      for (let vertex = 0; vertex < panel.panelUvs.length / 2; vertex += 1) {
        const key = `${panel.embedding.simTriangles[vertex * 3]}:${panel.embedding.simTriangles[vertex * 3 + 1]}:${panel.embedding.simTriangles[vertex * 3 + 2]}`
        assert.equal(validKeys.has(key), true)
      }
    }
  })

  test('solver can step without NaNs', () => {
    const runtime = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    const solver = new XPBDClothSolver(cloneMesh(runtime.simMesh), {
      gravity: -9.81,
      damping: 0.07,
      substeps: 2,
      iterations: 4,
      dt: 1 / 60,
      groundY: -1.6,
      maxVelocity: 6,
    })

    for (let step = 0; step < 5; step += 1) solver.step({ version: 1, proxies: [] })

    for (const value of solver.mesh.positions) {
      assert.equal(Number.isFinite(value), true)
    }
  })


  test('demo seam orientation avoids crossed horizontal pairing regression', () => {
    const fixed = compileGarmentRuntime(buildDocument(), { quality: 'medium', seamSamples: 12 }).value
    const regressed = compileGarmentRuntime(buildDocumentWithBackSeamsUnreversed(), { quality: 'medium', seamSamples: 12 }).value

    const fixedMaxRest = Math.max(...fixed.simMesh.seamConstraints.map((constraint) => constraint.rest))
    const regressedMaxRest = Math.max(...regressed.simMesh.seamConstraints.map((constraint) => constraint.rest))

    // With 3D auto-orientation, both authored-reversed and un-reversed versions
    // converge to the same correct orientation. Verify that both produce equal
    // results and that max rest is bounded by the panel separation + edge span.
    assert.equal(Math.abs(fixedMaxRest - regressedMaxRest) < 0.01, true)
    // The panels are 0.6m apart in Z; sleeve-top edge particles add X-offset.
    // Max rest should be well below the worst-case crossed pairing (~2m).
    assert.equal(fixedMaxRest < 1.5, true)
  })

  test('horizontal seams auto-orient to avoid crossed pairing', () => {
    const runtime = compileGarmentRuntime(buildHorizontalSeamDocument(), { quality: 'medium', seamSamples: 12 }).value
    const rests = runtime.simMesh.seamConstraints.map((constraint) => constraint.rest)
    assert.equal(rests.length > 0, true)
    assert.equal(Math.max(...rests) < 0.75, true)
  })

  test('demo seams compile with monotonic non-crossed edge progression', () => {
    const document = buildDocument()
    for (const seam of Object.values(document.seams)) {
      const panelA = document.panels[seam.a.panelId]
      const panelB = document.panels[seam.b.panelId]
      const pointsA = samplePanelEdge(panelA, seam.a.edgeId, 16, seam.a.reversed)
      const sampledB = samplePanelEdge(panelB, seam.b.edgeId, 16, seam.b.reversed)
      const pointsB = orientSeamSamples(panelA, pointsA, panelB, sampledB)
      const forward = pairingCost(panelA, pointsA, panelB, pointsB)
      const reversed = pairingCost(panelA, pointsA, panelB, [...pointsB].reverse())
      assert.equal(forward <= reversed + 1e-7, true)
    }
  })

  test('demo seams start aligned in the default placement', () => {
    const document = buildDocument()
    for (const seam of Object.values(document.seams)) {
      const resolved = resolveSeamSamples(document, seam, 16)
      assert.notEqual(resolved, null)
      if (!resolved) continue
      const count = Math.min(resolved.pointsA.length, resolved.pointsB.length)
      for (let index = 0; index < count; index += 1) {
        const a = place(document.panels[seam.a.panelId], resolved.pointsA[index])
        const b = place(document.panels[seam.b.panelId], resolved.pointsB[index])
        assert.equal(Math.abs(a.x - b.x) < 1e-6, true)
        assert.equal(Math.abs(a.y - b.y) < 1e-6, true)
      }
    }
  })
})

function buildDocument() {
  const garment = createDemoGarment()
  const placements: Record<string, PatternPlacement> = {
    'torso-front': {
      position: { x: 0, y: -0.74, z: 0.3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    'torso-back': {
      position: { x: 0, y: -0.74, z: -0.3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  }
  return toPatternDocument(garment, placements)
}


function buildDocumentWithBackSeamsUnreversed() {
  const garment = createDemoGarment()
  for (const seam of Object.values(garment.seams)) {
    if (seam.b.patternId === 'torso-back') seam.b.reversed = false
  }
  const placements: Record<string, PatternPlacement> = {
    'torso-front': {
      position: { x: 0, y: -0.74, z: 0.3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    'torso-back': {
      position: { x: 0, y: -0.74, z: -0.3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  }
  return toPatternDocument(garment, placements)
}

function buildHorizontalSeamDocument(): PatternDocument {
  const front = createRectPanel('front', { x: 0, y: -0.5, z: 0.25 }, { x: 0, y: 0, z: 0 })
  const back = createRectPanel('back', { x: 0, y: -0.5, z: -0.25 }, { x: 0, y: Math.PI, z: 0 })
  return {
    id: 'horizontal-seam-doc',
    name: 'Horizontal Seam Orientation',
    panels: {
      [front.id]: front,
      [back.id]: back,
    },
    seams: {
      shoulder: {
        id: 'shoulder',
        name: 'Shoulder',
        a: { panelId: front.id, edgeId: 'top' },
        b: { panelId: back.id, edgeId: 'top', reversed: false },
        strength: 1,
      },
    },
  }
}

function createRectPanel(id: string, position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number }): PatternPanel {
  return {
    id,
    name: id,
    points: {
      tl: { id: 'tl', x: -120, y: -60, kind: 'corner' },
      tr: { id: 'tr', x: 120, y: -60, kind: 'corner' },
      br: { id: 'br', x: 120, y: 60, kind: 'corner' },
      bl: { id: 'bl', x: -120, y: 60, kind: 'corner' },
    },
    edges: [
      { id: 'top', from: 'tl', to: 'tr', curve: 'line' },
      { id: 'right', from: 'tr', to: 'br', curve: 'line' },
      { id: 'bottom', from: 'br', to: 'bl', curve: 'line' },
      { id: 'left', from: 'bl', to: 'tl', curve: 'line' },
    ],
    closed: true,
    particleDistance: 16,
    placement: { position, rotation },
  }
}

function cloneMesh(mesh: ReturnType<typeof compileGarmentRuntime>['value']['simMesh']) {
  return {
    ...mesh,
    positions: new Float32Array(mesh.positions),
    prevPositions: new Float32Array(mesh.prevPositions),
    velocities: new Float32Array(mesh.velocities),
    invMass: new Float32Array(mesh.invMass),
    panelIds: [...mesh.panelIds],
    panelUvs: new Float32Array(mesh.panelUvs),
    panelLocalPositions: new Float32Array(mesh.panelLocalPositions),
    triangles: new Uint32Array(mesh.triangles),
    stretchConstraints: mesh.stretchConstraints.map((constraint) => ({ ...constraint })),
    shearConstraints: mesh.shearConstraints.map((constraint) => ({ ...constraint })),
    bendDistanceConstraints: mesh.bendDistanceConstraints.map((constraint) => ({ ...constraint })),
    bendConstraints: mesh.bendConstraints.map((constraint) => ({ ...constraint })),
    seamConstraints: mesh.seamConstraints.map((constraint) => ({ ...constraint })),
    pinConstraints: mesh.pinConstraints.map((constraint) => ({ ...constraint })),
  }
}

function pairingCost(
  panelA: PatternPanel,
  pointsA: Array<{ x: number; y: number }>,
  panelB: PatternPanel,
  pointsB: Array<{ x: number; y: number }>,
) {
  const n = Math.min(pointsA.length, pointsB.length)
  let sum = 0
  for (let index = 0; index < n; index += 1) {
    const a = place(panelA, pointsA[index])
    const b = place(panelB, pointsB[index])
    sum += (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
  }
  return sum
}

function place(panel: PatternPanel, point: { x: number; y: number }) {
  const yaw = panel.placement.rotation.y
  const px = point.x * 0.004
  const py = -point.y * 0.004
  return {
    x: panel.placement.position.x + px * Math.cos(yaw),
    y: panel.placement.position.y + py,
    z: panel.placement.position.z - px * Math.sin(yaw),
  }
}
