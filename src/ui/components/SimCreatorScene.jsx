import { For, Show, Suspense, createMemo, createSignal, lazy, onCleanup, onMount } from 'solid-js';
import { SimHumanViewerScene } from '../../game/test/SimHumanViewerScene.js';
import {
  createSimPreset,
  deleteSimPreset,
  loadSimPresets,
  saveSimPreset,
} from '../../game/characters/simhuman/simPresetStore.js';
import { MODELING_CONTROLS } from '../../vendor/vibe-human/characterModeling.ts';
import { getSimGarment } from '../../game/characters/simhuman/simGarmentStore.js';
import {
  ARM_SPACE_MAX,
  ARM_SPACE_MIN,
  DEFAULT_ARM_SPACE,
  DEFAULT_HAIR_FIT,
  DEFAULT_OUTFIT_LIMB_REVEAL,
  DEFAULT_SIM_HAIR_COLOR,
  DEFAULT_SIM_HAIR_STYLE_ID,
  HAIR_POS_MAX,
  HAIR_POS_MIN,
  HAIR_ROT_MAX,
  HAIR_ROT_MIN,
  HAIR_SCALE_MAX,
  HAIR_SCALE_MIN,
  SIM_BODY_OPTIONS,
  listSimHairOptions,
  sanitizeArmSpace,
  sanitizeHairFit,
  sanitizeOutfitPosition,
  sanitizeOutfitSkinTuck,
} from '../../game/characters/simhuman/simAppearanceSchema.js';
import {
  registerSimOutfitImport,
  resolveSimOutfitAsset,
} from '../../game/characters/simhuman/simOutfitCatalog.js';
import { clearOutfitTemplateCache } from '../../game/characters/simhuman/attachSimOutfit.js';
import { getSimOutfitAuthoredDefaults } from '../../game/characters/simhuman/simOutfitAuthoredDefaults.js';
import { sanitizeOutfitLoopCuts } from '../../game/characters/simhuman/outfitLoopCuts.js';

const SimGarmentEditor = lazy(() => import('./SimGarmentEditor.jsx').then((module) => ({
  default: module.SimGarmentEditor,
})));

const TABS = [...new Set(MODELING_CONTROLS.map((control) => control.tab))];

