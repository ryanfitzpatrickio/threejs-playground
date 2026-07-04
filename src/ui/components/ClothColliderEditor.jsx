import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';

export function ClothColliderEditor(props) {
  const runtime = () => props.runtime?.();
  const [editor, setEditor] = createSignal(null);
  const selected = createMemo(() => {
    const state = editor();
    return state?.colliders?.find((collider) => collider.id === state.selectedId) ?? null;
  });

  onMount(() => {
    const open = () => {
      const state = runtime()?.setClothColliderEditorEnabled(true);
      if (state) setEditor(state);
      return Boolean(state);
    };
    if (open()) return;
    const timer = setInterval(() => {
      if (open()) clearInterval(timer);
    }, 100);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => runtime()?.setClothColliderEditorEnabled(false));

  const update = (patch) => {
    const collider = selected();
    if (collider) setEditor(runtime()?.updateClothCollider(collider.id, patch) ?? editor());
  };

  const updateOffset = (axis, value) => {
    const collider = selected();
    if (!collider) return;
    const offset = [...collider.offset];
    offset[axis] = Number(value);
    update({ offset });
  };

  const updateJacketAxis = (field, axis, value) => {
    const transform = editor()?.jacketTransform;
    if (!transform) return;
    const vector = [...transform[field]];
    vector[axis] = Number(value);
    setEditor(runtime()?.updateJacketSocketTransform({ [field]: vector }) ?? editor());
  };

  const resetJacketTransform = () => {
    setEditor(runtime()?.updateJacketSocketTransform({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    }) ?? editor());
  };

  const add = () => {
    const state = editor();
    const bone = selected()?.bone ?? state?.bones?.find((entry) => /spine2/i.test(entry.name))?.name ?? state?.bones?.[0]?.name;
    setEditor(runtime()?.addClothCollider({ bone, radius: 0.2, offset: [0, 0, 0] }) ?? editor());
  };

  const exportProfile = () => {
    const profile = runtime()?.exportClothColliderProfile();
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${profile.modelId}-cloth-colliders.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importProfile = async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      setEditor(runtime()?.importClothColliderProfile(JSON.parse(await file.text())) ?? editor());
    } catch (error) {
      console.warn('[cloth-editor] Could not import collider profile.', error);
    } finally {
      event.currentTarget.value = '';
    }
  };

  return (
    <aside
      class="cloth-editor"
      aria-label="Cloth collider editor"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <header class="cloth-editor__header">
        <div>
          <strong>Cloth Colliders</strong>
          <span>{editor()?.modelId ?? 'Loading player'}</span>
        </div>
        <button onClick={props.onClose} aria-label="Close cloth editor">×</button>
      </header>

      <Show when={editor()} fallback={<p>Waiting for jacket cloth…</p>}>
        <Show when={editor().jacketTransform}>
          <section class="cloth-editor__section">
            <div class="cloth-editor__section-title">
              <strong>Jacket socket</strong>
              <button onClick={resetJacketTransform}>Reset</button>
            </div>
            <div class="cloth-editor__axis-grid">
              <NumberControl label="Position X" value={editor().jacketTransform.position[0]} min={-5} max={5} step={0.01} onInput={(value) => updateJacketAxis('position', 0, value)} />
              <NumberControl label="Position Y" value={editor().jacketTransform.position[1]} min={-5} max={5} step={0.01} onInput={(value) => updateJacketAxis('position', 1, value)} />
              <NumberControl label="Position Z" value={editor().jacketTransform.position[2]} min={-5} max={5} step={0.01} onInput={(value) => updateJacketAxis('position', 2, value)} />
            </div>
            <div class="cloth-editor__axis-grid">
              <NumberControl label="Rotation X" value={editor().jacketTransform.rotation[0]} min={-180} max={180} step={1} onInput={(value) => updateJacketAxis('rotation', 0, value)} />
              <NumberControl label="Rotation Y" value={editor().jacketTransform.rotation[1]} min={-180} max={180} step={1} onInput={(value) => updateJacketAxis('rotation', 1, value)} />
              <NumberControl label="Rotation Z" value={editor().jacketTransform.rotation[2]} min={-180} max={180} step={1} onInput={(value) => updateJacketAxis('rotation', 2, value)} />
            </div>
            <div class="cloth-editor__axis-grid">
              <NumberControl label="Scale X" value={editor().jacketTransform.scale[0]} min={0.05} max={5} step={0.01} onInput={(value) => updateJacketAxis('scale', 0, value)} />
              <NumberControl label="Scale Y" value={editor().jacketTransform.scale[1]} min={0.05} max={5} step={0.01} onInput={(value) => updateJacketAxis('scale', 1, value)} />
              <NumberControl label="Scale Z" value={editor().jacketTransform.scale[2]} min={0.05} max={5} step={0.01} onInput={(value) => updateJacketAxis('scale', 2, value)} />
            </div>
          </section>
        </Show>

        <section class="cloth-editor__section">
        <div class="cloth-editor__section-title"><strong>Collider spheres</strong></div>
        <label>
          Collider
          <select
            value={editor().selectedId ?? ''}
            onChange={(event) => setEditor(runtime()?.selectClothCollider(event.currentTarget.value) ?? editor())}
          >
            {editor().colliders.map((collider) => (
              <option value={collider.id} selected={collider.id === editor().selectedId}>
                {collider.bone.replace(/^mixamorig:?/i, '')}
              </option>
            ))}
          </select>
        </label>

        <Show when={selected()}>
          <label>
            Bone
            <select value={selected().bone} onChange={(event) => update({ bone: event.currentTarget.value })}>
              {editor().bones.map((bone) => (
                <option value={bone.name} selected={bone.name === selected().bone}>{bone.label}</option>
              ))}
            </select>
          </label>

          <NumberControl label="Radius" value={selected().radius} min={0.02} max={1.5} step={0.01} onInput={(value) => update({ radius: value })} />
          <div class="cloth-editor__axis-grid">
            <NumberControl label="Offset X" value={selected().offset[0]} min={-3} max={3} step={0.01} onInput={(value) => updateOffset(0, value)} />
            <NumberControl label="Offset Y" value={selected().offset[1]} min={-3} max={3} step={0.01} onInput={(value) => updateOffset(1, value)} />
            <NumberControl label="Offset Z" value={selected().offset[2]} min={-3} max={3} step={0.01} onInput={(value) => updateOffset(2, value)} />
          </div>
        </Show>

        <div class="cloth-editor__actions">
          <button onClick={add}>Add sphere</button>
          <button disabled={!selected()} onClick={() => setEditor(runtime()?.removeClothCollider(selected()?.id) ?? editor())}>Remove</button>
          <button onClick={async () => setEditor(await runtime()?.resetJacketCloth() ?? editor())}>Reset cloth</button>
        </div>
        <div class="cloth-editor__actions">
          <button onClick={exportProfile}>Export JSON</button>
          <label class="cloth-editor__file">
            Import JSON
            <input type="file" accept="application/json,.json" onChange={importProfile} />
          </label>
        </div>
        </section>
        <Show when={editor().clothWeights}>
          <div class="cloth-editor__weights">
            <strong>Jacket cloth mask</strong>
            <span>{editor().clothWeights.simulated} simulated</span>
            <span>{editor().clothWeights.blended} blended</span>
            <span>{editor().clothWeights.pinned} pinned</span>
            <p><code>clothWeight</code>: 0 is free cloth; 1 follows transferred skin weights.</p>
            <Show when={editor().skinTransfer}>
              <span>Transfer median</span><span>{(editor().skinTransfer.medianDistance * 100).toFixed(1)} cm</span>
              <span>Transfer P95</span><span>{(editor().skinTransfer.p95Distance * 100).toFixed(1)} cm</span>
            </Show>
            <p>Mesh2Motion skin weights are transferred automatically from the player body by nearest-triangle interpolation. Blender is only needed later to bake the fitted jacket asset.</p>
          </div>
        </Show>
        <p>Profiles autosave per player model. Orange is selected; blue spheres remain live during simulation.</p>
      </Show>
    </aside>
  );
}

function NumberControl(props) {
  return (
    <label class="cloth-editor__number">
      <span>{props.label}</span>
      <input
        type="range"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
      />
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
      />
    </label>
  );
}
