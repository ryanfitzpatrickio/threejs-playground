# AI Prompting Takeaways & Reusable Blueprints

This document outlines key technical lessons learned and provides reusable **AI Prompts** that serve as "quick wins" for building high-fidelity 3D physics and traversal features in WebGL / Three.js.

---

## 1. High-Performance Raycasting & Ledge Climbing with BVH

### The Quick Win
Ledge detection, wall climbing, and wall-running require casting dozens of rays per frame to detect geometric edges, surface normals, and vertical wall properties. Doing this against complex, high-poly level meshes will quickly drop the frame rate.
By integrating **`three-mesh-bvh`**, we index the level geometry so raycasts run in $O(\log N)$ time rather than $O(N)$. Further, we build the BVH trees *lazily* on first query to prevent attach-time hitching as chunks stream in.

### Reusable AI Prompt
```text
Write a helper class in Three.js that indexes level meshes using the 'three-mesh-bvh' library for real-time parkour raycasting (ledge detection and wall running).
The system must:
1. Traverse the scene graph and collect all static render meshes.
2. Build the Bounding Volume Hierarchy (BVH) trees lazily on the first raycast query rather than at attach/load time to avoid main-thread stuttering.
3. Expose a robust 'raycast(origin, direction, near, far, firstHitOnly)' function that configures the THREE.Raycaster to use the accelerated BVH intersection methods.
4. Correctly manage tree disposal ('geometry.disposeBoundsTree()') when chunks or meshes are streamed out or removed from the scene.
Provide a clean ES6 module implemewntation.
```

---

## 2. Dynamic Mesh Bisection & Separation using CSG

### The Quick Win
Real-time sword-slashing cuts require bisecting a detailed 3D model at arbitrary angles on contact.
Doing this requires a specialized CSG pipeline:
1. **Pose Baking**: Bake a skinned mesh's current animation frame into static vertex positions (`position` attribute).
2. **Bisection**: Intersect and clip the triangles against the cutting plane, separating them into positive and negative vertex lists.
3. **Capping**: Generate new cap polygons along the cut seam so the resulting pieces don't look like hollow hollow paper meshes.
4. **Isolate Components**: Group connected triangles to identify distinct physical shards (e.g. cutting a limb yields the arm piece and the rest of the body).

### Reusable AI Prompt
```text
Design a mesh-cutting utility in Three.js that bisects a 3D model along an arbitrary mathematical plane, caps the cut faces, and splits the result into separate meshes.
Requirements:
1. Accept a target mesh, a THREE.Plane, and custom materials for the exterior and the interior (cap) faces.
2. For skinned characters, bake the current bone-deformed vertex positions into static geometry before cutting.
3. Perform triangle-plane bisection: split existing polygons along the plane, generate new indices, and triangulate the cap along the cutting seam.
4. Run a flood-fill or BFS traversal over the clipped triangles to group connected vertices, returning an array of separate, closed THREE.BufferGeometry objects.
5. Dispose of the original geometry to prevent memory leaks, and optimize for sub-millisecond execution times.
```

---

## 3. Humanoid Skinned Ragdoll Shards

### The Quick Win
Slicing a humanoid enemy should yield two distinct halves that fall and flail realistically using physics (e.g., knees bending, joints twisting, arms extending).
Rather than spawning generic rigid boxes, the skinned mesh must be split into two separate skeleton rigs. Each bone in the rig is mapped to a physical rigid body in the physics engine, linked by anatomical joint limits, with bone transformations synced back to the skeleton in the render loop.

### Reusable AI Prompt
```text
Write a system in Three.js and Rapier.js to convert a bisected humanoid character skeleton into two independent, articulated skinned ragdoll shards.
Implement the following:
1. Replicate the character's skeleton structure for each shard, partitioning the active bones (e.g., upper body bones in the top shard, legs in the bottom shard).
2. For each active bone, create a dynamic physical RigidBody (e.g., capsule colliders for limbs, spheres for head/joints).
3. Connect parent and child bones in the physics world using Impulse Joints (Spherical and Revolute) configured with strict angular limits to enforce anatomical realism (e.g. elbows and knees only bending along a single axis from 0 to 145 degrees).
4. Implement a synchronization function to run inside requestAnimationFrame that converts the world transforms of the physics bodies into local-space matrices relative to each bone's parent bone, decomposing them into 'bone.position' and 'bone.quaternion'.
```

---

## 4. Cinematic Slow-Motion & Physics Timestep Scaling

### The Quick Win
Transitioning from real-time gameplay to slow-motion (e.g., a "blade mode" or post-cut separation phase) requires slowing down animations, movement, and physics in sync.
Simply scaling the game delta ($\Delta t_{\text{scaled}} = \Delta t \times 0.05$) is only half the solution. If the physics engine keeps stepping at its standard fixed timestep ($1/60$s), the physics simulation will run at normal speed while the animations run in slow motion. To fix this, you must dynamically scale the physics engine's integration timestep ($dt_{\text{world}} = 0.016 \times \text{timeScale}$) each frame to preserve mathematical precision and visual alignment.

### Reusable AI Prompt
```text
Explain and write a Time Dilation system in Three.js that integrates animations, character inputs, and Rapier.js physics in slow motion.
Requirements:
1. Define a dynamic 'timeScale' variable (1.0 = normal, 0.05 = slow-motion) and a smooth ramping recovery timer.
2. Scale the main update delta passed to animations and movement systems: deltaScaled = delta * timeScale.
3. Configure the physics world's timestep dynamically each frame: world.timestep = 0.016 * timeScale. This ensures physics integration resolves velocities, gravity, and joints accurately without numerical instability.
4. Show how to partition inputs during slow-mo: keep camera rotation and aiming unscaled (using raw delta) so looking remains responsive, but scale or lock locomotion inputs so characters move at the dilated speed.
Provide a clean update loop implementation in JavaScript.
```
