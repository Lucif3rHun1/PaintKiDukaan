import { type ReactNode, useCallback } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { AlertOctagon, RotateCcw, Power } from "lucide-react";
import { tauriInvoke, generateCorrelationId } from "../../lib/security/tauri";

interface AppErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

function AppErrorFallback({ error, resetErrorBoundary }: AppErrorFallbackProps) {
  return (
    <main
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100"
    >
      <div className="surface-translucent w-full max-w-md rounded-2xl border border-white/10 p-8 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/15">
            <AlertOctagon className="h-5 w-5 text-destructive" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="text-lg font-semibold tracking-tight">
              PaintKiDukaan hit an unexpected error
            </h1>
            <p className="text-sm text-zinc-400">
              The window stopped responding. You can try to recover or restart
              the app.
            </p>
            <pre className="max-h-40 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs text-destructive">
              {error.message}
            </pre>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white outline-none transition-colors hover:bg-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <RotateCcw className="h-4 w-4" />
            Try to recover
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-medium text-zinc-100 outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <Power className="h-4 w-4" />
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}

interface AppErrorBoundaryProps {
  children: ReactNode;
}

export function AppErrorBoundary({ children }: AppErrorBoundaryProps) {
  const handleError = useCallback(
    (error: unknown, info: { componentStack?: string | null }) => {
      const cid = generateCorrelationId();
      const errMsg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      const compStack = info.componentStack ?? "";
      const msg = `[RENDER:ERROR] context=app-root cid=${cid} ${errMsg}\n${stack}\ncomponentStack:${compStack}`;
      tauriInvoke("log_frontend", {
        level: "error",
        message: msg,
        correlation_id: cid,
      }).catch(() => {
        // eslint-disable-next-line no-console
        (console as unknown as { error: (...a: unknown[]) => void }).error(
          "[AppErrorBoundary] failed to forward render error",
        );
      });
    },
    [],
  );

  return (
    <ReactErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <AppErrorFallback error={error as Error} resetErrorBoundary={resetErrorBoundary} />
      )}
      onError={handleError}
    >
      {children}
    </ReactErrorBoundary>
  );
}
