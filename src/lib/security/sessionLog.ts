/**
 * Session logger — captures all frontend console output and unhandled errors,
 * routes them to the Rust backend logger so everything ends up in session.log.
 *
 * Cleared on each app start (the backend deletes the old log in lib.rs::run).
 */
import { tauriInvoke } from "./tauri";

let initialized = false;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "log";

/** Safe stringify that handles circular refs and big data. */
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

/** Send a log line to the Rust backend. Fire-and-forget. */
function sendToBackend(level: LogLevel, message: string) {
  tauriInvoke("log_frontend", { level, message }).catch(() => {
    // Backend not ready yet — ignore silently.
  });
}

/**
 * Initialize the session log. Call once at app start.
 * Overrides console methods and installs global error handlers.
 */
export function initSessionLog() {
  if (initialized) return;
  initialized = true;

  const methods: LogLevel[] = ["log", "info", "warn", "error", "debug", "trace"];
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of methods) {
    const original = con[level];
    if (typeof original !== "function") continue;

    con[level] = (...args: unknown[]) => {
      // Always call original so browser devtools still work.
      original.apply(console, args);

      const message = args.map(safeStringify).join(" ");
      sendToBackend(level, `[FE:${level.toUpperCase()}] ${message}`);
    };
  }

  // ── Unhandled errors ──────────────────────────────────────────────
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
