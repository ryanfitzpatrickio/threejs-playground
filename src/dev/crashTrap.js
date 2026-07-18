/**
 * Dev-only crash trap: captures errors that are otherwise hard to grab —
 * the tab dies, an async rejection vanishes, or the WebGPU device is lost
 * without a JS stack. Every record is written SYNCHRONOUSLY to localStorage
 * so it survives a tab crash/reload; on the next boot a console summary
 * points at the previous session's entries.
 *
 * Console access:
 *   __DREAMFALL_CRASHLOG__.list()   // all stored entries, oldest first
 *   __DREAMFALL_CRASHLOG__.clear()
 *
 * A 5s heartbeat records the JS heap size; after a hard crash (OOM /
 * GPU-process kill, where no JS runs) the last heartbeat still shows when
 * it died and whether the heap was ballooning.
 */

const STORAGE_KEY = 'dreamfall:crash-log';
const MAX_ENTRIES = 40;

function readLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Quota/serialization failures must never take the app down.
  }
}

export function installCrashTrap() {
  if (typeof window === 'undefined' || window.__DREAMFALL_CRASHLOG__) return;

  const sessionId = Math.random().toString(36).slice(2, 8);
  const record = (kind, detail) => {
    const entries = readLog();
    entries.push({
      kind,
      detail: String(detail ?? '').slice(0, 4000),
      session: sessionId,
      time: new Date().toISOString(),
      url: window.location.href,
    });
    writeLog(entries);
    if (kind !== 'heartbeat') {
      console.error(`[crashTrap] ${kind}:`, detail);
    }
  };

  window.addEventListener('error', (event) => {
    const stack = event.error?.stack ?? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`;
    record('window-error', stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    record('unhandled-rejection', reason?.stack ?? reason?.message ?? reason);
  });

  // The renderer owns the GPUDevice, so intercept creation to hear device
  // loss and uncaptured validation/OOM errors — these precede most "tab just
  // died" reports and never surface as window errors.
  if (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype.requestDevice) {
    const originalRequestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function requestDeviceTrapped(...args) {
      const device = await originalRequestDevice.apply(this, args);
      try {
        device.addEventListener('uncapturederror', (event) => {
          record('webgpu-uncaptured-error', event.error?.message ?? event.error);
        });
        device.lost.then((info) => {
          record('webgpu-device-lost', `${info.reason ?? 'unknown'}: ${info.message ?? ''}`);
        });
      } catch {
        // Never break device creation over instrumentation.
      }
      return device;
    };
  }

  // Heap heartbeat: overwrite one rolling entry per session instead of
  // appending, so the log holds errors, not noise.
  const heartbeat = () => {
    const memory = performance.memory;
    if (!memory) return;
    const entries = readLog();
    const detail = `heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)}MiB / limit ${(memory.jsHeapSizeLimit / 1048576).toFixed(0)}MiB`;
    const existing = entries.findLast?.((entry) => entry.kind === 'heartbeat' && entry.session === sessionId);
    if (existing) {
      existing.detail = detail;
      existing.time = new Date().toISOString();
    } else {
      entries.push({
        kind: 'heartbeat',
        detail,
        session: sessionId,
        time: new Date().toISOString(),
        url: window.location.href,
      });
    }
    writeLog(entries);
  };
  setInterval(heartbeat, 5000);

  const previous = readLog().filter((entry) => entry.session !== sessionId);
  const previousErrors = previous.filter((entry) => entry.kind !== 'heartbeat');
  if (previousErrors.length > 0) {
    console.warn(
      `[crashTrap] previous session(s) logged ${previousErrors.length} error(s) — `
      + 'inspect with __DREAMFALL_CRASHLOG__.list(), reset with .clear()',
      previousErrors.slice(-3),
    );
  }

  window.__DREAMFALL_CRASHLOG__ = {
    list: () => readLog(),
    clear: () => writeLog([]),
    record,
  };
}
