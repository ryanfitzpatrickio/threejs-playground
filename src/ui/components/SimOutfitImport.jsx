import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import {
  OUTFIT_IMPORT_MACRO_SLIDERS,
  OUTFIT_IMPORT_POSE_PRESETS,
} from '../../game/characters/simhuman/outfitImportPose.js';
import {
  OutfitImportSession,
  OUTFIT_BAKE_MAX_TEXTURE_DEFAULT,
} from '../../game/characters/simhuman/outfitImportSession.js';
import { isSimBodyId } from '../../game/characters/simhuman/simBodyProfiles.js';
import { registerSimOutfitPromoted } from '../../game/characters/simhuman/simOutfitCatalog.js';

const GIZMO_MODES = [
  ['translate', 'Move'],
  ['rotate', 'Rotate'],
  ['scale', 'Scale'],
];

const POSE_PRESET_LABELS = {
  rest: 'Rest',
  'a-pose': 'A-pose',
  'arms-down': 'Arms down',
  'arms-forward': 'Arms forward',
  crouch: 'Crouch',
};

const CUT_PRESETS = [
  ['sleeve.L', 'Sleeve L'],
  ['sleeve.R', 'Sleeve R'],
  ['forearm.L', 'Forearm L'],
  ['forearm.R', 'Forearm R'],
];

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const returnedHtml = /^\s*<!doctype|^\s*<html/i.test(text);
    throw new Error(returnedHtml
      ? `${label} returned the Vite HTML fallback. Restart npm run dev, reload the creator, and try again.`
      : `${label} returned invalid JSON (${response.status}).`);
  }
}

async function waitForBakedOutfitAsset(url, attempts = 4) {
  if (!url) throw new Error('Bake response did not include a standard outfit URL.');
  let detail = 'no response';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (
        response.ok
        && (contentType.includes('model/gltf-binary') || contentType.includes('application/octet-stream'))
      ) {
        return;
      }
      detail = `${response.status} ${contentType || 'unknown content type'}`;
      if (contentType.includes('text/html')) {
        detail += ' (Vite HTML fallback)';
      }
    } catch (error) {
      detail = error?.message ?? String(error);
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new Error(
    `Baked outfit is not available at ${url}: ${detail}. Restart npm run dev, reload, then use Wear baked.`,
  );
}

/**
 * Visual garment import / align / pose / bake panel.
 * Expects props.viewerApi with SimHumanViewerScene import hooks.
 */
