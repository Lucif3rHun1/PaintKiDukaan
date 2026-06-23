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

import { extractError } from "../extractError";

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
    // Tauri rejects with a plain {code,message} object for Rust AppErrors,
    // so extractError pulls the human-readable message instead of [object Object].
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : extractError(e);
    internals.invoke("log_frontend", {
      level: "error",
      message: `[IPC:ERR] cmd=${cmd} cid=${cid} ${msg}`,
      correlation_id: cid,
    }).catch(() => {}); // Intentional: log forwarding should not throw.
    throw e;
  }
}

export { generateCorrelationId };
