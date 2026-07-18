/// <reference types="node" />

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { createSeam } from './clothingActions'
import { clothingStore } from './clothingStore'
import type { GarmentDocument, PatternPiece } from './clothingTypes'

describe('clothingActions.createSeam', () => {
  beforeEach(() => {
    clothingStore.garment = buildGarment()
    clothingStore.dirty.previewDirty = false
    clothingStore.dirty.triangulationDirty = false
    clothingStore.history.past.length = 0
    clothingStore.history.future.length = 0
    clothingStore.selectedPatternIds = []
  })

  test('infers reversed seams for opposite edge directions', () => {
    const seamId = createSeam('front', 'edge', 'back', 'edge')
    const seam = clothingStore.garment.seams[seamId]
    assert.ok(seam)
    assert.equal(seam.b.reversed, true)
    assert.equal(clothingStore.garment.selectedSeamId, seamId)
    assert.equal(clothingStore.dirty.previewDirty, true)
    assert.equal(clothingStore.dirty.triangulationDirty, true)
  })

  test('reuses an existing seam for the same edge pair', () => {
    const first = createSeam('front', 'edge', 'back', 'edge')
    const second = createSeam('back', 'edge', 'front', 'edge')
    assert.equal(second, first)
    assert.equal(Object.keys(clothingStore.garment.seams).length, 1)
  })
})

function buildGarment(): GarmentDocument {
  return {
    id: 'garment',
    name: 'Seam Test',
    patterns: {
      front: buildPattern('front', false),
      back: buildPattern('back', true),
    },
    seams: {},
  }
}

function buildPattern(id: string, reversed: boolean): PatternPiece {
  const fromId = `${id}-from`
  const toId = `${id}-to`
  return {
    id,
    name: id,
    points: {
      [fromId]: { id: fromId, x: reversed ? 10 : 0, y: 0, kind: 'corner' },
      [toId]: { id: toId, x: reversed ? 0 : 10, y: 0, kind: 'corner' },
    },
    edges: [{ id: 'edge', from: fromId, to: toId, curve: 'line' }],
    closed: false,
    particleDistance: 20,
  }
}