import { createEffect, onMount } from 'solid-js';
import { ZONE_TYPES, POI_KINDS, ENTITY_GROUND_MODES } from '../../world/worldMap/worldMapSchema.js';
import { sampleCenterline } from '../../world/worldMap/roadProfile.js';

const SIZE = 184;        // css px
const VIEW_RADIUS = 130; // world metres from player to minimap edge

// A player-centred, north-up minimap derived from the same world-map data the 2D
// editor produces. Draws zone rects, POIs, and spawn, with the player fixed at
// the centre and a heading wedge from the camera yaw.
export function Minimap(props) {
  let canvas;
  let ctx;
  let dpr = 1;

  onMount(() => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  });

  // Redraw whenever the player moves or the map changes.
  createEffect(() => {
    props.player; // track
    props.map;    // track
    if (ctx) draw();
  });

  function draw() {
    const map = props.map;
    const player = props.player ?? { x: 0, z: 0, yaw: 0 };
    const cx = SIZE * 0.5;
    const cy = SIZE * 0.5;
    const scale = (SIZE * 0.5) / VIEW_RADIUS;

    // world -> minimap screen (north-up: world +z = down)
    const sx = (wx) => cx + (wx - player.x) * scale;
    const sy = (wz) => cy + (wz - player.z) * scale;

    ctx.clearRect(0, 0, SIZE, SIZE);

    // Round clip + backdrop
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE * 0.5 - 1, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    ctx.fillStyle = '#11140f';
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (map) {
      // Map bounds outline (so you can see the edge of the authored world)
      const b = map.bounds;
      ctx.strokeStyle = 'rgba(247,244,232,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(b.minX), sy(b.minZ), (b.maxX - b.minX) * scale, (b.maxZ - b.minZ) * scale);

      for (const zone of map.zones ?? []) {
        const color = ZONE_TYPES[zone.type]?.color ?? '#888888';
        ctx.fillStyle = hexToRgba(color, 0.45);
        if (zone.shape === 'polygon') {
          ctx.beginPath();
          ctx.moveTo(sx(zone.points[0].x), sy(zone.points[0].z));
          for (let i = 1; i < zone.points.length; i += 1) ctx.lineTo(sx(zone.points[i].x), sy(zone.points[i].z));
          ctx.closePath();
          ctx.fill();
        } else {
          const r = zone.rect;
          ctx.fillRect(sx(r.minX), sy(r.minZ), (r.maxX - r.minX) * scale, (r.maxZ - r.minZ) * scale);
        }
      }

      // Roads
      ctx.strokeStyle = 'rgba(230,200,90,0.9)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const road of map.roads ?? []) {
        const pts = sampleCenterline(road.points, 8);
        if (pts.length < 2) continue;
        ctx.lineWidth = Math.max(1.5, road.width * scale);
        ctx.beginPath();
        ctx.moveTo(sx(pts[0].x), sy(pts[0].z));
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(sx(pts[i].x), sy(pts[i].z));
        ctx.stroke();
      }

      // Spawn marker
      ctx.strokeStyle = '#e8c34a';
      ctx.lineWidth = 1.5;
      const spx = sx(map.spawn.x);
      const spy = sy(map.spawn.z);
      ctx.beginPath();
      ctx.arc(spx, spy, 3, 0, Math.PI * 2);
      ctx.stroke();

      for (const poi of map.pois ?? []) {
        ctx.fillStyle = POI_KINDS[poi.kind]?.color ?? '#ffffff';
        ctx.beginPath();
        ctx.arc(sx(poi.x), sy(poi.z), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Entities (placed blueprints): a ground-mode-coloured diamond (sized by
      // scale) so they read distinctly from circular POIs.
      for (const entity of map.entities ?? []) {
        const color = ENTITY_GROUND_MODES[entity.groundMode]?.color ?? '#ffffff';
        const ex = sx(entity.x);
        const ey = sy(entity.z);
        const r = 2.5 + Math.min(4, (entity.scale ?? 1) * 1.5);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ex, ey - r);
        ctx.lineTo(ex + r, ey);
        ctx.lineTo(ex, ey + r);
        ctx.lineTo(ex - r, ey);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();

    // Rim
    ctx.strokeStyle = 'rgba(247,244,232,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE * 0.5 - 1, 0, Math.PI * 2);
    ctx.stroke();

    // Player heading wedge (camera forward on ground = (-sin yaw, -cos yaw))
    const yaw = player.yaw ?? 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz; // right perpendicular
    const rz = fx;
    const tip = 9;
    const wing = 5;
    ctx.fillStyle = '#7ec8ff';
    ctx.beginPath();
    ctx.moveTo(cx + fx * tip, cy + fz * tip);
    ctx.lineTo(cx - fx * 4 + rx * wing, cy - fz * 4 + rz * wing);
    ctx.lineTo(cx - fx * 4 - rx * wing, cy - fz * 4 - rz * wing);
    ctx.closePath();
    ctx.fill();
  }

  return (
    <canvas
      ref={canvas}
      style={{
        position: 'fixed',
        left: '14px',
        bottom: '14px',
        width: `${SIZE}px`,
        height: `${SIZE}px`,
        'border-radius': '50%',
        'pointer-events': 'none',
        'z-index': 15,
        filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.45))',
      }}
      aria-label="World minimap"
    />
  );
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
