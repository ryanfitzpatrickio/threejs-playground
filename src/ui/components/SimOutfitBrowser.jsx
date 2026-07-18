import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import {
  DEFAULT_OUTFIT_LIMB_REVEAL,
  DEFAULT_OUTFIT_POSITION,
  DEFAULT_OUTFIT_SCALE,
  DEFAULT_OUTFIT_SKIN_TUCK,
  OUTFIT_ARM_REVEAL_MAX,
  OUTFIT_LIMB_REVEAL_MAX,
  OUTFIT_POSITION_MAX,
  OUTFIT_POSITION_MIN,
  OUTFIT_SCALE_MAX,
  OUTFIT_SCALE_MIN,
  OUTFIT_SKIN_TUCK_MAX,
  OUTFIT_SKIN_TUCK_MIN,
  sanitizeOutfitLimbReveal,
  sanitizeOutfitPosition,
  sanitizeOutfitScale,
  sanitizeOutfitSkinTuck,
} from '../../game/characters/simhuman/simAppearanceSchema.js';
import {
  getSimOutfitDefinition,
  listSimOutfitOptions,
  loadSimOutfitPromotedManifest,
} from '../../game/characters/simhuman/simOutfitCatalog.js';
import { isSimBodyId } from '../../game/characters/simhuman/simBodyProfiles.js';
import {
  OUTFIT_LOOP_EDGE_MAX,
  OUTFIT_LOOP_EDGE_MIN,
  OUTFIT_LOOP_RADIAL_DEFAULT,
  OUTFIT_LOOP_RADIAL_MAX,
  OUTFIT_LOOP_RADIAL_MIN,
  OUTFIT_LOOP_TARGETS,
  sanitizeOutfitLoopCuts,
} from '../../game/characters/simhuman/outfitLoopCuts.js';