export function SimCreatorScene(props) {
  let canvas;
  let preview;
  /** Stable handle for garment tools (Import pose/bake). Avoids Solid function-prop quirks. */
  const viewerRef = { current: null };
  /**
   * Bumped whenever the user (or a newer async flow) changes wardrobe intent.
   * In-flight body/preset syncs check this so a late setOutfit(null) cannot
   * wipe an outfit the user just picked on the first template click.
   */
  let wardrobeEpoch = 0;
  const [draft, setDraft] = createSignal(createSimPreset());
  const [savedPresets, setSavedPresets] = createSignal(loadSimPresets());
  const [activeTab, setActiveTab] = createSignal(TABS[0]);
  const [creatorMode, setCreatorMode] = createSignal('appearance');

  /**
   * Wardrobe card select: re-apply catalog-authored loop cuts / fit so showcase
   * dresses keep neck/sleeve/leg cuts when re-selected after switching away.
   */
  const appearanceForOutfitSelect = (current, outfitId) => {
    if (!outfitId) {
      return {
        ...current,
        outfitId: null,
        outfitLimbReveal: current.outfitLimbReveal,
        outfitLoopCuts: [],
      };
    }
    const authored = getSimOutfitAuthoredDefaults(outfitId);
    return {
      ...current,
      outfitId,
      garmentIds: [],
      outfitVariant: authored?.outfitVariant ?? current.outfitVariant ?? 'morph',
      outfitScale: authored?.outfitScale ?? current.outfitScale,
      outfitPosition: authored?.outfitPosition ?? current.outfitPosition,
      outfitSkinTuck: authored?.outfitSkinTuck ?? current.outfitSkinTuck,
      outfitTuck: authored?.outfitTuck ?? current.outfitTuck,
      outfitLimbReveal: authored?.outfitLimbReveal ?? { ...DEFAULT_OUTFIT_LIMB_REVEAL },
      outfitLoopCuts: authored?.outfitLoopCuts ?? [],
    };
  };

  const applySuggestedLimbReveal = (appearance, runtime) => {
    // Never clobber catalog-authored sleeve/leg reveal on showcase outfits.
    if (getSimOutfitAuthoredDefaults(appearance?.outfitId)?.outfitLimbReveal) {
      return appearance;
    }
    const suggested = runtime?.suggestedLimbReveal;
    if (!appearance?.outfitId || !suggested) return appearance;
    return {
      ...appearance,
      outfitLimbReveal: {
        ...DEFAULT_OUTFIT_LIMB_REVEAL,
        ...suggested,
      },
    };
  };
  const [previewSnapshot, setPreviewSnapshot] = createSignal(null);
  const [status, setStatus] = createSignal('Shape a character, then save the preset.');

  const updateOutfitLoopCuts = (outfitLoopCuts) => {
    setDraft((current) => {
      const next = { ...current, outfitLoopCuts: sanitizeOutfitLoopCuts(outfitLoopCuts) };
      preview?.setAppearance(next);
      return next;
    });
  };

  const sections = createMemo(() => {
    const grouped = new Map();
    for (const control of MODELING_CONTROLS) {
      if (control.tab !== activeTab()) continue;
      if (!grouped.has(control.section)) grouped.set(control.section, []);
      grouped.get(control.section).push(control);
    }
    return [...grouped.entries()].map(([name, controls]) => ({ name, controls }));
  });

  onMount(() => {
    preview = new SimHumanViewerScene({
      canvas,
      onSnapshot: setPreviewSnapshot,
      onOutfitLoopCutsChange: updateOutfitLoopCuts,
    });
    viewerRef.current = preview;
    preview.start().then(() => syncPreviewPreset(draft())).catch((error) => {
      console.error('Sim Creator preview failed to start.', error);
      setStatus(error?.message ?? String(error));
    });
  });

  onCleanup(() => {
    viewerRef.current = null;
    preview?.dispose();
    preview = null;
  });

  const updateName = (name) => {
    setDraft((current) => ({ ...current, name }));
  };

  const updateMorph = (id, value) => {
    const number = Number(value);
    setDraft((current) => ({
      ...current,
      morphs: { ...current.morphs, [id]: number },
    }));
    preview?.setControl(id, number);
  };

  const updateArmSpace = (value) => {
    const armSpace = sanitizeArmSpace(value);
    setDraft((current) => {
      const next = { ...current, armSpace };
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateHairStyle = (hairStyleId) => {
    const nextId = hairStyleId === '' || hairStyleId === 'none' ? null : hairStyleId;
    setDraft((current) => {
      const next = {
        ...current,
        hairStyleId: nextId,
        hairColor: current.hairColor ?? DEFAULT_SIM_HAIR_COLOR,
      };
      preview?.setAppearance(next);
      return next;
    });
    setStatus(nextId
      ? `Hair: ${listSimHairOptions().find((h) => h.id === nextId)?.name ?? nextId}. Save preset to keep.`
      : 'Hair removed. Save preset to keep bald.');
  };

  const updateHairColor = (hairColor) => {
    setDraft((current) => {
      const next = { ...current, hairColor };
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateHairFit = (partial) => {
    setDraft((current) => {
      const hairFit = sanitizeHairFit({
        ...(current.hairFit ?? DEFAULT_HAIR_FIT),
        ...partial,
        position: {
          ...(current.hairFit?.position ?? DEFAULT_HAIR_FIT.position),
          ...(partial.position ?? {}),
        },
        rotation: {
          ...(current.hairFit?.rotation ?? DEFAULT_HAIR_FIT.rotation),
          ...(partial.rotation ?? {}),
        },
      });
      const next = { ...current, hairFit };
      preview?.setAppearance(next);
      return next;
    });
  };

  const resetHairFit = () => {
    setDraft((current) => {
      const next = {
        ...current,
        hairFit: sanitizeHairFit(DEFAULT_HAIR_FIT),
      };
      preview?.setAppearance(next);
      return next;
    });
  };

  const syncPreviewPreset = async (preset) => {
    if (!preview) return;
    const epoch = ++wardrobeEpoch;
    // Store the new appearance before loading so the replacement body receives
    // its morphs before garments bind to it.
    preview.setAppearance(preset);
    await preview.setBody(preset.body);
    // A newer body/preset/outfit assignment started while we were loading.
    if (epoch !== wardrobeEpoch) return;
    await syncPresetWardrobe(preset, epoch);
  };

  const updateBody = (body) => {
    if (draft().body === body) return;
    const current = draft();
    let outfitId = current.outfitId;
    // Drop outfits that have no asset for the new gender (e.g. male-only athleisure).
    if (outfitId && !resolveSimOutfitAsset(outfitId, body, {
      variant: current.outfitVariant ?? 'morph',
    })) {
      outfitId = null;
    }
    // Keep or restore authored loop cuts for the outfit when the body still supports it.
    const withOutfit = appearanceForOutfitSelect({ ...current, body }, outfitId);
    const next = {
      ...withOutfit,
      body,
      outfitId,
    };
    setDraft(next);
    const label = SIM_BODY_OPTIONS.find((option) => option.id === body)?.label ?? body;
    setStatus(`Loading ${label} body…`);
    syncPreviewPreset(next).then(() => {
      setStatus(`${label} body selected. Save the preset to keep it.`);
    }).catch((error) => {
      console.error('Sim Creator body preview failed.', error);
      setStatus(error?.message ?? String(error));
    });
  };

  const choosePreset = (preset) => {
    const next = createSimPreset(preset);
    setDraft(next);
    setStatus(`Loading ${next.name}…`);
    syncPreviewPreset(next).then(() => setStatus(`Loaded ${next.name}.`)).catch((error) => {
      console.error('Sim Creator preset preview failed.', error);
      setStatus(error?.message ?? String(error));
    });
  };

  const newPreset = () => {
    const next = createSimPreset();
    setDraft(next);
    setStatus('Loading new Sim…');
    syncPreviewPreset(next).then(() => setStatus('New unsaved Sim.')).catch((error) => {
      console.error('Sim Creator new preset preview failed.', error);
      setStatus(error?.message ?? String(error));
    });
  };

  const save = () => {
    const saved = saveSimPreset(draft());
    setDraft(saved);
    setSavedPresets(loadSimPresets());
    setStatus(`${saved.name} saved.`);
    return saved;
  };

  const remove = (id) => {
    setSavedPresets(deleteSimPreset(id));
    if (draft().id === id) newPreset();
    setStatus('Preset deleted.');
  };

  const playLot = () => {
    const saved = save();
    props.onPlayLot?.(saved);
  };

  const previewGarment = (garment) => {
    try {
      preview?.setGarment(garment);
    } catch (error) {
      console.error('Garment preview failed.', error);
      setStatus(error?.message ?? String(error));
    }
  };

  const syncPresetWardrobe = async (preset, epoch = wardrobeEpoch) => {
    // Re-check after each await so a template click mid-sync cannot be wiped by
    // a late setOutfit(null) from the older preset snapshot.
    if (epoch !== wardrobeEpoch) return;
    const garment = getSimGarment(preset.garmentIds?.[0]);
    preview?.setGarment(garment);
    if (epoch !== wardrobeEpoch) return;
    await preview?.setOutfit(preset.outfitId);
  };

  const assignGarment = (garment) => {
    // Cancel any in-flight preset wardrobe sync that would re-apply an old outfit.
    wardrobeEpoch += 1;
    setDraft((current) => ({
      ...current,
      garmentIds: [garment.id],
      outfitId: null,
      outfitLoopCuts: [],
    }));
    preview?.setOutfit(null);
    previewGarment(garment);
    setStatus(`${garment.name} assigned to ${draft().name}. Save the preset to keep the outfit.`);
  };

  const assignOutfit = async (outfitId) => {
    // Invalidate body/preset syncs that still plan to apply an older wardrobe.
    wardrobeEpoch += 1;
    const body = draft().body;
    const next = appearanceForOutfitSelect(draft(), outfitId || null);
    if (!outfitId) {
      next.garmentIds = draft().garmentIds;
    }
    setDraft(next);
    preview?.setAppearance(next);
    if (outfitId) preview?.setGarment(null);
    // Dress only after the on-screen skeleton matches the draft gender. Outfit
    // GLBs are per-body; attaching while a body switch is in flight was the
    // intermittent male/female mix-up.
    if (outfitId && body) {
      await preview?.setBody?.(body);
    }
    const runtime = await preview?.setOutfit(outfitId);
    const fitted = applySuggestedLimbReveal(next, runtime);
    if (fitted !== next) setDraft(fitted);
    // Re-apply scale/morphs/loop cuts after attach so fit + neck/sleeve cuts stick.
    preview?.setAppearance(fitted);
    const authored = outfitId ? getSimOutfitAuthoredDefaults(outfitId) : null;
    setStatus(outfitId
      ? (authored?.outfitLoopCuts?.length
        ? 'Authored outfit + neck/sleeve loop cuts applied. Save preset to keep.'
        : 'Authored outfit assigned. Tune fit scale if chest/legs clip, then save.')
      : 'Authored outfit removed.');
  };

  const updateOutfitScale = (outfitScale) => {
    setDraft((current) => {
      const next = {
        ...current,
        outfitScale: {
          x: Number(outfitScale.x),
          y: Number(outfitScale.y),
          z: Number(outfitScale.z),
        },
      };
      // setAppearance sanitizes + drives outfitRuntime.applyAppearance (shader fit scale).
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateOutfitLimbReveal = (outfitLimbReveal) => {
    setDraft((current) => {
      const next = {
        ...current,
        outfitLimbReveal: {
          arms: Number(outfitLimbReveal.arms),
          legs: Number(outfitLimbReveal.legs),
          feet: Number(outfitLimbReveal.feet),
        },
      };
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateOutfitPosition = (outfitPosition) => {
    setDraft((current) => {
      const next = {
        ...current,
        outfitPosition: sanitizeOutfitPosition(outfitPosition),
      };
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateOutfitSkinTuck = (outfitSkinTuck) => {
    setDraft((current) => {
      const next = {
        ...current,
        outfitSkinTuck: sanitizeOutfitSkinTuck(outfitSkinTuck),
      };
      preview?.setAppearance(next);
      return next;
    });
  };

  const updateOutfitVariant = async (outfitVariant) => {
    wardrobeEpoch += 1;
    const next = { ...draft(), outfitVariant };
    setDraft(next);
    preview?.setAppearance(next);
    await preview?.setOutfitVariant?.(outfitVariant);
    setStatus(
      outfitVariant === 'standard'
        ? 'Standard outfit (no morph targets, smaller). Save preset to keep.'
        : 'Morph-Enabled outfit (bulk shape keys). Save preset to keep.',
    );
  };

  return (
    <section class={`garage-shell sim-creator-shell ${creatorMode() === 'garments' ? 'garment-mode' : ''}`}>
      <canvas ref={canvas} class="garage-canvas" aria-label="Character Maker preview" />

      <header class="garage-header">
        <div>
          <span class="garage-kicker">Dreamfall Households</span>
          <h1>Character Maker</h1>
        </div>
        <div class="garage-header-actions">
          <div class="garage-type-tabs" aria-label="Creator section">
            <button type="button" class={creatorMode() === 'appearance' ? 'active' : ''} onClick={() => setCreatorMode('appearance')}>Appearance</button>
            <button type="button" class={creatorMode() === 'garments' ? 'active' : ''} onClick={() => setCreatorMode('garments')}>Garments</button>
          </div>
          <button class="garage-button ghost" type="button" onClick={newPreset}>New Sim</button>
          <button class="garage-button ghost" type="button" onClick={save}>Save preset</button>
          <button class="garage-button primary" type="button" onClick={playLot}>Play Lot</button>
        </div>
      </header>

      <Show when={creatorMode() === 'appearance'}>
      <aside class="garage-panel garage-panel--left">
        <div class="garage-section-title"><span>01</span> Saved Sims</div>
        <div class="garage-saved-list">
          <Show when={savedPresets().length} fallback={<p class="garage-empty">No saved Sims yet.</p>}>
            <For each={savedPresets()}>
              {(preset) => (
                <div class={`garage-saved-card ${draft().id === preset.id ? 'active' : ''}`}>
                  <button type="button" onClick={() => choosePreset(preset)}>
                    <strong>{preset.name}</strong>
                    <small>
                      {SIM_BODY_OPTIONS.find((option) => option.id === preset.body)?.label ?? 'Base'} ·{' '}
                      {Object.keys(preset.morphs).length} adjusted features
                    </small>
                  </button>
                  <button class="garage-delete" type="button" title="Delete preset" onClick={() => remove(preset.id)}>×</button>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="garage-section-title garage-section-title--saved"><span>02</span> Feature group</div>
        <div class="garage-frame-list">
          <For each={TABS}>
            {(tab) => (
              <button
                type="button"
                class={`garage-frame-card ${activeTab() === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                <strong>{tab}</strong>
                <small>{MODELING_CONTROLS.filter((control) => control.tab === tab).length} controls</small>
              </button>
            )}
          </For>
        </div>
      </aside>

      <aside class="garage-panel garage-panel--right">
        <div class="garage-section-title"><span>03</span> {activeTab()} modeling</div>
        <div class="sim-body-field">
          <span>Body</span>
          <div class="garage-type-tabs sim-body-tabs" role="group" aria-label="Sim body">
            <For each={SIM_BODY_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  class={draft().body === option.id ? 'active' : ''}
                  aria-label={`${option.label} body`}
                  aria-pressed={draft().body === option.id}
                  disabled={previewSnapshot()?.status === 'loading'}
                  onClick={() => updateBody(option.id)}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <label class="garage-slider" title="Lateral shoulder raise — push arms out so hands clear the thighs">
          <span>Arm space</span>
          <input
            aria-label="Arm space"
            type="range"
            min={ARM_SPACE_MIN}
            max={ARM_SPACE_MAX}
            step="0.01"
            value={draft().armSpace ?? DEFAULT_ARM_SPACE}
            onInput={(event) => updateArmSpace(event.currentTarget.value)}
          />
          <output>{(draft().armSpace ?? DEFAULT_ARM_SPACE).toFixed(2)}</output>
        </label>
        <p class="garage-empty" style="margin: -4px 0 10px;">
          Opens arms sideways only (keeps idle forward/back). Right = out, left = in.
        </p>
        <label class="garage-name-field">
          <span>Name</span>
          <input
            aria-label="Sim name"
            value={draft().name}
            maxlength="80"
            onInput={(event) => updateName(event.currentTarget.value)}
          />
        </label>

        <Show when={activeTab() === 'Head'}>
          <div class="garage-control-group" data-testid="sim-hair-controls">
            <h2>Hair</h2>
            <label class="garage-name-field">
              <span>Hair cap</span>
              <select
                aria-label="Hair cap"
                value={draft().hairStyleId ?? 'none'}
                onChange={(event) => updateHairStyle(event.currentTarget.value)}
              >
                <option value="none">None</option>
                <For each={listSimHairOptions()}>
                  {(hair) => <option value={hair.id}>{hair.name}</option>}
                </For>
              </select>
            </label>
            <label class="garage-name-field" title="Multiplies the hair mesh tint">
              <span>Hair color</span>
              <input
                aria-label="Hair color"
                type="color"
                value={draft().hairColor ?? DEFAULT_SIM_HAIR_COLOR}
                disabled={!draft().hairStyleId}
                onInput={(event) => updateHairColor(event.currentTarget.value)}
              />
            </label>
            <p class="garage-empty" style="margin: -4px 0 10px;">
              Default: {listSimHairOptions().find((h) => h.id === DEFAULT_SIM_HAIR_STYLE_ID)?.name
                ?? 'Chestnut Cascade'}. Source pack keeps mesh 7 only.
            </p>

            <Show when={draft().hairStyleId}>
              <h2>Head socket fit</h2>
              <p class="garage-empty" style="margin: -4px 0 10px;">
                Parent: head bone (DEF-spine.006). Size / offset / rotation are local to the head.
              </p>
              <label class="garage-slider" title="Uniform scale on the head socket">
                <span>Size</span>
                <input
                  aria-label="Hair size"
                  type="range"
                  min={HAIR_SCALE_MIN}
                  max={HAIR_SCALE_MAX}
                  step="0.01"
                  value={draft().hairFit?.scale ?? DEFAULT_HAIR_FIT.scale}
                  onInput={(event) => updateHairFit({ scale: Number(event.currentTarget.value) })}
                />
                <output>{(draft().hairFit?.scale ?? 1).toFixed(2)}</output>
              </label>
              <For each={[
                ['x', 'Offset X'],
                ['y', 'Offset Y'],
                ['z', 'Offset Z'],
              ]}>
                {([axis, label]) => (
                  <label class="garage-slider" title={`${label} in meters (head-bone local)`}>
                    <span>{label}</span>
                    <input
                      aria-label={`Hair ${label}`}
                      type="range"
                      min={HAIR_POS_MIN}
                      max={HAIR_POS_MAX}
                      step="0.005"
                      value={draft().hairFit?.position?.[axis] ?? 0}
                      onInput={(event) => updateHairFit({
                        position: { [axis]: Number(event.currentTarget.value) },
                      })}
                    />
                    <output>{(draft().hairFit?.position?.[axis] ?? 0).toFixed(3)}</output>
                  </label>
                )}
              </For>
              <For each={[
                ['x', 'Rotate X'],
                ['y', 'Rotate Y'],
                ['z', 'Rotate Z'],
              ]}>
                {([axis, label]) => (
                  <label class="garage-slider" title={`${label} in degrees (head-bone local)`}>
                    <span>{label}</span>
                    <input
                      aria-label={`Hair ${label}`}
                      type="range"
                      min={HAIR_ROT_MIN}
                      max={HAIR_ROT_MAX}
                      step="1"
                      value={draft().hairFit?.rotation?.[axis] ?? 0}
                      onInput={(event) => updateHairFit({
                        rotation: { [axis]: Number(event.currentTarget.value) },
                      })}
                    />
                    <output>{Math.round(draft().hairFit?.rotation?.[axis] ?? 0)}°</output>
                  </label>
                )}
              </For>
              <div class="garage-save-row" style="margin-top: 6px;">
                <button class="garage-button ghost" type="button" onClick={resetHairFit}>
                  Reset head fit
                </button>
              </div>
            </Show>
          </div>
        </Show>

        <For each={sections()}>
          {(section) => (
            <div class="garage-control-group">
              <h2>{section.name}</h2>
              <For each={section.controls}>
                {(control) => (
                  <label class="garage-slider">
                    <span title={`${control.negativeLabel} ↔ ${control.positiveLabel}`}>{control.label}</span>
                    <input
                      aria-label={control.id}
                      type="range"
                      min={control.min}
                      max={control.max}
                      step="0.01"
                      value={draft().morphs[control.id] ?? 0}
                      onInput={(event) => updateMorph(control.id, event.currentTarget.value)}
                    />
                    <output>{(draft().morphs[control.id] ?? 0).toFixed(2)}</output>
                  </label>
                )}
              </For>
            </div>
          )}
        </For>

        <div class="garage-save-row">
          <p>{status()}</p>
          <small class="garage-empty">
            Preview {previewSnapshot()?.status ?? 'booting'} · {previewSnapshot()?.animationState ?? 'idle'}
          </small>
        </div>
      </aside>
      </Show>

      <Show when={creatorMode() === 'garments'}>
        <Suspense fallback={<div class="sim-garment-loading">Loading garment tools…</div>}>
          <SimGarmentEditor
            body={draft().body}
            selectedOutfitId={draft().outfitId}
            outfitScale={draft().outfitScale}
            outfitPosition={draft().outfitPosition}
            outfitSkinTuck={draft().outfitSkinTuck}
            outfitLimbReveal={draft().outfitLimbReveal}
            outfitLoopCuts={draft().outfitLoopCuts}
            outfitLoopEditor={previewSnapshot()?.outfitLoopEditor}
            outfitVariant={draft().outfitVariant}
            viewerApi={viewerRef}
            onCompile={previewGarment}
            onSave={assignGarment}
            onOutfitSelect={assignOutfit}
            onOutfitScaleChange={updateOutfitScale}
            onOutfitPositionChange={updateOutfitPosition}
            onOutfitSkinTuckChange={updateOutfitSkinTuck}
            onOutfitLimbRevealChange={updateOutfitLimbReveal}
            onOutfitLoopCutsChange={updateOutfitLoopCuts}
            onOutfitVariantChange={updateOutfitVariant}
            onClearOutfit={async () => {
              wardrobeEpoch += 1;
              const next = {
                ...draft(),
                outfitId: null,
                garmentIds: draft().garmentIds,
                outfitLoopCuts: [],
              };
              setDraft(next);
              preview?.setAppearance(next);
              await preview?.setOutfit?.(null);
            }}
            onOutfitBaked={async (result) => {
              const entry = result?.manifestEntry;
              const id = entry?.id ?? result?.id;
              if (!id) return;
              wardrobeEpoch += 1;
              if (entry) registerSimOutfitImport(entry);
              clearOutfitTemplateCache();
              // Prefer standard (no morphs) for imports — denser Meshy skins are
              // more reliable without morph projection.
              const next = {
                ...draft(),
                outfitId: id,
                garmentIds: [],
                outfitVariant: 'standard',
                outfitLimbReveal: { ...DEFAULT_OUTFIT_LIMB_REVEAL },
                outfitLoopCuts: [],
              };
              setDraft(next);
              preview?.setAppearance(next);
              // Exit import overlay cloth so skinned result is visible.
              preview?.endOutfitImport?.();
              const runtime = await preview?.setOutfit?.(id);
              const fitted = applySuggestedLimbReveal(next, runtime);
              if (fitted !== next) {
                setDraft(fitted);
                preview?.setAppearance(fitted);
              }
              setStatus(`Wearing imported outfit ${entry?.name ?? id}. Save preset to keep.`);
            }}
          />
        </Suspense>
      </Show>

      <div class="garage-orbit-hint">
        {creatorMode() === 'garments'
          ? 'Outfits catalog · Import align/pose/bake · Dynamic cloth patterns'
          : 'Drag to orbit · wheel to zoom'}
      </div>
    </section>
  );
}