export function SimOutfitImport(props) {
  const session = new OutfitImportSession();
  const [revision, setRevision] = createSignal(0);
  const [status, setStatus] = createSignal(
    'Drop an unrigged FBX/GLB, snap to the body, pose limbs into the cloth, then bake weights.',
  );
  const [baking, setBaking] = createSignal(false);
  const [bakeOk, setBakeOk] = createSignal(null);
  const [devReady, setDevReady] = createSignal(false);
  const [maxVerts, setMaxVerts] = createSignal(70000);
  // Bake export texture cap (client downscales before POST — big GLBs fail the wire).
  const [maxTexture, setMaxTexture] = createSignal(OUTFIT_BAKE_MAX_TEXTURE_DEFAULT);
  // Morph bake optional — default off for reliable first import (raw skin only).
  const [bakeMorphs, setBakeMorphs] = createSignal(false);
  // Rest-pose bakes transfer weights from a T-pose body — wrong for arms-down
  // Meshy garments. Two silent rest bakes shipped before this became opt-in.
  const [bakeRestPose, setBakeRestPose] = createSignal(false);
  const [editTarget, setEditTarget] = createSignal('cloth');
  const [gizmoMode, setGizmoMode] = createSignal('translate');

  const snap = () => {
    revision();
    return session.snapshot();
  };

  const bump = () => setRevision((n) => n + 1);

  /**
   * Resolve the live SimHumanViewerScene.
   * Accepts: { current }, () => scene, or the scene itself.
   */
  const api = () => {
    const v = props.viewerApi;
    if (v == null) return null;
    if (typeof v === 'function') return v() ?? null;
    if (typeof v === 'object' && 'current' in v) return v.current ?? null;
    return v;
  };

  onMount(() => {
    // Probe bake bridge (dev-only).
    if (import.meta.env.DEV) {
      fetch('/__editor/outfit/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setDevReady(Boolean(j?.blender)))
        .catch(() => setDevReady(false));
    }
    api()?.beginOutfitImport?.();
  });

  onCleanup(() => {
    api()?.endOutfitImport?.();
    session.dispose();
  });

  const pushPose = () => {
    const viewer = api();
    if (!viewer) {
      setStatus('Viewer not ready — wait for the body to finish loading.');
      return 0;
    }
    if (!viewer.applyImportPoseConfig) {
      setStatus('Viewer is missing pose API — hard-refresh the page.');
      return 0;
    }
    const config = session.getPoseConfig();
    const result = viewer.applyImportPoseConfig(config);
    session.rememberAppliedPose(result);
    if (!result || result.applied === 0) {
      const names = viewer.getImportBoneNames?.()?.filter((n) => /arm|shoulder/i.test(n)).slice(0, 8) ?? [];
      setStatus(
        `Pose applied 0 bones (${result?.status || 'unknown'}). `
        + (names.length ? `Arm-like bones: ${names.join(', ')}` : 'No bones found on body.'),
      );
    } else {
      const poseBoneCount = result.pose?.bones
        ? Object.keys(result.pose.bones).length
        : Object.keys(result.pose || {}).length;
      setStatus(
        `Pose OK · ${result.status} · bake deltas on ${poseBoneCount} bones`,
      );
    }
    bump();
    return result?.applied ?? 0;
  };

  const onFile = async (file) => {
    if (!file) return;
    setStatus(`Loading ${file.name}…`);
    setBakeOk(null);
    try {
      const viewer = api();
      if (!viewer?.setImportCloth) throw new Error('Viewer not ready — wait for the body preview.');
      if (!isSimBodyId(props.body)) {
        setStatus('Choose a supported body before importing weighted outfits.');
        return;
      }
      viewer.beginOutfitImport?.();
      // Clear authored outfit so it does not fight the import mesh.
      await props.onClearOutfit?.();
      const cloth = await session.loadClothFromFile(file);
      viewer.setImportCloth(cloth);
      const bodyObj = viewer.getBodyObjectForFit?.();
      if (bodyObj) {
        session.autoFitToBody(bodyObj);
      }
      viewer.setImportGizmoMode?.(gizmoMode());
      viewer.setImportEditTarget?.(editTarget());
      pushPose();
      setStatus(
        `Loaded ${file.name} (${session.vertCount()} verts). Snap/adjust cloth, pose body into it, then Apply weights.`,
      );
      bump();
    } catch (error) {
      console.error(error);
      setStatus(`Import failed: ${error?.message ?? error}`);
    }
  };

  const snapFit = () => {
    try {
      const bodyObj = api()?.getBodyObjectForFit?.();
      if (!bodyObj || !session.hasCloth) {
        setStatus('Load a cloth mesh first.');
        return;
      }
      session.autoFitToBody(bodyObj, {
        heightEase: session.heightEase,
        widthEase: session.widthEase,
      });
      setStatus('Snapped cloth to body height/feet (expand-only width). Fine-tune with the gizmo.');
      bump();
    } catch (error) {
      setStatus(`Snap failed: ${error?.message ?? error}`);
    }
  };

  const setMode = (mode) => {
    setGizmoMode(mode);
    session.gizmoMode = mode;
    api()?.setImportGizmoMode?.(mode);
    setEditTarget('cloth');
    api()?.setImportEditTarget?.('cloth');
    bump();
  };

  const setTarget = (target) => {
    setEditTarget(target);
    session.editTarget = target;
    api()?.setImportEditTarget?.(target);
    bump();
  };

  const applyCut = (preset) => {
    try {
      const n = session.applyBoneCutPreset(preset, (name) => api()?.getImportBone?.(name));
      setStatus(n ? `Cut ${preset} (${n} mesh piece${n === 1 ? '' : 's'}).` : `Cut ${preset}: no geometry kept.`);
      bump();
    } catch (error) {
      setStatus(`Cut failed: ${error?.message ?? error}`);
    }
  };

  const bake = async () => {
    if (!session.hasCloth) {
      setStatus('Load a cloth mesh first.');
      return;
    }
    if (!import.meta.env.DEV) {
      setStatus('Weight bake only runs on the local Vite dev server (Blender).');
      return;
    }
    setBaking(true);
    setStatus('Optimizing cloth (weld · decimate · resize textures) for bake…');
    setBakeOk(null);
    try {
      const viewer = api();
      const bodyObject = viewer?.getBodyObjectForFit?.() ?? viewer?.model?.object ?? null;
      if (!bodyObject) {
        throw new Error('Body not ready — wait for the selected body to load, then bake again.');
      }
      // Pose must be applied one more time so bake deltas match what you see.
      pushPose();
      const posePreview = session.getPose();
      const poseBoneCount = posePreview?.bones
        ? Object.keys(posePreview.bones).length
        : 0;
      if (poseBoneCount === 0 && !bakeRestPose()) {
        throw new Error(
          'Pose is REST (0 bone deltas) — weights would transfer from a T-pose body '
          + 'onto the posed garment. Click Arms down (section 06) until the limbs sit '
          + 'inside the cloth, or tick "Bake at rest pose" if the garment really is T-pose.',
        );
      }
      const payload = await session.exportBakePayload({
        bodyObject,
        maxVerts: maxVerts(),
        maxTexture: maxTexture(),
      });
      const exportMeta = payload.meta?.export;
      const clothMiB = ((exportMeta?.bytes ?? 0) / 1048576);
      const vertNote = exportMeta?.vertsBeforeOpt != null
        ? `${exportMeta.vertsBeforeOpt}→${exportMeta.vertsAfterOpt ?? exportMeta.vertCount} verts`
        : `${exportMeta?.vertCount ?? '?'} verts`;
      const texNote = `tex≤${exportMeta?.maxTexture ?? maxTexture()}`;
      const srcNote = exportMeta?.sourceFileIncluded
        ? ' · +source FBX'
        : (exportMeta?.sourceFileSkippedBytes
          ? ' · source FBX skipped (size)'
          : '');
      setStatus(
        `Optimized ${clothMiB.toFixed(2)} MiB · ${vertNote} · ${texNote}`
        + (exportMeta?.bindHeight ? ` · bindH ${exportMeta.bindHeight.toFixed(2)}` : '')
        + (exportMeta?.texturesEmbedded != null
          ? ` · maps ${exportMeta.texturesEmbedded}${exportMeta.texturesFailed ? `/${exportMeta.texturesFailed} fail` : ''}`
          : '')
        + srcNote
        + '. Weight transfer…',
      );
      const body = isSimBodyId(props.body) ? props.body : null;
      if (!body) throw new Error(`Unsupported outfit body: ${props.body}`);
      const id = (session.outfitId || 'import-outfit').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      // Estimate JSON size before POST. Oversized bodies used to abort the socket
      // with no HTTP response (browser: net::ERR_CONNECTION_RESET / Failed to fetch).
      const clothB64Len = payload.clothGlbBase64?.length ?? 0;
      let sourceB64Len = payload.sourceFileBase64?.length ?? 0;
      const MAX_POST_CHARS = 180 * 1024 * 1024; // ~ matches server MAX_JSON_BODY_BYTES
      let includeSource = Boolean(payload.sourceFileBase64);
      if (includeSource && clothB64Len + sourceB64Len > MAX_POST_CHARS * 0.9) {
        includeSource = false;
        sourceB64Len = 0;
        setStatus('Source FBX is large — baking without it (embedded cloth textures only)…');
      }
      if (clothB64Len + sourceB64Len > MAX_POST_CHARS) {
        throw new Error(
          `Bake payload still too large after optimize (~${((clothB64Len + sourceB64Len) / 1048576).toFixed(0)} MiB encoded). `
          + 'Lower Max verts / Max texture, then bake again.',
        );
      }
      let res;
      try {
        res = await fetch('/__editor/outfit/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            name: session.outfitName || id,
            body,
            clothGlbBase64: payload.clothGlbBase64,
            pose: payload.pose,
            ...(includeSource ? {
              sourceFileBase64: payload.sourceFileBase64,
              sourceFileExt: payload.sourceFileExt,
            } : {}),
            options: {
              noAutoAlign: true,
              expectedBindHeight: exportMeta?.bindHeight,
              expectedBindScale: exportMeta?.bindScale,
              bodyWorldScaleY: exportMeta?.bodyWorldScaleY,
              maxVerts: maxVerts(),
              maxTexture: maxTexture(),
              bakeMorphs: bakeMorphs(),
              morphMaxDist: 0.16,
              morphEase: 1.08,
              allowRestPose: bakeRestPose(),
            },
          }),
        });
      } catch (networkError) {
        // Dev-server restart, payload reset, or offline — never leave a bare TypeError.
        let blenderHint = '';
        try {
          const st = await fetch('/__editor/outfit/status', { cache: 'no-store' });
          if (st.ok) {
            const info = await st.json();
            blenderHint = info?.busy
              ? ' A bake may still be running on the server — wait and try Wear baked, or retry.'
              : info?.blender
                ? ' Dev server is up; retry the bake.'
                : ' Blender binary is missing — set BLENDER_BIN.';
          }
        } catch {
          blenderHint = ' Dev server looks down — restart `npm run dev`, hard-reload, then bake again.';
        }
        throw new Error(
          `Bake request failed (${networkError?.message ?? networkError}).${blenderHint}`,
        );
      }
      const json = await readJsonResponse(res, 'Outfit bake endpoint');
      if (!res.ok || !json.ok) {
        throw new Error(json.error || json.log?.slice?.(-500) || `Bake failed (${res.status})`);
      }
      // Sanity: server should have written a GLB; surface bind-height from client meta.
      await waitForBakedOutfitAsset(json.urls?.standard);
      setBakeOk(json);
      const miB = (json.bytes?.standard / 1048576) || 0;
      setStatus(
        `Baked ${id} · ${miB.toFixed(2)} MiB`
        + (exportMeta?.bindHeight ? ` · bindH ${exportMeta.bindHeight.toFixed(2)}` : '')
        + ' · wearing…',
      );
      await props.onBaked?.(json);
      setStatus(
        `Baked and wearing ${json.manifestEntry?.name ?? id}. `
        + 'If it still looks shredded, re-snap, Arms down, then bake again.',
      );
    } catch (error) {
      console.error(error);
      setStatus(`Bake failed: ${error?.message ?? error}`);
    } finally {
      setBaking(false);
      bump();
    }
  };

  const wearLast = async () => {
    if (!bakeOk()) return;
    try {
      await waitForBakedOutfitAsset(bakeOk().urls?.standard);
      await props.onBaked?.(bakeOk());
      setStatus('Wearing last baked import.');
    } catch (error) {
      console.error(error);
      setStatus(`Wear failed: ${error?.message ?? error}`);
    }
  };

  return (
    <section class="sim-outfit-browser sim-outfit-import" aria-label="Outfit import studio">
      <div class="sim-outfit-workspace">
        <div class="sim-outfit-hero">
          <span>Import pipeline</span>
          <h2>Align · Pose · Skin</h2>
          <p>
            Unrigged Meshy/FBX clothes are rarely T-pose. Snap the mesh, pose the body into the garment,
            then bake weights with Blender on the local dev server.
          </p>
        </div>

        <div class="sim-import-drop" data-testid="outfit-import-drop">
          <label class="sim-import-file">
            <span>Cloth file (FBX / GLB / OBJ)</span>
            <input
              type="file"
              accept=".fbx,.glb,.gltf,.obj,model/gltf-binary,model/gltf+json"
              disabled={!isSimBodyId(props.body)}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                onFile(file);
              }}
            />
          </label>
          <Show when={snap().fileName}>
            <p class="garage-empty">
              <strong>{snap().fileName}</strong> · {snap().vertCount} verts
            </p>
          </Show>
        </div>

        <Show when={!isSimBodyId(props.body)}>
          <p class="sim-outfit-warning">Choose a supported body in Appearance first.</p>
        </Show>
      </div>

      <aside class="sim-garment-inspector sim-outfit-inspector">
        <div class="garage-section-title"><span>04</span> Source</div>
        <label class="garage-name-field">
          <span>Outfit id</span>
          <input
            value={snap().outfitId}
            onInput={(e) => {
              session.outfitId = e.currentTarget.value;
              bump();
            }}
            placeholder="male-hoodie-01"
          />
        </label>
        <label class="garage-name-field">
          <span>Display name</span>
          <input
            value={snap().outfitName}
            onInput={(e) => {
              session.outfitName = e.currentTarget.value;
              bump();
            }}
            placeholder="Hoodie draft"
          />
        </label>

        <div class="garage-section-title" style="margin-top:14px;"><span>05</span> Cloth fit</div>
        <div class="sim-import-actions">
          <button type="button" class="garage-button ghost" disabled={!snap().hasCloth} onClick={snapFit}>
            Snap to body
          </button>
        </div>
        <div class="garage-type-tabs" role="group" aria-label="Edit target">
          <button type="button" class={editTarget() === 'cloth' ? 'active' : ''} onClick={() => setTarget('cloth')}>
            Cloth gizmo
          </button>
          <button type="button" class={editTarget() === 'pose' ? 'active' : ''} onClick={() => setTarget('pose')}>
            Body pose
          </button>
        </div>
        <Show when={editTarget() === 'cloth'}>
          <div class="garage-type-tabs" role="group" aria-label="Gizmo mode" style="margin-top:8px;">
            <For each={GIZMO_MODES}>
              {([id, label]) => (
                <button
                  type="button"
                  class={gizmoMode() === id ? 'active' : ''}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <label class="garage-slider">
            <span>Height ease</span>
            <input
              type="range"
              min="0.9"
              max="1.15"
              step="0.005"
              value={session.heightEase}
              onInput={(e) => {
                session.heightEase = Number(e.currentTarget.value);
                bump();
              }}
            />
            <output>{session.heightEase.toFixed(3)}</output>
          </label>
          <label class="garage-slider">
            <span>Width ease</span>
            <input
              type="range"
              min="1.0"
              max="1.25"
              step="0.01"
              value={session.widthEase}
              onInput={(e) => {
                session.widthEase = Number(e.currentTarget.value);
                bump();
              }}
            />
            <output>{session.widthEase.toFixed(2)}</output>
          </label>
          <p class="garage-empty">Drag the gizmo on the mesh. Re-snap uses ease values.</p>
        </Show>

        <div class="garage-section-title" style="margin-top:14px;"><span>06</span> Body pose</div>
        <p class="garage-empty" style="margin-bottom:8px;">
          Pose the body until limbs sit inside the cloth. Weights transfer in this pose.
        </p>
        <div class="sim-import-presets">
          <For each={Object.keys(OUTFIT_IMPORT_POSE_PRESETS)}>
            {(id) => (
              <button
                type="button"
                class={`garage-button ghost ${snap().presetId === id ? 'active' : ''}`}
                onClick={() => {
                  session.setPreset(id);
                  setTarget('pose');
                  pushPose();
                }}
              >
                {POSE_PRESET_LABELS[id] ?? id}
              </button>
            )}
          </For>
          <button
            type="button"
            class="garage-button ghost"
            onClick={() => {
              session.resetPose();
              pushPose();
            }}
          >
            Reset pose
          </button>
        </div>
        <p class="garage-empty" style="margin-bottom:8px;">
          For Meshy clothes: <strong>Arms down</strong>, then raise <strong>Arm out</strong> until
          sleeves match (positive = wider A-pose, negative = glued-in).
        </p>
        <For each={OUTFIT_IMPORT_MACRO_SLIDERS}>
          {(slider) => (
            <label class="garage-slider">
              <span>{slider.label}</span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step="1"
                value={snap().macros[slider.id] ?? 0}
                onInput={(e) => {
                  session.setMacro(slider.id, e.currentTarget.value);
                  setTarget('pose');
                  pushPose();
                }}
              />
              <output>
                {Math.round(snap().macros[slider.id] ?? 0)}{slider.unit === '%' ? '%' : '°'}
              </output>
            </label>
          )}
        </For>

        <div class="garage-section-title" style="margin-top:14px;"><span>07</span> Cuts</div>
        <div class="sim-import-presets">
          <For each={CUT_PRESETS}>
            {([id, label]) => (
              <button
                type="button"
                class="garage-button ghost"
                disabled={!snap().hasCloth}
                onClick={() => applyCut(id)}
              >
                {label}
              </button>
            )}
          </For>
          <button
            type="button"
            class="garage-button ghost"
            disabled={!snap().undoCuts}
            onClick={() => {
              if (session.undoCut()) {
                setStatus('Undid last cut.');
                bump();
              }
            }}
          >
            Undo cut
          </button>
        </div>

        <div class="garage-section-title" style="margin-top:14px;"><span>08</span> Bake weights</div>
        <p class="sim-outfit-warning" style="margin:6px 0 8px;">
          Bake optimizes first (weld · decimate to Max verts · resize textures) so the upload fits.
        </p>
        <label class="garage-slider">
          <span title="Client decimates the export mesh to this budget before Blender. Lower if bake says payload is still too large.">Max verts</span>
          <input
            type="range"
            min="20000"
            max="120000"
            step="5000"
            value={maxVerts()}
            onInput={(e) => setMaxVerts(Number(e.currentTarget.value))}
          />
          <output>{maxVerts()}</output>
        </label>
        <label class="garage-slider">
          <span title="Longest edge for maps embedded in the bake GLB. 1024 is usually enough; drop to 512 if the upload is still too big.">Max texture</span>
          <input
            type="range"
            min="512"
            max="2048"
            step="256"
            value={maxTexture()}
            onInput={(e) => setMaxTexture(Number(e.currentTarget.value))}
          />
          <output>{maxTexture()}px</output>
        </label>
        <label class="garage-name-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input
            type="checkbox"
            checked={bakeMorphs()}
            onChange={(e) => setBakeMorphs(e.currentTarget.checked)}
          />
          <span>Bake bulk morphs (mass/muscle/fat)</span>
        </label>
        <label class="garage-name-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input
            type="checkbox"
            checked={bakeRestPose()}
            onChange={(e) => setBakeRestPose(e.currentTarget.checked)}
          />
          <span>Bake at rest pose (garment already T-pose)</span>
        </label>
        <div class="sim-garment-actions">
          <button
            type="button"
            class="garage-button primary"
            disabled={!snap().hasCloth || baking() || !isSimBodyId(props.body)}
            onClick={bake}
          >
            {baking() ? 'Baking…' : 'Apply weights'}
          </button>
          <button
            type="button"
            class="garage-button ghost"
            disabled={!bakeOk()}
            onClick={wearLast}
          >
            Wear baked
          </button>
          <button
            type="button"
            class="garage-button ghost"
            disabled={!bakeOk() || !import.meta.env.DEV}
            onClick={async () => {
              if (!bakeOk()?.id) return;
              try {
                const res = await fetch('/__editor/outfit/promote', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    id: bakeOk().id,
                    name: bakeOk().manifestEntry?.name,
                    body: props.body,
                  }),
                });
                const json = await readJsonResponse(res, 'Outfit promote endpoint');
                if (!res.ok || !json.ok) throw new Error(json.error || 'Promote failed');
                registerSimOutfitPromoted(json.manifestEntry);
                setStatus(
                  `Promoted ${json.id}. It is now available in the Outfits list.`,
                );
              } catch (error) {
                setStatus(`Promote failed: ${error?.message ?? error}`);
              }
            }}
          >
            Promote
          </button>
        </div>
        <Show when={import.meta.env.DEV}>
          <p class="garage-empty">
            Blender bridge: {devReady() ? 'ready' : 'unavailable — start Vite with Blender installed'}
          </p>
        </Show>
        <Show when={!import.meta.env.DEV}>
          <p class="sim-outfit-warning">Bake requires local npm run dev + Blender.</p>
        </Show>

        <p class="sim-garment-status" data-testid="outfit-import-status">{status()}</p>
      </aside>
    </section>
  );
}
