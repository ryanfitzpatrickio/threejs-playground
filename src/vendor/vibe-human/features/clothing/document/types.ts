export type Vec2 = { x: number; y: number }
export type Vec3 = { x: number; y: number; z: number }

export type PatternPoint = {
  id: string
  x: number
  y: number
  in?: Vec2
  out?: Vec2
  kind: 'corner' | 'smooth' | 'symmetric'
}

export type PatternEdge = {
  id: string
  from: string
  to: string
  curve: 'line' | 'cubic'
}

export type PatternPlacement = {
  position: Vec3
  rotation: Vec3
}

export type FabricDefinition = {
  id: string
  name: string
  stretchCompliance?: number
  shearCompliance?: number
  bendCompliance?: number
  damping?: number
  friction?: number
  density?: number
}

export type PanelPin = {
  id: string
  u: number
  v: number
  weight?: number
}

export type GrainDirection = {
  angle: number
}

export type PatternPanel = {
  id: string
  name: string
  points: Record<string, PatternPoint>
  edges: PatternEdge[]
  holes?: PatternEdge[][]
  closed: boolean
  fabricId?: string
  color?: string
  particleDistance: number
  stretchCompliance?: number
  shearCompliance?: number
  bendCompliance?: number
  damping?: number
  friction?: number
  placement: PatternPlacement
  pins?: PanelPin[]
  grain?: GrainDirection
  metadata?: Record<string, unknown>
}

export type SeamEndpoint = {
  panelId: string
  edgeId: string
  reversed?: boolean
}

export type PatternSeam = {
  id: string
  name: string
  a: SeamEndpoint
  b: SeamEndpoint
  strength: number
}

export type PatternTack = {
  id: string
  a: { panelId: string; x: number; y: number }
  b: { panelId: string; x: number; y: number }
  strength: number
}

export type PatternDocument = {
  id: string
  name: string
  panels: Record<string, PatternPanel>
  seams: Record<string, PatternSeam>
  tacks?: Record<string, PatternTack>
  fabrics?: Record<string, FabricDefinition>
  metadata?: Record<string, unknown>
}
