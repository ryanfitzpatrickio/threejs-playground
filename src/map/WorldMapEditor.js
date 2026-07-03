/**
 * WorldMapEditor.js
 *
 * A standalone top-down 2D <canvas> editor for the "world map" (zones + POIs).
 * Mirrors MapBuilder's lifecycle contract (start/dispose/onChange/getProjectJSON/
 * flushAutosave) so it drops into the app the same way. No three.js — pure 2D.
 *
 * Produces the format defined in src/world/worldMap/worldMapSchema.js, which a
 * later milestone's composed streaming runtime will consume.
 */

import {
  ZONE_TYPES,
  POI_KINDS,
  ENTITY_GROUND_MODES,
  CITY_STYLES,
  createEmptyWorldMap,
  normalizeWorldMap,
  makeId,
} from '../world/worldMap/worldMapSchema.js';
import { zoneContains, zoneBounds } from '../world/worldMap/zoneGeometry.js';
import { sampleCenterline } from '../world/worldMap/roadProfile.js';
import * as Scenes from '../world/worldMap/worldMapScenes.js';
import * as Blueprints from './blueprintLibrary.js';
import { getWorldMapDraft, setWorldMapDraft } from '../store/fileStore.js';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const MIN_ZONE_WORLD = 2; // reject sub-2m drags as accidental clicks
const POI_SCREEN_RADIUS = 6;
const HISTORY_LIMIT = 100;

// Click priority for overlapping zones. Non-terrain zones (city/loopout/wilds)
// beat terrain so a large base terrain zone does not block selecting/editing
// contained feature zones. Within same priority, last-in-array wins (matches draw).
const ZONE_CLICK_PRIORITY = { terrain: 0, city: 2, loopout: 2, wilds: 2 };

export class WorldMapEditor {
  constructor({ canvas, onChange = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange ?? (() => {});

    this.map = createEmptyWorldMap();

    this.view = { panX: 0, panZ: 0, zoom: 0.7 };
    this.tool = 'select'; // select | terrain | city | loopout | wilds | poi | entity | spawn | pan
    this.activeZoneType = 'terrain';
    this.activeCityStyle = 'downtown';
    this.activePoiKind = 'landmark';
    this.activeBlueprintId = null; // picked blueprint for the entity tool
    this.activeEntityGroundMode = 'none'; // ENTITY_GROUND_MODES key
    this.drawShape = 'rect'; // 'rect' | 'poly' — how zone tools draw
    this.showGrid = true;
    this.snap = true;

    this.roadWidth = 8; // default width for new roads
    this.roadTrackStyle = null; // default GT3 trackside preset for new roads (null = plain)
    this.roadElevation = null; // null follows terrain; finite number is fixed world Y
    this.riverWidth = 10; // default width for new rivers
    this.riverDepth = 6; // default depth (carve) for new rivers
    this.riverOceanLeft = false; // default ocean-fill (left) for new rivers
    this.riverOceanRight = false; // default ocean-fill (right) for new rivers
    this.selection = null; // { kind:'zone'|'poi'|'road'|'river'|'entity', id }
    this.drag = null;
    this.polyDraft = null; // { type, points:[{x,z}] } while drawing a polygon
    this.roadDraft = null; // { points:[{x,z}] } while drawing a road spline
    this.riverDraft = null; // { points:[{x,z}] } while drawing a river spline
    this.mouseWorld = { x: 0, z: 0 };
    this.spaceDown = false;

    this.undoStack = [];
    this.redoStack = [];
    this.currentSceneId = null;

    this.cssWidth = 0;
    this.cssHeight = 0;
    this._raf = 0;
    this._dirty = true;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onResize = this._resize.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
    this._onStoreHydrated = () => this.emitChange();
  }

  async start() {
    if (typeof window !== 'undefined') {
      window.addEventListener('dreamfall:store-hydrated', this._onStoreHydrated);
    }
    this._restoreAutosave();
    this._resize();

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    this.canvas.addEventListener('dblclick', this._onDblClick);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('resize', this._onResize);

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._resize());
      this._resizeObserver.observe(this.canvas);
    }

