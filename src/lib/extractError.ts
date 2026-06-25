/**
 * Extract a readable error message from Tauri IPC errors.
 *
 * AppError objects arrive as `{code, message, user_message}` from Rust.
 * `message` is the raw underlying error (for traceback). `user_message`
 * is the human-friendly toast text — we prefer it when present.
 */
export function extractError(e: unknown): string {
  if (e && typeof e === "object") {
    const obj = e as { user_message?: unknown; message?: unknown };
    if (typeof obj.user_message === "string" && obj.user_message) return obj.user_message;
    if (typeof obj.message === "string") return obj.message;
  }
  if (typeof e === "string") return e;
  return String(e);
}
