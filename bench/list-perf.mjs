#!/usr/bin/env node
/**
 * list-perf.mjs — frontend perf harness for the DataList primitive.
 *
 * Measures:
 *   - first row paint (<300ms target)
 *   - search response (<200ms target)
 *   - sort/filter (<200ms target)
 *   - scroll jank / FPS (60fps = 16ms/frame target)
 *
 * Requires the Tauri app to be running locally (`pnpm tauri:dev`).
 * This is a placeholder for the Playwright + CDP harness described in the plan.
 * Future PRs will wire it to a real browser instance via `playwright`.
 */

const STUB = {
  message: "list-perf harness not yet wired to a browser",
  targets: {
    first_row_paint_ms: 300,
    search_response_ms: 200,
    sort_filter_ms: 200,
    scroll_frame_ms: 16,
  },
};

console.log("[list-perf] skeleton harness");
console.log(JSON.stringify(STUB, null, 2));
process.exit(0);