/**
 * Safe Tauri invoke wrapper with correlation ID generation.
 *
 * Every invoke call generates a unique correlation ID that is:
 * 1. Attached to the args as `_cid` for backend tracing (ignored by commands).
 * 2. Included in any error forwarding to `log_frontend`.
 *
 * Design choice: correlation IDs are injected as a reserved `_cid` key in the
 * invoke args. Tauri commands ignore unknown keys (serde `deny_unknown_fields`
 * is NOT enabled on any command), so this is a non-breaking additive change.
 */

import { listen as tauriListen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { useSecurity } from "./state";

let cidCounter = 0;

function generateCorrelationId(): string {
  cidCounter = (cidCounter + 1) & 0xffff;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}-${cidCounter.toString(16).padStart(4, "0")}`;
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke: (cmd: string, args: unknown, options?: unknown) => Promise<T> }
    | undefined;

  if (!internals?.invoke) {
    throw new Error(
      "Tauri IPC bridge not available. Make sure you are running inside the Tauri desktop app (npm run tauri dev), not a browser.",
    );
  }

  const cid = generateCorrelationId();
  const argsWithCid = { ...(args ?? {}), _cid: cid };

  try {
    return await internals.invoke(cmd, argsWithCid, undefined);
  } catch (e) {
    // Forward the error to the backend log with correlation ID.
    // JSON.stringify with Object.getOwnPropertyNames preserves serialisable
    // fields on Tauri rejection objects (e.g. {code,message}) instead of
    // emitting the unhelpful '[object Object]' string.
    const detail = e instanceof Error
      ? `${e.message}\n${e.stack ?? ""}`
      : JSON.stringify(e, e != null ? Object.getOwnPropertyNames(e) : []);
    const msg = `[IPC:ERR] cmd=${cmd} cid=${cid} ${detail}`;
    internals.invoke("log_frontend", {
      level: "error",
      message: msg,
      correlation_id: cid,
    }).catch((logErr: unknown) => {
      // Log forwarding should not throw, but we log the failure to the
      // browser console so it is not silently swallowed during debugging.
      // eslint-disable-next-line no-console
      console.error("[tauri.ts] failed to forward IPC error", logErr);
    });
    throw e;
  }
}

export { generateCorrelationId };

/**
 * Subscribe to the backend tray "lock now" event. When the tray icon's
 * "Lock now" is activated (or the workstation is locked on Windows), the
 * frontend transitions to the locked security phase using the same store
 * action as the in-app lock button.
 */
export function listenTrayLock(): Promise<UnlistenFn> {
  return tauriListen("tray:lock", () => {
    useSecurity.getState().setPhase("locked");
  });
}

/**
 * Typed wrapper around the Tauri event listener. The payload type is inferred
 * from the event name at the call site so plugin events (DownloadProgress,
 * UpdateAvailable, etc.) are consumed with the correct shape.
 */
export function listen<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return tauriListen(eventName, (event: Event<T>) => handler(event.payload));
}

if (typeof window !== "undefined") {
  listenTrayLock().catch(() => {});
}
