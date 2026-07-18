import assert from 'node:assert/strict';
import { createDemoGarment } from '../src/vendor/vibe-human/features/clothing/demo/createDemoGarment.ts';
import { toPatternDocument } from '../src/vendor/vibe-human/features/clothing/document/legacyAdapter.ts';
import { compileGarmentRuntime } from '../src/vendor/vibe-human/features/clothing/compiler/compileGarmentRuntime.ts';
import { XPBDClothSolver } from '../src/vendor/vibe-human/features/clothing/simulation/solver.ts';

const document = toPatternDocument(createDemoGarment(), {});
const compiled = compileGarmentRuntime(document, { quality: 'low', seamSamples: 18 });
const errors = compiled.issues.filter((issue) => issue.severity === 'error');
assert.deepEqual(errors, [], `compile errors: ${errors.map((issue) => issue.message).join('; ')}`);

const mesh = compiled.value.simMesh;
assert.ok(mesh.particleCount >= 100, `expected useful cloth density, got ${mesh.particleCount}`);
assert.ok(mesh.triangles.length >= 300, `expected triangulated panels, got ${mesh.triangles.length / 3} triangles`);
assert.ok(mesh.stretchConstraints.length > mesh.particleCount, 'expected structural edge constraints');
assert.ok(mesh.seamConstraints.length >= 40, `expected sampled seam joins, got ${mesh.seamConstraints.length}`);
assert.equal(compiled.value.renderPanels.length, 2, 'demo shirt should compile front and back render panels');

const initialSeamGap = meanConstraintLength(mesh.positions, mesh.seamConstraints);
const solver = new XPBDClothSolver(mesh, {
  gravity: 0,
  damping: 0.08,
  substeps: 2,
  iterations: 8,
  dt: 1 / 60,
  groundY: -100,
  maxVelocity: 8,
  selfCollisionRadius: 0.01,
  selfCollisionStiffness: 0.35,
  sewingTime: 0.25,
  gravityDelayTime: 0,
  gravityRampTime: 0,
});

for (let frame = 0; frame < 60; frame += 1) solver.step(null);

for (const value of mesh.positions) assert.ok(Number.isFinite(value), 'solver produced a non-finite position');
const finalSeamGap = meanConstraintLength(mesh.positions, mesh.seamConstraints);
assert.ok(finalSeamGap < initialSeamGap * 0.35, `seams should join (${initialSeamGap.toFixed(4)} -> ${finalSeamGap.toFixed(4)})`);

const stretchError = meanRelativeRestError(mesh.positions, mesh.stretchConstraints);
assert.ok(stretchError < 0.18, `mean structural edge error too high: ${(stretchError * 100).toFixed(1)}%`);

console.log(
  `verify-cloth-solver: ${mesh.particleCount} particles, ${mesh.triangles.length / 3} triangles, `
  + `${mesh.seamConstraints.length} seam joins, ${(stretchError * 100).toFixed(1)}% mean edge error OK`,
);

function meanConstraintLength(positions, constraints) {
  return constraints.reduce((sum, constraint) => sum + constraintLength(positions, constraint), 0) / constraints.length;
}

function meanRelativeRestError(positions, constraints) {
  return constraints.reduce((sum, constraint) => {
    const length = constraintLength(positions, constraint);
    return sum + Math.abs(length - constraint.rest) / Math.max(1e-6, constraint.rest);
  }, 0) / constraints.length;
}

function constraintLength(positions, constraint) {
  const a = constraint.a * 3;
  const b = constraint.b * 3;
  return Math.hypot(
    positions[b] - positions[a],
    positions[b + 1] - positions[a + 1],
    positions[b + 2] - positions[a + 2],
  );
}
