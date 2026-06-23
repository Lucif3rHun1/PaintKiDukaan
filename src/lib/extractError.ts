/**
 * Extract a readable error message from Tauri IPC errors (which arrive as {kind,message} objects).
 */
export function extractError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  if (typeof e === "string") return e;
  return String(e);
}
