import { createCoreDebugCommands } from './coreDebugCommands.js';
import { createRenderDebugCommands } from './renderDebugCommands.js';
import { createTraversalDebugCommands } from './traversalDebugCommands.js';
import { createCharacterDebugCommands } from './characterDebugCommands.js';
import { createVehicleDebugCommands } from './vehicleDebugCommands.js';
import { createCombatDebugCommands } from './combatDebugCommands.js';

/**
 * Merge domain command objects; throws on duplicate keys.
 * @param {object} rt runtime host
 */
export function createRuntimeDebugBridge(rt) {
  const sets = [
    createCoreDebugCommands(rt),
    createRenderDebugCommands(rt),
    createTraversalDebugCommands(rt),
    createCharacterDebugCommands(rt),
    createVehicleDebugCommands(rt),
    createCombatDebugCommands(rt),
  ];
  const bridge = {};
  for (const set of sets) {
    for (const [key, value] of Object.entries(set)) {
      if (Object.prototype.hasOwnProperty.call(bridge, key)) {
        throw new Error(`[debug-bridge] duplicate command key: ${key}`);
      }
      bridge[key] = value;
    }
  }
  return bridge;
}
