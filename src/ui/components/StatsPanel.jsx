import { For, Show, createMemo } from 'solid-js';
import { buildSparklinePath } from '../../game/render/drawCallProfiler.js';

const EMPTY = { frame: null, renderer: null };
const GRAPH_WIDTH = 156;
const GRAPH_HEIGHT = 34;

export function StatsPanel(props) {
  const snap = () => props.snapshot ?? EMPTY;

  const frame = () => snap().frame;
  const renderer = () => snap().renderer;
  const drawStats = () => renderer()?.drawStats ?? null;

  const fps = createMemo(() => {
    const f = frame();
    const avg = f?.recentAvgMs ?? 0;
    if (!avg || avg <= 0) return 0;
    return 1000 / avg;
  });

  const fpsStr = () => {
    const v = fps();
    if (!v) return '—';
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  };

  const fpsClass = createMemo(() => {
    const v = fps();
    if (v >= 55) return 'good';
    if (v >= 40) return 'warn';
    return 'bad';
  });

  const draws = () => renderer()?.drawCalls ?? renderer()?.renderCalls ?? '—';
  const tris = createMemo(() => {
    const t = renderer()?.triangles ?? 0;
    if (!t && t !== 0) return '—';
    if (t >= 1_000_000) return (t / 1_000_000).toFixed(1) + 'M';
    if (t >= 10_000) return Math.round(t / 1000) + 'k';
    return t.toLocaleString();
  });

  const geos = () => renderer()?.geometries ?? '—';
  const texs = () => renderer()?.textures ?? '—';
  const lightingMode = () => renderer()?.lightingMode ?? 'hemisphere';
  const clusteredLights = () => snap().scene?.clusteredTestLightCount ?? 0;

  const avgMs = () => (frame()?.recentAvgMs ?? 0).toFixed(1);
  const p95Ms = () => (frame()?.recentP95Ms ?? 0).toFixed(1);
  const renderMs = () => (frame()?.renderMs ?? 0).toFixed(1);

  const hitches = () => frame()?.hitches ?? 0;

  const overBudget = createMemo(() => {
    const f = frame();
    return (f?.recentP95Ms ?? 0) >= (f?.hitchMs ?? 20);
  });

  const topSystems = createMemo(() => {
    const f = frame();
    const systems = f?.systems ?? {};
    return Object.entries(systems)
      .filter(([, v]) => v > 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${shortLabel(k)} ${v.toFixed(1)}`);
  });

  const backend = () => renderer()?.backend ?? 'webgpu';

  const drawHistory = createMemo(() => drawStats()?.history ?? []);
  const drawBreakdown = createMemo(() => (drawStats()?.breakdown ?? []).slice(0, 8));
  const sparklinePath = createMemo(() => buildSparklinePath(drawHistory(), GRAPH_WIDTH, GRAPH_HEIGHT));
  const graphMax = createMemo(() => {
    const values = drawHistory();
    return values.length ? Math.max(...values, 1) : 1;
  });

  const formatTris = (value) => {
    if (!value && value !== 0) return '—';
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
    if (value >= 10_000) return Math.round(value / 1000) + 'k';
    return value.toLocaleString();
  };

  return (
    <div class="stats-panel" classList={{ 'stats-panel--warn': overBudget() }} aria-hidden="true">
      <div class="stats-head">
        <span class="stats-fps">
          <span class={`fps ${fpsClass()}`}>{fpsStr()}</span>
          <span class="fps-unit">FPS</span>
        </span>
        <span class="stats-ms">
          {avgMs()}<span class="u">ms</span>
        </span>
      </div>

      <div class="stats-grid">
        <div class="stat">
          <span class="l">p95</span>
          <span class="v">{p95Ms()}</span>
        </div>
        <div class="stat">
          <span class="l">draws</span>
          <span class="v">{draws()}</span>
        </div>
        <div class="stat">
          <span class="l">tris</span>
          <span class="v">{tris()}</span>
        </div>
        <div class="stat">
          <span class="l">gpu</span>
          <span class="v">{backend()}</span>
        </div>
        <div class="stat">
          <span class="l">geo</span>
          <span class="v">{geos()}</span>
        </div>
        <div class="stat">
          <span class="l">tex</span>
          <span class="v">{texs()}</span>
        </div>
      </div>

      <Show when={drawHistory().length > 1}>
        <div class="stats-graph">
          <div class="stats-graph-head">
            <span class="l">draws / frame</span>
            <span class="v">{draws()} · max {graphMax()}</span>
          </div>
          <svg
            class="stats-graph-svg"
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            width={GRAPH_WIDTH}
            height={GRAPH_HEIGHT}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path class="stats-graph-fill" d={`${sparklinePath()} L ${GRAPH_WIDTH - 2},${GRAPH_HEIGHT - 2} L 2,${GRAPH_HEIGHT - 2} Z`} />
            <path class="stats-graph-line" d={sparklinePath()} />
          </svg>
        </div>
      </Show>

      {drawBreakdown().length > 0 && (
        <div class="stats-breakdown">
          <div class="stats-breakdown-head">draw sources</div>
          <For each={drawBreakdown()}>
            {(row) => (
              <div class="stats-breakdown-row">
                <span class="l" title={row.label}>{row.label}</span>
                <span class="bar" aria-hidden="true">
                  <span class="fill" style={{ width: `${row.pct}%` }} />
                </span>
                <span class="v">{row.draws}</span>
                <span class="t">{formatTris(row.tris)}</span>
              </div>
            )}
          </For>
        </div>
      )}

      <div class="stats-bar">
        <span class="l">render</span>
        <span class="v">{renderMs()}ms</span>
        <span class="sep">·</span>
        <span class="h">{hitches()}h</span>
        <span class="sep">·</span>
        <span class="h">lt {lightingMode()}{clusteredLights() ? `/${clusteredLights()}` : ''}</span>
      </div>

      {topSystems().length > 0 && (
        <div class="stats-sys">
          {topSystems().map((s) => <span class="chip">{s}</span>)}
        </div>
      )}
    </div>
  );
}

function shortLabel(k) {
  const map = {
    enemy: 'en',
    movement: 'mv',
    animation: 'an',
    combat: 'cb',
    physics: 'ph',
    telekinesis: 'tk',
    streaming: 'st',
    cutProps: 'ct',
    render: 'rd',
  };
  return map[k] || k.slice(0, 2);
}
