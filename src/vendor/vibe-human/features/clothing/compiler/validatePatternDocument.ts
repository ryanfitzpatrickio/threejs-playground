import type { PatternDocument } from '../document/types'
import type { CompilerIssue } from './types'

export function validatePatternDocument(document: PatternDocument): CompilerIssue[] {
  const issues: CompilerIssue[] = []

  for (const seam of Object.values(document.seams)) {
    const panelA = document.panels[seam.a.panelId]
    const panelB = document.panels[seam.b.panelId]
    if (!panelA) {
      issues.push({
        code: 'invalid-seam-panel-a',
        message: `Seam ${seam.id} references missing panel ${seam.a.panelId}`,
        severity: 'error',
      })
      continue
    }
    if (!panelB) {
      issues.push({
        code: 'invalid-seam-panel-b',
        message: `Seam ${seam.id} references missing panel ${seam.b.panelId}`,
        severity: 'error',
      })
      continue
    }
    if (!panelA.edges.some((edge) => edge.id === seam.a.edgeId)) {
      issues.push({
        code: 'invalid-seam-edge-a',
        message: `Seam ${seam.id} references missing edge ${seam.a.edgeId}`,
        severity: 'error',
      })
    }
    if (!panelB.edges.some((edge) => edge.id === seam.b.edgeId)) {
      issues.push({
        code: 'invalid-seam-edge-b',
        message: `Seam ${seam.id} references missing edge ${seam.b.edgeId}`,
        severity: 'error',
      })
    }
  }

  for (const panel of Object.values(document.panels)) {
    if (!panel.closed) {
      issues.push({
        code: 'open-panel',
        message: `Panel ${panel.id} is open and will not simulate as a closed garment panel`,
        severity: 'warning',
      })
    }
  }

  return issues
}