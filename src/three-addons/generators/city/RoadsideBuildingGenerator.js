/**
 * RoadsideBuildingGenerator.js
 *
 * Procedural generator for low-rise strip retail / townhouses and mid-rise apartment
 * blocks placed along roads (trackStyle 'roadsideBuildings').
 *
 * Dual-tier LOD:
 *  - LOD 0 (near): merged modular geometry (walls, windows, shopfronts, roofs, balconies)
 *    built from simple boxes/quads. Opaque + optional glass parts.
 *  - LOD 1 (far): lightweight 6-face box with TSL material using Parallax Occlusion
 *    Mapping (via ParallaxOcclusion.js) for facade relief and simplified raymarched
 *    interior mapping (inspired by SkyscraperGenerator) behind "glass" regions.
 *
 * Usage in trackside builder:
 *   const gen = new RoadsideBuildingGenerator({ seed, style: 'strip'|'apartment', width, depth, stories, ... });
 *   const lod0 = gen.buildLOD0(); // { opaque: BufferGeometry, glass?: BufferGeometry, height, ... }
 *   const lod1 = gen.buildLOD1(); // { geometry: BufferGeometry, material: Material }
 *
 * The trackside layer is responsible for instancing + fade attributes + transforms.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
	color,
	float,
	Fn,
	mix,
	positionLocal,
	positionView,
	positionWorld,
	normalLocal,
	normalView,
	normalWorldGeometry,
	uv as uvNode,
	vec2,
	vec3,
	vec4,
	attribute,
	modelViewMatrix,
	inverse,
	normalize,
	dot,
	cross,
	floor,
	fract,
	smoothstep,
	select,
	step,
	mod,
	fwidth,
	sin,
	hash as ihash,
	mx_fractal_noise_float,
	mx_noise_float,
	uint,
	clamp,
	varying,
} from 'three/tsl';
import { parallaxOcclusionUV } from '../../tsl/utils/ParallaxOcclusion.js';

// material-zone codes baked per vertex into the merged LOD0 geometry, so the single
// facade material can branch on partId and shade every zone (mirrors SkyscraperGenerator).
// Kept a distinct, self-contained set — these ids are only ever read by the roadside
// facade/glass materials below.
const PartId = { WALL: 0, CONCRETE: 1, FRAME: 2, GLASS: 3, SHOPGLASS: 4, AC: 5 };

// the masonry course module ( brick height × length ). the procedural brickwork
// ( courses up local Y, columns along each face ) is keyed off this.
const BRICK = { height: 0.3, length: 0.6 };

// Adjacent roadside buildings are placed on an exact arc-length frontage grid.
// Give the visible facade a tiny overlap so floating point interpolation and
// curved-road chord error cannot expose terrain/sky slivers between neighbours.
export const ROADSIDE_FRONTAGE_OVERLAP = 0.08;

const _c = new THREE.Color();

// Tag a geometry piece with a per-vertex partId so the merged LOD0 geometry carries
// the zone code the facade material branches on. Wrapper at the call site — does not
// touch coloredBox/makeQuad signatures (a second coloredBox lives in createTracksideLayers).
function withPartId(geom, id) {
	const n = geom.attributes.position.count;
	geom.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
	return geom;
}

// Simple deterministic PRNG (mulberry-ish) for reproducible buildings from seed.
function makeRNG(seed) {
	let s = (seed | 0) >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function setColorAttribute(geom, hex) {
	_c.set(hex);
	const n = geom.attributes.position.count;
	const cols = new Float32Array(n * 3);
	for (let i = 0; i < n; i += 1) {
		cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b;
	}
	geom.setAttribute('color', new THREE.BufferAttribute(cols, 3));
}

function makeQuad(w, h, cx, cy, cz, normalSign = 1, hex = 0x888888) {
	// Quad in local XY plane, facing +Z (caller rotates). Two tris.
	const g = new THREE.BufferGeometry();
	const hw = w * 0.5, hh = h * 0.5;
	const positions = new Float32Array([
		cx - hw, cy - hh, cz,
		cx + hw, cy - hh, cz,
		cx + hw, cy + hh, cz,
		cx - hw, cy + hh, cz,
	]);
	const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
	g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
	g.setIndex([0, 1, 2, 0, 2, 3]);
	g.computeVertexNormals();
	setColorAttribute(g, hex);
	if (normalSign < 0) {
		// flip for backface if needed; we keep double-sided materials mostly.
	}
	return g;
}

function coloredBox(w, h, d, cx, cy, cz, hex) {
	const g = new THREE.BoxGeometry(w, h, d);
	g.translate(cx, cy, cz);
	setColorAttribute(g, hex);
	return g;
}

/** Fill a vertical gap between the last masonry course and the authored roof line. */
function addMasonryCap(geoms, { width, depth, y0, yTop, color, depthScale = 0.98 }) {
	const h = yTop - y0;
	if (h < 1e-3) return;
	geoms.push(withPartId(
		coloredBox(width, h, depth * depthScale, 0, y0 + h * 0.5, 0, color),
		PartId.WALL,
	));
}

