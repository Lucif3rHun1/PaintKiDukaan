import { useState } from "react";

import { Button, InlineDialog } from "../../components/ui";
import { restore, testRestore } from "./api";
import { ConfirmDialog } from "../components/ConfirmDialog";

export interface RestoreDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function RestoreDialog({ open, onClose, onDone }: RestoreDialogProps) {
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const reset = () => {
    setPath("");
    setPassphrase("");
    setError(null);
    setConfirm(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const runTest = async () => {
    if (!path || !passphrase) {
      setError("Pick a file and enter the passphrase");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await testRestore(path, passphrase);
      if (!r.ok) {
        setError(`quick_check: ${r.db_quick_check} — ${r.message}`);
      } else {
        setError("Test restore OK. Confirm to apply the restore.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async () => {
    setBusy(true);
    setError(null);
    try {
      await restore(path, passphrase);
      onDone();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <InlineDialog
        open={open}
        onClose={close}
        title="Restore from envelope"
        description="Pick a .pkb1 file and enter the recovery passphrase. The previous live DB is preserved as db.sqlite.prev."
        size="md"
      >
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-foreground">Envelope path</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="input font-mono text-xs"
              placeholder="/abs/path/to/backup.pkb1"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-foreground">Recovery passphrase</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="input"
            />
          </label>

          {error && (
            <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-sm text-warning-foreground">
              {error}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={runTest}
            >
              Test restore
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              Restore…
            </Button>
          </div>
        </div>
      </InlineDialog>

      <ConfirmDialog
        open={confirm}
        title="Apply restore?"
        body="The live database will be replaced. The previous live DB is kept as db.sqlite.prev."
        confirmLabel="Apply restore"
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void runRestore();
        }}
      />
    </>
  );
}
