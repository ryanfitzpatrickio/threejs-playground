// Resolve hook (paired with _three-webgpu-loader.mjs): remap bare `import ...
// from 'three'` to the WebGPU build. Under bare node, `'three'` is the WebGL
// main entry, which lacks the node materials the vendored SeedThree engine
// uses. The vite alias maps `'three'` → WebGPU for the browser; this mirrors it
// headlessly. Construction is CPU-only — no GPU backend touched.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return nextResolve('three/webgpu', context);
  return nextResolve(specifier, context);
}