// Build a simple low-rise strip shop / townhouse (1-2 stories).
// Front faces +Z in local space (trackside will rotate to face road).
function buildStripLOD0({ width = 14, depth = 9, stories = 1, storyHeight = 3.2, seed = 1, colorBase = 0xc9b896, colorTrim = 0x5a5348 }) {
	const rng = makeRNG(seed);
	const geoms = [];
	const glassGeoms = [];

	const totalH = stories * storyHeight;
	const groundH = Math.min(2.6, storyHeight * 0.85);
	const upperH = totalH - groundH;

	// Base plinth / foundation (extends a little below grade in caller placement).
	geoms.push(withPartId(coloredBox(width + 0.2, 0.6, depth + 0.2, 0, -0.1, 0, 0x666666), PartId.CONCRETE));

	// Ground floor main mass (shop or house). Footprint is centred on the local
	// origin (z spans [-depth/2, +depth/2]) so the +Z facade elements below sit
	// flush on the front face — and the LOD1 box (also origin-centred) matches.
	geoms.push(withPartId(coloredBox(width, groundH, depth * 0.98, 0, groundH * 0.5, 0, colorBase), PartId.WALL));

	// City-style storefront: a low bulkhead, sign fascia, piers/mullions, and a
	// broad display pane. Keep these dimensions derived from the building width so
	// adjacent frontage-packed buildings read as one continuous street wall.
	const bulkhead = Math.min(0.5, groundH * 0.22);
	const fascia = Math.min(0.72, groundH * 0.25);
	const glassH = Math.max(1.1, groundH - bulkhead - fascia);
	const glassY = bulkhead + glassH * 0.5;
	const shopW = Math.max(4, width - 1.8);
	geoms.push(withPartId(coloredBox(width + 0.04, bulkhead, 0.34, 0, bulkhead * 0.5, depth * 0.5 + 0.06, colorTrim), PartId.FRAME));
	geoms.push(withPartId(coloredBox(width + 0.08, fascia, 0.44, 0, groundH - fascia * 0.5, depth * 0.5 + 0.08, 0x5d554a), PartId.FRAME));
	geoms.push(withPartId(coloredBox(0.28, glassH + bulkhead, 0.36, -shopW * 0.5, (glassH + bulkhead) * 0.5, depth * 0.5 + 0.07, colorTrim), PartId.FRAME));
	geoms.push(withPartId(coloredBox(0.28, glassH + bulkhead, 0.36, shopW * 0.5, (glassH + bulkhead) * 0.5, depth * 0.5 + 0.07, colorTrim), PartId.FRAME));
	for (let m = 1; m < 3; m += 1) {
		const mx = -shopW * 0.5 + (shopW * m) / 3;
		geoms.push(withPartId(coloredBox(0.08, glassH, 0.18, mx, glassY, depth * 0.5 + 0.1, colorTrim), PartId.FRAME));
	}
	const shopGlass = withPartId(makeQuad(shopW - 0.18, glassH, 0, glassY, depth * 0.5 + 0.12, 1, 0x88aacc), PartId.SHOPGLASS);
	glassGeoms.push(shopGlass);

	// Door (offset randomly).
	const doorW = 1.1 + rng() * 0.3;
	const doorX = (rng() < 0.5 ? -1 : 1) * shopW * 0.33;
	geoms.push(withPartId(coloredBox(doorW, glassH, 0.2, doorX, glassY, depth * 0.5 + 0.15, 0x3a2f28), PartId.FRAME));

	// Upper floor(s) if any.
	if (stories >= 2) {
		geoms.push(withPartId(coloredBox(width, upperH, depth * 0.96, 0, groundH + upperH * 0.5, 0, colorBase * 0.92 + 0x111111), PartId.WALL));
		// Window grid on upper facade.
		const rows = Math.max(1, stories - 1);
		const cols = Math.max(2, Math.floor(width / 3.2));
		const winW = 1.6, winH = 1.35;
		const marginX = (width - cols * winW - (cols - 1) * 0.6) * 0.5;
		for (let r = 0; r < rows; r += 1) {
			for (let c = 0; c < cols; c += 1) {
				const wx = -width * 0.5 + marginX + c * (winW + 0.6) + winW * 0.5;
				const wy = groundH + 0.4 + r * (winH + 0.55) + winH * 0.5;
				// wall recess frame
				geoms.push(withPartId(coloredBox(winW + 0.18, winH + 0.18, 0.12, wx, wy, depth * 0.5 + 0.01, colorTrim), PartId.FRAME));
				const gwin = withPartId(makeQuad(winW, winH, wx, wy, depth * 0.5 + 0.04, 1, 0x9fb8d1), PartId.GLASS);
				glassGeoms.push(gwin);
			}
		}
	}

	// Shop floors are shorter than storyHeight; cap masonry to totalH before the roof.
	let wallTop = groundH;
	if (stories >= 2) wallTop = groundH + upperH * 0.98;
	addMasonryCap(geoms, { width, depth, y0: wallTop, yTop: totalH, color: colorBase, depthScale: 0.98 });

	// Roof: flat parapet or simple gable for variety.
	const roofStyle = (seed % 3);
	if (roofStyle === 0) {
		// Flat with parapet — bottom flush with the masonry cap.
		geoms.push(withPartId(coloredBox(width + 0.4, 0.35, depth + 0.25, 0, totalH + 0.175, 0, 0x555555), PartId.CONCRETE));
	} else {
		// Low gable: slopes start on the wall top, ridge rises above.
		geoms.push(withPartId(coloredBox(width + 0.6, 0.3, depth * 0.2, 0, totalH + 0.95, 0, 0x4a4a4a), PartId.CONCRETE));
		geoms.push(withPartId(coloredBox(width + 0.3, 0.8, depth * 0.55, 0, totalH + 0.4, depth * 0.2, 0x6b6256), PartId.CONCRETE));
		geoms.push(withPartId(coloredBox(width + 0.3, 0.8, depth * 0.55, 0, totalH + 0.4, -depth * 0.2, 0x6b6256), PartId.CONCRETE));
	}

	// Balcony on upper for apartments-ish strips.
	if (stories >= 2 && (seed % 5) < 2) {
		const balY = groundH + upperH - 0.6;
		geoms.push(withPartId(coloredBox(width * 0.6, 0.12, 1.2, 0, balY, depth * 0.5 + 0.6, 0x555555), PartId.FRAME));
		// rail
		geoms.push(withPartId(coloredBox(width * 0.6, 0.9, 0.08, 0, balY + 0.5, depth * 0.5 + 1.1, 0x444444), PartId.FRAME));
	}

	const opaque = mergeGeometries(geoms, false);
	for (const g of geoms) g.dispose();
	let glass = null;
	if (glassGeoms.length) {
		glass = mergeGeometries(glassGeoms, false);
		for (const g of glassGeoms) g.dispose();
	}

	return {
		opaque,
		glass,
		width,
		depth,
		height: totalH,
	};
}

