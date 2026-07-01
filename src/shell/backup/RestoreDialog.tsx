import { useState } from "react";
import { CheckCircle, FolderOpen } from "lucide-react";

import { Button, InlineDialog } from "../../components/ui";
import { restore, testRestore } from "./api";
import { ipc } from "../lib/ipc";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { extractError } from "../../lib/extractError";

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
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const reset = () => {
    setPath("");
    setPassphrase("");
    setError(null);
    setSuccess(null);
    setConfirm(false);
  };

  const handleBrowse = async () => {
    try {
      const picked = await ipc.pickBackupFile();
      if (picked) setPath(picked);
    } catch {
      // noop
    }
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const runTest = async () => {
    if (!path || !passphrase) {
      setError("Pick a file and enter the password");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await testRestore(path, passphrase);
      if (!r.ok) {
        setError(`quick_check: ${r.db_quick_check} — ${r.message}`);
      } else {
        setSuccess("Test restore OK. Confirm to apply.");
      }
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await restore(path, passphrase);
      onDone();
      reset();
      onClose();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <InlineDialog
        open={open}
        onClose={close}
        title="Recover from backup file"
        description="Pick a backup file and enter the recovery password. The previous shop data is saved separately."
        size="md"
      >
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-foreground">Backup file path</span>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="input flex-1 font-mono text-xs"
                placeholder="/abs/path/to/backup.pkb1"
              />
              <Button
                type="button"
                variant="secondary"
                size="md"
                icon={FolderOpen}
                onClick={handleBrowse}
                disabled={busy}
              >
                Browse…
              </Button>
            </div>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-foreground">Recovery password</span>
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

          {success && (
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-2 text-sm">
              <CheckCircle className="h-4 w-4 shrink-0 text-success" />
              <span>{success}</span>
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
              Test recover
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              Recover…
            </Button>
          </div>
        </div>
      </InlineDialog>

      <ConfirmDialog
        open={confirm}
        title="Apply recovery?"
        body="The current shop data will be replaced. The previous data is saved separately."
        confirmLabel="Apply recovery"
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
