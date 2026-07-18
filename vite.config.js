import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { WebSocketServer } from 'ws';
import { dreamfallStorePlugin } from './vite/dreamfall-store-plugin.mjs';
import { bodyshopPlugin } from './vite/bodyshopPlugin.mjs';
import { outfitPreparePlugin } from './vite/outfitPreparePlugin.mjs';
import { deployAssetsPlugin } from './vite/deployAssetsPlugin.mjs';
import { forestLeavesPlugin } from './vite/forest-leaves-plugin.mjs';
import { grokBridgePlugin } from './vite/grokBridge.mjs';
import { createThreeAliases } from './vite/sharedViteResolve.mjs';
import { shaderDebugPlugin } from './vite/shaderDebugPlugin.mjs';

const mainHtml = fileURLToPath(new URL('./index.html', import.meta.url));
const cityGiExampleHtml = fileURLToPath(new URL('./webgpu_generator_city.html', import.meta.url));
const devToolsModule = fileURLToPath(new URL('./src/dev/devTools.jsx', import.meta.url));
const bodyshopModule = fileURLToPath(new URL('./src/dev/BodyshopScene.jsx', import.meta.url));
const gunsmithModule = fileURLToPath(new URL('./src/dev/GunsmithScene.jsx', import.meta.url));
const devToolsPublicId = 'virtual:dreamfall-dev-tools';
const devToolsResolvedId = `\0${devToolsPublicId}`;

function devToolsPlugin(enabled) {
  return {
    name: 'dreamfall-dev-tools',
    resolveId(id) {
      return id === devToolsPublicId ? devToolsResolvedId : null;
    },
    load(id) {
      if (id !== devToolsResolvedId) return null;
      if (enabled) {
        // createDevTools + GunsmithScene both re-export from devTools.jsx so a single
        // module update picks up new editor surfaces without a stale virtual cache.
        return `
          export { createDevTools, GunsmithScene } from ${JSON.stringify(devToolsModule)};
          export { BodyshopScene } from ${JSON.stringify(bodyshopModule)};
        `;
      }
      return `
        export function createDevTools() {
          return {
            beforeSwitch() {},
            toggleMode() {},
            ModeButtons() { return null; },
            Views() { return null; },
          };
        }
        export function BodyshopScene() { return null; }
        export function GunsmithScene() { return null; }
      `;
    },
  };
}