    this._fitToBounds();
    this._loop();
    this.emitChange();
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('dreamfall:store-hydrated', this._onStoreHydrated);
    }
    cancelAnimationFrame(this._raf);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('dblclick', this._onDblClick);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    this._resizeObserver?.disconnect();
    this.flushAutosave();
  }

  // ----------------------------------------------------------------------
  // View transform
  // ----------------------------------------------------------------------
  worldToScreen(wx, wz) {
    const cx = this.cssWidth * 0.5;
    const cy = this.cssHeight * 0.5;
    return {
      x: (wx - this.view.panX) * this.view.zoom + cx,
      y: (wz - this.view.panZ) * this.view.zoom + cy,
    };
  }

  screenToWorld(sx, sy) {
    const cx = this.cssWidth * 0.5;
    const cy = this.cssHeight * 0.5;
    return {
      x: (sx - cx) / this.view.zoom + this.view.panX,
      z: (sy - cy) / this.view.zoom + this.view.panZ,
    };
  }

  _snapValue(v) {
    if (!this.snap) return v;
    const s = this.map.chunkSize || 32;
    return Math.round(v / s) * s;
  }

  _fitToBounds() {
    const b = this.map.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    if (w <= 0 || h <= 0 || this.cssWidth <= 0) return;
    const margin = 0.85;
    this.view.zoom = clamp(
      Math.min((this.cssWidth * margin) / w, (this.cssHeight * margin) / h),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.view.panX = (b.minX + b.maxX) * 0.5;
    this.view.panZ = (b.minZ + b.maxZ) * 0.5;
    this._dirty = true;
  }

  // ----------------------------------------------------------------------
  // Pointer / interaction
  // ----------------------------------------------------------------------
  _localPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this._localPointer(e);
    const world = this.screenToWorld(p.x, p.y);
    const panMode = this.tool === 'pan' || this.spaceDown || e.button === 1;

    if (panMode) {
      this.drag = { mode: 'pan', startScreen: p, startPan: { x: this.view.panX, z: this.view.panZ } };
      return;
    }

    if (this.tool === 'select') {
      // If a road is already selected, prefer grabbing one of ITS control-point
      // handles (drawn in _drawRoad) over the whole-road/other-object hit test —
      // lets you fine-tune an end or a middle bend after the road is placed,
      // instead of only being able to drag the whole spline as a rigid body.
      if (this.selection?.kind === 'road') {
        const road = this._roadById(this.selection.id);
        const pointIndex = road ? this._hitPointHandle(road.points, p) : -1;
        if (pointIndex >= 0) {
          this.drag = {
            mode: 'move-road-point', id: road.id, index: pointIndex,
            before: this._snapshot(), moved: false,
          };
          this.emitChange();
          this._dirty = true;
          return;
        }
      }
      // Same fine-tuning for a selected river's control points.
      if (this.selection?.kind === 'river') {
        const river = this._riverById(this.selection.id);
        const pointIndex = river ? this._hitPointHandle(river.points, p) : -1;
        if (pointIndex >= 0) {
          this.drag = {
            mode: 'move-river-point', id: river.id, index: pointIndex,
            before: this._snapshot(), moved: false,
          };
          this.emitChange();
          this._dirty = true;
          return;
        }
      }
      // Corner grips on an already-selected rect zone (resize affordance).
      // Whole-zone drag is handled after the general hitTest.
      if (this.selection?.kind === 'zone') {
        const zone = this._zoneById(this.selection.id);
        const corner = zone ? this._hitZoneCornerHandle(zone, p) : -1;
        if (corner >= 0) {
          this.drag = {
            mode: 'resize-zone-corner',
            id: zone.id,
            corner,
            orig: { ...zone.rect },
            before: this._snapshot(),
            moved: false,
          };
          this.emitChange();
          this._dirty = true;
          return;
        }
      }
      const hit = this._hitTest(p);
      this.selection = hit;
      if (hit?.kind === 'zone') {
        const zone = this._zoneById(hit.id);
        const orig = zone.shape === 'polygon'
          ? { shape: 'polygon', points: zone.points.map((q) => ({ ...q })) }
          : { shape: 'rect', rect: { ...zone.rect } };
        this.drag = { mode: 'move-zone', id: hit.id, grab: world, orig, before: this._snapshot(), moved: false };
      } else if (hit?.kind === 'road') {
        const road = this._roadById(hit.id);
        this.drag = { mode: 'move-road', id: hit.id, grab: world, orig: road.points.map((q) => ({ ...q })), before: this._snapshot(), moved: false };
      } else if (hit?.kind === 'river') {
        const river = this._riverById(hit.id);
        this.drag = { mode: 'move-river', id: hit.id, grab: world, orig: river.points.map((q) => ({ ...q })), before: this._snapshot(), moved: false };
      } else if (hit?.kind === 'poi') {
        const poi = this._poiById(hit.id);
        this.drag = { mode: 'move-poi', id: hit.id, grab: world, orig: { x: poi.x, z: poi.z }, before: this._snapshot(), moved: false };
      } else if (hit?.kind === 'entity') {
        const entity = this._entityById(hit.id);
        this.drag = { mode: 'move-entity', id: hit.id, grab: world, orig: { x: entity.x, z: entity.z }, before: this._snapshot(), moved: false };
      }
      this.emitChange();
      this._dirty = true;
      return;
    }

    if (this.tool === 'poi') {
      this._commit(() => {
        const poi = { id: makeId('p'), name: POI_KINDS[this.activePoiKind].label, kind: this.activePoiKind, x: this._snapValue(world.x), z: this._snapValue(world.z) };
        this.map.pois.push(poi);
        this.selection = { kind: 'poi', id: poi.id };
      });
      this.tool = 'select';
      this.emitChange();
      return;
    }

    if (this.tool === 'entity') {
      if (!this.activeBlueprintId) {
        // No blueprint picked — flash a hint and stay in the tool.
        this._dirty = true;
        this.emitChange();
        return;
      }
      this._commit(() => {
        const bp = Blueprints.getBlueprint(this.activeBlueprintId);
        const entity = {
          id: makeId('e'),
          name: bp?.name ?? 'Entity',
          blueprintId: this.activeBlueprintId,
          x: this._snapValue(world.x),
          z: this._snapValue(world.z),
          yaw: 0,
          scale: 1,
          groundMode: this.activeEntityGroundMode,
        };
        this.map.entities.push(entity);
        this.selection = { kind: 'entity', id: entity.id };
      });
      this.tool = 'select';
      this.emitChange();
      return;
    }

    if (this.tool === 'spawn') {
      this._commit(() => {
        this.map.spawn.x = this._snapValue(world.x);
        this.map.spawn.z = this._snapValue(world.z);
      });
      this.tool = 'select';
      this.emitChange();
      return;
    }

    if (this.tool === 'road') {
      // Open spline: each click adds a grid-snapped point.
      if (!this.roadDraft) this.roadDraft = { points: [] };
      this.roadDraft.points.push({ x: this._snapValue(world.x), z: this._snapValue(world.z) });
      this._dirty = true;
      return;
    }

    if (this.tool === 'river') {
      // Open spline: each click adds a grid-snapped point.
      if (!this.riverDraft) this.riverDraft = { points: [] };
      this.riverDraft.points.push({ x: this._snapValue(world.x), z: this._snapValue(world.z) });
      this._dirty = true;
      return;
    }

    // Zone-creation tools (terrain/city/loopout/wilds).
    if (ZONE_TYPES[this.tool]) {
      const sx = this._snapValue(world.x);
      const sz = this._snapValue(world.z);
      if (this.drawShape === 'poly') {
        // Polygon: click to add a vertex; clicking near the first closes it.
        if (!this.polyDraft || this.polyDraft.type !== this.tool) {
          this.polyDraft = { type: this.tool, points: [] };
        }
        const pts = this.polyDraft.points;
        if (pts.length >= 3) {
          const first = this.worldToScreen(pts[0].x, pts[0].z);
          if (Math.hypot(first.x - p.x, first.y - p.y) <= 10) {
            this._closePolyDraft();
            return;
          }
        }
        pts.push({ x: sx, z: sz });
        this._dirty = true;
        return;
      }
      // Rectangle: click-drag.
      this.drag = { mode: 'create', type: this.tool, start: { x: sx, z: sz }, cur: { x: sx, z: sz } };
    }
  }

  _onDblClick(e) {
    // Double-click finishes an in-progress polygon/road (the first click of the
    // pair already added a vertex; drop that duplicate before finishing).
    if (this.roadDraft) {
      e.preventDefault();
      if (this.roadDraft.points.length > 2) this.roadDraft.points.pop();
      this._finishRoadDraft();
      return;
    }
    if (this.riverDraft) {
      e.preventDefault();
      if (this.riverDraft.points.length > 2) this.riverDraft.points.pop();
      this._finishRiverDraft();
      return;
    }
    if (this.polyDraft) {
      e.preventDefault();
      if (this.polyDraft.points.length > 3) this.polyDraft.points.pop();
      this._closePolyDraft();
    }
  }

  _finishRoadDraft() {
    const draft = this.roadDraft;
    this.roadDraft = null;
    if (!draft || draft.points.length < 2) {
      this._dirty = true;
      this.emitChange();
      return;
    }
    this._commit(() => {
      const road = { id: makeId('r'), points: draft.points, width: this.roadWidth, type: 'road', trackStyle: this.roadTrackStyle, elevation: this.roadElevation };
      this.map.roads.push(road);
      this.selection = { kind: 'road', id: road.id };
    });
    this.tool = 'select';
    this.emitChange();
  }

  _finishRiverDraft() {
    const draft = this.riverDraft;
    this.riverDraft = null;
    if (!draft || draft.points.length < 2) {
      this._dirty = true;
      this.emitChange();
      return;
    }
    this._commit(() => {
      const river = {
        id: makeId('rv'), points: draft.points, width: this.riverWidth, depth: this.riverDepth, type: 'river',
        oceanLeft: this.riverOceanLeft, oceanRight: this.riverOceanRight,
      };
      this.map.rivers.push(river);
      this.selection = { kind: 'river', id: river.id };
    });
    this.tool = 'select';
    this.emitChange();
  }

  _closePolyDraft() {
    const draft = this.polyDraft;
    this.polyDraft = null;
    if (!draft || draft.points.length < 3) {
      this._dirty = true;
      this.emitChange();
      return;
    }
    this._commit(() => {
      const zone = {
        id: makeId('z'),
        type: draft.type,
        shape: 'polygon',
        points: draft.points,
        props: draft.type === 'city' ? { seed: (Math.random() * 1e9) | 0, cityStyle: this.activeCityStyle } : {},
      };
      this.map.zones.push(zone);
      this.selection = { kind: 'zone', id: zone.id };
    });
    this.tool = 'select';
    this.emitChange();
  }

  _onPointerMove(e) {
    const p = this._localPointer(e);
    this.mouseWorld = this.screenToWorld(p.x, p.y);
    this._dirty = true;

    if (!this.drag) {
      // Cheap throttle: only emit on move when idle if mouse moved a lot — skip,
      // the render loop draws the HUD coords. Emit lightly for the controls.
      return;
    }

    if (this.drag.mode === 'pan') {
      const dx = (p.x - this.drag.startScreen.x) / this.view.zoom;
      const dy = (p.y - this.drag.startScreen.y) / this.view.zoom;
      this.view.panX = this.drag.startPan.x - dx;
      this.view.panZ = this.drag.startPan.z - dy;
    } else if (this.drag.mode === 'create') {
      this.drag.cur = { x: this._snapValue(this.mouseWorld.x), z: this._snapValue(this.mouseWorld.z) };
    } else if (this.drag.mode === 'move-zone') {
      const zone = this._zoneById(this.drag.id);
      if (zone) {
        this.drag.moved = true;
        let dx = this.mouseWorld.x - this.drag.grab.x;
        let dz = this.mouseWorld.z - this.drag.grab.z;
        if (this.snap) { dx = this._snapValue(dx); dz = this._snapValue(dz); }
        const orig = this.drag.orig;
        if (orig.shape === 'polygon') {
          zone.points = orig.points.map((q) => ({ x: q.x + dx, z: q.z + dz }));
        } else {
          zone.rect = {
            minX: orig.rect.minX + dx,
            minZ: orig.rect.minZ + dz,
            maxX: orig.rect.maxX + dx,
            maxZ: orig.rect.maxZ + dz,
          };
        }
      }
    } else if (this.drag.mode === 'resize-zone-corner') {
      const zone = this._zoneById(this.drag.id);
      if (zone && zone.shape === 'rect') {
        this.drag.moved = true;
        let x = this.mouseWorld.x;
        let z = this.mouseWorld.z;
        if (this.snap) {
          x = this._snapValue(x);
          z = this._snapValue(z);
        }
        const orig = this.drag.orig;
        const c = this.drag.corner;
        let minX = orig.minX;
        let minZ = orig.minZ;
        let maxX = orig.maxX;
        let maxZ = orig.maxZ;
        if (c === 0 || c === 2) minX = x;
        else maxX = x;
        if (c === 0 || c === 1) minZ = z;
        else maxZ = z;
        // Normalize if user dragged a corner past the opposite edge (swap roles)
        if (minX > maxX) [minX, maxX] = [maxX, minX];
        if (minZ > maxZ) [minZ, maxZ] = [maxZ, minZ];
        // Enforce min size by clamping the dragged edge (prevents degenerate zones)
        const MIN = MIN_ZONE_WORLD;
        if (maxX - minX < MIN) {
          if (c === 0 || c === 2) minX = maxX - MIN;
          else maxX = minX + MIN;
        }
        if (maxZ - minZ < MIN) {
          if (c === 0 || c === 1) minZ = maxZ - MIN;
          else maxZ = minZ + MIN;
        }
        zone.rect = { minX, minZ, maxX, maxZ };
      }
    } else if (this.drag.mode === 'move-road') {
      const road = this._roadById(this.drag.id);
      if (road) {
        this.drag.moved = true;
        let dx = this.mouseWorld.x - this.drag.grab.x;
        let dz = this.mouseWorld.z - this.drag.grab.z;
        if (this.snap) { dx = this._snapValue(dx); dz = this._snapValue(dz); }
        road.points = this.drag.orig.map((q) => ({ x: q.x + dx, z: q.z + dz }));
      }
    } else if (this.drag.mode === 'move-road-point') {
      const road = this._roadById(this.drag.id);
      if (road) {
        this.drag.moved = true;
        road.points[this.drag.index] = { x: this._snapValue(this.mouseWorld.x), z: this._snapValue(this.mouseWorld.z) };
      }
    } else if (this.drag.mode === 'move-river') {
      const river = this._riverById(this.drag.id);
      if (river) {
        this.drag.moved = true;
        let dx = this.mouseWorld.x - this.drag.grab.x;
        let dz = this.mouseWorld.z - this.drag.grab.z;
        if (this.snap) { dx = this._snapValue(dx); dz = this._snapValue(dz); }
        river.points = this.drag.orig.map((q) => ({ x: q.x + dx, z: q.z + dz }));
      }
    } else if (this.drag.mode === 'move-river-point') {
      const river = this._riverById(this.drag.id);
      if (river) {
        this.drag.moved = true;
        river.points[this.drag.index] = { x: this._snapValue(this.mouseWorld.x), z: this._snapValue(this.mouseWorld.z) };
      }
    } else if (this.drag.mode === 'move-poi') {
      const poi = this._poiById(this.drag.id);
      if (poi) {
        this.drag.moved = true;
        let x = this.drag.orig.x + (this.mouseWorld.x - this.drag.grab.x);
        let z = this.drag.orig.z + (this.mouseWorld.z - this.drag.grab.z);
        poi.x = this._snapValue(x);
        poi.z = this._snapValue(z);
      }
    } else if (this.drag.mode === 'move-entity') {
      const entity = this._entityById(this.drag.id);
      if (entity) {
        this.drag.moved = true;
        let x = this.drag.orig.x + (this.mouseWorld.x - this.drag.grab.x);
        let z = this.drag.orig.z + (this.mouseWorld.z - this.drag.grab.z);
        entity.x = this._snapValue(x);
        entity.z = this._snapValue(z);
      }
    }
  }

  _onPointerUp(e) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;

    if (drag.mode === 'create') {
      const minX = Math.min(drag.start.x, drag.cur.x);
      const maxX = Math.max(drag.start.x, drag.cur.x);
      const minZ = Math.min(drag.start.z, drag.cur.z);
      const maxZ = Math.max(drag.start.z, drag.cur.z);
      if (maxX - minX >= MIN_ZONE_WORLD && maxZ - minZ >= MIN_ZONE_WORLD) {
        this._commit(() => {
          const zone = {
            id: makeId('z'),
            type: drag.type,
            shape: 'rect',
            rect: { minX, minZ, maxX, maxZ },
            props: drag.type === 'city' ? { seed: (Math.random() * 1e9) | 0, cityStyle: this.activeCityStyle } : {},
          };
          this.map.zones.push(zone);
          this.selection = { kind: 'zone', id: zone.id };
        });
        this.tool = 'select';
      }
    } else if ((drag.mode === 'move-zone' || drag.mode === 'resize-zone-corner' || drag.mode === 'move-poi' || drag.mode === 'move-road' || drag.mode === 'move-road-point' || drag.mode === 'move-river' || drag.mode === 'move-river-point' || drag.mode === 'move-entity') && drag.moved) {
      // Persist the move/resize as one undo step (the "before" snapshot was captured
      // at drag start; state has already been mutated live during the drag).
      this._pushHistorySnapshotOf(drag.before ?? null);
      this.flushAutosave();
    }
    this.emitChange();
  }

  _onWheel(e) {
    e.preventDefault();
    const p = this._localPointer(e);
    const before = this.screenToWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0014);
    this.view.zoom = clamp(this.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(p.x, p.y);
    this.view.panX += before.x - after.x;
    this.view.panZ += before.z - after.z;
    this._dirty = true;
    this.emitChange();
  }

  _onKeyDown(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.roadDraft) {
      if (e.key === 'Enter') { e.preventDefault(); this._finishRoadDraft(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.roadDraft = null; this._dirty = true; this.emitChange(); return; }
    }
    if (this.riverDraft) {
      if (e.key === 'Enter') { e.preventDefault(); this._finishRiverDraft(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.riverDraft = null; this._dirty = true; this.emitChange(); return; }
    }
    if (this.polyDraft) {
      if (e.key === 'Enter') { e.preventDefault(); this._closePolyDraft(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.polyDraft = null; this._dirty = true; this.emitChange(); return; }
    }
    if (e.code === 'Space') { this.spaceDown = true; return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection) { e.preventDefault(); this.deleteSelected(); }
    }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') this.spaceDown = false;
  }

  // ----------------------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------------------
  _hitTest(screenPoint) {
    // Entities + POIs are points (small, on top); entities checked first so a
    // dense cluster still prefers the larger entity marker.
    for (let i = this.map.entities.length - 1; i >= 0; i -= 1) {
      const entity = this.map.entities[i];
      const s = this.worldToScreen(entity.x, entity.z);
      const r = POI_SCREEN_RADIUS + 3;
      if (Math.hypot(s.x - screenPoint.x, s.y - screenPoint.y) <= r) {
        return { kind: 'entity', id: entity.id };
      }
    }
    for (let i = this.map.pois.length - 1; i >= 0; i -= 1) {
      const poi = this.map.pois[i];
      const s = this.worldToScreen(poi.x, poi.z);
      if (Math.hypot(s.x - screenPoint.x, s.y - screenPoint.y) <= POI_SCREEN_RADIUS + 3) {
        return { kind: 'poi', id: poi.id };
      }
    }
    const world = this.screenToWorld(screenPoint.x, screenPoint.y);
    // Roads (thin) before zones.
    const pickPad = 4 / this.view.zoom; // a few px of slack in world units
    for (let i = this.map.roads.length - 1; i >= 0; i -= 1) {
      const road = this.map.roads[i];
      if (distanceToPolyline(sampleCenterline(road.points, 6), world.x, world.z) <= road.width * 0.5 + pickPad) {
        return { kind: 'road', id: road.id };
      }
    }
    for (let i = this.map.rivers.length - 1; i >= 0; i -= 1) {
      const river = this.map.rivers[i];
      if (distanceToPolyline(sampleCenterline(river.points, 6), world.x, world.z) <= river.width * 0.5 + pickPad) {
        return { kind: 'river', id: river.id };
      }
    }
    // Zones with click priority: non-terrain (cities etc) win over terrain zones.
    // Lets you click inner zones even when a terrain zone covers their area.
    let bestZone = null;
    let bestPrio = -1;
    for (let i = this.map.zones.length - 1; i >= 0; i -= 1) {
      const z = this.map.zones[i];
      if (zoneContains(z, world.x, world.z)) {
        const p = ZONE_CLICK_PRIORITY[z.type] ?? 0;
        if (p > bestPrio) {
          bestPrio = p;
          bestZone = z;
        }
        // equal prio keeps the last-in-array (first seen in reverse scan)
      }
    }
    if (bestZone) {
      return { kind: 'zone', id: bestZone.id };
    }
    return null;
  }

  // Nearest control-point handle (screen-space) within `radius` px, or -1. Used
  // to grab an individual road point (end or bend) once the road is selected,
  // rather than always dragging the whole spline as a rigid body.
  _hitPointHandle(points, screenPoint, radius = 7) {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const s = this.worldToScreen(points[i].x, points[i].z);
      if (Math.hypot(s.x - screenPoint.x, s.y - screenPoint.y) <= radius) return i;
    }
    return -1;
  }

  // Screen-space hit for the 4 corner grips of a rect zone (when already selected).
  // Returns 0..3 or -1. Order: TL(0), TR(1), BL(2), BR(3) in (minX/minZ etc).
  _hitZoneCornerHandle(zone, screenPoint, radius = 8) {
    if (!zone || zone.shape !== 'rect') return -1;
    const r = zone.rect;
    const corners = [
      { x: r.minX, z: r.minZ }, // 0
      { x: r.maxX, z: r.minZ }, // 1
      { x: r.minX, z: r.maxZ }, // 2
      { x: r.maxX, z: r.maxZ }, // 3
    ];
    for (let i = 0; i < 4; i += 1) {
      const s = this.worldToScreen(corners[i].x, corners[i].z);
      if (Math.hypot(s.x - screenPoint.x, s.y - screenPoint.y) <= radius) return i;
    }
    return -1;
  }

  _roadById(id) { return this.map.roads.find((r) => r.id === id) ?? null; }
  _riverById(id) { return this.map.rivers.find((r) => r.id === id) ?? null; }

  _zoneById(id) { return this.map.zones.find((z) => z.id === id) ?? null; }
  _poiById(id) { return this.map.pois.find((p) => p.id === id) ?? null; }
  _entityById(id) { return this.map.entities.find((e) => e.id === id) ?? null; }

  // Explicit selection (used by UI lists etc. to target a specific item even
  // if its area is hard to click due to overlaps).
  select(kind, id) {
    this.selection = kind && id ? { kind, id } : null;
    this._dirty = true;
    this.emitChange();
  }

  // Control stacking / priority. Later zones win for hit-testing within same
  // click priority tier, and for runtime zoneAtPoint() resolution (override order).
  // Bring-to-front makes a zone the "top" for its overlaps.
  bringZoneToFront(id) {
    const idx = this.map.zones.findIndex((z) => z.id === id);
    if (idx < 0) return;
    const [zone] = this.map.zones.splice(idx, 1);
    this.map.zones.push(zone);
    this._dirty = true;
    this.emitChange();
  }

  sendZoneToBack(id) {
    const idx = this.map.zones.findIndex((z) => z.id === id);
    if (idx < 0) return;
    const [zone] = this.map.zones.splice(idx, 1);
    this.map.zones.unshift(zone);
    this._dirty = true;
    this.emitChange();
  }

  // ----------------------------------------------------------------------
  // History + mutations
  // ----------------------------------------------------------------------
  _snapshot() { return JSON.stringify(this.map); }

  _pushHistory() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  _pushHistorySnapshotOf(beforeJson) {
    // Used by drag-move: the "before" snapshot was captured at drag start.
    if (beforeJson) {
      this.undoStack.push(beforeJson);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    } else {
      this._pushHistory();
    }
    this.redoStack.length = 0;
  }

  // Run a mutation as a single undoable step.
  _commit(fn) {
    this._pushHistory();
    fn();
    this._dirty = true;
    this.flushAutosave();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this._snapshot());
    this.map = normalizeWorldMap(JSON.parse(this.undoStack.pop()));
    this.selection = null;
    this._dirty = true;
    this.flushAutosave();
    this.emitChange();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this._snapshot());
    this.map = normalizeWorldMap(JSON.parse(this.redoStack.pop()));
    this.selection = null;
    this._dirty = true;
    this.flushAutosave();
    this.emitChange();
  }

  deleteSelected() {
    if (!this.selection) return;
    this._commit(() => {
      if (this.selection.kind === 'zone') {
        this.map.zones = this.map.zones.filter((z) => z.id !== this.selection.id);
      } else if (this.selection.kind === 'road') {
        this.map.roads = this.map.roads.filter((r) => r.id !== this.selection.id);
      } else if (this.selection.kind === 'river') {
        this.map.rivers = this.map.rivers.filter((r) => r.id !== this.selection.id);
      } else if (this.selection.kind === 'entity') {
        this.map.entities = this.map.entities.filter((e) => e.id !== this.selection.id);
      } else {
        this.map.pois = this.map.pois.filter((p) => p.id !== this.selection.id);
      }
      this.selection = null;
    });
    this.emitChange();
  }

  clearAll() {
    this._commit(() => {
      this.map.zones = [];
      this.map.roads = [];
      this.map.rivers = [];
      this.map.pois = [];
      this.map.entities = [];
      this.selection = null;
    });
    this.emitChange();
  }

  setRoadWidth(width) {
    const w = Math.max(2, Number(width) || this.roadWidth);
    this.roadWidth = w;
    // Also resize the selected road, if any.
    if (this.selection?.kind === 'road') {
      const road = this._roadById(this.selection.id);
      if (road) { road.width = w; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  setRoadTrackStyle(style) {
    // Empty string from the UI dropdown → plain road (null).
    const next = style ? String(style) : null;
    this.roadTrackStyle = next;
    // Also restyle the selected road, if any.
    if (this.selection?.kind === 'road') {
      const road = this._roadById(this.selection.id);
      if (road) { road.trackStyle = next; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  setRoadElevation(value) {
    const numeric = value === null || value === '' ? NaN : Number(value);
    const next = Number.isFinite(numeric) ? numeric : null;
    this.roadElevation = next;
    if (this.selection?.kind === 'road') {
      const road = this._roadById(this.selection.id);
      if (road) { road.elevation = next; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  setRiverWidth(width) {
    const w = Math.max(2, Number(width) || this.riverWidth);
    this.riverWidth = w;
    if (this.selection?.kind === 'river') {
      const river = this._riverById(this.selection.id);
      if (river) { river.width = w; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  setRiverDepth(depth) {
    const d = Math.max(1, Number(depth) || this.riverDepth);
    this.riverDepth = d;
    if (this.selection?.kind === 'river') {
      const river = this._riverById(this.selection.id);
      if (river) { river.depth = d; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  // Ocean fill: the flagged side never fades back to natural terrain (infinite
  // ocean/coastline) instead of the normal symmetric channel banks.
  setRiverOceanLeft(value) {
    const v = !!value;
    this.riverOceanLeft = v;
    if (this.selection?.kind === 'river') {
      const river = this._riverById(this.selection.id);
      if (river) { river.oceanLeft = v; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  setRiverOceanRight(value) {
    const v = !!value;
    this.riverOceanRight = v;
    if (this.selection?.kind === 'river') {
      const river = this._riverById(this.selection.id);
      if (river) { river.oceanRight = v; this.flushAutosave(); }
    }
    this._dirty = true;
    this.emitChange();
  }

  // ----------------------------------------------------------------------
  // Public setters (driven by the controls panel)
  // ----------------------------------------------------------------------
  setTool(tool) { this.tool = tool; this.polyDraft = null; this.roadDraft = null; this.riverDraft = null; this._dirty = true; this.emitChange(); }
  setActiveZoneType(type) { if (ZONE_TYPES[type]) { this.activeZoneType = type; this.tool = type; if (this.polyDraft) this.polyDraft = null; } this.emitChange(); }
  setActiveCityStyle(style) { if (CITY_STYLES[style]) this.activeCityStyle = style; this.emitChange(); }
  setDrawShape(shape) { this.drawShape = shape === 'poly' ? 'poly' : 'rect'; if (this.polyDraft) this.polyDraft = null; this._dirty = true; this.emitChange(); }
  setActivePoiKind(kind) { if (POI_KINDS[kind]) this.activePoiKind = kind; this.emitChange(); }
  toggleGrid() { this.showGrid = !this.showGrid; this._dirty = true; this.emitChange(); }
  toggleSnap() { this.snap = !this.snap; this.emitChange(); }
  fitView() { this._fitToBounds(); this.emitChange(); }

  setName(name) { this.map.name = String(name ?? ''); this.flushAutosave(); this.emitChange(); }

  setChunkSize(size) {
    const s = Math.max(1, Number(size) || this.map.chunkSize);
    this._commit(() => { this.map.chunkSize = s; });
    this.emitChange();
  }

  setBounds(patch = {}) {
    this._commit(() => {
      const b = this.map.bounds;
      this.map.bounds = {
        minX: numOr(patch.minX, b.minX),
        minZ: numOr(patch.minZ, b.minZ),
        maxX: numOr(patch.maxX, b.maxX),
        maxZ: numOr(patch.maxZ, b.maxZ),
      };
    });
    this.emitChange();
  }

  setSelectedName(name) {
    if (this.selection?.kind === 'poi') {
      const poi = this._poiById(this.selection.id);
      if (poi) { poi.name = String(name ?? ''); this.flushAutosave(); this.emitChange(); }
    } else if (this.selection?.kind === 'entity') {
      const entity = this._entityById(this.selection.id);
      if (entity) { entity.name = String(name ?? ''); this.flushAutosave(); this.emitChange(); }
    }
  }

  // Entity tool state (which blueprint / ground mode new entities get).
  setActiveBlueprint(id) {
    if (id && Blueprints.getBlueprint(id)) this.activeBlueprintId = id;
    else if (id === null || id === '') this.activeBlueprintId = null;
    this.emitChange();
  }

  setActiveEntityGroundMode(mode) {
    if (ENTITY_GROUND_MODES[mode]) this.activeEntityGroundMode = mode;
    this.emitChange();
  }

  // Per-entity property edits (driven by the selection panel).
  setSelectedEntityBlueprint(id) {
    if (this.selection?.kind !== 'entity') return;
    if (!id || !Blueprints.getBlueprint(id)) return;
    const entity = this._entityById(this.selection.id);
    if (entity) { entity.blueprintId = id; entity.name = Blueprints.getBlueprint(id)?.name ?? entity.name; this.flushAutosave(); this.emitChange(); }
  }

  setSelectedEntityYaw(deg) {
    if (this.selection?.kind !== 'entity') return;
    const entity = this._entityById(this.selection.id);
    if (entity) { entity.yaw = (((Number(deg) || 0) % 360) + 360) % 360; this.flushAutosave(); this.emitChange(); }
  }

  setSelectedEntityScale(scale) {
    if (this.selection?.kind !== 'entity') return;
    const entity = this._entityById(this.selection.id);
    if (entity) { entity.scale = Math.max(0.01, Number(scale) || 0.01); this.flushAutosave(); this.emitChange(); }
  }

  setSelectedEntityGroundMode(mode) {
    if (this.selection?.kind !== 'entity') return;
    if (!ENTITY_GROUND_MODES[mode]) return;
    const entity = this._entityById(this.selection.id);
    if (entity) { entity.groundMode = mode; this.flushAutosave(); this.emitChange(); }
  }

  setSelectedCitySeed(seed) {
    if (this.selection?.kind !== 'zone') return;
    const zone = this._zoneById(this.selection.id);
    if (zone && zone.type === 'city') {
      this._commit(() => { zone.props = { ...zone.props, seed: Number(seed) || 0 }; });
      this.emitChange();
    }
  }

  setSelectedCityStyle(style) {
    if (this.selection?.kind !== 'zone' || !CITY_STYLES[style]) return;
    const zone = this._zoneById(this.selection.id);
    if (zone?.type === 'city') {
      this._commit(() => { zone.props = { ...zone.props, cityStyle: style }; });
      this.emitChange();
    }
  }

  setSelectedBiome(biome) {
    if (this.selection?.kind !== 'zone') return;
    const zone = this._zoneById(this.selection.id);
    if (zone && zone.type === 'terrain') {
      zone.props = { ...zone.props, biome: biome || undefined };
      this.flushAutosave();
      this.emitChange();
    }
  }

  // Elevation constraint on a `terrain` zone: minHeight guarantees the surface
  // never dips below it (e.g. "always > 0" for a guaranteed mountain); maxHeight
  // guarantees it never rises above it (e.g. "always < 0" for a canyon/valley
  // floor). Empty string clears the constraint (unconstrained on that side).
  setSelectedMinHeight(value) {
    if (this.selection?.kind !== 'zone') return;
    const zone = this._zoneById(this.selection.id);
    if (!zone || zone.type !== 'terrain') return;
    const n = Number(value);
    zone.props = { ...zone.props, minHeight: value === '' || !Number.isFinite(n) ? undefined : n };
    this.flushAutosave();
    this.emitChange();
  }

  setSelectedMaxHeight(value) {
    if (this.selection?.kind !== 'zone') return;
    const zone = this._zoneById(this.selection.id);
    if (!zone || zone.type !== 'terrain') return;
    const n = Number(value);
    zone.props = { ...zone.props, maxHeight: value === '' || !Number.isFinite(n) ? undefined : n };
    this.flushAutosave();
    this.emitChange();
  }

  // How much natural variation (metres) to preserve above minHeight / below
  // maxHeight — without this the terrain would just clamp flat at the floor or
  // ceiling. Empty clears it back to the automatic default (the zone's own biome
  // amplitude). Meaningless (ignored) when both minHeight and maxHeight are set,
  // since that band itself defines the relief.
  setSelectedRelief(value) {
    if (this.selection?.kind !== 'zone') return;
    const zone = this._zoneById(this.selection.id);
    if (!zone || zone.type !== 'terrain') return;
    const n = Number(value);
    zone.props = { ...zone.props, relief: value === '' || !Number.isFinite(n) || n <= 0 ? undefined : n };
    this.flushAutosave();
    this.emitChange();
  }

  // ----------------------------------------------------------------------
  // Named scenes (multi-map manager) — separate from the working autosave.
  // ----------------------------------------------------------------------
  saveSceneAs(name) {
    const finalName = (name ?? this.map.name ?? '').trim() || 'Untitled World';
    this.map.name = finalName;
    const meta = Scenes.saveScene({ name: finalName, map: this.getProjectJSON() });
    this.currentSceneId = meta.id;
    this.flushAutosave();
    this.emitChange();
    return meta;
  }

  loadSceneById(id) {
    const scene = Scenes.getScene(id);
    if (!scene) return;
    this.currentSceneId = scene.id;
    this.loadJSON(scene.map); // sets map + fits view + emits change
  }

  deleteSceneById(id) {
    Scenes.deleteScene(id);
    if (this.currentSceneId === id) this.currentSceneId = null;
    this.emitChange();
  }

  // ----------------------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------------------
  getProjectJSON() {
    return normalizeWorldMap(JSON.parse(JSON.stringify(this.map)));
  }

  loadJSON(json) {
    this._pushHistory();
    this.map = normalizeWorldMap(json, Blueprints.getBlueprintIds());
    this.selection = null;
    this._fitToBounds();
    this.flushAutosave();
    this.emitChange();
  }

  exportJSON() {
    const data = JSON.stringify(this.getProjectJSON(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(this.map.name || 'world-map').replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importJSON(file) {
    const text = await file.text();
    this.loadJSON(JSON.parse(text));
  }

  flushAutosave() {
    try {
      setWorldMapDraft(this.getProjectJSON(), { debounce: true });
    } catch {
      // non-fatal
    }
  }

  _restoreAutosave() {
    try {
      const draft = getWorldMapDraft();
      if (draft) {
        this.map = normalizeWorldMap(draft, Blueprints.getBlueprintIds());
        return;
      }
    } catch {
      // ignore corrupt storage
    }
    this.map = createEmptyWorldMap();
  }

  // ----------------------------------------------------------------------
  // Snapshot for the controls panel
  // ----------------------------------------------------------------------
  getSnapshot() {
    const byType = { terrain: 0, city: 0, loopout: 0, wilds: 0 };
    for (const z of this.map.zones) byType[z.type] = (byType[z.type] ?? 0) + 1;
    let selected = null;
    if (this.selection?.kind === 'zone') {
      const z = this._zoneById(this.selection.id);
      if (z) {
        selected = {
          kind: 'zone', id: z.id, type: z.type, shape: z.shape, seed: z.props?.seed, cityStyle: z.props?.cityStyle ?? 'downtown', biome: z.props?.biome ?? '',
          minHeight: z.props?.minHeight ?? '', maxHeight: z.props?.maxHeight ?? '', relief: z.props?.relief ?? '',
        };
      }
    } else if (this.selection?.kind === 'road') {
      const r = this._roadById(this.selection.id);
      if (r) selected = { kind: 'road', id: r.id, width: r.width, trackStyle: r.trackStyle ?? null, elevation: r.elevation ?? null };
    } else if (this.selection?.kind === 'river') {
      const rv = this._riverById(this.selection.id);
      if (rv) selected = { kind: 'river', id: rv.id, width: rv.width, depth: rv.depth, oceanLeft: !!rv.oceanLeft, oceanRight: !!rv.oceanRight };
    } else if (this.selection?.kind === 'poi') {
      const p = this._poiById(this.selection.id);
      if (p) selected = { kind: 'poi', id: p.id, name: p.name, poiKind: p.kind };
    } else if (this.selection?.kind === 'entity') {
      const e = this._entityById(this.selection.id);
      if (e) {
        const bp = Blueprints.getBlueprint(e.blueprintId);
        selected = {
          kind: 'entity',
          id: e.id,
          name: e.name,
          blueprintId: e.blueprintId,
          blueprintName: bp?.name ?? '(missing blueprint)',
          yaw: e.yaw,
          scale: e.scale,
          groundMode: e.groundMode,
        };
      }
    }
    return {
      tool: this.tool,
      activeZoneType: this.activeZoneType,
      activeCityStyle: this.activeCityStyle,
      activePoiKind: this.activePoiKind,
      activeBlueprintId: this.activeBlueprintId,
      activeEntityGroundMode: this.activeEntityGroundMode,
      blueprints: Blueprints.listBlueprints(),
      drawShape: this.drawShape,
      drawingPoly: Boolean(this.polyDraft),
      drawingRoad: Boolean(this.roadDraft),
      drawingRiver: Boolean(this.riverDraft),
      roadWidth: this.roadWidth,
      roadTrackStyle: this.roadTrackStyle,
      roadElevation: this.roadElevation,
      riverWidth: this.riverWidth,
      riverDepth: this.riverDepth,
      riverOceanLeft: this.riverOceanLeft,
      riverOceanRight: this.riverOceanRight,
      showGrid: this.showGrid,
      snap: this.snap,
      zoom: this.view.zoom,
      mouseWorld: { x: Math.round(this.mouseWorld.x), z: Math.round(this.mouseWorld.z) },
      name: this.map.name,
      chunkSize: this.map.chunkSize,
      bounds: { ...this.map.bounds },
      spawn: { ...this.map.spawn },
      stats: { zones: this.map.zones.length, roads: this.map.roads.length, rivers: this.map.rivers.length, pois: this.map.pois.length, entities: this.map.entities.length, byType },
      // Lightweight zone list for UI (direct select + reorder controls).
      zones: this.map.zones.map((z) => ({
        id: z.id,
        type: z.type,
        shape: z.shape || 'rect',
        label: ZONE_TYPES[z.type]?.label ?? z.type,
      })),
      selected,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      scenes: Scenes.listScenes(),
      currentSceneId: this.currentSceneId,
    };
  }

  emitChange() { this.onChange(this.getSnapshot()); }

  // ----------------------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------------------
  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dirty = true;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (!this._dirty) return;
    this._dirty = false;
    this._render();
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = '#11140f';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    if (this.showGrid) this._drawGrid(ctx);
    this._drawBounds(ctx);

    // Terrain zones first as the base layer, then feature zones (city/loop/wilds)
    // drawn on top. Prevents terrain fills from visually burying other zones.
    const terrainZones = this.map.zones.filter((z) => z.type === 'terrain');
    const otherZones = this.map.zones.filter((z) => z.type !== 'terrain');
    for (const zone of terrainZones) this._drawZone(ctx, zone);
    for (const zone of otherZones) this._drawZone(ctx, zone);
    if (this.drag?.mode === 'create') this._drawCreatePreview(ctx);
    if (this.polyDraft) this._drawPolyDraft(ctx);

    for (const road of this.map.roads) this._drawRoad(ctx, road);
    if (this.roadDraft) this._drawRoadDraft(ctx);

    for (const river of this.map.rivers) this._drawRiver(ctx, river);
    if (this.riverDraft) this._drawRiverDraft(ctx);

    for (const entity of this.map.entities) this._drawEntity(ctx, entity);
    for (const poi of this.map.pois) this._drawPoi(ctx, poi);
    this._drawSpawn(ctx);
    this._drawHud(ctx);
  }

  _drawGrid(ctx) {
    let step = this.map.chunkSize || 32;
    while (step * this.view.zoom < 8) step *= 2;
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.cssWidth, this.cssHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const s = this.worldToScreen(x, 0);
      ctx.moveTo(s.x, 0); ctx.lineTo(s.x, this.cssHeight);
    }
    for (let z = Math.floor(tl.z / step) * step; z <= br.z; z += step) {
      const s = this.worldToScreen(0, z);
      ctx.moveTo(0, s.y); ctx.lineTo(this.cssWidth, s.y);
    }
    ctx.stroke();
  }

  _drawBounds(ctx) {
    const b = this.map.bounds;
    const a = this.worldToScreen(b.minX, b.minZ);
    const c = this.worldToScreen(b.maxX, b.maxZ);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(247,244,232,0.5)';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.setLineDash([]);
  }

  _drawZone(ctx, zone) {
    const color = ZONE_TYPES[zone.type]?.color ?? '#888';
    const selected = this.selection?.kind === 'zone' && this.selection.id === zone.id;
    const b = zoneBounds(zone);
    const a = this.worldToScreen(b.minX, b.minZ);

    // Terrain zones use lower opacity so they don't visually bury inner zones.
    const isTerrain = zone.type === 'terrain';
    const fillAlpha = selected ? (isTerrain ? 0.38 : 0.52) : (isTerrain ? 0.16 : 0.30);
    ctx.fillStyle = hexToRgba(color, fillAlpha);
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.strokeStyle = selected ? '#fff' : color;

    if (zone.shape === 'polygon') {
      ctx.beginPath();
      const p0 = this.worldToScreen(zone.points[0].x, zone.points[0].z);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < zone.points.length; i += 1) {
        const s = this.worldToScreen(zone.points[i].x, zone.points[i].z);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const c = this.worldToScreen(b.maxX, b.maxZ);
      ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
      ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    }

    const label = ZONE_TYPES[zone.type]?.label ?? zone.type;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(label, a.x + 4, a.y + 3);

    // Resize grip squares at the four corners of a selected *rectangle* zone.
    // Gold highlight on hover (or while dragging that corner). Square shape
    // distinguishes from road/river round bend points. Only shown for rects.
    if (selected && zone.shape === 'rect' && this.tool === 'select') {
      const hoverCorner = !this.drag
        ? this._hitZoneCornerHandle(zone, this.worldToScreen(this.mouseWorld.x, this.mouseWorld.z))
        : -1;
      const activeCorner = (this.drag?.mode === 'resize-zone-corner' && this.drag.id === zone.id)
        ? this.drag.corner
        : hoverCorner;
      const r = zone.rect;
      const corners = [
        { x: r.minX, z: r.minZ },
        { x: r.maxX, z: r.minZ },
        { x: r.minX, z: r.maxZ },
        { x: r.maxX, z: r.maxZ },
      ];
      for (let i = 0; i < 4; i += 1) {
        const s = this.worldToScreen(corners[i].x, corners[i].z);
        const active = i === activeCorner;
        const size = active ? 5.5 : 4;
        ctx.fillStyle = active ? '#ffd25a' : '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(s.x - size, s.y - size, size * 2, size * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  _drawRoad(ctx, road) {
    const selected = this.selection?.kind === 'road' && this.selection.id === road.id;
    const pts = sampleCenterline(road.points, 6);
    if (pts.length < 2) return;
    // Paved width stroke.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = selected ? 'rgba(255,255,255,0.85)' : 'rgba(54,55,58,0.95)';
    ctx.lineWidth = Math.max(2, road.width * this.view.zoom);
    ctx.beginPath();
    const s0 = this.worldToScreen(pts[0].x, pts[0].z);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i += 1) {
      const s = this.worldToScreen(pts[i].x, pts[i].z);
      ctx.lineTo(s.x, s.y);
    }
    // Track-style roads get a dashed cyan outline (drawn wider, UNDER the paved
    // stroke) so they read as race circuits in the 2D map.
    if (road.trackStyle) {
      ctx.save();
      ctx.strokeStyle = 'rgba(90,210,225,0.9)';
      ctx.lineWidth = Math.max(2, road.width * this.view.zoom) + 5;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.restore();
    }
    ctx.stroke();
    // Center hairline + control-point handles.
    ctx.strokeStyle = 'rgba(230,200,90,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Handles glow gold + enlarge under the cursor (grabbable) or while actively
    // being dragged, so it's clear a bend/end point can be fine-tuned in place.
    const hoverIndex = selected && this.tool === 'select' && !this.drag
      ? this._hitPointHandle(road.points, this.worldToScreen(this.mouseWorld.x, this.mouseWorld.z))
      : -1;
    const dragIndex = this.drag?.mode === 'move-road-point' && this.drag.id === road.id ? this.drag.index : -1;
    for (let i = 0; i < road.points.length; i += 1) {
      const p = road.points[i];
      const s = this.worldToScreen(p.x, p.z);
      const active = i === hoverIndex || i === dragIndex;
      ctx.fillStyle = active ? '#ffd25a' : (selected ? '#fff' : 'rgba(230,200,90,0.9)');
      ctx.beginPath();
      ctx.arc(s.x, s.y, active ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawRoadDraft(ctx) {
    const pts = this.roadDraft.points;
    ctx.strokeStyle = 'rgba(230,200,90,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (pts.length > 0) {
      const s0 = this.worldToScreen(pts[0].x, pts[0].z);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i += 1) {
        const s = this.worldToScreen(pts[i].x, pts[i].z);
        ctx.lineTo(s.x, s.y);
      }
      const m = this.worldToScreen(this._snapValue(this.mouseWorld.x), this._snapValue(this.mouseWorld.z));
      ctx.lineTo(m.x, m.y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(230,200,90,0.95)';
    for (const p of pts) {
      const s = this.worldToScreen(p.x, p.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawRiver(ctx, river) {
    const selected = this.selection?.kind === 'river' && this.selection.id === river.id;
    const pts = sampleCenterline(river.points, 6);
    if (pts.length < 2) return;
    // Ocean-fill hint: a light wash on the flagged side(s) so it's clear which
    // way the "infinite ocean" faces before checking the 3D preview. Offset by
    // a modest editor-only distance (not the runtime's ~6000m visual extent —
    // this is just a direction cue on the 2D canvas).
    if (river.oceanLeft || river.oceanRight) {
      const OCEAN_HINT_DIST = 200;
      const buildSide = (sign) => pts.map((p, i) => {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        let tx = next.x - prev.x, tz = next.z - prev.z;
        const len = Math.hypot(tx, tz) || 1;
        tx /= len; tz /= len;
        const nx = -tz * sign, nz = tx * sign;
        return this.worldToScreen(p.x + nx * OCEAN_HINT_DIST, p.z + nz * OCEAN_HINT_DIST);
      });
      const drawWash = (sign) => {
        const far = buildSide(sign);
        ctx.beginPath();
        const s0 = this.worldToScreen(pts[0].x, pts[0].z);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < pts.length; i += 1) {
          const s = this.worldToScreen(pts[i].x, pts[i].z);
          ctx.lineTo(s.x, s.y);
        }
        for (let i = far.length - 1; i >= 0; i -= 1) ctx.lineTo(far[i].x, far[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(90,170,220,0.14)';
        ctx.fill();
      };
      if (river.oceanLeft) drawWash(1);
      if (river.oceanRight) drawWash(-1);
    }
    // Water width stroke (translucent blue).
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = selected ? 'rgba(120,200,230,0.85)' : 'rgba(40,110,150,0.85)';
    ctx.lineWidth = Math.max(2, river.width * this.view.zoom);
    ctx.beginPath();
    const s0 = this.worldToScreen(pts[0].x, pts[0].z);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i += 1) {
      const s = this.worldToScreen(pts[i].x, pts[i].z);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    // Center hairline + control-point handles.
    ctx.strokeStyle = 'rgba(150,210,235,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Handles glow gold + enlarge under the cursor (grabbable) or while actively
    // being dragged — mirrors _drawRoad's handle affordance.
    const hoverIndex = selected && this.tool === 'select' && !this.drag
      ? this._hitPointHandle(river.points, this.worldToScreen(this.mouseWorld.x, this.mouseWorld.z))
      : -1;
    const dragIndex = this.drag?.mode === 'move-river-point' && this.drag.id === river.id ? this.drag.index : -1;
    for (let i = 0; i < river.points.length; i += 1) {
      const p = river.points[i];
      const s = this.worldToScreen(p.x, p.z);
      const active = i === hoverIndex || i === dragIndex;
      ctx.fillStyle = active ? '#ffd25a' : (selected ? '#fff' : 'rgba(150,210,235,0.9)');
      ctx.beginPath();
      ctx.arc(s.x, s.y, active ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawRiverDraft(ctx) {
    const pts = this.riverDraft.points;
    ctx.strokeStyle = 'rgba(150,210,235,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (pts.length > 0) {
      const s0 = this.worldToScreen(pts[0].x, pts[0].z);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i += 1) {
        const s = this.worldToScreen(pts[i].x, pts[i].z);
        ctx.lineTo(s.x, s.y);
      }
      const m = this.worldToScreen(this._snapValue(this.mouseWorld.x), this._snapValue(this.mouseWorld.z));
      ctx.lineTo(m.x, m.y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(150,210,235,0.95)';
    for (const p of pts) {
      const s = this.worldToScreen(p.x, p.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawPolyDraft(ctx) {
    const d = this.polyDraft;
    const color = ZONE_TYPES[d.type]?.color ?? '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.beginPath();
    const p0 = this.worldToScreen(d.points[0]?.x ?? this.mouseWorld.x, d.points[0]?.z ?? this.mouseWorld.z);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < d.points.length; i += 1) {
      const s = this.worldToScreen(d.points[i].x, d.points[i].z);
      ctx.lineTo(s.x, s.y);
    }
    // rubber-band segment to the cursor
    const m = this.worldToScreen(this._snapValue(this.mouseWorld.x), this._snapValue(this.mouseWorld.z));
    ctx.lineTo(m.x, m.y);
    ctx.stroke();
    if (d.points.length >= 2) { ctx.closePath(); ctx.fill(); }
    // vertex dots
    ctx.fillStyle = color;
    for (const pt of d.points) {
      const s = this.worldToScreen(pt.x, pt.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawCreatePreview(ctx) {
    const d = this.drag;
    const color = ZONE_TYPES[d.type]?.color ?? '#fff';
    const a = this.worldToScreen(Math.min(d.start.x, d.cur.x), Math.min(d.start.z, d.cur.z));
    const c = this.worldToScreen(Math.max(d.start.x, d.cur.x), Math.max(d.start.z, d.cur.z));
    ctx.fillStyle = hexToRgba(color, 0.25);
    ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.setLineDash([]);
  }

  _drawEntity(ctx, entity) {
    const color = ENTITY_GROUND_MODES[entity.groundMode]?.color ?? '#9aa0a6';
    const s = this.worldToScreen(entity.x, entity.z);
    const selected = this.selection?.kind === 'entity' && this.selection.id === entity.id;
    // Marker grows with entity scale (clamped) so larger blueprints read bigger.
    const r = clamp(POI_SCREEN_RADIUS + Math.min(8, Math.max(0, entity.scale - 1) * 3), POI_SCREEN_RADIUS, 16);

    // Yaw tick: a short spoke rotated by yaw so rotation is visible on the map.
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((-entity.yaw * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r + 7, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Diamond marker, filled by ground-mode color.
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - r);
    ctx.lineTo(s.x + r, s.y);
    ctx.lineTo(s.x, s.y + r);
    ctx.lineTo(s.x - r, s.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    const bp = Blueprints.getBlueprint(entity.blueprintId);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(entity.name || bp?.name || 'Entity', s.x + r + 5, s.y);
  }

  _drawPoi(ctx, poi) {
    const color = POI_KINDS[poi.kind]?.color ?? '#fff';
    const s = this.worldToScreen(poi.x, poi.z);
    const selected = this.selection?.kind === 'poi' && this.selection.id === poi.id;
    ctx.beginPath();
    ctx.arc(s.x, s.y, POI_SCREEN_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(poi.name, s.x + POI_SCREEN_RADIUS + 4, s.y);
  }

  _drawSpawn(ctx) {
    const s = this.worldToScreen(this.map.spawn.x, this.map.spawn.z);
    ctx.strokeStyle = '#e8c34a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y);
    ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawHud(ctx) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'bottom';
    const txt = `x ${Math.round(this.mouseWorld.x)}  z ${Math.round(this.mouseWorld.z)}   zoom ${this.view.zoom.toFixed(2)}   tool ${this.tool}`;
    ctx.fillText(txt, 8, this.cssHeight - 8);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function numOr(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function distanceToPolyline(points, x, z) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
