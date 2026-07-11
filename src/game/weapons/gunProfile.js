/**
 * Gun profile schema helpers.
 *
 * A profile is data-only: it references a GLB by path and annotates meshes with
 * part identity, anchors, materials, behavior tags, and stat overrides.
 * Authored in the Gunsmith; stubs can be hand-written before the editor exists.
 */

import {
  BEHAVIOR_TAGS,
  createStubAnchors,
  PART_IDENTITIES,
  SURFACE_CLASSES,
  validateRequiredAnchors,
} from './gunAnchors.js';
import { normalizeGunSoundAssignments } from './gunSoundLibrary.js';
import { createDefaultGunAppearance, normalizeGunAppearance } from './gunMaterials.js';
import { normalizeScopeViewport } from './gunScopeViewport.js';

export const GUN_PROFILE_VERSION = 5;

export const WEAPON_KINDS = Object.freeze(['rifle', 'pistol', 'shotgun']);

/**
 * @typedef {object} GunPartAnnotation
 * @property {string} meshName
 * @property {string} [identity]  one of PART_IDENTITIES
 * @property {string} [surfaceClass]  one of SURFACE_CLASSES
 * @property {{mode:string,textureSet:string,uvScale:number,metalness:number,roughness:number}} [appearance]
 * @property {{pattern?:string,scale?:number,tintPalette?:string[],roughnessBias?:number,wearAmount?:number}|null} [skin]
 * @property {string[]} [behaviors]  subset of BEHAVIOR_TAGS
 * @property {{axis?:number[],travel?:number,angle?:number}|null} [behaviorParams]
 */

/**
 * @typedef {object} GunProfile
 * @property {number} version
 * @property {string} id
 * @property {string} label
 * @property {string} glbUrl
 * @property {'weapon'|'source'} anchorSpace  coordinate space used by `anchors`
 * @property {'rifle'|'pistol'|'shotgun'} weaponKind
 * @property {string} [statsId]  key into gunConfig defaults
 * @property {object} [statOverrides]
 * @property {object} [presentation] weapon-feedback tuning
 * @property {Record<string, string>} sounds
 * @property {Array<object>} anchors
 * @property {GunPartAnnotation[]} parts
 * @property {object|null} scopeViewport generated cylindrical scope display
 * @property {number} [updatedAt]
 */

export function createEmptyProfile({
  id,
  label = id,
  glbUrl,
  weaponKind = 'rifle',
  statsId = null,
  meshNames = [],
} = {}) {
  if (!id) throw new Error('createEmptyProfile requires id');
  if (!glbUrl) throw new Error('createEmptyProfile requires glbUrl');

  const parts = (meshNames.length ? meshNames : []).map((meshName) => ({
    meshName,
    identity: 'misc',
    surfaceClass: 'metal',
    appearance: createDefaultGunAppearance('metal'),
    skin: null,
    behaviors: [],
    behaviorParams: null,
  }));

  return {
    version: GUN_PROFILE_VERSION,
    id,
    label,
    glbUrl,
    weaponKind,
    statsId: statsId ?? weaponKind,
    statOverrides: {},
    presentation: null,
    sounds: normalizeGunSoundAssignments(null, id),
    anchorSpace: 'weapon',
    anchors: createStubAnchors(weaponKind),
    parts,
    scopeViewport: null,
    updatedAt: Date.now(),
  };
}

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gun profile must be an object');
  }
  const id = String(raw.id || '').trim();
  if (!id) throw new Error('gun profile missing id');

  const weaponKind = WEAPON_KINDS.includes(raw.weaponKind) ? raw.weaponKind : 'rifle';
  // Version 1/2 profiles saved from the original Gunsmith used raw Meshy space.
  // New/editor-exported profiles explicitly carry `weapon`, matching runtime.
  const anchorSpace = raw.anchorSpace === 'weapon' ? 'weapon' : 'source';
  const sounds = normalizeGunSoundAssignments(raw.sounds, id);
  const anchors = Array.isArray(raw.anchors) ? raw.anchors.map(normalizeAnchor) : createStubAnchors(weaponKind);
  const parts = Array.isArray(raw.parts) ? raw.parts.map(normalizePart) : [];

  return {
    version: Math.max(Number(raw.version) || 1, GUN_PROFILE_VERSION),
    id,
    label: String(raw.label || id),
    glbUrl: String(raw.glbUrl || ''),
    weaponKind,
    statsId: String(raw.statsId || weaponKind),
    statOverrides: raw.statOverrides && typeof raw.statOverrides === 'object' ? { ...raw.statOverrides } : {},
    presentation: raw.presentation && typeof raw.presentation === 'object' ? { ...raw.presentation } : null,
    sounds,
    anchorSpace,
    anchors,
    parts,
    // V4 introduced the viewport with a conservative 4× default. Migrate that
    // exact default to the tighter V5 tactical sight; custom authored values stay.
    scopeViewport: normalizeScopeViewport(raw.scopeViewport
      ? {
        ...raw.scopeViewport,
        magnification: (Number(raw.version) || 1) < 5
          && Number(raw.scopeViewport.magnification) === 4
          ? 8
          : raw.scopeViewport.magnification,
      }
      : null),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizeAnchor(a) {
  return {
    name: String(a?.name || 'unnamed'),
    position: toVec3(a?.position, [0, 0, 0]),
    quaternion: toVec4(a?.quaternion, [0, 0, 0, 1]),
    scale: toVec3(a?.scale, [1, 1, 1]),
  };
}

function normalizePart(p) {
  const identity = PART_IDENTITIES.includes(p?.identity) ? p.identity : 'misc';
  const surfaceClass = SURFACE_CLASSES.includes(p?.surfaceClass) ? p.surfaceClass : 'metal';
  const behaviors = Array.isArray(p?.behaviors)
    ? p.behaviors.filter((b) => BEHAVIOR_TAGS.includes(b))
    : [];
  return {
    meshName: String(p?.meshName || ''),
    identity,
    surfaceClass,
    appearance: normalizeGunAppearance(p?.appearance, surfaceClass),
    skin: p?.skin && typeof p.skin === 'object' ? { ...p.skin } : null,
    behaviors,
    behaviorParams: p?.behaviorParams && typeof p.behaviorParams === 'object' ? { ...p.behaviorParams } : null,
  };
}

function toVec3(v, fallback) {
  if (Array.isArray(v) && v.length >= 3) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  return [...fallback];
}

function toVec4(v, fallback) {
  if (Array.isArray(v) && v.length >= 4) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, Number(v[3]) || 0];
  }
  return [...fallback];
}

