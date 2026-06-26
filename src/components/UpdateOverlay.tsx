import { Loader2 } from "lucide-react";
import logo from "../assets/logo-64.png";
import type { UpdateProgress } from "../lib/updater";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

interface UpdateOverlayProps {
  readonly version: string;
  readonly progress: UpdateProgress | null;
}

export function UpdateOverlay({ version, progress }: UpdateOverlayProps) {
  const isDownloading = progress?.stage === "downloading";
  const isInstalling = progress?.stage === "installing";
  const isDone = progress?.stage === "done";
  const percent = isDownloading ? progress.percent : 0;
  const hasTotal = isDownloading && progress.totalBytes > 0;
  const bytesText = isDownloading
    ? hasTotal
      ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
      : progress.downloadedBytes > 0
        ? `${formatBytes(progress.downloadedBytes)} downloaded`
        : "Preparing download…"
    : "";
  const stageText = isInstalling ? "Installing update…" : isDone ? "Restarting…" : "Downloading update…";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/90 px-4 text-zinc-100 backdrop-blur-md">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-zinc-900 shadow-2xl shadow-black/40">
        <div className="border-b border-white/10 bg-white/[0.03] px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img
                src={logo}
                alt="PaintKiDukaan"
                className="h-11 w-11 rounded-2xl ring-1 ring-inset ring-white/15"
              />
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">PaintKiDukaan</p>
                <h1 className="text-lg font-semibold text-zinc-50">Auto-update</h1>
              </div>
            </div>
            <span className="rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-400/25">
              v{version}
            </span>
          </div>
        </div>

        <div className="space-y-6 px-6 py-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-400/25">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-semibold text-zinc-50">{stageText}</p>
              <p className="text-sm text-zinc-400">
                {isDownloading ? "Hold tight while the new build downloads." : "Finishing the update safely."}
              </p>
            </div>
          </div>

          {isDownloading ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Downloaded</p>
                  <p className="mt-1 text-sm text-zinc-300">{bytesText}</p>
                </div>
                {hasTotal && <p className="text-3xl font-bold tabular-nums text-zinc-50">{percent}%</p>}
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800" aria-label="Update download progress">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
                  style={{ width: `${hasTotal ? Math.min(percent, 100) : 0}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-300">
              {isDone ? "The app is relaunching with the new version." : "Applying the downloaded files now."}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            <span className={isDownloading ? "rounded-full bg-indigo-500/10 py-2 text-indigo-300" : "rounded-full bg-zinc-800/70 py-2"}>
              Download
            </span>
            <span className={isInstalling ? "rounded-full bg-indigo-500/10 py-2 text-indigo-300" : "rounded-full bg-zinc-800/70 py-2"}>
              Install
            </span>
            <span className={isDone ? "rounded-full bg-indigo-500/10 py-2 text-indigo-300" : "rounded-full bg-zinc-800/70 py-2"}>
              Restart
            </span>
          </div>
        </div>

        <p className="border-t border-white/10 px-6 py-4 text-center text-xs text-zinc-500">
          The app will restart automatically.
        </p>
      </div>
    </div>
  );
}
