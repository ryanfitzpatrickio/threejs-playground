// Unit check for the twist–swing swing-inversion bend correction.
// length axis = local +Y (as in the horse rig). A bend is a swing about an axis
// perpendicular to Y; twist is spin about Y. We construct deltas from a known
// bend+twist, invert with the new method, and confirm the bend sign-flips while
// twist is preserved — exactly, at any angle, for any hinge orientation. The
// old Euler single-axis-negation is printed for comparison (it only agrees when
// the hinge is perfectly axis-aligned; a tilted hinge + large bend corrupts it).
import * as THREE from 'three';

const Y = new THREE.Vector3(0, 1, 0);

function measure(delta, hinge) {
  const rotAxis = Y.clone().applyQuaternion(delta);
  const swing = new THREE.Quaternion().setFromUnitVectors(Y, rotAxis);
  const twist = swing.clone().invert().multiply(delta);
  if (twist.w < 0) twist.set(-twist.x, -twist.y, -twist.z, -twist.w);
  const bend = Math.atan2(new THREE.Vector3().crossVectors(Y, rotAxis).dot(hinge), Y.dot(rotAxis));
  const twistAng = 2 * Math.atan2(twist.y, twist.w); // length axis is Y
  return { bend: THREE.MathUtils.radToDeg(bend), twist: THREE.MathUtils.radToDeg(twistAng) };
}

function newInvert(delta) {
  const rotAxis = Y.clone().applyQuaternion(delta);
  const swing = new THREE.Quaternion().setFromUnitVectors(Y, rotAxis);
  const twist = swing.clone().invert().multiply(delta);
  swing.slerp(swing.clone().invert(), 1);
  return swing.multiply(twist);
}

function oldInvert(delta) {
  const e = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
  e.x = -e.x;
  return new THREE.Quaternion().setFromEuler(e);
}

const tilts = {
  'pure-X hinge ': new THREE.Vector3(1, 0, 0),
  'tilted hinge': new THREE.Vector3(1, 0, 0.35).normalize(),
};
const cases = [[30, 0], [80, 20], [90, 10], [120, 15]];
const r = (n) => n.toFixed(1).padStart(7);

let ok = true;
for (const [label, hinge] of Object.entries(tilts)) {
  console.log(`\n${label} (h≈[${hinge.x.toFixed(2)},${hinge.y.toFixed(2)},${hinge.z.toFixed(2)}])`);
  console.log('  in(bend°,tw°) |   NEW bend°/tw°   |   OLD bend°/tw°');
  for (const [b, t] of cases) {
    const delta = new THREE.Quaternion().setFromAxisAngle(hinge, THREE.MathUtils.degToRad(b))
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, THREE.MathUtils.degToRad(t)));
    const n = measure(newInvert(delta), hinge);
    const o = measure(oldInvert(delta), hinge);
    console.log(
      `  (${String(b).padStart(3)},${String(t).padStart(2)})    | ${r(n.bend)} /${r(n.twist)}  | ${r(o.bend)} /${r(o.twist)}`,
    );
    if (Math.abs(n.bend - -b) > 0.01 || Math.abs(n.twist - t) > 0.01) {
      ok = false;
      console.log(`    !! NEW expected bend=${-b}, twist=${t}`);
    }
  }
}

console.log(`\n${ok ? 'PASS' : 'FAIL'}: new method sign-flips bend and preserves twist exactly, for every hinge and angle.`);
process.exit(ok ? 0 : 1);
