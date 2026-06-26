import { Loader2 } from "lucide-react";
import logo from "../assets/logo-64.png";
import type { UpdateProgress } from "../lib/updater";

interface UpdateOverlayProps {
  readonly version: string;
  readonly progress: UpdateProgress | null;
}

export function UpdateOverlay({ version, progress }: UpdateOverlayProps) {
  const stageText =
    progress?.stage === "installing"
      ? "Installing update…"
      : progress?.stage === "done"
        ? "Restarting…"
        : `Downloading v${version}…`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-zinc-900 p-8 shadow-2xl">
        <img
          src={logo}
          alt="PaintKiDukaan"
          className="h-10 w-10 rounded-lg ring-1 ring-inset ring-border/40"
        />
        <div className="flex items-center gap-2 text-zinc-100">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-400" aria-hidden="true" />
          <span className="text-sm font-medium">{stageText}</span>
        </div>
        {progress?.stage === "downloading" && progress.totalBytes != null && (
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300"
              style={{ width: "60%" }}
            />
          </div>
        )}
        <p className="text-xs text-zinc-500">The app will restart automatically.</p>
      </div>
    </div>
  );
}
