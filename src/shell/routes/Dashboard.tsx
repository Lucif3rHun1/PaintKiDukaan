import { useEffect, useState } from "react";

import { ipc, type BackupStatus } from "../lib/ipc";
import { useSessionStore } from "../store/session";

export function Dashboard() {
  const session = useSessionStore((s) => s.session);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc
      .backupStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Dashboard</h2>
      <p className="text-sm text-slate-600">
        Welcome back, {session.user?.name ?? "owner"}. The dashboard for
        POS/inward/reports lands in Slice C; the shell surfaces these cards in
        the meantime.
      </p>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Last backup">
          {status?.last_backup_unix_ms
            ? new Date(status.last_backup_unix_ms).toLocaleString("en-IN")
            : "never"}
        </Card>
        <Card title="Last test restore">
          {status?.last_test_restore_unix_ms
            ? new Date(status.last_test_restore_unix_ms).toLocaleString(
                "en-IN",
              )
            : "never"}
        </Card>
        <Card title="Backup age (hours)">
          {status ? status.backup_age_hours.toFixed(1) : "—"}
        </Card>
        <Card title="Targets available">
          {status?.targets.length ?? 0}
        </Card>
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase text-slate-500">{title}</div>
      <div className="mt-1 text-lg font-medium">{children}</div>
    </div>
  );
}
