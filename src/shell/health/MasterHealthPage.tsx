import { useEffect, useState } from "react";

import type { MasterHealth } from "../lib/ipc";
import { fetchMasterHealth } from "./api";
import { SkeletonRow } from "../components/SkeletonRow";
import { extractError } from "../../lib/extractError";

export function MasterHealthPage() {
  const [data, setData] = useState<MasterHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMasterHealth()
      .then((d) => setData(d ?? null))
      .catch((e: unknown) => setError(extractError(e)));
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <SkeletonRow count={6} />;

  return (
    <div className="space-y-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Master health</h3>
        <span
          className={
            "rounded px-2 py-0.5 text-xs font-medium " +
            badge(data.overall)
          }
        >
          {data.overall}
        </span>
      </header>

      <Section title="App">
        <Row k="Version" v={data.app.version} />
        <Row k="Browser engine" v={data.app.webview2} />
        <Row k="Database engine" v={data.app.sqlcipher} />
        <Row k="Last backup" v={data.app.last_backup} />
        <Row k="Last test-restore" v={data.app.last_test_restore} />
      </Section>

      <Section title="System">
        <Row k="Drive protection (C:)" v={data.system.bitlocker_c_drive} />
        <Row k="Disk free (GB)" v={data.system.disk_free_gb.toFixed(1)} />
        <Row
          k="Sleep prevented"
          v={data.system.sleep_prevented ? "yes" : "no"}
        />
        <Row k="Auto-lock policy" v={data.system.auto_lock_policy} />
      </Section>

      <Section title="Data">
        <Row k="Data health" v={data.data.db_integrity} />
        <Row
          k="Rows"
          v={`sales=${data.data.rows_count.sales}, items=${data.data.rows_count.items}, customers=${data.data.rows_count.customers}`}
        />
        <Row
          k="Backup age (h)"
          v={data.data.backup_age_hours < 0 ? "never" : String(data.data.backup_age_hours)}
        />
      </Section>

      <Section title="Network">
        <Row k="Network discovery" v={data.network.mdns_active ? "yes" : "no"} />
        <Row k="LAN IP" v={data.network.lan_ip || "—"} />
        <Row k="Connected devices" v={String(data.network.connected_devices)} />
      </Section>

      <Section title="Ops">
        <Row k="Day-close age (h)" v={String(data.ops.day_close_age_hours)} />
        <Row k="Low-stock count" v={String(data.ops.low_stock_count)} />
        <Row k="Pending sales" v={String(data.ops.pending_sales)} />
      </Section>

      <div className="text-xs text-muted-foreground">
        checked at {data.checked_at}
      </div>
    </div>
  );
}

function badge(level: string): string {
  switch (level) {
    case "ok":
      return "bg-success/20 text-success";
    case "warn":
      return "bg-warning/20 text-warning";
    case "error":
      return "bg-destructive/20 text-destructive";
    default:
      return "bg-muted text-foreground";
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border p-3">
      <h4 className="mb-2 text-sm font-semibold text-foreground">{title}</h4>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
