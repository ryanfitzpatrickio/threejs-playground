/**
 * Sibling of dreamfall-dev-tools: DEV exports real pane/register; PROD inert
 * stubs (no tweakpane). RuntimeLoader.js statically imports
 * `virtual:dreamfall-shader-debug`, so any config that reaches RuntimeLoader
 * (main playground, or the dog product's Phase P GameRuntime shell) must
 * register this plugin — inert is fine, missing is a hard Vite resolve error.
 */
import { fileURLToPath } from 'node:url';

const shaderDebugPaneModule = fileURLToPath(new URL('../src/game/debug/shaderDebugPane.js', import.meta.url));
const shaderDebugRegisterModule = fileURLToPath(new URL('../src/game/debug/registerBuiltinShaderDebug.js', import.meta.url));
const shaderDebugPublicId = 'virtual:dreamfall-shader-debug';
const shaderDebugResolvedId = `\0${shaderDebugPublicId}`;

export function shaderDebugPlugin(enabled) {
  return {
    name: 'dreamfall-shader-debug',
    resolveId(id) {
      return id === shaderDebugPublicId ? shaderDebugResolvedId : null;
    },
    load(id) {
      if (id !== shaderDebugResolvedId) return null;
      if (enabled) {
        return `
          export { mountShaderDebugPane } from ${JSON.stringify(shaderDebugPaneModule)};
          export { registerBuiltinShaderDebug } from ${JSON.stringify(shaderDebugRegisterModule)};
        `;
      }
      return `
        export async function mountShaderDebugPane() { return null; }
        export function registerBuiltinShaderDebug() {}
      `;
    },
  };
}
