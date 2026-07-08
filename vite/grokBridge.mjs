import { spawn, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function getGrokEnv() {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`];
  return { ...process.env, PATH: `${process.env.PATH}:${extraPaths.join(':')}` };
}

export function checkGrokAvailability() {
  try {
    const version = execSync('grok --version', {
      encoding: 'utf8',
      timeout: 5000,
      env: getGrokEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { available: true, version };
  } catch {
    return { available: false, error: 'Grok CLI not found. Make sure "grok" is on PATH (e.g. ~/.local/bin) and authenticated.' };
  }
}

export function stripJsonFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*\n?/gi, '')
    .replace(/\n?\s*```\s*$/gi, '')
    .trim();
}

export function parseGrokStructuredPayload(candidates = []) {
  const isWorldMapLike = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    // Bare map object produced directly by the model
    if (Array.isArray(obj.roads) || Array.isArray(obj.zones) || obj.bounds) return true;
    return false;
  };

  const tryParseObject = (text) => {
    const cleaned = stripJsonFences(text);
    if (!cleaned) return null;

    try {
      const direct = JSON.parse(cleaned);
      if (direct && typeof direct === 'object') {
        if (direct.map || direct.project || direct.data || direct.summary || isWorldMapLike(direct)) {
          return direct;
        }
      }
    } catch {}

    const matches = [...cleaned.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0]);
    for (const fragment of matches.sort((a, b) => b.length - a.length)) {
      try {
        const parsed = JSON.parse(fragment);
        if (parsed && typeof parsed === 'object' &&
            (parsed.map || parsed.project || parsed.data || parsed.summary || isWorldMapLike(parsed))) {
          return parsed;
        }
      } catch {}
    }

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const sliced = JSON.parse(cleaned.slice(start, end + 1));
        if (sliced && typeof sliced === 'object') return sliced;
      } catch {}
    }

    return null;
  };

  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export async function runGrokGenerate({ prompt, summary, mode = 'blueprint' }) {
  const env = getGrokEnv();

  const isWorldMap = mode === 'worldmap' || mode === 'map';

  // For worldmap we send a compact summary so the prompt stays smaller and the model
  // is less likely to get lost and emit non-JSON or partial maps.
  let currentSummary;
  if (isWorldMap && summary) {
    const s = summary;
    const compact = {
      bounds: s.bounds,
      spawn: s.spawn,
      stats: s.stats,
      poiAnchors: s.poiAnchors,
      zones: (s.zones || []).map(z => ({ id: z.id, type: z.type, props: z.props })),
      roads: (s.roads || []).map(r => ({
        id: r.id, width: r.width, trackStyle: r.trackStyle, surface: r.surface,
        pointsCount: r.pointsCount, pointsSample: r.pointsSample
      })),
      districts: (s.districts || []).map(d => ({ id: d.id, name: d.name })),
      availableBlueprints: s.availableBlueprints,
    };
    currentSummary = JSON.stringify(compact);
  } else {
    currentSummary = summary ? JSON.stringify(summary, null, 2) : 'empty scene';
  }

  let instruction;
  if (isWorldMap) {
    const b = summary?.bounds || { minX: -512, minZ: -512, maxX: 512, maxZ: 512 };
    const existingPois = (summary?.poiAnchors && summary.poiAnchors.length)
      ? summary.poiAnchors.join('; ')
      : (summary?.pois || []).map((p) => `${p.kind} "${p.name || p.id}" at x=${p.x},z=${p.z}`).join('; ') || 'none yet';

    const userReq = prompt || 'Create a complete filled world map.';
    const p = userReq.toLowerCase();
    const isRally = /\brally\b/.test(p) || /\bdirt stage\b/.test(p) || /pine ridge/.test(p);
    const isRace = /\brace\b/.test(p) || /race ?course|race ?track|circuit|grand prix|event center/.test(p);

    let courseGuidance = '';
    if (isRally) {
      courseGuidance = `
**RALLY GUIDANCE (detected "rally" in request):**
Use trackStyle "rallySpectator" (crowds+rope) or "rallyStage" on main roads. Set surface:"mud" for ruts. Use many "wilds"+"forest" zones (alpine/hills biomes) + terrain for nature. Make a flowing closed loop. Add start/finish POIs. Fast/remote feel.
`;
    } else if (isRace) {
      courseGuidance = `
**RACE / EVENT GUIDANCE (detected race/circuit in request):**
Use trackStyle "urbanCircuit" for the main loop (barriers+grandstands). "roadsideBuildings" for backdrops. Wrap in "city" zones for building skyline. asphalt surface. Use districts for paddock / grandstand areas. Technical urban event layout.
`;
    } else {
      courseGuidance = `
**Tip:** For rally/race courses give roads a trackStyle (rally* or urbanCircuit) + matching surface.
`;
    }

    instruction = `OUTPUT ONLY A SINGLE VALID JSON OBJECT. NOTHING ELSE. NO EXPLANATION. NO MARKDOWN. NO OTHER TEXT BEFORE OR AFTER. THE RESPONSE MUST START WITH { AND END WITH }.

You are generating a Dreamfall world map. Use the current bounds EXACTLY. FILL the map with dense, playable content.

**CRITICAL: Existing Points of Interest (POIs)**
Existing POIs: ${existingPois}

Rules:
- COPY the exact existing POIs into "map.pois".
- Roads/rivers must connect to POIs. Place content near them.

${courseGuidance}

World map schema (exact top level required):
{
  "summary": "short description + how POIs were used",
  "map": {
    "version":1, "name":"...", "chunkSize":32,
    "bounds": ${JSON.stringify(b)},
    "spawn":{"x":0,"z":0,"yaw":0},
    "zones":[ {"id":"z1","type":"terrain|city|wilds|loopout|forest","shape":"rect","rect":{...},"props":{}} , ... ],
    "districts":[...],
    "roads":[ {"id":"r1","points":[...],"width":6.5,"trackStyle":"rallySpectator|rallyStage|urbanCircuit|...","surface":"mud|dirt|asphalt"} , ...],
    "rivers":[...], "pois":[...],
    "entities":[...]
  }
}

Current map summary (for context only — do not echo it):
${currentSummary}

User request: ${userReq}

REMEMBER: YOUR ENTIRE RESPONSE MUST BE EXACTLY ONE JSON OBJECT:
{
  "summary": "...",
  "map": { the complete world map matching the schema above }
}
START WITH {  END WITH }  NOTHING ELSE.
`;
  } else {
    instruction = `OUTPUT ONLY A SINGLE VALID JSON OBJECT. NOTHING ELSE. NO EXPLANATION. NO MARKDOWN. START WITH { AND END WITH }.

You are generating a Dreamfall Map Builder project (chunk terrain + atlas-textured primitives).

Required exact top level: {"summary": "<short description>", "project": <full mapbuilder project> }

Map builder project schema (preserve version/chunkSize/resolution/seed from summary when present):
{
  "version": 1, "chunkSize": 32, "resolution": 33, "seed": 1,
  "amplitude": 12, "octaves": 4, "createdAt": <ms timestamp>,
  "activeTileIndex": 0,
  "chunks": [ {"cx":0,"cz":0,"heights":[...]} ],
  "objects": [
    {"type":"box or plane or cylinder or player_spawn","name":"...","tileIndex":0,
     "position":[x,y,z],"rotationDegrees":[0,0,0],"scale":[x,y,z],
     "textureRepeat":[1,1],"zIndex":0}
  ],
  "roads": [ {"id":"r1","points":[{"x":...,"z":...},...],"width":8} ],
  "rivers": [ {"id":"v1","points":[{"x":...,"z":...},...],"width":6,"depth":3} ],
  "terrainTexture": {"id":null,"blend":0.6,"tiling":0.08}
}

Coordinate system: X east/west, Y height, Z north/south. Prefer atlas-textured primitives for platforms, walls, props.
Use current summary as context; merge or extend existing objects/terrain when reasonable.

Current scene summary:
${currentSummary}

User request: ${prompt || 'small test area with a few objects.'}

JSON ONLY:
`;
  }

  const headlessCwd = os.tmpdir();
  const promptFile = join(headlessCwd, `dreamfall-grok-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, instruction, 'utf8');

  const args = [
    '--prompt-file', promptFile,
    '--output-format', 'json',
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--no-memory',
    '--no-plan',
    '--no-subagents',
    '--disable-web-search',
    '--no-leader',
    '--tools', '',
    '--verbatim',
    '--cwd', headlessCwd,
    '--rules', 'Headless JSON generation only. Do not use tools or explore the repo. Put the complete JSON object in your response text.',
    '--max-turns', '2',
  ];

  const cleanupPromptFile = () => {
    try { unlinkSync(promptFile); } catch {}
  };

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('grok', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: headlessCwd,
    });
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const hardTimeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 2000);
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(hardTimeout);
      cleanupPromptFile();
      let cliEnvelope = null;
      const trimmed = stdout.trim();
      try { cliEnvelope = JSON.parse(trimmed); } catch {}

      const candidates = [];
      if (cliEnvelope) {
        if (typeof cliEnvelope.structuredOutput === 'object' && cliEnvelope.structuredOutput) {
          candidates.push(JSON.stringify(cliEnvelope.structuredOutput));
        }
        if (typeof cliEnvelope.text === 'string') candidates.push(cliEnvelope.text);
        if (typeof cliEnvelope.thought === 'string') candidates.push(cliEnvelope.thought);
      }
      candidates.push(trimmed);

      const result = parseGrokStructuredPayload(candidates);
      const bestText = stripJsonFences(cliEnvelope?.text || cliEnvelope?.thought || trimmed);

      let data = null;
      let topSummary = null;
      let isBareMap = false;

      if (result && typeof result === 'object') {
        if (result.map && typeof result.map === 'object') {
          data = result.map;
          topSummary = result.summary;
        } else if (result.project && typeof result.project === 'object') {
          data = result.project;
          topSummary = result.summary;
        } else if (result.data && typeof result.data === 'object') {
          data = result.data;
          topSummary = result.summary;
        } else if (Array.isArray(result.roads) || Array.isArray(result.zones) || result.bounds) {
          // The model emitted a bare world map object (common when prompts are long)
          data = result;
          topSummary = result.summary;
          isBareMap = true;
        }
      }

      if (result && typeof result === 'object' && data && typeof data === 'object') {
        const isMap = isBareMap || !!result.map;
        resolve({
          success: true,
          summary: String(topSummary || result.summary || (isMap ? 'World map generated by Grok.' : 'Content generated by Grok.')),
          project: (!isMap && result.project) ? result.project : (isMap ? null : data),
          map: isMap ? data : (result.map || (result.project && !result.map ? null : null)),
          raw: cliEnvelope || bestText,
        });
        return;
      }

      const partial = (cliEnvelope && (cliEnvelope.text || cliEnvelope.thought)) || bestText;
      const baseErr = `Failed to obtain JSON from Grok (exit ${code}). ${stderr ? 'stderr: ' + stderr.slice(0, 280) : ''}`.trim();
      let hint = '';
      if ((stderr || '').includes('max turns') || baseErr.includes('max turns')) {
        hint = ' Try a shorter/simpler prompt, or switch to Codex for incremental edits.';
      } else if (isWorldMap) {
        hint = ' The model did not return a clean {"summary": "...", "map": {...}} object. Try a more specific request or use Codex (live tools) for edits.';
      }

      // Last-chance recovery: if the text contains something that looks like a usable map, return it
      // so the user doesn't lose the work.
      let recoveredMap = null;
      const candidateText = partial || trimmed;
      if (isWorldMap && candidateText) {
        const m = candidateText.match(/\{[\s\S]*\}/g);
        if (m) {
          for (const frag of m.sort((a,b) => b.length - a.length)) {
            try {
              const obj = JSON.parse(frag);
              if (obj && (Array.isArray(obj.roads) || Array.isArray(obj.zones) || obj.bounds)) {
                recoveredMap = obj;
                break;
              }
              if (obj && obj.map && (Array.isArray(obj.map.roads) || Array.isArray(obj.map.zones))) {
                recoveredMap = obj.map;
                break;
              }
            } catch {}
          }
        }
      }
      if (recoveredMap) {
        resolve({
          success: true,
          summary: 'Recovered partial map from Grok output (may be incomplete).',
          map: recoveredMap,
          raw: cliEnvelope || bestText,
        });
        return;
      }

      resolve({
        success: false,
        error: baseErr + hint,
        raw: cliEnvelope || bestText,
        partial: partial || trimmed.slice(0, 800),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(hardTimeout);
      cleanupPromptFile();
      resolve({ success: false, error: `Grok spawn error: ${err?.message || err}` });
    });
  });
}

function grokStatusMiddleware() {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      res.end('Method Not Allowed');
      return;
    }
    sendJson(res, 200, checkGrokAvailability());
  };
}

function grokGenerateMiddleware() {
  return (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'POST');
      res.end('Method Not Allowed');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let input = {};
      try { input = body ? JSON.parse(body) : {}; } catch { input = {}; }
      const result = await runGrokGenerate({
        prompt: String(input.prompt || ''),
        summary: input.summary || null,
        mode: input.mode || 'blueprint',
      });
      sendJson(res, 200, result);
    });
  };
}

export function grokBridgePlugin() {
  return {
    name: 'dreamfall-grok-bridge',
    configureServer(server) {
      server.middlewares.use('/api/grok/status', grokStatusMiddleware());
      server.middlewares.use('/api/grok/generate', grokGenerateMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/grok/status', grokStatusMiddleware());
      server.middlewares.use('/api/grok/generate', grokGenerateMiddleware());
    },
  };
}
