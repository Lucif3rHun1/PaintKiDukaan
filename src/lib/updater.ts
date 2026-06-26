import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export type UpdateProgress =
  | { stage: "downloading"; downloadedBytes: number; totalBytes: number; percent: number }
  | { stage: "installing" }
  | { stage: "done" };

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (update) {
      return {
        version: update.version,
        releaseDate: update.date ?? new Date().toISOString(),
        releaseNotes: update.body,
      };
    }
    return null;
  } catch (err) {
    console.error("[updater] check failed:", err);
    return null;
  }
}

export async function downloadAndInstallUpdate(
  onProgress?: (p: UpdateProgress) => void,
): Promise<void> {
  const update = await check();
  if (!update) return;

  let total = 0;
  let downloaded = 0;

  onProgress?.({ stage: "downloading", downloadedBytes: downloaded, totalBytes: total, percent: 0 });

  await update.downloadAndInstall((event) => {
    if (event.event === "Started" && typeof event.data.contentLength === "number") {
      total = event.data.contentLength;
      onProgress?.({ stage: "downloading", downloadedBytes: downloaded, totalBytes: total, percent: 0 });
    } else if (event.event === "Progress" && typeof event.data.chunkLength === "number") {
      downloaded += event.data.chunkLength;
      onProgress?.({
        stage: "downloading",
        downloadedBytes: downloaded,
        totalBytes: total,
        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
      });
    } else if (event.event === "Finished") {
      onProgress?.({ stage: "installing" });
    }
  });

  onProgress?.({ stage: "done" });
  await relaunch();
}
