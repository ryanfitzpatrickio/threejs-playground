import { sampleEdgeLoop, samplePatternOutline } from '../geometry/patternSampling'
import type { PatternPanel } from '../document/types'
import type { PanelDiscretization } from './types'

export function discretizePanel(panel: PatternPanel): PanelDiscretization {
  const outline = samplePatternOutline(panel, 12)
  const holes = (panel.holes ?? []).map((hole) => sampleEdgeLoop(panel, hole, 12))
  const points = Object.values(panel.points)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  if (!points.length) {
    minX = -140
    minY = -140
    maxX = 140
    maxY = 140
  }

  return {
    panel,
    outline,
    holes,
    bounds: {
      minX,
      minY,
      width: maxX - minX || 1,
      height: maxY - minY || 1,
    },
  }
}