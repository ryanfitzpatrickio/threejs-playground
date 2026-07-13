import { createRuntimeKernel } from '../runtime/createRuntimeKernel.js';

/**
 * Stable public facade over the runtime kernel.
 * Closed to feature implementation — new systems register outside this file.
 *
 * @see docs/game-runtime-modularization-plan.md
 */
export class GameRuntime {
  constructor(options) {
    this._kernel = createRuntimeKernel(options);
    // Compatibility: expose kernel fields so existing probes/UI that touch
    // runtime.sceneSystem etc. keep working without going through getters.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target || prop === '_kernel') {
          return Reflect.get(target, prop, receiver);
        }
        const k = target._kernel;
        const value = k[prop];
        if (typeof value === 'function') {
          return value.bind(k);
        }
        return value;
      },
      set(target, prop, value, receiver) {
        if (prop === '_kernel' || prop in target) {
          return Reflect.set(target, prop, value, receiver);
        }
        target._kernel[prop] = value;
        return true;
      },
    });
  }

  async start() {
    return this._kernel.start();
  }

  update(timeMs) {
    return this._kernel.update(timeMs);
  }

  snapshot(options) {
    return this._kernel.snapshot(options);
  }

  dispose() {
    return this._kernel.dispose();
  }
}