export function SimOutfitBrowser(props) {
  const [status, setStatus] = createSignal('Choose an authored outfit to preview it on this Sim.');
  const [outfits, setOutfits] = createSignal(listSimOutfitOptions());
  const compatible = createMemo(() => isSimBodyId(props.body));
  const scale = createMemo(() => sanitizeOutfitScale(props.outfitScale ?? DEFAULT_OUTFIT_SCALE));
  const position = createMemo(() => sanitizeOutfitPosition(
    props.outfitPosition ?? DEFAULT_OUTFIT_POSITION,
  ));
  const skinTuck = createMemo(() => sanitizeOutfitSkinTuck(
    props.outfitSkinTuck ?? DEFAULT_OUTFIT_SKIN_TUCK,
  ));
  const [loopTarget, setLoopTarget] = createSignal('torso');
  const [loopInterpolation, setLoopInterpolation] = createSignal('smooth');
  const [loopHideSide, setLoopHideSide] = createSignal('positive');

  let selectSeq = 0;
  const select = async (outfitId) => {
    if (outfitId && !compatible()) return;
    const seq = ++selectSeq;
    const definition = getSimOutfitDefinition(outfitId);
    setStatus(outfitId ? `Loading ${definition?.name ?? 'outfit'}…` : 'Removing authored outfit…');
    try {
      await props.onSelect?.(outfitId);
      // Ignore status from an older click if the user already picked another card.
      if (seq !== selectSeq) return;
      setStatus(outfitId
        ? `${definition?.name ?? 'Outfit'} assigned. Save the Sim preset to keep it.`
        : 'Authored outfit removed.');
    } catch (error) {
      if (seq !== selectSeq) return;
      setStatus(`Outfit failed: ${error?.message ?? error}`);
    }
  };

  onMount(async () => {
    await loadSimOutfitPromotedManifest();
    setOutfits(listSimOutfitOptions());
  });

  const setScaleAxis = (axis, value) => {
    const next = { ...scale(), [axis]: Number(value) };
    props.onOutfitScaleChange?.(next);
  };

  const resetScale = () => {
    props.onOutfitScaleChange?.({ ...DEFAULT_OUTFIT_SCALE });
  };

  const setPositionAxis = (axis, value) => {
    props.onOutfitPositionChange?.({ ...position(), [axis]: Number(value) });
  };

  const resetPosition = () => {
    props.onOutfitPositionChange?.({ ...DEFAULT_OUTFIT_POSITION });
  };

  const setSkinTuck = (key, value) => {
    props.onOutfitSkinTuckChange?.({ ...skinTuck(), [key]: Number(value) });
  };

  const resetSkinTuck = () => {
    props.onOutfitSkinTuckChange?.({ ...DEFAULT_OUTFIT_SKIN_TUCK });
  };

  const limbReveal = createMemo(() => sanitizeOutfitLimbReveal(
    props.outfitLimbReveal ?? DEFAULT_OUTFIT_LIMB_REVEAL,
  ));

  const setLimbReveal = (key, value) => {
    props.onOutfitLimbRevealChange?.({ ...limbReveal(), [key]: Number(value) });
  };

  const setVariant = (variant) => {
    props.onOutfitVariantChange?.(variant === 'standard' ? 'standard' : 'morph');
  };

  const variant = () => (props.outfitVariant === 'standard' ? 'standard' : 'morph');
  const loopCuts = createMemo(() => sanitizeOutfitLoopCuts(props.outfitLoopCuts));
  const loopEditor = () => props.outfitLoopEditor ?? { active: false, pointCount: 0, status: '' };

  const beginLoopCut = () => {
    const started = props.viewerApi?.current?.beginOutfitLoopCut?.({
      target: loopTarget(),
      interpolation: loopInterpolation(),
      hideSide: loopHideSide(),
      // Torso rings default to a tube around the drawn dots: neckline cruft is
      // removable without the cut reaching the shoulder tops at the same
      // height. Tunable per saved cut below; null opts back out.
      radialReach: loopTarget() === 'torso' ? OUTFIT_LOOP_RADIAL_DEFAULT : undefined,
    });
    setStatus(started
      ? 'Loop Cut active: Shift-click dots around the garment; drag normally to orbit.'
      : 'Loop Cut needs a loaded authored outfit.');
  };

  const updateLoopCut = (id, patch) => {
    props.onOutfitLoopCutsChange?.(loopCuts().map((cut) => (
      cut.id === id ? { ...cut, ...patch } : cut
    )));
  };

  const removeLoopCut = (id) => {
    props.onOutfitLoopCutsChange?.(loopCuts().filter((cut) => cut.id !== id));
  };

  const positiveSideLabel = () => {
    if (loopTarget() === 'torso') return 'Hide above loop';
    return 'Hide toward hand/foot';
  };
  const negativeSideLabel = () => {
    if (loopTarget() === 'torso') return 'Hide below loop';
    return 'Hide toward shoulder/hip';
  };

  return (
    <section class="sim-outfit-browser" aria-label="Authored outfits">
      <div class="sim-outfit-workspace">
        <div class="sim-outfit-hero">
          <span>Weighted wardrobe</span>
          <h2>Fantasy outfits</h2>
          <p>Imported meshes are weighted against the selected Base, Male, or Female body.</p>
        </div>

        <div class="sim-outfit-grid">
          <button
            type="button"
            class={`sim-outfit-card ${!props.selectedOutfitId ? 'active' : ''}`}
            aria-label="No authored outfit"
            aria-pressed={!props.selectedOutfitId}
            onClick={() => select(null)}
          >
            <strong>None</strong>
            <small>Use the base body or Dynamic Cloth wardrobe.</small>
          </button>
          <For each={outfits()}>
            {(outfit) => {
              const forBody = () => Boolean(outfit.bodies?.[props.body]);
              const disabled = () => !compatible() || !forBody();
              const blurb = () => {
                if (outfit.id === 'fantasy-ranger') return 'Hood · leather · belts';
                if (outfit.id === 'athleisure-mono') return 'Male only · Meshy · weighted';
                if (outfit.promoted) return 'Promoted · weighted import';
                return 'Cloth · wraps · boots';
              };
              return (
                <button
                  type="button"
                  class={`sim-outfit-card ${props.selectedOutfitId === outfit.id ? 'active' : ''}`}
                  aria-label={`${outfit.name} outfit`}
                  aria-pressed={props.selectedOutfitId === outfit.id}
                  disabled={disabled()}
                  title={disabled() && compatible() ? `Not available for ${props.body} body` : undefined}
                  onClick={() => select(outfit.id)}
                >
                  <span>{blurb()}</span>
                  <strong>{outfit.name}</strong>
                  <small>{outfit.description}</small>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <aside class="sim-garment-inspector sim-outfit-inspector">
        <div class="garage-section-title"><span>04</span> Authored outfits</div>
        <Show
          when={compatible()}
          fallback={<p class="sim-outfit-warning">Choose a supported body in Appearance before assigning outfits.</p>}
        >
          <p class="garage-empty">
            Selective bulk morphs + residual ease follow Body Mass/Muscle/Fat.
            Use fit scale for chest/leg fine-tuning.
          </p>
          <div class="sim-outfit-compatibility">
            <span>Current body</span>
            <strong>{props.body}</strong>
          </div>

          <Show when={props.selectedOutfitId}>
            <div class="garage-section-title" style="margin-top:14px;"><span>05</span> Asset variant</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              <strong>Morph-Enabled</strong> bakes 5 bulk shape keys (mass/muscle/fat) with sparse+Draco.
              <strong>Standard</strong> strips morphs for a smaller file (shader ease + fit scale only).
            </p>
            <div class="garage-type-tabs" role="tablist" aria-label="Outfit asset variant" style="margin-bottom:12px;">
              <button
                type="button"
                role="tab"
                class={variant() === 'morph' ? 'active' : ''}
                aria-selected={variant() === 'morph'}
                onClick={() => setVariant('morph')}
              >
                Morph-Enabled
              </button>
              <button
                type="button"
                role="tab"
                class={variant() === 'standard' ? 'active' : ''}
                aria-selected={variant() === 'standard'}
                onClick={() => setVariant('standard')}
              >
                Standard
              </button>
            </div>

            <div class="garage-section-title"><span>06</span> Outfit fit scale</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              Bind-pose scale on each axis (1.00 = authored). Affects width/height/depth of the clothes before skinning. Saved with the preset.
            </p>
            <For each={[['x', 'Width (X)'], ['y', 'Height (Y)'], ['z', 'Depth (Z)']]}>
              {([axis, label]) => (
                <label class="garage-slider">
                  <span>{label}</span>
                  <input
                    type="range"
                    min={OUTFIT_SCALE_MIN}
                    max={OUTFIT_SCALE_MAX}
                    step="0.005"
                    value={scale()[axis]}
                    onInput={(event) => setScaleAxis(axis, event.currentTarget.value)}
                  />
                  <output>{Number(scale()[axis]).toFixed(3)}</output>
                </label>
              )}
            </For>
            <button type="button" class="tb-btn" style="margin-top:8px; width:100%;" onClick={resetScale}>
              Reset scale 1.0
            </button>

            <div class="garage-section-title" style="margin-top:14px;"><span>07</span> Outfit position</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              Bind-pose XYZ offset applied after baking and before skinning. Moves every garment
              piece together, updates live, and saves with the preset.
            </p>
            <For each={[['x', 'Offset X'], ['y', 'Offset Y'], ['z', 'Offset Z']]}>
              {([axis, label]) => (
                <label class="garage-slider">
                  <span>{label}</span>
                  <input
                    aria-label={`Outfit ${label}`}
                    type="range"
                    min={OUTFIT_POSITION_MIN}
                    max={OUTFIT_POSITION_MAX}
                    step="0.005"
                    value={position()[axis]}
                    onInput={(event) => setPositionAxis(axis, event.currentTarget.value)}
                  />
                  <output>{Number(position()[axis]).toFixed(3)}</output>
                </label>
              )}
            </For>
            <button type="button" class="tb-btn" style="margin-top:8px; width:100%;" onClick={resetPosition}>
              Reset position 0.0
            </button>

            <div class="garage-section-title" style="margin-top:14px;"><span>08</span> Inner skin tuck</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              Moves the real-skin companion behind open necklines and backs. Lower is more flush;
              1.00 is the previous depth. Updates live without rebuilding the body and saves with the preset.
            </p>
            <For each={[
              ['torso', 'Torso tuck depth'],
              ['seams', 'Limb seam depth'],
            ]}>
              {([key, label]) => (
                <label class="garage-slider">
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    type="range"
                    min={OUTFIT_SKIN_TUCK_MIN}
                    max={OUTFIT_SKIN_TUCK_MAX}
                    step="0.01"
                    value={skinTuck()[key]}
                    onInput={(event) => setSkinTuck(key, event.currentTarget.value)}
                  />
                  <output>{Number(skinTuck()[key]).toFixed(2)}</output>
                </label>
              )}
            </For>
            <button type="button" class="tb-btn" style="margin-top:8px; width:100%;" onClick={resetSkinTuck}>
              Reset tuck depth
            </button>

            <div class="garage-section-title" style="margin-top:14px;"><span>09</span> Limb replacement</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              Left keeps the authored garment limb. Moving right cuts the clothing back from the tip
              and restores the real body underneath. Arm reveal continues past 1 through the shoulder,
              collarbone, and center chest. Each control affects both sides and is saved with the preset.
            </p>
            <For each={[
              ['arms', 'Arm reveal', OUTFIT_ARM_REVEAL_MAX],
              ['legs', 'Leg reveal', OUTFIT_LIMB_REVEAL_MAX],
              ['feet', 'Foot reveal', OUTFIT_LIMB_REVEAL_MAX],
            ]}>
              {([key, label, max]) => (
                <label class="garage-slider">
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    type="range"
                    min="0"
                    max={max}
                    step="0.005"
                    value={limbReveal()[key]}
                    onInput={(event) => setLimbReveal(key, event.currentTarget.value)}
                  />
                  <output>{Number(limbReveal()[key]).toFixed(3)}</output>
                </label>
              )}
            </For>

            <div class="garage-section-title" style="margin-top:14px;"><span>10</span> Surface loop cuts</div>
            <p class="garage-empty" style="margin-bottom:8px;">
              Draw a closed loop directly on the outfit. The garment and its shadow are removed on
              one side while the real body takes over. Use Sharp for a V-neck point; Smooth rounds
              the spline between dots.
            </p>
            <label class="garage-name-field">
              <span>Loop target</span>
              <select
                aria-label="Loop cut target"
                value={loopTarget()}
                disabled={loopEditor().active}
                onChange={(event) => setLoopTarget(event.currentTarget.value)}
              >
                <For each={OUTFIT_LOOP_TARGETS}>
                  {(target) => <option value={target.id}>{target.label}</option>}
                </For>
              </select>
            </label>
            <div class="garage-type-tabs" role="tablist" aria-label="Loop cut interpolation" style="margin:8px 0;">
              <button
                type="button"
                role="tab"
                class={loopInterpolation() === 'smooth' ? 'active' : ''}
                aria-selected={loopInterpolation() === 'smooth'}
                disabled={loopEditor().active}
                onClick={() => setLoopInterpolation('smooth')}
              >Smooth</button>
              <button
                type="button"
                role="tab"
                class={loopInterpolation() === 'sharp' ? 'active' : ''}
                aria-selected={loopInterpolation() === 'sharp'}
                disabled={loopEditor().active}
                onClick={() => setLoopInterpolation('sharp')}
              >Sharp</button>
            </div>
            <label class="garage-name-field">
              <span>Remove side</span>
              <select
                aria-label="Loop cut remove side"
                value={loopHideSide()}
                disabled={loopEditor().active}
                onChange={(event) => setLoopHideSide(event.currentTarget.value)}
              >
                <option value="positive">{positiveSideLabel()}</option>
                <option value="negative">{negativeSideLabel()}</option>
              </select>
            </label>
            <Show
              when={loopEditor().active}
              fallback={(
                <button type="button" class="garage-button primary" style="width:100%; margin-top:8px;" onClick={beginLoopCut}>
                  Draw loop on mesh
                </button>
              )}
            >
              <p class="sim-outfit-warning" style="margin-top:8px;">
                {loopEditor().status || `Placed ${loopEditor().pointCount} points.`}
              </p>
              <div class="sim-garment-actions">
                <button type="button" class="garage-button ghost" onClick={() => props.viewerApi?.current?.undoOutfitLoopPoint?.()}>
                  Undo dot
                </button>
                <button type="button" class="garage-button primary" onClick={() => props.viewerApi?.current?.finishOutfitLoopCut?.()}>
                  Close loop
                </button>
                <button type="button" class="garage-button ghost" onClick={() => props.viewerApi?.current?.cancelOutfitLoopCut?.()}>
                  Cancel
                </button>
              </div>
            </Show>
            <Show when={loopCuts().length > 0}>
              <div class="garage-control-group" style="margin-top:8px;">
                <h2>Saved loop cuts</h2>
                <For each={loopCuts()}>
                  {(cut, index) => (
                    <div style="margin-top:8px;">
                      <small>{index() + 1}. {OUTFIT_LOOP_TARGETS.find((target) => target.id === cut.target)?.label ?? cut.target} · {cut.interpolation}</small>
                      <label class="garage-slider" style="margin-top:4px;">
                        <span title="Negative cuts farther; positive keeps more of the authored garment.">Edge adjustment</span>
                        <input
                          aria-label={`Loop cut ${index() + 1} edge adjustment`}
                          type="range"
                          min={OUTFIT_LOOP_EDGE_MIN}
                          max={OUTFIT_LOOP_EDGE_MAX}
                          step="0.005"
                          value={cut.edgeInset ?? 0}
                          onInput={(event) => updateLoopCut(cut.id, {
                            edgeInset: Number(event.currentTarget.value),
                          })}
                        />
                        <output>{Number(cut.edgeInset ?? 0).toFixed(3)}</output>
                      </label>
                      <div style="display:flex; justify-content:space-between; margin-top:-3px;">
                        <small>Cut more</small>
                        <small>Keep more garment</small>
                      </div>
                      <Show when={cut.target === 'torso'}>
                        <label class="garage-slider" style="margin-top:4px;">
                          <span title="Limits the cut to a tube around the drawn dots — neckline cruft is removed without the cut reaching the shoulders at the same height. Wider reaches farther from the dots; off cuts everything above the loop.">Ring limit</span>
                          <input
                            aria-label={`Loop cut ${index() + 1} ring limit enabled`}
                            type="checkbox"
                            checked={Number.isFinite(cut.radialReach)}
                            onChange={(event) => updateLoopCut(cut.id, {
                              radialReach: event.currentTarget.checked
                                ? OUTFIT_LOOP_RADIAL_DEFAULT
                                : null,
                            })}
                          />
                          <input
                            aria-label={`Loop cut ${index() + 1} ring limit reach`}
                            type="range"
                            min={OUTFIT_LOOP_RADIAL_MIN}
                            max={OUTFIT_LOOP_RADIAL_MAX}
                            step="0.005"
                            disabled={!Number.isFinite(cut.radialReach)}
                            value={Number.isFinite(cut.radialReach) ? cut.radialReach : OUTFIT_LOOP_RADIAL_DEFAULT}
                            onInput={(event) => updateLoopCut(cut.id, {
                              radialReach: Number(event.currentTarget.value),
                            })}
                          />
                          <output>{Number.isFinite(cut.radialReach) ? `+${cut.radialReach.toFixed(3)}` : 'off'}</output>
                        </label>
                      </Show>
                      <div class="sim-garment-actions" style="align-items:center; margin-top:6px;">
                        <button
                          type="button"
                          class="garage-button ghost"
                          onClick={() => updateLoopCut(cut.id, {
                            hideSide: cut.hideSide === 'positive' ? 'negative' : 'positive',
                          })}
                        >Flip side</button>
                        <button type="button" class="garage-button ghost" onClick={() => removeLoopCut(cut.id)}>Remove</button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
        <p class="sim-garment-status" data-testid="outfit-status">{status()}</p>
        <small class="garage-empty">CC0 models by Quaternius · 2K embedded texture maps</small>
      </aside>
    </section>
  );
}
