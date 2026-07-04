#!/usr/bin/env node
/**
 * Stream-parse a Chrome trace (.json or .json.gz) without loading it all into RAM.
 * Usage: node scripts/analyze-chrome-trace.mjs /path/to/trace.json.gz
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-chrome-trace.mjs <trace.json|.json.gz>');
  process.exit(1);
}

const isGz = path.endsWith('.gz');
const input = isGz
  ? createReadStream(path).pipe(createGunzip())
  : createReadStream(path);

/** @type {Map<string, string>} */
const threadNames = new Map();
let mainPid = null;
let mainTid = null;

const byName = new Map();
const byCat = new Map();
const byUrl = new Map();
const byFn = new Map();
/** @type {Map<string, { byName: Map<string, number>, byCat: Map<string, number>, byFn: Map<string, number>, byUrl: Map<string, number>, total: number, gcMs: number, gcCount: number }>} */
const perThread = new Map();
let eventCount = 0;
let droppedFrames = 0;
const longTasks = [];
const frameDurations = [];

let phase = 'seek'; // seek | bracket | events | done
let seekTail = '';
let depth = 0;
let buf = '';
let inString = false;
let escape = false;

function key(pid, tid) {
  return `${pid}:${tid}`;
}

function threadStats(pid, tid) {
  const k = key(pid, tid);
  let stats = perThread.get(k);
  if (!stats) {
    stats = { byName: new Map(), byCat: new Map(), byFn: new Map(), byUrl: new Map(), total: 0, gcMs: 0, gcCount: 0 };
    perThread.set(k, stats);
  }
  return stats;
}

function add(map, k, v) {
  map.set(k, (map.get(k) ?? 0) + v);
}

function resolveMainThread() {
  if (mainTid) return;
  for (const [k, name] of threadNames) {
    if (name.includes('RendererMain')) {
      const [pid, tid] = k.split(':').map(Number);
      mainPid = pid;
      mainTid = tid;
      break;
    }
  }
}

function processEvent(e) {
  eventCount += 1;
  const name = e.name ?? '';
  const cat = e.cat ?? '';
  const ph = e.ph;

  if (name === 'thread_name' && e.args?.name) {
    threadNames.set(key(e.pid, e.tid), e.args.name);
    if (!mainTid && e.args.name.includes('RendererMain')) {
      mainPid = e.pid;
      mainTid = e.tid;
    }
  }

  if (name === 'DroppedFrame') droppedFrames += 1;

  if (ph !== 'X' || !e.dur) return;

  resolveMainThread();
  const durMs = e.dur / 1000;
  const stats = threadStats(e.pid, e.tid);
  stats.total += durMs;
  add(stats.byName, name, durMs);
  add(stats.byCat, cat, durMs);

  const gcLike = cat.toLowerCase().includes('gc') || name.startsWith('V8.') || name.includes('GC');
  if (gcLike) {
    stats.gcMs += durMs;
    stats.gcCount += 1;
  }

  if (e.pid === mainPid && e.tid === mainTid) {
    if (durMs > 16) longTasks.push({ durMs, name, cat });
  }

  if (name === 'FunctionCall') {
    const fn = e.args?.data?.functionName ?? e.args?.functionName ?? '';
    const url = e.args?.data?.url ?? e.args?.url ?? '';
    if (fn) add(stats.byFn, fn, durMs);
    if (url) add(stats.byUrl, url, durMs);
  }

  if (name === 'BeginFrame' && e.pid === mainPid) {
    frameDurations.push(durMs);
  }
}

function tryFlushObject() {
  const trimmed = buf.trim();
  buf = '';
  if (!trimmed || trimmed === ',') return;
  try {
    processEvent(JSON.parse(trimmed));
  } catch {
    // ignore non-event fragments
  }
}

function feedChar(c) {
  if (phase === 'done') return;

  if (phase === 'seek') {
    seekTail = (seekTail + c).slice(-32);
    if (seekTail.includes('"traceEvents"')) {
      phase = 'bracket';
      seekTail = '';
    }
    return;
  }

  if (phase === 'bracket') {
    if (c === '[') phase = 'events';
    return;
  }

  if (phase === 'events') {
    if (depth === 0) {
      if (c === '{') {
        depth = 1;
        buf = '{';
        inString = false;
        escape = false;
      } else if (c === ']') {
        phase = 'done';
      }
      return;
    }

    buf += c;

    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      return;
    }

    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) tryFlushObject();
    }
  }
}

