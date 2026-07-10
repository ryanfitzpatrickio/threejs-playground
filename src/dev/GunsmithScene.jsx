/**
 * Gunsmith — annotation editor for fully-assembled gun GLBs.
 * Sibling of Bodyshop: part identity, anchors, materials, behavior tags, stats.
 * Dev-only via virtual:dreamfall-dev-tools.
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createGltfLoader } from '../game/utils/createGltfLoader.js';
import {
  BEHAVIOR_TAGS,
  GUN_ANCHOR_NAMES,
  PART_IDENTITIES,
  SURFACE_CLASSES,
  createDefaultAnchor,
  findAnchor,
} from '../game/weapons/gunAnchors.js';
import {
  GUN_CATALOG,
  createCatalogStubProfile,
  normalizeProfile,
} from '../game/weapons/gunProfile.js';
import { GUN_KIND_DEFAULTS, resolveGunStats } from '../game/weapons/gunConfig.js';
import {
  GUN_SOUND_CATEGORIES,
  GUN_SOUND_INTERACTIONS,
  GUN_SOUND_LIBRARY,
  getGunSound,
  getGunSoundsForInteraction,
} from '../game/weapons/gunSoundLibrary.js';
import {
  getGunsmithProfile,
  saveGunsmithProfile,
  flushGunsmithStore,
} from '../game/weapons/gunsmithStore.js';
import {
  applyGunProfileMaterials,
  createDefaultGunAppearance,
  GUN_MATERIAL_MODES,
  GUN_PBR_TEXTURE_SETS,
  gunMaterialModeUsesTextureSet,
  normalizeGunAppearance,
} from '../game/weapons/gunMaterials.js';
import {
  configureBodyshopRenderer,
  installBodyshopEnvironment,
  prepareBodyshopGltfMaterials,
} from './bodyshopViewport.js';

export function GunsmithScene(props) {
  let canvasRef;
  let renderer;
  let scene;
  let camera;
  let controls;
  let transformControls;
  let gunRoot = null;
  let anchorHelpers = new THREE.Group();
  let selectedMesh = null;
  let selectedAnchorName = null;
  let frameId = 0;
  let disposed = false;
  let previewAudio = null;

  const [gunId, setGunId] = createSignal(GUN_CATALOG[0]?.id ?? '');
  const [profile, setProfile] = createSignal(null);
  const [meshNames, setMeshNames] = createSignal([]);
  const [selectedPart, setSelectedPart] = createSignal(null);
  const [selectedAnchor, setSelectedAnchor] = createSignal(null);
  const [status, setStatus] = createSignal('Ready');
  const [busy, setBusy] = createSignal(false);
  const [tab, setTab] = createSignal('parts'); // parts | anchors | stats | sounds

  const statsPreview = () => {
    const p = profile();
    if (!p) return null;
    return resolveGunStats(p);
  };

  onMount(async () => {
    const viewport = canvasRef;
    if (!viewport) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14161a);

    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
    camera.position.set(0.6, 0.45, 0.9);

    renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(viewport.clientWidth || 640, viewport.clientHeight || 420);
    configureBodyshopRenderer(renderer, { exposure: 1.1 });
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    viewport.append(renderer.domElement);
    await renderer.init();
    await installBodyshopEnvironment(renderer, scene, { intensity: 0.85 });

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(2, 4, 3);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    scene.add(new THREE.GridHelper(2, 20, 0x333843, 0x22262e));
    scene.add(anchorHelpers);

    const dom = renderer.domElement;
    controls = new OrbitControls(camera, dom);
    controls.enableDamping = true;
    controls.target.set(0, 0.08, 0);

    transformControls = new TransformControls(camera, dom);
    transformControls.setSize(0.7);
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
    });
    transformControls.addEventListener('objectChange', () => {
      if (!selectedAnchorName || !transformControls.object) return;
      syncAnchorFromHelper(selectedAnchorName, transformControls.object);
    });
    scene.add(typeof transformControls.getHelper === 'function'
      ? transformControls.getHelper()
      : transformControls);

    const onResize = () => {
      if (!viewport || !renderer || !camera) return;
      const w = viewport.clientWidth || 1;
      const h = viewport.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    window.addEventListener('resize', onResize);
    onResize();

    const onClick = (event) => {
      if (tab() !== 'parts' || !gunRoot || busy()) return;
      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(gunRoot, true);
      const hit = hits.find((h) => h.object?.isMesh && !h.object.userData?._anchorHelper);
      if (hit) {
        selectMesh(hit.object);
      }
    };
    dom.addEventListener('pointerdown', onClick);

    const loop = () => {
      if (disposed) return;
      frameId = requestAnimationFrame(loop);
      controls?.update();
      renderer?.render(scene, camera);
    };
    loop();

    props.onReady?.({
      flushAutosave: async () => {
        saveCurrent({ debounce: false });
        await flushGunsmithStore();
      },
    });

    await loadGun(gunId());

    onCleanup(() => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
      dom.removeEventListener('pointerdown', onClick);
      transformControls?.dispose();
      controls?.dispose();
      previewAudio?.pause?.();
      previewAudio = null;
      renderer?.dispose();
      renderer?.domElement?.remove?.();
    });
  });

  async function loadGun(id) {
    if (!id || !scene) return;
    setBusy(true);
    setStatus(`Loading ${id}…`);
    try {
      clearGun();
      const entry = GUN_CATALOG.find((g) => g.id === id) || { id, glbUrl: `/assets/guns/${id}.glb`, label: id, weaponKind: 'rifle' };
      const loader = createGltfLoader();
      const gltf = await loader.loadAsync(entry.glbUrl);
      gunRoot = gltf.scene;
      prepareBodyshopGltfMaterials(gunRoot);
      scene.add(gunRoot);

      const names = [];
      gunRoot.traverse((child) => {
        if (child.isMesh) {
          if (!child.name) child.name = `part_${names.length}`;
          names.push(child.name);
          child.userData._gunsmithMesh = true;
        }
      });
      setMeshNames(names);

      let next = getGunsmithProfile(id);
      if (!next) {
        next = createCatalogStubProfile(entry, names);
      } else {
        // Merge any new meshes into parts list.
        const have = new Set(next.parts.map((p) => p.meshName));
        for (const meshName of names) {
          if (!have.has(meshName)) {
            next.parts.push({
              meshName,
              identity: 'misc',
              surfaceClass: 'metal',
              appearance: createDefaultGunAppearance('metal'),
              skin: null,
              behaviors: [],
              behaviorParams: null,
            });
          }
        }
        next = normalizeProfile(next);
      }
      setProfile(next);
      await applyMaterialsFromProfile(next);
      rebuildAnchorHelpers(next);
      setStatus(`Loaded ${next.label} (${names.length} parts)`);
      setSelectedPart(null);
      setSelectedAnchor(null);
      transformControls?.detach();
    } catch (err) {
      console.error(err);
      setStatus(`Load failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function clearGun() {
    if (gunRoot) {
      scene.remove(gunRoot);
      gunRoot.traverse((c) => {
        if (c.geometry) c.geometry.dispose?.();
        const materials = Array.isArray(c.material) ? c.material : [c.material];
        materials.forEach((material) => material?.dispose?.());
        c.userData?._gunsmithBakedMaterials?.forEach((material) => material?.dispose?.());
      });
      gunRoot = null;
    }
    while (anchorHelpers.children.length) {
      const c = anchorHelpers.children[0];
      anchorHelpers.remove(c);
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    selectedMesh = null;
  }

  async function applyMaterialsFromProfile(p) {
    if (!gunRoot || !p) return;
    try {
      await applyGunProfileMaterials(gunRoot, p);
    } catch (error) {
      console.error('[Gunsmith] material preview failed', error);
      setStatus(`Material preview failed: ${error?.message || 'unknown error'}`);
    }
  }

  function rebuildAnchorHelpers(p) {
    while (anchorHelpers.children.length) {
      const c = anchorHelpers.children[0];
      anchorHelpers.remove(c);
    }
    for (const name of GUN_ANCHOR_NAMES) {
      const anchor = findAnchor(p.anchors, name) || createDefaultAnchor(name);
      const helper = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 12),
        new THREE.MeshBasicMaterial({ color: name === 'muzzle' ? 0xff5533 : name === 'grip_mount' ? 0x55ff88 : 0x66aaff }),
      );
      helper.name = `anchor:${name}`;
      helper.userData._anchorHelper = true;
      helper.userData.anchorName = name;
      helper.position.fromArray(anchor.position || [0, 0, 0]);
      helper.quaternion.fromArray(anchor.quaternion || [0, 0, 0, 1]);
      anchorHelpers.add(helper);
    }
  }

  function selectMesh(mesh) {
    selectedMesh = mesh;
    setSelectedPart(mesh.name);
    setSelectedAnchor(null);
    transformControls?.detach();
    highlightSelection(mesh.name);
  }

  function highlightSelection(meshName) {
    if (!gunRoot) return;
    gunRoot.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const on = child.name === meshName;
      if (child.material.emissive?.setHex) {
        child.material.emissive.setHex(on ? 0x334422 : 0x000000);
        child.material.emissiveIntensity = on ? 0.35 : 0;
      }
    });
  }

  function updatePartField(meshName, patch) {
    const p = profile();
    if (!p) return;
    const parts = p.parts.map((part) => (
      part.meshName === meshName ? { ...part, ...patch } : part
    ));
    // Ensure entry exists.
    if (!parts.some((part) => part.meshName === meshName)) {
      parts.push({
        meshName,
        identity: 'misc',
        surfaceClass: 'metal',
        appearance: createDefaultGunAppearance('metal'),
        skin: null,
        behaviors: [],
        behaviorParams: null,
        ...patch,
      });
    }
    const next = normalizeProfile({ ...p, parts });
    setProfile(next);
    void applyMaterialsFromProfile(next).then(() => highlightSelection(meshName));
  }

  function updatePartAppearance(meshName, patch) {
    const p = profile();
    const current = p?.parts?.find((part) => part.meshName === meshName);
    const surfaceClass = current?.surfaceClass ?? 'metal';
    const appearance = normalizeGunAppearance({
      ...(current?.appearance ?? createDefaultGunAppearance(surfaceClass)),
      ...patch,
    }, surfaceClass);
    updatePartField(meshName, { appearance });
  }

  function selectAnchor(name) {
    setSelectedAnchor(name);
    selectedAnchorName = name;
    setSelectedPart(null);
    const helper = anchorHelpers.children.find((c) => c.userData.anchorName === name);
    if (helper && transformControls) {
      transformControls.attach(helper);
      transformControls.setMode('translate');
    }
  }

  function syncAnchorFromHelper(name, object) {
    const p = profile();
    if (!p) return;
    const anchors = [...(p.anchors || [])];
    const idx = anchors.findIndex((a) => a.name === name);
    const nextAnchor = {
      name,
      position: object.position.toArray(),
      quaternion: object.quaternion.toArray(),
      scale: [1, 1, 1],
    };
    if (idx >= 0) anchors[idx] = nextAnchor;
    else anchors.push(nextAnchor);
    setProfile(normalizeProfile({ ...p, anchors }));
  }

  function updateStatsField(key, value) {
    const p = profile();
    if (!p) return;
    const statOverrides = { ...(p.statOverrides || {}), [key]: value };
    setProfile(normalizeProfile({ ...p, statOverrides }));
  }

  function setWeaponKind(kind) {
    const p = profile();
    if (!p) return;
    setProfile(normalizeProfile({ ...p, weaponKind: kind, statsId: kind }));
  }

  function updateSoundAssignment(interactionId, soundId) {
    const p = profile();
    if (!p) return;
    const sounds = { ...(p.sounds || {}), [interactionId]: soundId };
    setProfile(normalizeProfile({ ...p, sounds }));
  }

  function previewSound(soundId) {
    const sound = getGunSound(soundId);
    previewAudio?.pause?.();
    previewAudio = null;
    if (!sound || typeof Audio === 'undefined') return;
    const audio = new Audio(sound.url);
    audio.volume = Math.min(1, Math.max(0, sound.volume ?? 0.7));
    previewAudio = audio;
    void audio.play().catch((error) => {
      setStatus(`Preview failed: ${error?.message || 'audio unavailable'}`);
    });
  }

  function saveCurrent({ debounce = true } = {}) {
    const p = profile();
    if (!p) return;
    const saved = saveGunsmithProfile(p, { debounce });
    setProfile(saved);
    setStatus(`Saved ${saved.id}`);
  }

  function downloadCurrentProfile() {
    const p = profile();
    if (!p || typeof document === 'undefined') return;
    const blob = new Blob([`${JSON.stringify(p, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${p.id}.gunsmith.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${p.id}.gunsmith.json`);
  }

  function selectedPartAnnotation() {
    const name = selectedPart();
    const p = profile();
    if (!name || !p) return null;
    return p.parts.find((part) => part.meshName === name) || {
      meshName: name,
      identity: 'misc',
      surfaceClass: 'metal',
      appearance: createDefaultGunAppearance('metal'),
      behaviors: [],
    };
  }

  return (
    <div class="gunsmith-shell" style="display:flex; width:100%; height:100%; background:#0e1014; color:#e8eaed; font:12px/1.4 system-ui,sans-serif;">
      <aside style="width:280px; flex-shrink:0; border-right:1px solid #2a2f38; padding:12px; overflow:auto; display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="button" class="ghost-button" onClick={() => props.onBack?.()}>← Back</button>
          <strong style="font-size:13px;">Gunsmith</strong>
        </div>

        <label style="display:flex; flex-direction:column; gap:4px;">
          <span style="opacity:0.7;">Gun</span>
          <select
            value={gunId()}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setGunId(id);
              void loadGun(id);
            }}
            disabled={busy()}
            style="background:#1a1e26; color:inherit; border:1px solid #333; padding:6px;"
          >
            <For each={GUN_CATALOG}>
              {(g) => <option value={g.id}>{g.label}</option>}
            </For>
          </select>
        </label>

        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          <button type="button" class={tab() === 'parts' ? 'solid-button' : 'ghost-button'} onClick={() => setTab('parts')}>Parts</button>
          <button type="button" class={tab() === 'anchors' ? 'solid-button' : 'ghost-button'} onClick={() => setTab('anchors')}>Anchors</button>
          <button type="button" class={tab() === 'stats' ? 'solid-button' : 'ghost-button'} onClick={() => setTab('stats')}>Stats</button>
          <button type="button" class={tab() === 'sounds' ? 'solid-button' : 'ghost-button'} onClick={() => setTab('sounds')}>Sounds</button>
        </div>

        <Show when={tab() === 'parts'}>
          <div style="display:flex; flex-direction:column; gap:4px; max-height:40vh; overflow:auto;">
            <For each={meshNames()}>
              {(name) => (
                <button
                  type="button"
                  class="ghost-button"
                  style={`text-align:left; ${selectedPart() === name ? 'outline:1px solid #8cf;' : ''}`}
                  onClick={() => {
                    const mesh = gunRoot?.getObjectByName(name);
                    if (mesh) selectMesh(mesh);
                    else setSelectedPart(name);
                  }}
                >
                  {name}
                </button>
              )}
            </For>
          </div>
          <Show when={selectedPartAnnotation()}>
            {(ann) => (
              <div style="display:flex; flex-direction:column; gap:8px; border-top:1px solid #2a2f38; padding-top:8px;">
                <div style="opacity:0.7;">{ann().meshName}</div>
                <label>
                  Identity
                  <select
                    value={ann().identity || 'misc'}
                    onChange={(e) => updatePartField(ann().meshName, { identity: e.currentTarget.value })}
                    style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
                  >
                    <For each={[...PART_IDENTITIES]}>{(id) => <option value={id}>{id}</option>}</For>
                  </select>
                </label>
                <label>
                  Surface
                  <select
                    value={ann().surfaceClass || 'metal'}
                    onChange={(e) => updatePartField(ann().meshName, { surfaceClass: e.currentTarget.value })}
                    style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
                  >
                    <For each={[...SURFACE_CLASSES]}>{(s) => <option value={s}>{s}</option>}</For>
                  </select>
                </label>
                <label>
                  Appearance
                  <select
                    value={ann().appearance?.mode || 'pbr'}
                    onChange={(e) => updatePartAppearance(ann().meshName, { mode: e.currentTarget.value })}
                    style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
                  >
                    <For each={GUN_MATERIAL_MODES}>{(mode) => <option value={mode.id}>{mode.label}</option>}</For>
                  </select>
                </label>
                <Show when={gunMaterialModeUsesTextureSet(ann().appearance?.mode || 'pbr')}>
                  <label>
                    PBR texture set
                    <select
                      value={ann().appearance?.textureSet || 'field-panel'}
                      onChange={(e) => updatePartAppearance(ann().meshName, { textureSet: e.currentTarget.value })}
                      style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
                    >
                      <For each={GUN_PBR_TEXTURE_SETS}>{(set) => <option value={set.id}>{set.label}</option>}</For>
                    </select>
                  </label>
                  <RangeField
                    label="UV scale"
                    value={ann().appearance?.uvScale ?? 1}
                    min={0.1}
                    max={8}
                    step={0.1}
                    onChange={(value) => updatePartAppearance(ann().meshName, { uvScale: value })}
                  />
                </Show>
                <Show when={!['flat', 'baked', 'baked_flat'].includes(ann().appearance?.mode || 'pbr')}>
                  <RangeField
                    label="Roughness"
                    value={ann().appearance?.roughness ?? 0.4}
                    min={0.02}
                    max={1}
                    step={0.01}
                    onChange={(value) => updatePartAppearance(ann().meshName, { roughness: value })}
                  />
                  <RangeField
                    label="Metalness"
                    value={ann().appearance?.metalness ?? 0.75}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(value) => updatePartAppearance(ann().meshName, { metalness: value })}
                  />
                </Show>
                <p style="margin:0; color:#8ea0b4; font-size:10px;">
                  {GUN_MATERIAL_MODES.find((mode) => mode.id === (ann().appearance?.mode || 'pbr'))?.description}
                </p>
                <div>
                  <div style="opacity:0.7; margin-bottom:4px;">Behaviors</div>
                  <For each={[...BEHAVIOR_TAGS]}>
                    {(tag) => (
                      <label style="display:flex; gap:6px; align-items:center; margin-bottom:2px;">
                        <input
                          type="checkbox"
                          checked={(ann().behaviors || []).includes(tag)}
                          onChange={(e) => {
                            const set = new Set(ann().behaviors || []);
                            if (e.currentTarget.checked) set.add(tag);
                            else set.delete(tag);
                            updatePartField(ann().meshName, { behaviors: [...set] });
                          }}
                        />
                        {tag}
                      </label>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Show>

        <Show when={tab() === 'anchors'}>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <For each={[...GUN_ANCHOR_NAMES]}>
              {(name) => (
                <button
                  type="button"
                  class="ghost-button"
                  style={`text-align:left; ${selectedAnchor() === name ? 'outline:1px solid #8cf;' : ''}`}
                  onClick={() => selectAnchor(name)}
                >
                  {name}
                </button>
              )}
            </For>
            <p style="opacity:0.65; margin:8px 0 0;">Select an anchor, then drag the gizmo on the gun.</p>
          </div>
        </Show>

        <Show when={tab() === 'stats'}>
          <label>
            Kind
            <select
              value={profile()?.weaponKind || 'rifle'}
              onChange={(e) => setWeaponKind(e.currentTarget.value)}
              style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
            >
              <For each={Object.keys(GUN_KIND_DEFAULTS)}>{(k) => <option value={k}>{k}</option>}</For>
            </select>
          </label>
          <Show when={statsPreview()}>
            {(s) => (
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                <StatField label="damage" value={s().damage} onChange={(v) => updateStatsField('damage', v)} />
                <StatField label="fireRate" value={s().fireRate} onChange={(v) => updateStatsField('fireRate', v)} step={0.1} />
                <StatField label="spread" value={s().spread} onChange={(v) => updateStatsField('spread', v)} step={0.001} />
                <StatField label="magazine" value={s().magazineSize} onChange={(v) => updateStatsField('magazineSize', v)} step={1} />
                <StatField label="reload" value={s().reloadTime} onChange={(v) => updateStatsField('reloadTime', v)} step={0.05} />
                <StatField label="pellets" value={s().pellets} onChange={(v) => updateStatsField('pellets', v)} step={1} />
              </div>
            )}
          </Show>
        </Show>

        <Show when={tab() === 'sounds'}>
          <div style="display:flex; flex-direction:column; gap:10px;">
            <p style="opacity:0.65; margin:0;">
              Assign a library sound to each weapon interaction. Preview does not save until the profile is saved.
            </p>
            <For each={[...new Set(GUN_SOUND_INTERACTIONS.map((entry) => entry.group))]}>
              {(group) => (
                <section style="display:flex; flex-direction:column; gap:7px; border-top:1px solid #2a2f38; padding-top:8px;">
                  <strong style="font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:#9fb8d4;">
                    {group}
                  </strong>
                  <For each={GUN_SOUND_INTERACTIONS.filter((entry) => entry.group === group)}>
                    {(interaction) => {
                      const selectedSoundId = () => profile()?.sounds?.[interaction.id] || '';
                      return (
                        <div style="display:grid; grid-template-columns:1fr auto; gap:5px; align-items:end;">
                          <label style="display:flex; flex-direction:column; gap:3px; min-width:0;">
                            <span style="opacity:0.72;">{interaction.label}</span>
                            <select
                              value={selectedSoundId()}
                              onChange={(event) => updateSoundAssignment(interaction.id, event.currentTarget.value)}
                              style="width:100%; min-width:0; background:#1a1e26; color:inherit; border:1px solid #333; padding:5px;"
                            >
                              <option value="">Default / none</option>
                              <For each={GUN_SOUND_CATEGORIES.filter((category) => interaction.categories.includes(category.id))}>
                                {(category) => (
                                  <optgroup label={category.label}>
                                    <For each={getGunSoundsForInteraction(interaction.id).filter((entry) => entry.category === category.id)}>
                                      {(sound) => <option value={sound.id}>{sound.label}</option>}
                                    </For>
                                  </optgroup>
                                )}
                              </For>
                            </select>
                          </label>
                          <button
                            type="button"
                            class="ghost-button"
                            disabled={!selectedSoundId()}
                            onClick={() => previewSound(selectedSoundId())}
                            title="Preview selected sound"
                            style="height:29px; min-width:34px;"
                          >
                            ▶
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </section>
              )}
            </For>
            <div style="opacity:0.55; font-size:10px;">
              {GUN_SOUND_CATEGORIES.map((category) => (
                `${category.label}: ${GUN_SOUND_LIBRARY.filter((entry) => entry.category === category.id).length}`
              )).join(' · ')}
            </div>
          </div>
        </Show>

        <div style="margin-top:auto; display:flex; flex-direction:column; gap:8px;">
          <button type="button" class="solid-button" disabled={busy() || !profile()} onClick={() => saveCurrent({ debounce: false })}>
            Save profile
          </button>
          <button type="button" class="ghost-button" disabled={!profile()} onClick={downloadCurrentProfile}>
            Download JSON
          </button>
          <div style="opacity:0.7; font-size:11px;">{status()}</div>
        </div>
      </aside>

      <div ref={canvasRef} style="flex:1; position:relative; min-width:0; height:100%;" />
    </div>
  );
}

function StatField(props) {
  return (
    <label style="display:flex; flex-direction:column; gap:2px; font-size:11px;">
      <span style="opacity:0.65;">{props.label}</span>
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
        style="background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
      />
    </label>
  );
}

function RangeField(props) {
  return (
    <label style="display:grid; grid-template-columns:1fr 52px; gap:6px; align-items:center; font-size:11px;">
      <span style="opacity:0.72;">{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        style="width:100%; background:#1a1e26; color:inherit; border:1px solid #333; padding:4px;"
      />
    </label>
  );
}
