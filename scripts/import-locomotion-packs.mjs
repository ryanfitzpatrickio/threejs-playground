#!/usr/bin/env node
/**
 * Normalize the new Mixamo weapon-locomotion FBX packs into clean, slugged
 * directories that match the existing `weapon-rifle/` convention, so the
 * animation manifest can reference tidy URLs (no spaces / capitalization).
 *
 * Source packs (dropped in by hand, kept intact):
 *   public/assets/animation-packs/Rifle 8-Way Locomotion Pack/   (rifle family)
 *   public/assets/animation-packs/Pistol_Handgun Locomotion Pack (2)/ (pistol family)
 *   (Pro Rifle Pack (4)/ is a byte-for-byte duplicate of the 8-Way pack — ignored.)
 *
 * Output:
 *   public/assets/animation-packs/weapon-rifle-8way/<slug>.fbx
 *   public/assets/animation-packs/weapon-pistol/<slug>.fbx
 *
 * The clips are already the plain Mixamo skeleton (mixamorig*, 57 bones), so the
 * runtime loads them directly with retarget:false + useBakedClip:false exactly
 * like weapon-rifle/ — no re-encode needed, this is a copy + rename.
 *
 * Usage: node scripts/import-locomotion-packs.mjs  (npm run import:loco-packs)
 */
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const PACKS = path.join(ROOT, 'public/assets/animation-packs');

// Canonical 8-way direction slugs (shared by walk/run/sprint + crouch walk).
const DIRS = {
  forward: 'fwd',
  'forward left': 'fwd_left',
  'forward right': 'fwd_right',
  backward: 'bwd',
  'backward left': 'bwd_left',
  'backward right': 'bwd_right',
  left: 'left',
  right: 'right',
};

function buildRifleMap() {
  const map = {};
  for (const tier of ['walk', 'run', 'sprint']) {
    for (const [dirName, dirSlug] of Object.entries(DIRS)) {
      map[`${tier} ${dirName}.fbx`] = `${tier}_${dirSlug}.fbx`;
    }
  }
  // Crouch only ships a walk tier in the pack.
  for (const [dirName, dirSlug] of Object.entries(DIRS)) {
    map[`walk crouching ${dirName}.fbx`] = `crouch_walk_${dirSlug}.fbx`;
  }
  Object.assign(map, {
    'idle.fbx': 'idle.fbx',
    'idle aiming.fbx': 'aim_idle.fbx',
    'idle crouching.fbx': 'crouch_idle.fbx',
    'idle crouching aiming.fbx': 'crouch_aim_idle.fbx',
    'turn 90 left.fbx': 'turn_left.fbx',
    'turn 90 right.fbx': 'turn_right.fbx',
    'crouching turn 90 left.fbx': 'crouch_turn_left.fbx',
    'crouching turn 90 right.fbx': 'crouch_turn_right.fbx',
    'jump up.fbx': 'jump_up.fbx',
    'jump loop.fbx': 'jump_loop.fbx',
    'jump down.fbx': 'jump_down.fbx',
    // Reload (not in the base pack — drop a Mixamo "Reloading"/"Rifle Reload"
    // FBX into the source dir under any of these names and re-run the import).
    'reload.fbx': 'reload.fbx',
    'reloading.fbx': 'reload.fbx',
    'rifle reload.fbx': 'reload.fbx',
  });
  return map;
}

// The pistol pack uses a different, sparser vocabulary. "arc" = diagonal, and the
// "(2)" mirror suffix marks the right-hand variant. Left/right assignment is a
// best guess — verify visually in-browser at M3 and swap here if mirrored.
const PISTOL_MAP = {
  'pistol idle.fbx': 'idle.fbx',
  'pistol walk.fbx': 'walk_fwd.fbx',
  'pistol walk backward.fbx': 'walk_bwd.fbx',
  'pistol walk arc.fbx': 'walk_fwd_left.fbx',
  'pistol walk arc (2).fbx': 'walk_fwd_right.fbx',
  'pistol walk backward arc.fbx': 'walk_bwd_left.fbx',
  'pistol walk backward arc (2).fbx': 'walk_bwd_right.fbx',
  'pistol run.fbx': 'run_fwd.fbx',
  'pistol run backward.fbx': 'run_bwd.fbx',
  'pistol run arc.fbx': 'run_fwd_left.fbx',
  'pistol run arc (2).fbx': 'run_fwd_right.fbx',
  'pistol run backward arc.fbx': 'run_bwd_left.fbx',
  'pistol run backward arc (2).fbx': 'run_bwd_right.fbx',
  'pistol strafe.fbx': 'strafe_left.fbx',
  'pistol strafe (2).fbx': 'strafe_right.fbx',
  'pistol kneeling idle.fbx': 'crouch_idle.fbx',
  'pistol stand to kneel.fbx': 'crouch_enter.fbx',
  'pistol kneel to stand.fbx': 'crouch_exit.fbx',
  'pistol jump.fbx': 'jump.fbx',
  'pistol jump (2).fbx': 'jump_alt.fbx',
  // Reload — drop a Mixamo pistol reload FBX under any of these names.
  'reload.fbx': 'reload.fbx',
  'reloading.fbx': 'reload.fbx',
  'pistol reload.fbx': 'reload.fbx',
};

async function importPack(srcName, destName, map) {
  const srcDir = path.join(PACKS, srcName);
  const destDir = path.join(PACKS, destName);
  await mkdir(destDir, { recursive: true });

  const present = new Set((await readdir(srcDir)).filter((f) => f.toLowerCase().endsWith('.fbx')));
  let copied = 0;
  const missing = [];
  for (const [srcFile, destFile] of Object.entries(map)) {
    if (!present.has(srcFile)) {
      missing.push(srcFile);
      continue;
    }
    await copyFile(path.join(srcDir, srcFile), path.join(destDir, destFile));
    present.delete(srcFile);
    copied += 1;
  }

  console.log(`\n[${destName}] copied ${copied}/${Object.keys(map).length}`);
  if (missing.length) console.warn(`  missing sources (skipped): ${missing.join(', ')}`);
  const unmapped = [...present].filter((f) => !/death/i.test(f));
  if (unmapped.length) console.warn(`  unmapped sources (ignored): ${unmapped.join(', ')}`);
  return copied;
}

await importPack('Rifle 8-Way Locomotion Pack', 'weapon-rifle-8way', buildRifleMap());
await importPack('Pistol_Handgun Locomotion Pack (2)', 'weapon-pistol', PISTOL_MAP);
console.log('\nimport-locomotion-packs: done');
