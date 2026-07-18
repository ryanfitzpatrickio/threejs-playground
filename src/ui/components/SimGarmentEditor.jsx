import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { GarmentEditorStore } from '../../game/characters/simhuman/garmentEditorStore.js';
import { SimPatternCanvas } from './SimPatternCanvas.jsx';
import { SimOutfitBrowser } from './SimOutfitBrowser.jsx';
import { SimOutfitImport } from './SimOutfitImport.jsx';

const TOOLS = [
  ['select', 'Select'],
  ['edit-points', 'Points'],
  ['rect', 'Rectangle'],
  ['ellipse', 'Ellipse'],
  ['circle', 'Circle'],
  ['polygon', 'Polygon'],
  ['pen', 'Pen'],
  ['seam', 'Seam'],
  ['tack', 'Tack'],
  ['pan', 'Pan'],
];

export function SimGarmentEditor(props) {
  const editor = new GarmentEditorStore();
  const [revision, setRevision] = createSignal(0);
  const [quality, setQuality] = createSignal('low');
  const [status, setStatus] = createSignal('Demo T-shirt loaded. Compile to preview it in 3D.');
  const [saved, setSaved] = createSignal(editor.savedGarments());
  const [pixiReady, setPixiReady] = createSignal(false);
  const [editorTab, setEditorTab] = createSignal('outfits'); // outfits | import | dynamic

  const state = () => {
    revision();
    return editor.state;
  };
  const selectedPanel = createMemo(() => {
    revision();
    return editor.selectedPanel;
  });

  onMount(() => {
    const unsubscribe = editor.subscribe(() => setRevision((value) => value + 1));
    onCleanup(unsubscribe);
  });
  onCleanup(() => editor.dispose());

  const compile = () => {
    try {
      const result = editor.compile(quality());
      const errors = result.issues.filter((issue) => issue.severity === 'error');
      if (errors.length) throw new Error(errors.map((issue) => issue.message).join('; '));
      props.onCompile?.(result.garment);
      setStatus(
        `Compiled ${result.value.simMesh.particleCount} particles · `
        + `${result.value.simMesh.triangles.length / 3} triangles · ${result.issues.length} notices.`,
      );
      return result;
    } catch (error) {
      setStatus(`Compile failed: ${error?.message ?? error}`);
      return null;
    }
  };

  const save = () => {
    if (!compile()) return;
    const garment = editor.save();
    setSaved(editor.savedGarments());
    props.onSave?.(garment);
    setStatus(`${garment.name} saved and assigned to this Sim.`);
  };

  const newDemo = () => {
    editor.newDemo();
    setStatus('Fresh demo T-shirt loaded.');
    queueMicrotask(compile);
  };

  const load = (id) => {
    const garment = editor.load(id);
    if (!garment) return;
    setStatus(`${garment.name} loaded.`);
    queueMicrotask(compile);
  };

  const updatePanel = (key, value) => {
    editor.updateSelectedPanel({ [key]: value });
  };

  return (
    <section class="sim-garment-editor" aria-label="Garment editor">
      <div class="garage-type-tabs sim-garment-kind-tabs" role="tablist" aria-label="Garment type">
        <button
          type="button"
          role="tab"
          class={editorTab() === 'outfits' ? 'active' : ''}
          aria-selected={editorTab() === 'outfits'}
          onClick={() => setEditorTab('outfits')}
        >
          Outfits
        </button>
        <button
          type="button"
          role="tab"
          class={editorTab() === 'import' ? 'active' : ''}
          aria-selected={editorTab() === 'import'}
          onClick={() => setEditorTab('import')}
        >
          Import
        </button>
        <button
          type="button"
          role="tab"
          class={editorTab() === 'dynamic' ? 'active' : ''}
          aria-selected={editorTab() === 'dynamic'}
          onClick={() => setEditorTab('dynamic')}
        >
          Dynamic Cloth
        </button>
      </div>

      <Show when={editorTab() === 'dynamic'}>
      <>
      <div class="sim-pattern-workspace">
        <div class="sim-garment-toolbar" role="toolbar" aria-label="Pattern tools">
          <For each={TOOLS}>
            {([id, label]) => (
              <button
                type="button"
                class={state().activeClothingTool === id ? 'active' : ''}
                aria-pressed={state().activeClothingTool === id}
                onClick={() => editor.setTool(id)}
              >
                {label}
              </button>
            )}
          </For>
          <span class="sim-toolbar-spacer" />
          <button type="button" onClick={() => editor.undo()}>Undo</button>
          <button type="button" onClick={() => editor.redo()}>Redo</button>
        </div>
        <SimPatternCanvas
          onReady={() => {
            setPixiReady(true);
            queueMicrotask(compile);
          }}
          onError={(error) => setStatus(`Pixi failed: ${error?.message ?? error}`)}
        />
      </div>

      <aside class="sim-garment-inspector">
        <div class="garage-section-title"><span>04</span> Garment authoring</div>
        <label class="garage-name-field">
          <span>Garment name</span>
          <input
            aria-label="Garment name"
            value={state().garment.name}
            onInput={(event) => editor.renameGarment(event.currentTarget.value)}
          />
        </label>

        <div class="sim-garment-actions">
          <button class="garage-button ghost" type="button" onClick={newDemo}>New demo</button>
          <button class="garage-button ghost" type="button" disabled={!pixiReady()} onClick={compile}>Compile 3D</button>
          <button class="garage-button primary" type="button" disabled={!pixiReady()} onClick={save}>Save garment</button>
        </div>

        <label class="garage-name-field">
          <span>Compile quality</span>
          <select aria-label="Garment compile quality" value={quality()} onChange={(event) => setQuality(event.currentTarget.value)}>
            <option value="low">Low · runtime</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>

        <Show when={saved().length > 0}>
          <label class="garage-name-field">
            <span>Saved garments</span>
            <select aria-label="Saved garments" onChange={(event) => event.currentTarget.value && load(event.currentTarget.value)}>
              <option value="">Choose saved garment…</option>
              <For each={saved()}>{(garment) => <option value={garment.id}>{garment.name}</option>}</For>
            </select>
          </label>
        </Show>

        <Show when={selectedPanel()} fallback={<p class="garage-empty">Select a pattern panel to inspect it.</p>}>
          {(panel) => (
            <div class="garage-control-group sim-panel-inspector">
              <h2>Selected panel</h2>
              <label class="garage-name-field">
                <span>Name</span>
                <input value={panel().name} onInput={(event) => updatePanel('name', event.currentTarget.value)} />
              </label>
              <label class="garage-name-field">
                <span>Fabric color</span>
                <input type="color" value={panel().color ?? '#6f91d8'} onInput={(event) => updatePanel('color', event.currentTarget.value)} />
              </label>
              <InspectorRange label="Particle distance" min="8" max="32" step="1" value={panel().particleDistance} onInput={(value) => updatePanel('particleDistance', value)} />
              <InspectorRange label="Stretch compliance" min="0.00002" max="0.001" step="0.00002" value={panel().stretchCompliance ?? 0.0002} onInput={(value) => updatePanel('stretchCompliance', value)} />
              <InspectorRange label="Bend compliance" min="0.02" max="0.8" step="0.02" value={panel().bendCompliance ?? 0.4} onInput={(value) => updatePanel('bendCompliance', value)} />
              <InspectorRange label="Damping" min="0" max="0.2" step="0.005" value={panel().damping ?? 0.08} onInput={(value) => updatePanel('damping', value)} />
            </div>
          )}
        </Show>

        <p class="sim-garment-status" data-testid="garment-status">{status()}</p>
        <small class="garage-empty">V/P/R/C/O draw · M seam · T tack · wheel zoom · middle drag pan</small>
      </aside>
      </>
      </Show>

      <Show when={editorTab() === 'outfits'}>
        <SimOutfitBrowser
          body={props.body}
          selectedOutfitId={props.selectedOutfitId}
          outfitScale={props.outfitScale}
          outfitPosition={props.outfitPosition}
          outfitSkinTuck={props.outfitSkinTuck}
          outfitLimbReveal={props.outfitLimbReveal}
          outfitLoopCuts={props.outfitLoopCuts}
          outfitLoopEditor={props.outfitLoopEditor}
          outfitVariant={props.outfitVariant}
          viewerApi={props.viewerApi}
          onSelect={props.onOutfitSelect}
          onOutfitScaleChange={props.onOutfitScaleChange}
          onOutfitPositionChange={props.onOutfitPositionChange}
          onOutfitSkinTuckChange={props.onOutfitSkinTuckChange}
          onOutfitLimbRevealChange={props.onOutfitLimbRevealChange}
          onOutfitLoopCutsChange={props.onOutfitLoopCutsChange}
          onOutfitVariantChange={props.onOutfitVariantChange}
        />
      </Show>

      <Show when={editorTab() === 'import'}>
        <SimOutfitImport
          body={props.body}
          viewerApi={props.viewerApi}
          onClearOutfit={props.onClearOutfit}
          onBaked={props.onOutfitBaked}
        />
      </Show>
    </section>
  );
}

function InspectorRange(props) {
  return (
    <label class="garage-slider">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
      />
      <output>{Number(props.value).toPrecision(3)}</output>
    </label>
  );
}