function getCodexEnv() {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`];
  return { ...process.env, PATH: `${process.env.PATH}:${extraPaths.join(':')}` };
}

function checkCodexAvailability() {
  try {
    const version = execSync('codex --version', {
      encoding: 'utf8',
      timeout: 5000,
      env: getCodexEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { available: true, version };
  } catch {
    return { available: false, error: 'Codex CLI not found. Install it and run "codex login".' };
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function codexStatusMiddleware() {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      res.end('Method Not Allowed');
      return;
    }
    sendJson(res, 200, checkCodexAvailability());
  };
}

function registerCodexWebSocket(server) {
  if (!server.httpServer || server.httpServer.__dreamfallCodexBridgeRegistered) return;
  server.httpServer.__dreamfallCodexBridgeRegistered = true;

  const wss = new WebSocketServer({ noServer: true });
  server.httpServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws/codex') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    let session = null;

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendWs(ws, { type: 'error', message: 'Invalid Codex bridge message', fatal: false });
        return;
      }

      if (msg.type === 'start') {
        if (session) cleanupCodexSession(session);
        try {
          session = await startCodexSession(ws, msg);
        } catch (error) {
          sendWs(ws, { type: 'error', message: error?.message || 'Failed to start Codex', fatal: true });
        }
        return;
      }

      if (msg.type === 'tool_result' && session) {
        const rpcId = Number(msg.id);
        if (!session.pendingToolCalls.has(rpcId)) return;
        session.pendingToolCalls.delete(rpcId);
        sendCodex(session, {
          id: rpcId,
          result: {
            contentItems: [{ type: 'inputText', text: msg.result || '' }],
            success: msg.success !== false,
          },
        });
        return;
      }

      if (msg.type === 'abort' && session) {
        cleanupCodexSession(session);
        session = null;
      }
    });

    ws.on('close', () => {
      if (session) cleanupCodexSession(session);
      session = null;
    });
  });
}

async function startCodexSession(ws, config) {
  sendWs(ws, { type: 'status', status: 'connecting' });
  const proc = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: getCodexEnv(),
  });

  const session = {
    process: proc,
    readline: createInterface({ input: proc.stdout }),
    ws,
    requestId: 0,
    pendingRequests: new Map(),
    pendingToolCalls: new Map(),
    agentText: '',
    threadId: config.threadId,
  };

  session.readline.on('line', (line) => {
    try {
      handleCodexMessage(session, JSON.parse(line));
    } catch {
      // Ignore non-JSON app-server logs.
    }
  });

  proc.on('exit', (code) => {
    if (ws.readyState === ws.OPEN) {
      sendWs(ws, { type: 'error', message: `Codex process exited with code ${code}`, fatal: true });
    }
  });

  await sendCodexRequest(session, 'initialize', {
    clientInfo: { name: 'dreamfall-map-editor', title: 'Dreamfall Map Editor', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  sendCodex(session, { method: 'initialized', params: {} });

  const threadResult = await sendCodexRequest(session, session.threadId ? 'thread/resume' : 'thread/start', {
    ...(session.threadId ? { threadId: session.threadId } : {}),
    model: config.model || 'gpt-5.4',
    baseInstructions: config.systemPrompt || '',
    dynamicTools: Array.isArray(config.tools) ? config.tools : [],
    serviceName: 'dreamfall-map-editor',
  });

  session.threadId = threadResult?.thread?.id || session.threadId;
  if (session.threadId) sendWs(ws, { type: 'thread', threadId: session.threadId });

  sendWs(ws, { type: 'status', status: 'thinking' });
  sendCodex(session, {
    method: 'turn/start',
    id: ++session.requestId,
    params: {
      threadId: session.threadId,
      input: [{ type: 'text', text: config.userMessage || '' }],
    },
  });

  return session;
}

function handleCodexMessage(session, msg) {
  if (msg.id !== undefined && !msg.method) {
    const pending = session.pendingRequests.get(msg.id);
    if (!pending) return;
    session.pendingRequests.delete(msg.id);
    if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
    return;
  }

  if (msg.id !== undefined && msg.method === 'item/tool/call') {
    const params = msg.params || {};
    session.pendingToolCalls.set(msg.id, true);
    sendWs(session.ws, { type: 'tool_call', id: String(msg.id), name: params.tool, args: params.arguments || {} });
    sendWs(session.ws, { type: 'status', status: 'executing' });
    return;
  }

  if (
    msg.id !== undefined
    && (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval')
  ) {
    sendCodex(session, { id: msg.id, result: { decision: 'deny' } });
    return;
  }

  const params = msg.params || {};
  if (msg.method === 'item/agentMessage/delta') {
    const delta = params.delta || '';
    session.agentText += delta;
    if (delta) sendWs(session.ws, { type: 'delta', text: delta });
  } else if (msg.method === 'item/started' && params.item?.type === 'dynamicToolCall') {
    sendWs(session.ws, { type: 'status', status: 'executing' });
  } else if (msg.method === 'item/completed' && params.item?.type === 'dynamicToolCall') {
    sendWs(session.ws, { type: 'status', status: 'thinking' });
  } else if (msg.method === 'turn/completed') {
    sendWs(session.ws, { type: 'turn_complete', text: session.agentText });
    cleanupCodexSession(session);
  } else if (msg.method === 'turn/failed') {
    sendWs(session.ws, { type: 'error', message: params.turn?.error?.message || 'Codex turn failed', fatal: true });
    cleanupCodexSession(session);
  }
}

function sendCodex(session, msg) {
  if (session.process.stdin?.writable) session.process.stdin.write(`${JSON.stringify(msg)}\n`);
}

function sendCodexRequest(session, method, params) {
  const id = ++session.requestId;
  return new Promise((resolveRequest, rejectRequest) => {
    session.pendingRequests.set(id, { resolve: resolveRequest, reject: rejectRequest });
    sendCodex(session, { method, id, params });
    setTimeout(() => {
      if (!session.pendingRequests.has(id)) return;
      session.pendingRequests.delete(id);
      rejectRequest(new Error(`Codex request ${method} timed out`));
    }, 30000);
  });
}

function sendWs(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanupCodexSession(session) {
  session.readline.close();
  if (!session.process.killed) {
    session.process.kill('SIGTERM');
    setTimeout(() => {
      if (!session.process.killed) session.process.kill('SIGKILL');
    }, 5000);
  }
  session.pendingRequests.forEach(({ reject }) => reject(new Error('Codex session closed')));
  session.pendingRequests.clear();
  session.pendingToolCalls.clear();
}

function codexBridgePlugin() {
  return {
    name: 'dreamfall-codex-bridge',
    configureServer(server) {
      server.middlewares.use('/api/codex/status', codexStatusMiddleware());
      registerCodexWebSocket(server);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/codex/status', codexStatusMiddleware());
      registerCodexWebSocket(server);
    },
  };
}

export default defineConfig(({ command, isPreview }) => {
  const isDevServer = command === 'serve' && !isPreview;

  return {
    plugins: [
      solidPlugin(),
      devToolsPlugin(isDevServer),
      shaderDebugPlugin(isDevServer),
      dreamfallStorePlugin(),
      forestLeavesPlugin(),
      deployAssetsPlugin(),
      ...(isDevServer ? [codexBridgePlugin(), grokBridgePlugin(), bodyshopPlugin(), outfitPreparePlugin()] : []),
    ],
    resolve: {
      alias: createThreeAliases(),
      dedupe: ['three'],
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      // Outfit bake + bodyshop write large GLBs under public/ during long
      // requests. Watching them can bounce the client mid-fetch (Failed to fetch).
      watch: {
        ignored: [
          '**/public/assets/simoutfits/_import/**',
          '**/public/assets/models/_bodyshop-*.glb',
          '**/data/**',
          '**/.codex-tmp/**',
        ],
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
    },
    build: {
      rollupOptions: {
        input: {
          main: mainHtml,
          webgpuGeneratorCity: cityGiExampleHtml,
          forestProbe: fileURLToPath(new URL('./forest-probe.html', import.meta.url)),
        },
      },
    },
  };
});
