import { createRuntimeDebugBridge } from './createRuntimeDebugBridge.js';

/**
 * Installs/removes globalThis.__DREAMFALL_DEBUG__.
 * Removes only the bridge instance it installed.
 */
export class RuntimeDebugHost {
  constructor(host) {
    this._host = host;
    this._bridge = null;
  }

  install() {
    const host = this._host;
    const bridge = createRuntimeDebugBridge(host);
    host.debugBridge = bridge;
    this._bridge = bridge;
    globalThis.__DREAMFALL_DEBUG__ = bridge;
    return bridge;
  }

  uninstall() {
    const host = this._host;
    if (globalThis.__DREAMFALL_DEBUG__ === this._bridge || globalThis.__DREAMFALL_DEBUG__ === host.debugBridge) {
      delete globalThis.__DREAMFALL_DEBUG__;
    }
    host.debugBridge = null;
    this._bridge = null;
  }
}
