import { useEffect, useState } from "react";

import { backupNow, listTargets, status } from "./api";
import type { BackupStatus, BackupTarget } from "../lib/ipc";
import { RestoreDialog } from "./RestoreDialog";
import { extractError } from "../../lib/extractError";

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
      .catch((e: unknown) => setError(extractError(e)));
  };

  useEffect(refresh, []);

  const onBackup = async () => {
    if (passphrase.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await backupNow(passphrase);
      refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <h3 className="text-base font-semibold">Backup</h3>

      <div className="space-y-1">
        <div className="text-muted-foreground">Targets</div>
        <ul className="rounded-md border border-border bg-muted p-2">
          {targets.length === 0 && <li className="text-muted-foreground">none</li>}
          {targets.map((t) => (
            <li key={t.id} className="flex justify-between">
              <span>
                {t.label} <span className="text-xs text-muted-foreground">({t.kind})</span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">{t.path}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <div className="text-muted-foreground">Recovery password</div>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="w-full rounded-md border border-input p-2"
          placeholder="Used to protect this backup"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onBackup}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          {busy ? "Working…" : "Back up now"}
        </button>
        <button
          type="button"
          onClick={() => setRestoreOpen(true)}
          className="rounded-md border border-border px-3 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Restore…
        </button>
      </div>

      {st && (
        <dl className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Last backup</dt>
            <dd>
              {st.last_backup_unix_ms
                ? new Date(st.last_backup_unix_ms).toLocaleString("en-IN")
                : "never"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last test restore</dt>
            <dd>
              {st.last_test_restore_unix_ms
                ? new Date(st.last_test_restore_unix_ms).toLocaleString("en-IN")
                : "never"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Age (h)</dt>
            <dd>{st.backup_age_hours.toFixed(1)}</dd>
          </div>
        </dl>
      )}

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive">
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
