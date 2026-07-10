import { Rifle } from './Rifle.js';
import { Pistol } from './Pistol.js';
import { Shotgun } from './Shotgun.js';
import { normalizeProfile } from './gunProfile.js';

const KIND_CLASS = {
  rifle: Rifle,
  pistol: Pistol,
  shotgun: Shotgun,
};

/**
 * Factory: build a BaseGun subclass from a profile or kind string.
 * @param {object|string} profileOrKind
 * @param {object} [options]
 */
export function createGun(profileOrKind, options = {}) {
  if (typeof profileOrKind === 'string') {
    const kind = profileOrKind;
    const Cls = KIND_CLASS[kind] || Rifle;
    return new Cls({ weaponKind: kind, ...options });
  }

  const profile = normalizeProfile(profileOrKind);
  const Cls = KIND_CLASS[profile.weaponKind] || Rifle;
  return new Cls({ profile, ...options });
}

export function gunClassForKind(kind) {
  return KIND_CLASS[kind] || Rifle;
}