export function validateProfile(profile) {
  const errors = [];
  try {
    normalizeProfile(profile);
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors };
  }
  if (!profile.glbUrl) errors.push('missing glbUrl');
  const anchors = validateRequiredAnchors(profile);
  if (!anchors.ok) {
    errors.push(`missing required anchors for ${anchors.kind}: ${anchors.missing.join(', ')}`);
  }
  return { ok: errors.length === 0, errors, anchors };
}

/** Resolve a mesh name → part annotation (or null). */
export function findPartAnnotation(profile, meshName) {
  if (!profile?.parts || !meshName) return null;
  return profile.parts.find((p) => p.meshName === meshName) ?? null;
}

/** Catalog defaults for the 10 assembled guns (hand stubs until Gunsmith saves). */
export const GUN_CATALOG = Object.freeze([
  { id: 'modern-ar15', label: 'Modern AR-15', glbUrl: '/assets/guns/modern-ar15.glb', weaponKind: 'rifle' },
  { id: 'desert-ar15', label: 'Desert Tan AR-15', glbUrl: '/assets/guns/desert-ar15.glb', weaponKind: 'rifle' },
  { id: 'desert-scar', label: 'Desert Tan SCAR', glbUrl: '/assets/guns/desert-scar.glb', weaponKind: 'rifle' },
  { id: 'ak47', label: 'AK-47 Style', glbUrl: '/assets/guns/ak47.glb', weaponKind: 'rifle' },
  { id: 'folding-stock-ar', label: 'Folding-Stock AR', glbUrl: '/assets/guns/folding-stock-ar.glb', weaponKind: 'rifle' },
  { id: 'obsidian-carbine', label: 'Obsidian Shadow Carbine', glbUrl: '/assets/guns/obsidian-carbine.glb', weaponKind: 'rifle' },
  { id: 'olive-bullpup', label: 'Olive Bullpup', glbUrl: '/assets/guns/olive-bullpup.glb', weaponKind: 'rifle' },
  { id: 'midnight-glock', label: 'Midnight Glock', glbUrl: '/assets/guns/midnight-glock.glb', weaponKind: 'pistol' },
  { id: 'tactical-shotgun', label: 'Tactical Pump Shotgun', glbUrl: '/assets/guns/tactical-shotgun.glb', weaponKind: 'shotgun' },
  { id: 'desert-sentinel', label: 'Desert Sentinel', glbUrl: '/assets/guns/desert-sentinel.glb', weaponKind: 'rifle' },
]);

export function createCatalogStubProfile(entry, meshNames = []) {
  return createEmptyProfile({
    id: entry.id,
    label: entry.label,
    glbUrl: entry.glbUrl,
    weaponKind: entry.weaponKind,
    statsId: entry.weaponKind,
    meshNames,
  });
}
