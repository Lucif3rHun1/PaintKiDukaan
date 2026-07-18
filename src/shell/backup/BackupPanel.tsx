import { useEffect, useState } from "react";
import { Clock3, DatabaseBackup, HardDrive } from "lucide-react";

import { backupNow, listTargets, status } from "./api";
import type { BackupStatus, BackupTarget } from "../lib/ipc";
import { RestoreDialog } from "./RestoreDialog";
import { extractError } from "../../lib/extractError";
import { Alert, Badge, Button, Card, Skeleton } from "../../components/ui";

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
    if (!/[a-zA-Z]/.test(passphrase) || !/[0-9]/.test(passphrase)) {
      setError("Password must contain at least one letter and one number");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await backupNow(passphrase);
      setPassphrase("");
      refresh();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      {st ? (
        <Card depth="raised">
          <Card.Body className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <DatabaseBackup className="h-4 w-4" aria-hidden="true" />
                Last backup
              </div>
              <p className="font-medium tabular-nums text-foreground">
                {st.last_backup_unix_ms
                  ? new Date(st.last_backup_unix_ms).toLocaleString("en-IN")
                  : "Never"}
              </p>
              <Badge variant={st.last_backup_unix_ms ? "success" : "warning"}>
                {st.last_backup_unix_ms ? `${st.backup_age_hours.toFixed(1)} h old` : "Backup required"}
              </Badge>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="h-4 w-4" aria-hidden="true" />
                Last test restore
              </div>
              <p className="font-medium tabular-nums text-foreground">
                {st.last_test_restore_unix_ms
                  ? new Date(st.last_test_restore_unix_ms).toLocaleString("en-IN")
                  : "Never tested"}
              </p>
              <Badge variant={st.last_test_restore_unix_ms ? "success" : "muted"}>
                {st.last_test_restore_unix_ms ? "Recovery verified" : "Not yet verified"}
              </Badge>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HardDrive className="h-4 w-4" aria-hidden="true" />
                Backup targets
              </div>
              <p className="text-2xl font-bold leading-7 tabular-nums text-foreground">{targets.length}</p>
              <Badge variant={targets.length > 0 ? "info" : "warning"}>
                {targets.length > 0 ? "Ready" : "No target available"}
              </Badge>
            </div>
          </Card.Body>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3" aria-label="Loading backup status">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      )}

      {st && (!st.last_backup_unix_ms || targets.length === 0) ? (
        <Alert variant="warning" title="Backup protection needs attention">
          {!st.last_backup_unix_ms
            ? "No completed backup is recorded. Create one now to protect shop data."
            : "No backup target is available. Check the configured destination before relying on recovery."}
        </Alert>
      ) : (
        <Alert variant="success" title="Backup protection is ready">
          A backup destination is available. Run a fresh backup after material shop changes.
        </Alert>
      )}

      <Card depth="flat" className="bg-surface-sunken">
        <Card.Body className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-medium text-foreground">Recovery password</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="input"
              placeholder="Used to protect this backup"
            />
            <span className="mt-1 block text-xs text-muted-foreground">At least 8 characters with a letter and number.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" loading={busy} onClick={onBackup} icon={DatabaseBackup}>
              Back up now
            </Button>
            <Button type="button" variant="secondary" onClick={() => setRestoreOpen(true)}>
              Restore from file…
            </Button>
          </div>
        </Card.Body>
      </Card>

      {targets.length > 0 ? (
        <Card depth="flat">
          <Card.Body>
            <div className="mb-2 font-medium text-foreground">Available targets</div>
            <ul className="divide-y divide-border rounded-md border border-border bg-surface-sunken">
              {targets.map((target) => (
                <li key={target.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-medium text-foreground">
                    {target.label} <span className="text-xs font-normal text-muted-foreground">({target.kind})</span>
                  </span>
                  <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{target.path}</span>
                </li>
              ))}
            </ul>
          </Card.Body>
        </Card>
      ) : null}

      {error ? <Alert variant="destructive" title="Backup action failed">{error}</Alert> : null}

      <RestoreDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onDone={refresh}
      />
    </div>
  );
}
