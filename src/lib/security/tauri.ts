/**
 * Safe Tauri invoke wrapper.
 * Checks for the Tauri IPC bridge before calling and provides a clear error.
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke: (cmd: string, args: unknown, options?: unknown) => Promise<T> }
    | undefined;

  if (!internals?.invoke) {
    throw new Error(
      "Tauri IPC bridge not available. Make sure you are running inside the Tauri desktop app (npm run tauri dev), not a browser.",
    );
  }

  return internals.invoke(cmd, args ?? {}, undefined);
}
