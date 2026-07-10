/**
 * AbilitySystem — equip traversal powers like guns, activate with F.
 *
 * Scroll (when not FP-armed) cycles the loadout. The equipped ability remaps
 * F (and a few secondary inputs) onto the legacy hook / wingsuit flags so
 * HookSwingSystem and WingsuitFlightSystem stay unchanged.
 */

import {
  ABILITY_CATALOG,
  DEFAULT_ABILITY_ID,
  abilityIndex,
  findAbility,
} from '../abilities/abilityCatalog.js';

export class AbilitySystem {
  constructor() {
    this.equippedId = DEFAULT_ABILITY_ID;
    this.switchIndex = abilityIndex(this.equippedId);
  }

  /**
   * @param {string} abilityId
   * @returns {string|null} equipped id
   */
  equip(abilityId) {
    const entry = findAbility(abilityId);
    if (!entry) return this.equippedId;
    this.equippedId = entry.id;
    this.switchIndex = abilityIndex(entry.id);
    return this.equippedId;
  }

  /**
   * Cycle loadout by scroll direction (+1 / -1).
   * @param {number} dir
   */
  cycle(dir = 1) {
    if (ABILITY_CATALOG.length === 0) return this.equippedId;
    const step = dir > 0 ? 1 : -1;
    this.switchIndex = (this.switchIndex + step + ABILITY_CATALOG.length) % ABILITY_CATALOG.length;
    this.equippedId = ABILITY_CATALOG[this.switchIndex]?.id ?? DEFAULT_ABILITY_ID;
    return this.equippedId;
  }

  /**
   * Remap ability input onto hook/wingsuit flags. Call early in the frame,
   * before vehicle/mount/FP/traversal consume input.
   *
   * Scroll is owned by the weapon loadout (sword + guns). Cycle abilities via
   * equip()/cycle() (debug) or a future dedicated control.
   *
   * @param {{ input: object, firstPersonWeaponSystem?: object, weaponSystem?: object }} ctx
   * @returns {object} patched input
   */
  processInput({ input, firstPersonWeaponSystem = null, weaponSystem = null } = {}) {
    if (!input) return input;
    void firstPersonWeaponSystem;
    void weaponSystem;

    // Keep switch index aligned if something else equipped via debug bridge.
    if (this.equippedId) {
      const idx = abilityIndex(this.equippedId);
      if (idx >= 0) this.switchIndex = idx;
    }

    const ability = findAbility(this.equippedId);
    const abilityPressed = Boolean(input.abilityPressed);
    const abilityHeld = Boolean(input.abilityHeld);
    const abilityDoubleTapped = Boolean(input.abilityDoubleTapped);

    // Strip always-on traversal powers — they only fire through the equipped ability.
    // Middle-click remains a swing secondary only while swing is equipped.
    const middlePressed = Boolean(input.mouseMiddlePressed);
    const middleHeld = Boolean(input.mouseMiddleHeld);

    let hookFirePressed = false;
    let hookFire = false;
    let hookFireDoubleTapped = false;
    let hookAimHeld = Boolean(input.hookAimHeld);
    let wingsuitTogglePressed = false;

    if (ability?.id === 'swing') {
      hookFirePressed = abilityPressed || middlePressed;
      hookFire = abilityHeld || middleHeld;
      hookFireDoubleTapped = abilityDoubleTapped;
    } else {
      // Aim reticle only matters while the grapple is equipped.
      hookAimHeld = false;
    }

    if (ability?.id === 'wingsuit') {
      // F toggle, plus double-tap Space (InputSystem still exposes the raw edge).
      wingsuitTogglePressed = abilityPressed || Boolean(input.wingsuitTogglePressed);
    }

    return {
      ...input,
      // Consume ability edges so nothing else re-uses F this frame.
      abilityPressed: false,
      abilityDoubleTapped: false,
      equippedAbilityId: this.equippedId,
      equippedAbilityLabel: ability?.shortLabel ?? ability?.label ?? null,
      hookFirePressed,
      hookFire,
      hookFireDoubleTapped,
      hookAimHeld,
      wingsuitTogglePressed,
    };
  }

  snapshot() {
    const entry = findAbility(this.equippedId);
    return {
      equippedId: this.equippedId,
      label: entry?.label ?? this.equippedId,
      shortLabel: entry?.shortLabel ?? this.equippedId,
      catalog: ABILITY_CATALOG.map((a) => ({ id: a.id, label: a.label, shortLabel: a.shortLabel })),
      switchIndex: this.switchIndex,
    };
  }
}
