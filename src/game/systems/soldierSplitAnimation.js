import * as THREE from 'three';
import {
  SOLDIER_LOCOMOTION_CLIPS,
} from './soldierPartialCut.js';

const LOWER_BODY_PREFIXES = [
  'mixamorighips',
  'mixamorigleftupleg',
  'mixamorigleftleg',
  'mixamorigleftfoot',
  'mixamoriglefttoe',
  'mixamorigrightupleg',
  'mixamorigrightleg',
  'mixamorigrightfoot',
  'mixamorigrighttoe',
];

function boneNameOfTrack(track) {
  const dot = track.name.indexOf('.');
  return dot === -1 ? track.name : track.name.slice(0, dot);
}

function normalizeBoneName(name) {
  return String(name).replace(/^mixamorig:?/i, 'mixamorig').toLowerCase();
}

export function filterSoldierClipByBody(source, keepLower) {
  const tracks = source.tracks.filter((track) => {
    const isLower = LOWER_BODY_PREFIXES.some((prefix) => (
      normalizeBoneName(boneNameOfTrack(track)).startsWith(prefix)
    ));
    return keepLower ? isLower : !isLower;
  });

  const masked = new THREE.AnimationClip(
    `${source.name}:${keepLower ? 'lower' : 'upper'}`,
    source.duration,
    tracks,
    source.blendMode,
  );
  masked.userData = { ...(source.userData ?? {}), bodyMask: keepLower ? 'lower' : 'upper' };
  return masked;
}

export function isSoldierArmSplitLocomotion(enemy) {
  if (enemy?.limbLossProfile !== 'mixamo-humanoid' || !enemy.limbLoss) {
    return false;
  }

  if (enemy.locomotionMode === 'crawl' || enemy.pendingCorpse) {
    return false;
  }

  const loss = enemy.limbLoss;
  const oneArmMissing = (!loss.armL || !loss.armR) && loss.armL !== loss.armR;

  return oneArmMissing && loss.legL && loss.legR && loss.head;
}

export function resolveSoldierArmMissingUpperClip(enemy) {
  const loss = enemy?.limbLoss;
  if (!loss) {
    return null;
  }

  if (!loss.armL && loss.armR) {
    return SOLDIER_LOCOMOTION_CLIPS.armL;
  }

  if (!loss.armR && loss.armL) {
    return SOLDIER_LOCOMOTION_CLIPS.armR;
  }

  return null;
}

export function resolveSoldierSplitLowerClip(enemy) {
  if (enemy.state === 'hold' || enemy.state === 'attack') {
    return 'Idle Alert';
  }

  if (enemy.state === 'chase') {
    return 'Run';
  }

  return 'Walk';
}

// "At the player and not moving" — hold (in range) or attack (striking). Used to
// decide when a disability soldier should idle its legs instead of locomoting.
export function isSoldierStationaryState(enemy) {
  return enemy?.state === 'hold' || enemy?.state === 'attack';
}

// One-leg-lost (prone/lying state): drives the split system so the remaining
// leg can idle (lower) while the leg-missing upper torso keeps playing.
export function isSoldierSingleLegSplitLocomotion(enemy) {
  if (enemy?.limbLossProfile !== 'mixamo-humanoid' || !enemy?.limbLoss) {
    return false;
  }

  if (enemy.locomotionMode === 'crawl' || enemy.pendingCorpse) {
    return false;
  }

  const loss = enemy.limbLoss;
  return (!loss.legL || !loss.legR) && loss.legL !== loss.legR;
}

// The leg-missing clip played on the UPPER body (torso/arms) while the remaining
// leg takes the lower-body clip. Mirrors resolveSoldierArmMissingUpperClip.
export function resolveSoldierLegMissingUpperClip(enemy) {
  const loss = enemy?.limbLoss;
  if (!loss) {
    return null;
  }

  if (!loss.legL && loss.legR) {
    return SOLDIER_LOCOMOTION_CLIPS.legL;
  }

  if (!loss.legR && loss.legL) {
    return SOLDIER_LOCOMOTION_CLIPS.legR;
  }

  return null;
}

export function createSoldierSplitActionMaps(mixer, clips) {
  const actions = new Map();
  const lowerActions = new Map();
  const upperActions = new Map();

  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    actions.set(clip.name, action);
    actions.set(clip.name.toLowerCase(), action);

    const lowerClip = filterSoldierClipByBody(clip, true);
    const upperClip = filterSoldierClipByBody(clip, false);
    const lowerAction = mixer.clipAction(lowerClip);
    const upperAction = mixer.clipAction(upperClip);
    lowerAction.enabled = true;
    upperAction.enabled = true;
    lowerAction.setLoop(THREE.LoopRepeat, Infinity);
    upperAction.setLoop(THREE.LoopRepeat, Infinity);
    lowerAction.clampWhenFinished = false;
    upperAction.clampWhenFinished = false;
    lowerActions.set(clip.name, lowerAction);
    lowerActions.set(clip.name.toLowerCase(), lowerAction);
    upperActions.set(clip.name, upperAction);
    upperActions.set(clip.name.toLowerCase(), upperAction);
  }

  return { actions, lowerActions, upperActions };
}

export function soldierSplitAnimationLabel(lowerName, upperName) {
  return `${lowerName}|${upperName}`;
}

export function isSoldierSplitAnimationLabel(label) {
  return String(label).includes('|');
}