// Apartment block: ground commercial + stacked residential grid (3-6 stories).
function buildApartmentLOD0({ width = 22, depth = 11, stories = 4, storyHeight = 3.1, seed = 42, colorBase = 0xa8b0b8, colorTrim = 0x3f464f }) {
	const rng = makeRNG(seed);
	const geoms = [];
	const glassGeoms = [];

	const totalH = stories * storyHeight;
	const groundH = Math.min(3.0, storyHeight * 0.95);

	// Foundation plinth.
	geoms.push(withPartId(coloredBox(width + 0.4, 0.8, depth + 0.3, 0, -0.2, 0, 0x555555), PartId.CONCRETE));

	// Ground floor commercial mass. Footprint centred on the local origin so the
	// +Z facade (shopfronts/columns/windows) sits flush on the front face and the
	// LOD1 box matches (both origin-centred).
	geoms.push(withPartId(coloredBox(width, groundH, depth * 0.99, 0, groundH * 0.5, 0, colorBase), PartId.WALL));

	// Ground shopfronts (multiple bays).
	const bulkhead = Math.min(0.5, groundH * 0.2);
	const fascia = Math.min(0.85, groundH * 0.24);
	const glassH = Math.max(1.2, groundH - bulkhead - fascia);
	const glassY = bulkhead + glassH * 0.5;
	geoms.push(withPartId(coloredBox(width + 0.04, bulkhead, 0.34, 0, bulkhead * 0.5, depth * 0.5 + 0.06, colorTrim), PartId.FRAME));
	geoms.push(withPartId(coloredBox(width + 0.08, fascia, 0.48, 0, groundH - fascia * 0.5, depth * 0.5 + 0.09, 0x5f574d), PartId.FRAME));
	const bays = Math.max(2, Math.floor(width / 5.5));
	const bayW = width / bays;
	for (let b = 0; b < bays; b += 1) {
		const bx = -width * 0.5 + bayW * (b + 0.5);
		const gw = Math.max(2.4, bayW - 0.72);
		const gg = withPartId(makeQuad(gw, glassH, bx, glassY, depth * 0.5 + 0.12, 1, 0x7fa8c8), PartId.SHOPGLASS);
		glassGeoms.push(gg);
		geoms.push(withPartId(coloredBox(0.08, glassH, 0.18, bx - gw * 0.18, glassY, depth * 0.5 + 0.14, colorTrim), PartId.FRAME));
		geoms.push(withPartId(coloredBox(0.08, glassH, 0.18, bx + gw * 0.18, glassY, depth * 0.5 + 0.14, colorTrim), PartId.FRAME));
		if ((seed + b) % 3 !== 0) {
			geoms.push(withPartId(coloredBox(gw + 0.3, 0.12, 1.15, bx, groundH - fascia - 0.08, depth * 0.5 + 0.62, 0x7a4c38), PartId.FRAME));
		}
	}
	for (let b = 0; b <= bays; b += 1) {
		const px = -width * 0.5 + bayW * b;
		geoms.push(withPartId(coloredBox(0.34, groundH, 0.42, px, groundH * 0.5, depth * 0.5 + 0.08, colorTrim), PartId.FRAME));
	}

	// Upper residential floors.
	const upperStart = groundH;
	for (let s = 1; s < stories; s += 1) {
		const y0 = upperStart + (s - 0.5) * storyHeight;
		geoms.push(withPartId(coloredBox(width, storyHeight * 0.98, depth * 0.97, 0, y0, 0, s % 2 ? colorBase : (colorBase * 0.9 + 0x0a0a0a)), PartId.WALL));

		// Regular window grid.
		const cols = Math.max(3, Math.floor(width / 3.8));
		const winW = 1.45, winH = 1.55;
		const spacingX = width / cols;
		for (let c = 0; c < cols; c += 1) {
			const wx = -width * 0.5 + spacingX * (c + 0.5);
			const wy = y0;
			geoms.push(withPartId(coloredBox(winW + 0.22, winH + 0.22, 0.1, wx, wy, depth * 0.5 + 0.01, colorTrim), PartId.FRAME));
			const gwin = withPartId(makeQuad(winW, winH, wx, wy, depth * 0.5 + 0.03, 1, 0x9ab8d4), PartId.GLASS);
			glassGeoms.push(gwin);
		}
	}

	// Ground floor is shorter than storyHeight; fill the parapet line before the roof slab.
	const wallTop = groundH + Math.max(0, stories - 1) * storyHeight * 0.98;
	addMasonryCap(geoms, { width, depth, y0: wallTop, yTop: totalH, color: colorBase, depthScale: 0.97 });

	// Roof parapet / mechanical — sits on the capped wall top.
	geoms.push(withPartId(coloredBox(width + 0.5, 0.6, depth + 0.4, 0, totalH + 0.3, 0, 0x474c52), PartId.CONCRETE));
	// A few AC boxes / vents on roof for interest, scattered across the back half.
	for (let i = 0; i < 2; i += 1) {
		const ax = (rng() - 0.5) * (width * 0.6);
		geoms.push(withPartId(coloredBox(1.6 + rng(), 0.7, 1.2, ax, totalH + 0.7, -depth * 0.5 + rng() * depth * 0.5, 0x333333), PartId.AC));
	}

	const opaque = mergeGeometries(geoms, false);
	for (const g of geoms) g.dispose();
	let glass = null;
	if (glassGeoms.length) {
		glass = mergeGeometries(glassGeoms, false);
		for (const g of glassGeoms) g.dispose();
	}
	return {
		opaque,
		glass,
		width,
		depth,
		height: totalH,
	};
}

