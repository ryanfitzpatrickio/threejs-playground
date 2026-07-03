/**
 * WorldMapPreview3D.js
 *
 * A picture-in-picture 3D preview of the world map that renders the *real* runtime
 * level: it instantiates createComposedWorldLevel (streaming procedural terrain +
 * per-zone biomes, the road network with its asphalt material, and the streamed
 * city generator) from the editor's current map and drives its streaming from the
 * camera's focus point — exactly what the game builds, minus physics/gameplay.
 *
 * It runs on the app's WebGPU renderer (async init) so the terrain/city/road TSL
 * node materials render identically to the game. Geometry is in true world
 * coordinates (scene x/z = world x/z, y up).
 *
 * Controls:
 *   - OrbitControls: left-drag orbit, right-drag pan, wheel zoom.
 *   - WASD: fly across the ground; Q/E: down/up; Shift: faster.
 *
 * Usage: new WorldMapPreview3D({ canvas }); preview.setMap(projectJSON); ...; preview.dispose().
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { POI_KINDS } from '../world/worldMap/worldMapSchema.js';
import { zoneBounds } from '../world/worldMap/zoneGeometry.js';
import { createComposedWorldLevel } from '../game/world/createComposedWorldLevel.js';
import { getQualityPreset, getQualityLevel } from '../game/config/qualityPresets.js';

const MOVE_SPEED = 120;        // metres / second for WASD flythrough
const STREAM_INTERVAL = 0.25;  // seconds between streaming updates around the focus

export class WorldMapPreview3D {
  constructor({ canvas }) {
    this.canvas = canvas;
    this._mapHash = '';
    this._keys = new Set();
    this._raf = 0;
    this._lastTime = 0;
    this._running = false;
    this._streamAccum = 0;
    this._disposables = [];
    this.level = null;

    // The app aliases `three` to the WebGPU build, so use WebGPURenderer (async
    // init). The render loop holds off drawing until the backend is ready.
    this._ready = false;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x10130e, 1);
    this.renderer.init().then(() => { this._ready = true; }).catch((err) => {
      console.error('WorldMapPreview3D renderer init failed', err);
    });

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x10130e, 1500, 8000);

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
    this.camera.position.set(400, 500, 400);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't drop below the ground
    this.controls.screenSpacePanning = false;

    // Lighting close to the game's hemisphere look.
    const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x39351f, 1.0);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(600, 900, 300);
    this.scene.add(sun);

    // A far void floor under the streamed terrain (terrain can dip below 0).
    const voidMat = new THREE.MeshStandardMaterial({ color: 0x0c0f0a, roughness: 1 });
    const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), voidMat);
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.y = -400;
    this.scene.add(voidPlane);
    this._disposables.push(voidPlane.geometry, voidMat);

    // Marker overlays (spawn + POIs) — drawn on top of the real geometry.
    this.markers = new THREE.Group();
    this.scene.add(this.markers);

    this._focus = new THREE.Vector3();

    this._onKeyDown = (e) => {
      // Only capture movement keys, and only while the preview is focused, so we
      // never steal the editor's global shortcuts.
      const k = e.key.toLowerCase();
      if ('wasdqe'.includes(k) || e.key === 'Shift') { this._keys.add(k === 'shift' ? 'shift' : k); e.preventDefault(); }
    };
    this._onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      this._keys.delete(k === 'shift' ? 'shift' : k);
    };
    this._onBlur = () => this._keys.clear();

    canvas.tabIndex = 0; // focusable, so WASD only fires when the viewport has focus
    canvas.addEventListener('keydown', this._onKeyDown);
    canvas.addEventListener('keyup', this._onKeyUp);
    canvas.addEventListener('blur', this._onBlur);
    canvas.addEventListener('pointerdown', () => canvas.focus());

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._resize());
      this._resizeObserver.observe(canvas);
    }
    this._resize();
    this.start();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    const tick = (now) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this._lastTime) / 1000);
      this._lastTime = now;
      this._applyMovement(dt);
      this.controls.update();
      this._driveStreaming(dt);
      if (this._ready) this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  // Stream terrain/city chunks in around wherever the camera is looking, the same
  // way the game streams around the player.
  _driveStreaming(dt) {
    if (!this.level) return;
    this._streamAccum += dt;
    if (this._streamAccum < STREAM_INTERVAL) return;
    this._streamAccum = 0;
    this._focus.set(this.controls.target.x, 0, this.controls.target.z);
    try {
      this.level.updateStreaming(this._focus);
    } catch (err) {
      console.error('WorldMapPreview3D streaming failed', err);
    }
  }

  _applyMovement(dt) {
    if (this._keys.size === 0) return;
    const speed = MOVE_SPEED * (this._keys.has('shift') ? 3 : 1) * dt;

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const move = new THREE.Vector3();
    if (this._keys.has('w')) move.add(forward);
    if (this._keys.has('s')) move.sub(forward);
    if (this._keys.has('d')) move.add(right);
    if (this._keys.has('a')) move.sub(right);
    if (this._keys.has('e')) move.y += 1;
    if (this._keys.has('q')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);

    // Move both the camera and the orbit target so we glide, keeping orbit intact.
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  /**
   * Rebuild the runtime level from a normalized world-map (the editor's
   * getProjectJSON()). Heavy — tears down and recreates the streaming level — so
   * the caller should debounce this. Skips work when the map data is unchanged.
   */
  setMap(map) {
    if (!map) return;
    const hash = JSON.stringify({ z: map.zones, r: map.roads, rv: map.rivers, p: map.pois, e: map.entities, s: map.spawn, b: map.bounds });
    if (hash === this._mapHash) return;
    const firstBuild = !this.level;
    this._mapHash = hash;

    this._disposeLevel();
    try {
      const preset = getQualityPreset(getQualityLevel());
      this.level = createComposedWorldLevel(preset, { worldMap: map });
      this.scene.add(this.level.group);
    } catch (err) {
      console.error('WorldMapPreview3D level build failed', err);
      this.level = null;
    }

    this._rebuildMarkers(map);
    if (firstBuild) this._frame(map);

    // Stream immediately at the current focus so geometry appears without waiting.
    this._streamAccum = STREAM_INTERVAL;
  }

  _disposeLevel() {
    if (!this.level) return;
    this.scene.remove(this.level.group);
    try { this.level.dispose?.(); } catch (err) { console.error('WorldMapPreview3D level dispose failed', err); }
    this.level = null;
  }

  _rebuildMarkers(map) {
    for (const child of this.markers.children) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    this.markers.clear();
    for (const poi of map.pois ?? []) this._addPoi(poi);
    if (map.spawn) this._addSpawn(map.spawn);
  }

  _addPoi(poi) {
    const color = POI_KINDS[poi.kind]?.color ?? '#ffffff';
    const geom = new THREE.CylinderGeometry(3, 3, 30, 12);
    geom.translate(0, 15, 0);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: 0.5, roughness: 0.6 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(poi.x, 0, poi.z);
    this.markers.add(mesh);
  }

  _addSpawn(spawn) {
    const geom = new THREE.ConeGeometry(8, 30, 4);
    geom.translate(0, 15, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8c34a, emissive: 0x8a6a10, emissiveIntensity: 0.6, roughness: 0.5 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(spawn.x, 0, spawn.z);
    this.markers.add(mesh);
  }

  // Frame the camera on the map's authored content the first time it loads.
  _frame(map) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const include = (x, z) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
    for (const z of map.zones ?? []) { const b = zoneBounds(z); include(b.minX, b.minZ); include(b.maxX, b.maxZ); }
    for (const r of map.roads ?? []) for (const p of r.points ?? []) include(p.x, p.z);
    for (const p of map.pois ?? []) include(p.x, p.z);
    if (map.spawn) include(map.spawn.x, map.spawn.z);
    if (!Number.isFinite(minX)) {
      const b = map.bounds ?? { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
      minX = b.minX; maxX = b.maxX; minZ = b.minZ; maxZ = b.maxZ;
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.max(300, maxX - minX, maxZ - minZ);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + span * 0.55, span * 0.7, cz + span * 0.55);
    this.controls.update();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    this._resizeObserver?.disconnect();
    this.canvas.removeEventListener('keydown', this._onKeyDown);
    this.canvas.removeEventListener('keyup', this._onKeyUp);
    this.canvas.removeEventListener('blur', this._onBlur);
    this._disposeLevel();
    this._rebuildMarkers({});
    for (const d of this._disposables) d?.dispose?.();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
