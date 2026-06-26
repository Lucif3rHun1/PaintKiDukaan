import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export type UpdateProgress =
  | { stage: "downloading"; totalBytes?: number; chunkBytes?: number }
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

  onProgress?.({ stage: "downloading" });

  await update.downloadAndInstall((event) => {
    if (event.event === "Started" && typeof event.data.contentLength === "number") {
      onProgress?.({ stage: "downloading", totalBytes: event.data.contentLength });
    } else if (event.event === "Progress" && typeof event.data.chunkLength === "number") {
      onProgress?.({ stage: "downloading", chunkBytes: event.data.chunkLength });
    } else if (event.event === "Finished") {
      onProgress?.({ stage: "installing" });
    }
  });

  onProgress?.({ stage: "done" });
  await relaunch();
}