// Simple 6-face box geometry sized to the building (caller scales/positions via instance matrix or direct).
function buildLOD1Box({ width, depth, height }) {
	const g = new THREE.BoxGeometry(width, height, depth);
	// Center the box so bottom sits at y=0 after translate by caller; BoxGeometry centered at origin.
	g.translate(0, height * 0.5, 0);
	// Provide a base color attribute so attribute('color') in the far shader has data.
	// (InstancedMesh can override per-instance via setColorAt if desired later.)
	setDefaultColor(g, 0x8a8175);
	// The far LOD material uses ParallaxOcclusion which requires tangent attribute
	// (see ParallaxOcclusion.js and its use of tangentView / tangentGeometry).
	g.computeTangents();
	// Tag for material selection if needed.
	g.userData.roadsideLOD1 = true;
	return g;
}

function setDefaultColor(g, hex) {
	_c.set(hex);
	const count = g.attributes.position.count;
	const colors = new Float32Array(count * 3);
	for (let i = 0; i < count; i += 1) {
		colors[i * 3] = _c.r;
		colors[i * 3 + 1] = _c.g;
		colors[i * 3 + 2] = _c.b;
	}
	g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Build a simple procedural height texture for facade relief (window frames, sills, lintels).
// Red channel = height (1 = peak). Works headless.
function createFacadeHeightTexture(size = 128) {
	const w = size, h = size;
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) {
			const u = x / (w - 1);
			const v = y / (h - 1);
			// Base wall height.
			let hh = 0.25;
			// Horizontal floor bands / spandrels.
			const floorV = fract(v * 4.0);
			if (floorV < 0.08 || floorV > 0.92) hh = 0.65;
			// Vertical piers.
			const colU = fract(u * 5.0);
			if (colU < 0.06 || colU > 0.94) hh = 0.72;
			// Window recess (lower).
			const winU = fract(u * 5.0 + 0.1);
			const winV = fract(v * 4.0 + 0.12);
			const inWin = (winU > 0.18 && winU < 0.82) && (winV > 0.12 && winV < 0.78);
			if (inWin) hh = 0.08;
			// Window frame rim.
			if (inWin && (winU < 0.24 || winU > 0.76 || winV < 0.18 || winV > 0.72)) hh = 0.55;
			// Slight sill protrusion.
			if (winV > 0.10 && winV < 0.16) hh = Math.max(hh, 0.48);
			const i = (y * w + x) * 4;
			const val = Math.floor(hh * 255);
			data[i] = val;
			data[i + 1] = val;
			data[i + 2] = val;
			data[i + 3] = 255;
		}
	}
	const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.generateMipmaps = true;
	tex.needsUpdate = true;
	return tex;
}

let _sharedFacadeHeight = null;
function getFacadeHeight() {
	if (!_sharedFacadeHeight) _sharedFacadeHeight = createFacadeHeightTexture(128);
	return _sharedFacadeHeight;
}

