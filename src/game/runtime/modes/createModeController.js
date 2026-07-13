import { HighwayModeController } from './HighwayModeController.js';
import { OpenWorldModeController } from './OpenWorldModeController.js';
import { RallyModeController } from './RallyModeController.js';
import { RangeModeController } from './RangeModeController.js';
import { HordeModeController } from './HordeModeController.js';
import { DeathmatchModeController } from './DeathmatchModeController.js';

/**
 * Select exactly one mode policy controller at startup.
 * Mode-specific environment, spawn, update, and teardown policy lives here —
 * not in GameRuntime.js or shared lifecycle/frame modules.
 *
 * @param {string} levelMode
 * @param {object} host runtime kernel
 */
export function createModeController(levelMode, host) {
  switch (levelMode) {
    case 'highway':
      return new HighwayModeController(host);
    case 'rally':
      return new RallyModeController(host);
    case 'range':
      return new RangeModeController(host);
    case 'horde':
      return new HordeModeController(host);
    case 'deathmatch':
      return new DeathmatchModeController(host);
    case 'world':
    case 'wilds':
    case 'city':
    default:
      return new OpenWorldModeController(host, levelMode);
  }
}
