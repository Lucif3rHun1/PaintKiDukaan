import { type ReactNode, useCallback } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";
import { tauriInvoke } from "../../lib/security/tauri";
import { Card } from "./Card";
import { Button } from "./Button";
import { cn } from "./cn";

interface ErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
  context?: string;
}

function ErrorFallback({ error, resetErrorBoundary, context }: ErrorFallbackProps) {
  return (
    <div role="alert" aria-live="assertive" className="mx-auto max-w-2xl p-4">
      <Card className={cn("p-6")}>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h3 className="font-semibold text-foreground">
                {context ? `${context} crashed` : "Something went wrong"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                The app hit an unexpected error. You can try again or reload the
                page if the problem persists.
              </p>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p className="break-words font-mono text-xs text-destructive">
                {error.message}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="primary"
                size="sm"
                icon={RotateCcw}
                onClick={resetErrorBoundary}
              >
                Try again
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => window.location.reload()}
              >
                Reload app
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={Home}
                onClick={() => {
                  window.location.hash = "dashboard";
                  resetErrorBoundary();
                }}
              >
                Go home
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  context?: string;
  fallback?: ReactNode;
  onReset?: () => void;
}

/**
 * Isolated error boundary. Catches render errors in `children` so a crash in
 * one slice does not tear down the whole app shell.
 */
export function ErrorBoundary({
  children,
  context,
  fallback,
  onReset,
}: ErrorBoundaryProps) {
  const handleError = useCallback(
    (error: unknown, info: { componentStack?: string | null }) => {
      const ctx = context ?? "unknown";
      const errMsg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      const compStack = info.componentStack ?? "";
      const msg = `[RENDER:ERROR] context=${ctx} ${errMsg}\n${stack}\ncomponentStack:${compStack}`;
      tauriInvoke("log_frontend", {
        level: "error",
        message: msg,
        correlation_id: null,
      }).catch(() => {}); // Intentional: log forwarding should not throw.
    },
    [context],
  );

  return (
    <ReactErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) =>
        fallback ?? (
          <ErrorFallback
            error={error as Error}
            resetErrorBoundary={resetErrorBoundary}
            context={context}
          />
        )
      }
      onError={handleError}
      onReset={onReset}
    >
      {children}
    </ReactErrorBoundary>
  );
}