function report() {
  resolveMainThread();
  const mainKey = key(mainPid, mainTid);
  const main = perThread.get(mainKey) ?? {
    byName: new Map(), byCat: new Map(), byFn: new Map(), byUrl: new Map(), total: 0, gcMs: 0, gcCount: 0,
  };
  const mainTotalMs = main.total;
  const gcMs = main.gcMs;
  const gcCount = main.gcCount;
  const byName = main.byName;
  const byCat = main.byCat;
  const byFn = main.byFn;
  const byUrl = main.byUrl;
  const pct = (ms) => `${((ms / Math.max(mainTotalMs, 1)) * 100).toFixed(1)}%`;
  const top = (map, n = 30) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log('=== TRACE SUMMARY ===');
  console.log(`events parsed: ${eventCount}`);
  console.log(`main thread: pid=${mainPid} tid=${mainTid}`);
  console.log(`main X-event time: ${mainTotalMs.toFixed(1)} ms`);
  console.log(`GC on main: ${gcMs.toFixed(1)} ms (${pct(gcMs)}) count=${gcCount}`);
  console.log(`DroppedFrame: ${droppedFrames}`);

  if (frameDurations.length) {
    const sorted = [...frameDurations].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`BeginFrame: n=${sorted.length} mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${sorted.at(-1).toFixed(2)}ms`);
    const over16 = sorted.filter((v) => v > 16).length;
    console.log(`frames >16ms: ${over16} (${((over16 / sorted.length) * 100).toFixed(1)}%)`);
    const estFps = 1000 / mean;
    console.log(`est FPS from BeginFrame mean: ${estFps.toFixed(1)}`);
  }

  console.log('\n=== TOP MAIN THREAD EVENTS ===');
  for (const [name, ms] of top(byName, 35)) {
    console.log(`${ms.toFixed(1).padStart(9)}ms ${pct(ms).padStart(6)}  ${name}`);
  }

  console.log('\n=== TOP CATEGORIES ===');
  for (const [cat, ms] of top(byCat, 15)) {
    console.log(`${ms.toFixed(1).padStart(9)}ms ${pct(ms).padStart(6)}  ${cat}`);
  }

  console.log('\n=== TOP FUNCTION NAMES (FunctionCall) ===');
  for (const [fn, ms] of top(byFn, 30)) {
    console.log(`${ms.toFixed(1).padStart(9)}ms  ${fn}`);
  }

  console.log('\n=== TOP URLS (FunctionCall) ===');
  for (const [url, ms] of top(byUrl, 20)) {
    console.log(`${ms.toFixed(1).padStart(9)}ms  ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  }

  console.log('\n=== LONGEST TASKS (>16ms) ===');
  longTasks.sort((a, b) => b.durMs - a.durMs);
  for (const t of longTasks.slice(0, 25)) {
    console.log(`${t.durMs.toFixed(1).padStart(8)}ms  ${t.name}  [${t.cat}]`);
  }

  const needles = ['three', 'dreamfall', 'GameRuntime', 'Renderer', 'updateForRender', 'needsRefresh', 'node', 'BVH', 'MeshBVH', 'collider', 'LevelSystem', 'City', 'WebGPU', 'compile', 'traverse'];
  console.log('\n=== GAME-RELATED FUNCTION HITS ===');
  for (const [fn, ms] of top(byFn, 800)) {
    if (needles.some((n) => fn.includes(n))) {
      console.log(`${ms.toFixed(1).padStart(9)}ms  ${fn}`);
    }
  }
  console.log('\n=== GAME-RELATED URL HITS ===');
  for (const [url, ms] of top(byUrl, 300)) {
    if (needles.some((n) => url.includes(n))) {
      console.log(`${ms.toFixed(1).padStart(9)}ms  ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    }
  }
}

input.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  for (let i = 0; i < text.length; i += 1) {
    feedChar(text[i]);
  }
});

input.on('end', report);
input.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
