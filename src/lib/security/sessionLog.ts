/**
 * Session logger — captures all frontend console output and unhandled errors,
 * routes them to the Rust backend logger so everything ends up in session.log.
 *
 * Cleared on each app start (the backend deletes the old log in lib.rs::run).
 *
 * All forwarded messages now include a correlation ID for cross-boundary tracing.
 *
 * Safety rails (added after a hang-on-open incident):
 * - `initSessionLog()` MUST be called at module top-level (e.g. main.tsx),
 *   not inside a render body. Calling it during render interacts badly with
 *   React 19 StrictMode double-render and any error-path that also calls
 *   console.* (re-entrant IPC forwarding).
 * - The console.* override tracks its own in-flight IPC count and short-
 *   circuits when too many forwards are pending, so a render storm or
 *   recursive console.error → log_frontend → console.error cannot pin the
 *   main thread or exhaust IPC channels.
 * - Errors raised while forwarding a log are swallowed to the *raw* console
 *   and NEVER re-routed, breaking the loop.
 */
import { tauriInvoke, generateCorrelationId } from "./tauri";

let initialized = false;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "log";

// Max concurrent log_frontend IPCs. Anything beyond this is dropped silently
// — we'd rather lose a log than deadlock the main thread.
const MAX_IN_FLIGHT_LOGS = 16;
let inFlightLogs = 0;

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}

function sendToBackend(level: LogLevel, message: string) {
  // Backpressure: if too many logs are in flight, drop. This is the primary
  // defense against an IPC storm during a render or error loop.
  if (inFlightLogs >= MAX_IN_FLIGHT_LOGS) return;
  inFlightLogs++;
  // `console.log` is not a valid backend log level; map it to `info`.
  const backendLevel = level === "log" ? "info" : level;
  tauriInvoke("log_frontend", { level: backendLevel, message, correlation_id: generateCorrelationId() })
    .catch(() => {
      // Deliberately use the raw console here: the wrapped `console.error`
      // would re-enter this function and may itself be the source of the
      // error loop. The raw call is captured by the override but only at
      // the bottom of the recursion (single hop).
      // eslint-disable-next-line no-console
      (rawConsole.error as (...a: unknown[]) => void)(`[sessionLog] forward failed: ${backendLevel}`);
    })
    .finally(() => {
      inFlightLogs = Math.max(0, inFlightLogs - 1);
    });
}

// Keep handles to the raw console methods so the override can fall back
// without recursion, and so the error path can log without re-entering.
const rawConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
} as const;

export function initSessionLog() {
  if (initialized) return;
  initialized = true;

  const methods: LogLevel[] = ["log", "info", "warn", "error", "debug", "trace"];
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of methods) {
    const original = con[level];
    if (typeof original !== "function") continue;

    con[level] = (...args: unknown[]) => {
      // Always write to the *raw* console first — this preserves crash-time
      // visibility in DevTools even if the IPC forward is overloaded.
      (rawConsole[level as keyof typeof rawConsole] as (...a: unknown[]) => void)(...args);

      const message = args.map(safeStringify).join(" ");
      sendToBackend(level, `[FE:${level.toUpperCase()}] ${message}`);
    };
  }

  window.addEventListener("error", (event) => {
    const msg = `[FE:UNCAUGHT] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`;
    sendToBackend("error", msg);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason);
    sendToBackend("error", `[FE:UNHANDLED_PROMISE] ${reason}`);
  });

  sendToBackend("info", `[FE:SESSION] Frontend session log initialized at ${new Date().toISOString()}`);
}