// Simplified interior mapping TSL snippet (raymarch box rooms behind facade "glass").
// Adapted from SkyscraperGenerator interior logic, stripped for a box facade use-case.
const interiorMapping = Fn(({ roomUV, roomSeed, isShop, viewDirLocal }) => {
	// roomUV: 0..1 across the pane. viewDirLocal is already expressed in the
	// facade frame (across, up, inward), including the InstancedMesh rotation.
	const setback = float(0.08);
	const roomDepth = select(isShop, float(3.2), float(2.4));
	const roomH = select(isShop, float(2.2), float(2.8));
	const halfW = select(isShop, float(1.1), float(0.9));

	const origin = vec3(
		roomUV.x.sub(0.5).mul(halfW.mul(2.0)),
		roomUV.y.sub(0.5).mul(roomH),
		0,
	);
	const dir = normalize(viewDirLocal);
	const boxMax = vec3(halfW, roomH.mul(0.5), setback.add(roomDepth));
	const boxMin = vec3(halfW.negate(), roomH.mul(-0.5), setback);
	const tFar = boxMin.sub(origin).div(dir).max(boxMax.sub(origin).div(dir));
	const t = tFar.x.min(tFar.y).min(tFar.z);
	const hit = origin.add(dir.mul(t));
	const q = hit.sub(boxMin).div(boxMax.sub(boxMin));

	// Walls / furniture hints.
	const onBack = q.z.greaterThan(0.998);
	const onCeil = q.y.greaterThan(0.998);
	const onFloor = q.y.lessThan(0.002);
	const onSide = q.x.lessThan(0.002).or(q.x.greaterThan(0.998));

	const cell = floor(roomSeed.add(float(0.5)));
	const ckey = uint(cell.mul(1664525).add(1013904223)).toVar();
	const h = (k) => fract(float(ckey.add(uint(k)).mul(2654435761)).div(float(4294967296.0)));

	const lit = step(select(isShop, float(0.18), float(0.5)), h(7));
	const lamp = mix(color(0xffcc88), color(0xccdfff), h(11));
	const market = step(0.42, h(23));
	const goods = (k) => {
		const pick = k.mul(6);
		let c = color(0x9e3d33);
		c = select(pick.greaterThan(1), color(0xb2802f), c);
		c = select(pick.greaterThan(2), color(0x3d6b4f), c);
		c = select(pick.greaterThan(3), color(0x35578a), c);
		c = select(pick.greaterThan(4), color(0xd6d0c4), c);
		c = select(pick.greaterThan(5), color(0x2b2830), c);
		return c;
	};
	const shelves = (ax, ay, cols, salt) => {
		const bands = 4;
		const gx = fract(ax.mul(cols));
		const gy = fract(ay.mul(bands));
		const cellKey = ckey
			.add(uint(salt))
			.add(uint(floor(ax.mul(cols))).mul(uint(197)))
			.add(uint(floor(ay.mul(bands))).mul(uint(4099)));
		const r = ihash(cellKey);
		const r2 = ihash(cellKey.add(uint(1)));
		const item = step(0.1, gy)
			.mul(step(gy, mix(float(0.4), float(0.86), fract(r2.mul(9)))))
			.mul(step(gx.sub(0.5).abs(), mix(float(0.22), float(0.44), fract(r2.mul(13)))))
			.mul(step(0.12, r2));
		const board = mix(color(0x6b5a43), color(0xd8d4cc), step(0.5, h(37)));
		return mix(mix(color(0x211e1b), goods(r), item), board, step(gy, 0.08));
	};
	const rect = (ax, ay, cx, cy, hw, hh) => smoothstep(hw + 0.006, hw - 0.006, ax.sub(cx).abs())
		.mul(smoothstep(hh + 0.006, hh - 0.006, ay.sub(cy).abs()));

	const baseWall = mix(color(0x8f7f68), color(0x6b747c), h(17));
	let col = baseWall;
	// Back wall variation
	col = select(onBack, mix(baseWall, color(0x4a3f35), h(31)), col);
	// Ceiling
	col = select(onCeil, color(0xdddddd), col);
	// Floor
	col = select(onFloor, color(0x555555), col);
	// Side walls make the room volume read clearly at oblique viewing angles.
	col = select(onSide, baseWall.mul(0.78), col);

	// Retail dressing copied from the city shop vocabulary, simplified for the
	// procedural pane-only mapper: stocked back/side shelves, tiled floor, ceiling
	// troffers, a display plinth, and a counter visible through the glass.
	const tileSeam = step(0.93, fract(q.x.mul(8))).max(step(0.93, fract(q.z.mul(10))));
	const shopFloor = mix(color(0xb5afa2), color(0x958f83), h(41)).mul(tileSeam.mul(0.35).oneMinus());
	const troffer = step(fract(q.x.mul(3)).sub(0.5).abs(), 0.3).mul(step(fract(q.z.mul(4)).sub(0.5).abs(), 0.15));
	const shopCeil = mix(color(0xe9e6df), lamp.mul(mix(float(0.8), float(4.2), lit)), troffer);
	const shopWall = mix(color(0xd8d2c6), color(0xbfb9ae), h(43));
	const poster = rect(q.x, q.y, mix(float(0.28), float(0.72), h(44)), 0.62, 0.12, 0.16);
	const showroom = mix(mix(goods(h(45)), shopWall, 0.45), goods(h(46)), poster);
	const shopBack = select(market, shelves(q.x, q.y, 6, 31), showroom);
	const shopSide = select(market, shelves(q.z, q.y, 7, 57), shopWall);
	let shopCol = select(onBack, shopBack, select(onCeil, shopCeil, select(onFloor, shopFloor, shopSide)));
	const display = rect(q.x, q.z, 0.5, 0.18, 0.34, 0.1);
	const counter = rect(q.x, q.z, mix(float(0.28), float(0.72), h(47)), 0.52, 0.16, 0.12);
	shopCol = select(onFloor, mix(shopCol, color(0xdad5cb), display), shopCol);
	shopCol = select(onFloor, mix(shopCol, mix(color(0x4a4036), color(0x2c333a), h(48)), counter), shopCol);
	col = select(isShop, shopCol, col);

	// Simple lamp glow when "lit"
	const distToCenter = q.sub(vec3(0.5, 0.85, 0.5)).length();
	const glow = smoothstep(0.6, 0.0, distToCenter).mul(lit).mul(2.2);
	col = mix(col, lamp, glow);

	// Some closed shops get a roller grille. Open shops keep the populated display
	// unobscured, so the street reads as active retail rather than blank panes.
	const grille = step(0.62, fract(roomUV.y.mul(13))).mul(lit.oneMinus()).mul(step(0.48, h(49)));
	col = select(isShop, mix(col, color(0x20242a), grille.mul(0.65)), col);

	// w carries the lamp-lit weight so the glass/far materials can drive an emissive
	// glow from the same raymarch (lit rooms glow, unlit ones stay dark).
	return vec4(col, lit);
});

