import { useState } from "react";

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

  const close = () => {
    if (busy) return;
    setPath("");
    setPassphrase("");
    setError(null);
    setConfirm(false);
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
    <div
      className={
        "fixed inset-0 z-40 flex items-center justify-center bg-black/40 " +
        (open ? "" : "hidden")
      }
    >
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold">Restore from envelope</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pick a <code>.pkb1</code> file and enter the recovery passphrase. The
          previous live DB is preserved as <code>db.sqlite.prev</code>.
        </p>

        <label className="mt-3 block text-sm">
          <span className="text-slate-600">Envelope path</span>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            placeholder="/abs/path/to/backup.pkb1"
          />
        </label>

        <label className="mt-3 block text-sm">
          <span className="text-slate-600">Recovery passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 p-2"
          />
        </label>

        {error && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
            {error}
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={runTest}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Test restore
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm(true)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Restore…
          </button>
        </div>
      </div>

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
    </div>
  );
}
