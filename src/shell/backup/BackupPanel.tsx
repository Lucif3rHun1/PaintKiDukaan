import { useEffect, useState } from "react";

import { backupNow, listTargets, status } from "./api";
import type { BackupStatus, BackupTarget } from "../lib/ipc";
import { RestoreDialog } from "./RestoreDialog";

export function BackupPanel() {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const refresh = () => {
    void Promise.all([listTargets(), status()])
      .then(([t, s]) => {
        setTargets(t);
        setSt(s);
      })
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(refresh, []);

  const onBackup = async () => {
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await backupNow(passphrase);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Backup</h3>

      <div className="space-y-1">
        <div className="text-slate-600">Targets</div>
        <ul className="rounded-md border border-slate-200 bg-slate-50 p-2">
          {targets.length === 0 && <li className="text-slate-500">none</li>}
          {targets.map((t) => (
            <li key={t.id} className="flex justify-between">
              <span>
                {t.label} <span className="text-xs text-slate-500">({t.kind})</span>
              </span>
              <span className="font-mono text-xs text-slate-500">{t.path}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <div className="text-slate-600">Recovery passphrase</div>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="w-full rounded-md border border-slate-300 p-2"
          placeholder="Used to encrypt this backup"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onBackup}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Back up now"}
        </button>
        <button
          type="button"
          onClick={() => setRestoreOpen(true)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Restore…
        </button>
      </div>

      {st && (
        <dl className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-3 text-sm">
          <div>
            <dt className="text-slate-500">Last backup</dt>
            <dd>
              {st.last_backup_unix_ms
                ? new Date(st.last_backup_unix_ms).toLocaleString("en-IN")
                : "never"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Last test restore</dt>
            <dd>
              {st.last_test_restore_unix_ms
                ? new Date(st.last_test_restore_unix_ms).toLocaleString("en-IN")
                : "never"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Age (h)</dt>
            <dd>{st.backup_age_hours.toFixed(1)}</dd>
          </div>
        </dl>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <RestoreDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onDone={refresh}
      />
    </div>
  );
}