// cheap value noise (~[-1,1]), a lighter stand-in for gradient mx_noise on the
// weathering terms; integer-hashed (not fract(sin)) to stay stable across drivers.
// Ported verbatim from SkyscraperGenerator.
const valueNoise = /*@__PURE__*/ Fn(([p]) => {
	const i = floor(p);
	const f = fract(p);
	const u = f.mul(f).mul(f.mul(-2).add(3)); // 3f2 - 2f3 smooth interpolation
	const corner = (ox, oy, oz) => {
		const c = i.add(vec3(ox, oy, oz));
		return ihash(uint(c.x.add(1 << 20)).mul(uint(73856093)).bitXor(uint(c.y.add(1 << 20)).mul(uint(19349663))).bitXor(uint(c.z.add(1 << 20)).mul(uint(83492791))));
	};
	const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), u.x);
	const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), u.x);
	const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), u.x);
	const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), u.x);
	return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z).mul(2).sub(1);
}).setLayout({ name: 'valueNoise', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

// fractal (fBm) of valueNoise, octaves summed like mx_fractal_noise_float.
const valueFractal = (p, octaves) => {
	let sum = valueNoise(p);
	let amp = 0.5, freq = 2;
	for (let o = 1; o < octaves; o += 1) {
		sum = sum.add(valueNoise(p.mul(freq)).mul(amp));
		amp *= 0.5;
		freq *= 2;
	}
	return sum;
};

// derivative-based bump from a height field keyed off world position (Mikkelsen
// surface-gradient method). Ported from SkyscraperGenerator / SidewalkGenerator.
function bumpNormal(height) {
	const dpdx = positionView.dFdx();
	const dpdy = positionView.dFdy();
	const r1 = dpdy.cross(normalView);
	const r2 = normalView.cross(dpdx);
	const det = dpdx.dot(r1);
	const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
	return det.abs().mul(normalView).sub(grad).normalize();
}

// an antialiased line repeated at every multiple of `period` (scored joints).
function gridLine(coord, period, halfWidth) {
	const g = coord.div(period);
	const d = float(0.5).sub(fract(g).sub(0.5).abs());
	const aa = fwidth(g).max(0.0001);
	const hw = halfWidth / period;
	return smoothstep(float(hw).add(aa), float(hw).sub(aa), d);
}

// fine aggregate noise; caller folds in the distance `detail` fade (skipping the
// If-branch optimization the sidewalk version uses, to keep this branch-free).
function detailNoise(p, scale, amp) {
	return mx_noise_float(p.mul(scale)).mul(amp);
}

// The LOD0 facade material: one MeshStandardNodeMaterial that reads the baked
// per-vertex `partId` and reproduces each zone — procedural brick on the walls,
// scored concrete on plinths/parapets/roofs, painted trim on frames/doors, dark
// metal on AC units — all dressed with world-space weathering. `buildingBase` is
// the building's flat masonry colour as a TSL node (strip vs apartment). Brick and
// concrete are pure TSL math (no textures) so the WebGPU sampler budget is untouched.
export function createRoadsideFacadeMaterial(buildingBase = color(0xcdb48a)) {
	const soot = color(0x4a4236);

	// broad weathering, world-space so it reads consistently across instances
	const tone = varying(mx_fractal_noise_float(positionWorld.mul(0.03), 2)).mul(0.18);
	const mottle = valueNoise(positionWorld.mul(0.7)).mul(0.06);
	const streak = mx_fractal_noise_float(vec3(positionWorld.x.mul(1.5), positionWorld.y.mul(0.04), positionWorld.z.mul(1.5)), 2);
	const dirt = smoothstep(-0.1, 0.45, streak).mul(smoothstep(210, 0, positionWorld.y)).mul(0.6);

	// --- procedural brick (WALL): running bond keyed off building-local position
	// (courses up local Y; across-face axis = world XZ on the face tangent). Ported
	// from SkyscraperGenerator.
	const brickH = BRICK.height;
	const brickL = BRICK.length;
	const mortar = 0.025;
	const nrm = normalWorldGeometry.abs();
	const across = positionLocal.x.mul(normalWorldGeometry.z).sub(positionLocal.z.mul(normalWorldGeometry.x));
	const rowCoord = positionLocal.y.div(brickH);
	const courseRow = floor(rowCoord);
	const colCoord = across.div(brickL).add(mod(courseRow, 2).mul(0.5)); // half-brick stagger
	// anti-aliased mortar (the "pristine grid" trick) — crisp up close, dissolves far away
	const mU = mortar / (2 * brickL);
	const mV = mortar / (2 * brickH);
	const ddU = nrm.z.mul(fwidth(positionWorld.x)).add(nrm.x.mul(fwidth(positionWorld.z))).div(brickL).clamp(1e-6, 0.5);
	const ddV = fwidth(rowCoord).clamp(1e-6, 0.5);
	const distU = float(0.5).sub(fract(colCoord).sub(0.5).abs());
	const distV = float(0.5).sub(fract(rowCoord).sub(0.5).abs());
	const drawU = ddU.max(mU);
	const drawV = ddV.max(mV);
	const lineU = smoothstep(drawU.add(ddU), drawU.sub(ddU), distU).mul(float(mU).div(drawU).min(1));
	const lineV = smoothstep(drawV.add(ddV), drawV.sub(ddV), distV).mul(float(mV).div(drawV).min(1));
	const wallFacing = smoothstep(0.7, 0.45, nrm.y); // brick only on vertical walls
	const joint = lineU.max(lineV).mul(wallFacing);

	const brickKey = uint(courseRow.add(1 << 16)).mul(uint(73856093)).bitXor(uint(floor(colCoord).add(1 << 16)).mul(uint(19349663))).toVar();
	const brickRnd = ihash(brickKey);
	const brickRnd2 = ihash(brickKey.add(uint(1)));
	const perBrick = float(1).add(tone).add(mottle).add(brickRnd.sub(0.5).mul(0.14));
	const warmCool = brickRnd2.sub(0.5).mul(0.14);
	const brickShift = vec3(float(1).add(warmCool), float(1), float(1).sub(warmCool));
	const tint = buildingBase.mul(perBrick).mul(brickShift);
	const masonry = mix(tint, tint.mul(0.6), joint); // recessed joints read darker
	const roofMask = wallFacing.oneMinus();
	const roofGrime = select(roofMask.greaterThan(0), smoothstep(0.0, 0.55, valueFractal(positionWorld.mul(0.025), 3)).mul(0.22), float(0));
	const stoneColor = mix(masonry, soot, mix(dirt, roofGrime, roofMask));

	// rounded brick relief for the bump + rougher mortar joints
	const texel = fwidth(positionWorld).length();
	const lodBevel = texel.mul(1.5).max(0.02);
	const brickFace = smoothstep(0, lodBevel, distU.mul(brickL)).mul(smoothstep(0, lodBevel, distV.mul(brickH))).mul(wallFacing);
	const wallRelief = brickFace.mul(0.008);
	const wallRough = valueNoise(positionWorld.mul(0.5)).mul(0.08).add(0.82).add(joint.mul(0.12));

	// --- scored concrete (CONCRETE): per-flag tone, fine grit, expansion joints.
	// Ported from SidewalkGenerator; joints keyed off world X/Y so the front facade
	// reads a proper grid (the most-seen face).
	const cp = positionWorld;
	const cdetail = smoothstep(200, 18, positionView.z.negate());
	const cpanel = 1.5;
	const panelHash = fract(sin(floor(cp.x.div(cpanel)).mul(127.1).add(floor(cp.y.div(cpanel)).mul(311.7))).mul(43758.5453));
	const ctone = mx_noise_float(cp.mul(0.5)).mul(0.5).add(0.5);
	const cgrit = detailNoise(cp, 14, 0.07).mul(cdetail);
	const cgrain = detailNoise(cp, 3, 0.003);
	const cbase = mix(color(0x6f6f68), color(0x8c8c82), ctone).mul(panelHash.sub(0.5).mul(0.16).add(1));
	const concreteColor = cbase.add(cgrit).mul(gridLine(cp.x, cpanel, 0.045).max(gridLine(cp.y, cpanel, 0.045)).mul(cdetail).mul(0.45).oneMinus());
	const concreteRelief = cgrain.sub(gridLine(cp.x, cpanel, 0.045).max(gridLine(cp.y, cpanel, 0.045)).mul(cdetail).mul(0.012)).mul(cdetail);
	const concreteRough = float(0.92).sub(panelHash.mul(0.05));

	// --- painted trim (FRAME) + dark metal AC ---
	const frameColor = buildingBase.mul(0.55);
	const acDinge = valueNoise(positionWorld.mul(0.4)).mul(0.5).add(0.5);
	const acColor = mix(color(0x3a3a3a), color(0x4a4036), acDinge);

	// partId branch (FLAT: a per-face id must not interpolate or equal() misses)
	const partId = varying(attribute('partId', 'float')).setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER);
	const isWall = partId.equal(PartId.WALL);
	const isConcrete = partId.equal(PartId.CONCRETE);
	const isFrame = partId.equal(PartId.FRAME);
	const isAC = partId.equal(PartId.AC);

	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = select(isAC, acColor, select(isFrame, frameColor, select(isConcrete, concreteColor, stoneColor)));
	mat.roughnessNode = select(isAC, float(0.52), select(isFrame, float(0.6), select(isConcrete, concreteRough, wallRough)));
	mat.metalnessNode = float(0);
	mat.normalNode = bumpNormal(select(isConcrete, concreteRelief, select(isWall, wallRelief, float(0))));
	mat.opacityNode = attribute('aBuildingFade', 'float');
	// Stochastic fade keeps depth writes and back-face culling intact. Conventional
	// alpha blending exposed the backs of the merged boxes as broad black bands.
	mat.alphaHash = true;
	mat.transparent = false;
	mat.depthWrite = true;
	mat.side = THREE.FrontSide;
	return mat;
}

// The LOD0 glass material: tinted plate glass with a raymarched room behind it
// (lit rooms glow via the shared interiorMapping Fn). SHOPGLASS panes get a warmer
// retail interior, GLASS panes a cooler residential one. interiorMapping is called
// exactly once (toVar) — referencing it from two branches miscompiles.
export function createRoadsideGlassMaterial() {
	const partId = varying(attribute('partId', 'float')).setInterpolation(THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER);
	const isShop = partId.equal(PartId.SHOPGLASS);

	// Instancing mutates positionLocal/normalLocal before the material runs. Convert
	// the camera ray into the per-instance facade frame, matching the city interior
	// mapper instead of treating every rotated building as if it faced +Z.
	const viewObject = normalize(inverse(modelViewMatrix).mul(vec4(normalize(positionView), 0.0)).xyz);
	const facadeNormal = normalLocal;
	const facadeAcross = cross(vec3(0, 1, 0), facadeNormal).normalize();
	const viewRoom = vec3(
		dot(viewObject, facadeAcross),
		viewObject.y,
		dot(viewObject, facadeNormal).negate(),
	);
	const room = interiorMapping({
		roomUV: uvNode(),
		roomSeed: float(fract(positionLocal.x.mul(0.073).add(positionLocal.y.mul(0.019)).add(positionLocal.z.mul(0.11)))).mul(17.3),
		isShop,
		viewDirLocal: viewRoom,
	}).toVar();

	const glassTint = select(isShop, color(0xccd4cf), color(0xb6c6bf));
	const glassBack = select(isShop, color(0x161a1e), color(0x232b31));
	const col = mix(room.xyz.mul(glassTint), glassBack, float(0.18));

	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = col;
	mat.roughnessNode = float(0.14);
	mat.metalnessNode = float(0);
	mat.emissiveNode = room.xyz.mul(room.w).mul(2.0);
	mat.opacityNode = attribute('aBuildingFade', 'float');
	mat.alphaHash = true;
	mat.transparent = false;
	mat.depthWrite = true;
	mat.side = THREE.FrontSide;
	return mat;
}

// Create the far LOD material (shared, configured via instance attributes where possible).
function createFarMaterial() {
	const heightTex = getFacadeHeight();
	const mat = new MeshStandardNodeMaterial({
		vertexColors: true,
		roughness: 0.85,
		metalness: 0.0,
		side: THREE.DoubleSide,
	});

	// Base color modulated by vertex color + simple facade tint.
	const baseCol = attribute('color', 'vec3');

	// Compute per-fragment facade POM using the height map.
	// Tile the box UVs so the height field reads as ~3m window modules.
	const uvs = uvNode();
	const facadeUV = vec2(uvs.x.mul(float(3.2)), uvs.y.mul(float(2.8)));

	const pom = parallaxOcclusionUV(heightTex, {
		uvNode: facadeUV,
		scale: 0.05,
		minLayers: 10,
		maxLayers: 32,
		silhouette: false, // boxes don't need silhouette clip for distant use
	});

	// Simple color from height (lighter on frames) + base.
	const relief = pom.sample(heightTex).r; // reuse the height read
	const facadeTint = mix(color(0x8a8175), color(0x5c656f), relief.sub(0.3).clamp(0, 1));
	let col = mix(baseCol, facadeTint, float(0.65));

	// Add "glass" regions where we composite interiors.
	// Detect repeating window bands using UVs (cheap mask).
	const winMask = Fn(() => {
		const fu = fract(facadeUV.x.mul(float(1.05)));
		const fv = fract(facadeUV.y.mul(float(1.6)).add(float(0.07)));
		const inPane = fu.greaterThan(float(0.22)).and(fu.lessThan(float(0.78))).and(fv.greaterThan(float(0.15))).and(fv.lessThan(float(0.82)));
		const groundShop = facadeUV.y.lessThan(float(0.28)); // bottom band for ground floor shops
		return inPane.or(groundShop.and(fv.greaterThan(float(0.08)).and(fv.lessThan(float(0.65)))));
	})();

	// View ray in building-local space (mirrors SkyscraperGenerator: positionView
	// transformed by inverse(modelViewMatrix), avoiding a shared cameraPosition
	// pull). positionView runs from the camera through the fragment, so the
	// local-space form marches into the room behind the glass.
	const viewObject = normalize(inverse(modelViewMatrix).mul(vec4(normalize(positionView), 0.0)).xyz);
	const facadeNormal = normalLocal;
	const facadeAcross = cross(vec3(0, 1, 0), facadeNormal).normalize();
	const viewRoom = vec3(
		dot(viewObject, facadeAcross),
		viewObject.y,
		dot(viewObject, facadeNormal).negate(),
	);

	const interiorCol = interiorMapping({
		roomUV: vec2(fract(facadeUV.x.mul(float(1.05))), fract(facadeUV.y.mul(float(1.6)).add(float(0.07)))),
		roomSeed: float(fract(positionLocal.x.mul(float(0.073)).add(positionLocal.y.mul(float(0.019))).add(positionLocal.z.mul(float(0.11))))).mul(float(17.3)),
		isShop: facadeUV.y.lessThan(float(0.3)),
		viewDirLocal: viewRoom,
	});

	const interiorFactor = select(winMask, float(0.9), float(0));
	col = mix(col, interiorCol.rgb, interiorFactor);

	mat.colorNode = col;
	mat.roughnessNode = select(winMask, float(0.35), float(0.82));
	mat.metalnessNode = 0.0;

	// Fade driven by instanced attribute during crossfade (both LOD tiers).
	mat.opacityNode = attribute('aBuildingFade', 'float');
	mat.alphaHash = true;
	mat.transparent = false;
	mat.depthWrite = true;
	mat.side = THREE.FrontSide;

	return mat;
}

export class RoadsideBuildingGenerator {
	constructor(options = {}) {
		this.seed = options.seed ?? 1;
		this.style = options.style ?? 'strip'; // 'strip' | 'apartment'
		this.width = options.width ?? (this.style === 'strip' ? 13 : 21);
		this.depth = options.depth ?? (this.style === 'strip' ? 9 : 11);
		this.stories = options.stories ?? (this.style === 'strip' ? 1 + (this.seed % 2) : 3 + (this.seed % 4));
		this.storyHeight = options.storyHeight ?? 3.25;
		this.colorBase = options.colorBase ?? (this.style === 'strip' ? 0xcdb48a : 0x9aa5ad);
	}

	buildLOD0() {
		const params = {
			width: this.width,
			depth: this.depth,
			stories: Math.max(1, Math.min(6, Math.round(this.stories))),
			storyHeight: this.storyHeight,
			seed: this.seed,
			colorBase: this.colorBase,
		};
		if (this.style === 'apartment') {
			return buildApartmentLOD0(params);
		}
		return buildStripLOD0(params);
	}

	buildLOD1() {
		// Derive height directly from stories so the far box matches the LOD0
		// footprint exactly, without rebuilding the detailed geometry (buildLOD0
		// returns the same stories*storyHeight for `height`).
		const stories = Math.max(1, Math.min(6, Math.round(this.stories)));
		const height = stories * this.storyHeight;
		const geom = buildLOD1Box({ width: this.width, depth: this.depth, height });
		const material = createFarMaterial();
		return { geometry: geom, material, height, width: this.width, depth: this.depth };
	}

	// Convenience: build both and return handles. Geometries are owned by caller (dispose).
	buildBoth() {
		const lod0 = this.buildLOD0();
		const lod1 = this.buildLOD1();
		return { lod0, lod1 };
	}
}

export default RoadsideBuildingGenerator;
