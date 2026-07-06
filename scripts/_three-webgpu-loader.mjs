// Run with: node --import ./scripts/_three-webgpu-loader.mjs <script.mjs>
//
// Registers the resolve hook that remaps bare 'three' → 'three/webgpu' so the
// pure-node verify scripts can import the forest LOD stack (which pulls node
// materials the WebGL 'three' entry doesn't export). See
// _three-webgpu-resolve.mjs. (Node prints a one-line deprecation notice for
// module.register — harmless; the API still works in current Node.)
import { register } from 'node:module';
register('./_three-webgpu-resolve.mjs', import.meta.url);
