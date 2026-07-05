import assert from 'node:assert/strict';

const TWO_SQRT_THREE = 2 * Math.sqrt(3);
const INV_SQRT_THREE = 1 / Math.sqrt(3);
const TWO_INV_SQRT_THREE = 2 / Math.sqrt(3);

const fract = (x) => x - Math.floor(x);
const fract2 = ([x, y]) => [fract(x), fract(y)];
const add2 = ([ax, ay], [bx, by]) => [ax + bx, ay + by];
const floor2 = ([x, y]) => [Math.floor(x), Math.floor(y)];
const scale2 = ([x, y], k) => [x * k, y * k];
const skew = ([x, y]) => [x - y * INV_SQRT_THREE, y * TWO_INV_SQRT_THREE];

function triangleGridRws(st, stOffset) {
  const skewed = skew(scale2(st, TWO_SQRT_THREE));
  const skewedOffset = skew(scale2(stOffset, TWO_SQRT_THREE));
  const offsetBase = floor2(skewedOffset);
  const combined = add2(skewed, fract2(skewedOffset));
  const base = add2(floor2(combined), offsetBase);
  const [fx, fy] = fract2(combined);
  const z = 1 - fx - fy;
  const s = z <= 0 ? 1 : 0;
  const s2 = 2 * s - 1;
  return {
    weights: [-z * s2, s - fy * s2, s - fx * s2],
    vertices: [
      add2(base, [s, s]),
      add2(base, [s, 1 - s]),
      add2(base, [1 - s, s]),
    ],
  };
}

function hash2([x, y]) {
  return [
    fract(Math.sin(127.1 * x + 311.7 * y) * 43758.5453),
    fract(Math.sin(269.5 * x + 183.3 * y) * 43758.5453),
  ];
}

function rotationAngle([x, y], strength) {
  let angle = (Math.abs(x * y) + Math.abs(x + y) + Math.PI) % (2 * Math.PI);
  if (angle < 0) angle += 2 * Math.PI;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  return angle * strength;
}

function vertexCenter([x, y]) {
  return [(x + 0.5 * y) / TWO_SQRT_THREE, (y / TWO_INV_SQRT_THREE) / TWO_SQRT_THREE];
}

function close(actual, expected, epsilon = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(
    Math.abs(value - expected[i]) <= epsilon,
    `index ${i}: expected ${expected[i]}, received ${value}`,
  ));
}

// Pinned fixtures calculated from the publication's HLSL equations. They cover
// both simplex halves and the RWS integer-offset fold.
const fixtures = [
  {
    st: [0, 0], offset: [0, 0],
    weights: [1, 0, 0], vertices: [[0, 0], [0, 1], [1, 0]],
  },
  {
    st: [0.125, 0.25], offset: [0, 0],
    weights: [0.0669872981077807, 0, 0.9330127018922193],
    vertices: [[-1, 1], [-1, 2], [0, 1]],
  },
  {
    st: [0.125, 0.25], offset: [1000000.25, -2000000.5],
    weights: [0.5858241400263088, 0, 0.4141758599736912],
    vertices: [[7464103, -8000001], [7464103, -8000000], [7464104, -8000001]],
  },
];

for (const fixture of fixtures) {
  const result = triangleGridRws(fixture.st, fixture.offset);
  close(result.weights, fixture.weights, 2e-9);
  assert.deepEqual(result.vertices, fixture.vertices);
  close([result.weights.reduce((sum, value) => sum + value, 0)], [1]);
  result.weights.forEach((weight) => assert.ok(weight >= -1e-12 && weight <= 1 + 1e-12));
}

close(hash2([0, 0]), [0, 0]);
close(hash2([1, 0]), [0.32561142705526436, 0.2163376393255021], 1e-10);
close(hash2([-3, 7]), [0.48669001503731124, 0.5447428355437296], 1e-10);
close(vertexCenter([2, -1]), [0.43301270189221935, -0.25]);
close([rotationAngle([2, -1], 0)], [0]);
close([rotationAngle([2, -1], 1)], [-0.14159265358979312]);

console.log('Hex-tile lattice, RWS offset, hash, center, and rotation fixtures passed.');
