import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { toast } from "@/lib/feedback/toast";

interface KeystoreErrorViewProps {
  reason: string | null;
  onTryUnlock: () => void;
  onWipeAndReset: () => Promise<void>;
}

export function KeystoreErrorView({
  reason,
  onTryUnlock,
  onWipeAndReset,
}: KeystoreErrorViewProps) {
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wipeLoading, setWipeLoading] = useState(false);

  async function handleWipe() {
    setWipeLoading(true);
    try {
      await onWipeAndReset();
      setWipeConfirm(false);
    } catch (e) {
      toast.error("Wipe failed: " + String(e));
    } finally {
      setWipeLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-8 shadow-overlay">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-destructive/20">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-destructive">Keystore error</p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">Security Store Unavailable</h2>
          </div>
        </div>
        <Alert variant="destructive" title="Action required">
          {reason}
        </Alert>
        <div className="space-y-2 pt-1">
          <Button className="w-full" variant="secondary" onClick={onTryUnlock}>
            Try PIN Unlock
          </Button>
          {!wipeConfirm ? (
            <Button className="w-full" variant="danger" onClick={() => setWipeConfirm(true)}>
              Erase &amp; Start Fresh
            </Button>
          ) : (
            <div className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-xs leading-5 text-destructive">
                This will permanently erase all data. Click again to confirm.
              </p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  variant="secondary"
                  onClick={() => setWipeConfirm(false)}
                  disabled={wipeLoading}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  variant="danger"
                  loading={wipeLoading}
                  onClick={handleWipe}
                >
                  Confirm Erase
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
