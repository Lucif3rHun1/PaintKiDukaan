/**
 * Session logger — captures all frontend console output and unhandled errors,
 * routes them to the Rust backend logger so everything ends up in session.log.
 *
 * Cleared on each app start (the backend deletes the old log in lib.rs::run).
 *
 * All forwarded messages now include a correlation ID for cross-boundary tracing.
 */
import { tauriInvoke, generateCorrelationId } from "./tauri";

let initialized = false;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "log";

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
  const cid = generateCorrelationId();
  // `console.log` is not a valid backend log level; map it to `info`.
  const backendLevel = level === "log" ? "info" : level;
  tauriInvoke("log_frontend", { level: backendLevel, message, correlation_id: cid }).catch(
    (logErr: unknown) => {
      // Backend may not be ready yet; log the failure locally so it is not
      // silently swallowed during startup debugging.
      // eslint-disable-next-line no-console
      console.error("[sessionLog.ts] failed to forward log", backendLevel, message, logErr);
    },
  );
}

export function initSessionLog() {
  if (initialized) return;
  initialized = true;

  const methods: LogLevel[] = ["log", "info", "warn", "error", "debug", "trace"];
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of methods) {
    const original = con[level];
    if (typeof original !== "function") continue;

    con[level] = (...args: unknown[]) => {
      original.apply(console, args);

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
