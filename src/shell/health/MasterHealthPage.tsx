import { useEffect, useState } from "react";

import type { MasterHealth } from "../lib/ipc";
import { fetchMasterHealth } from "./api";
import { SkeletonRow } from "../components/SkeletonRow";

export function MasterHealthPage() {
  const [data, setData] = useState<MasterHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMasterHealth()
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
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
        <Row k="WebView2" v={data.app.webview2} />
        <Row k="SQLCipher" v={data.app.sqlcipher} />
        <Row k="Last backup" v={data.app.last_backup} />
        <Row k="Last test-restore" v={data.app.last_test_restore} />
      </Section>

      <Section title="System">
        <Row k="BitLocker (C:)" v={data.system.bitlocker_c_drive} />
        <Row k="Disk free (GB)" v={data.system.disk_free_gb.toFixed(1)} />
        <Row
          k="Sleep prevented"
          v={data.system.sleep_prevented ? "yes" : "no"}
        />
        <Row k="Auto-lock policy" v={data.system.auto_lock_policy} />
      </Section>

      <Section title="Data">
        <Row k="DB integrity" v={data.data.db_integrity} />
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
        <Row k="mDNS active" v={data.network.mdns_active ? "yes" : "no"} />
        <Row k="LAN IP" v={data.network.lan_ip || "—"} />
        <Row k="Connected devices" v={String(data.network.connected_devices)} />
      </Section>

      <Section title="Ops">
        <Row k="Day-close age (h)" v={String(data.ops.day_close_age_hours)} />
        <Row k="Low-stock count" v={String(data.ops.low_stock_count)} />
        <Row k="Pending sales" v={String(data.ops.pending_sales)} />
      </Section>

      <div className="text-xs text-slate-500">
        checked at {data.checked_at}
      </div>
    </div>
  );
}

function badge(level: string): string {
  switch (level) {
    case "ok":
      return "bg-emerald-100 text-emerald-800";
    case "warn":
      return "bg-amber-100 text-amber-800";
    case "error":
      return "bg-red-100 text-red-800";
    default:
      return "bg-slate-100 text-slate-800";
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 p-3">
      <h4 className="mb-2 text-sm font-semibold text-slate-700">{title}</h4>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-slate-500">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
