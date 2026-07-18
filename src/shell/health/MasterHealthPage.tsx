import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";

import type { MasterHealth } from "../lib/ipc";
import { fetchMasterHealth } from "./api";
import { Alert, Badge, Button, Card, Skeleton } from "../../components/ui";
import { extractError } from "../../lib/extractError";

export function MasterHealthPage() {
  const [data, setData] = useState<MasterHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setError(null);
    fetchMasterHealth()
      .then((d) => setData(d ?? null))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setRefreshing(false));
  }, [refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
  }, []);

  if (error) {
    return (
      <Alert variant="destructive" title="Health check failed">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          <Button type="button" variant="destructive" size="sm" onClick={handleRefresh} loading={refreshing}>
            Check again
          </Button>
        </div>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3" aria-label="Loading system health">
        <Skeleton variant="card" className="h-32" />
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton variant="card" className="h-48" />
          <Skeleton variant="card" className="h-48" />
        </div>
      </div>
    );
  }

  const overallVariant = data.overall === "ok" ? "success" : data.overall === "warn" ? "warning" : "danger";
  const overallLabel = data.overall === "ok" ? "Healthy" : data.overall === "warn" ? "Attention needed" : "Action required";

  return (
    <div className="space-y-3 text-sm">
      <Card depth="raised">
        <Card.Body className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">System health</h2>
              <Badge variant={overallVariant}>{overallLabel}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Data, device, network, and operational checks completed at <span className="font-mono tabular-nums text-foreground">{data.checked_at}</span>.
            </p>
          </div>
          <Button
            type="button"
            size="md"
            icon={RefreshCw}
            onClick={handleRefresh}
            loading={refreshing}
            aria-label="Refresh health data"
          >
            Run health check
          </Button>
        </Card.Body>
      </Card>

      {data.overall === "ok" ? (
        <Alert variant="success" title="No health risks detected">
          Continue normal operation. Re-run diagnostics after system or hardware changes.
        </Alert>
      ) : (
        <Alert variant={data.overall === "warn" ? "warning" : "destructive"} title={overallLabel}>
          Review the detailed checks below, correct the reported condition, then run the health check again.
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <HealthSection title="Application">
          <Row k="Version" v={data.app.version} />
          <Row k="Browser engine" v={data.app.webview2} />
          <Row k="Database engine" v={data.app.sqlcipher} />
          <Row k="Last backup" v={data.app.last_backup} />
          <Row k="Last test restore" v={data.app.last_test_restore} />
          <Row k="Tray" v={data.app.tray_status} />
        </HealthSection>

        <HealthSection title="System">
          <Row k="Drive protection (C:)" v={data.system.bitlocker_c_drive} />
          <Row k="Disk free (GB)" v={data.system.disk_free_gb?.toFixed(1) ?? "—"} />
          <Row k="Sleep prevented" v={data.system.sleep_prevented ? "yes" : "no"} />
          <Row k="Auto-lock policy" v={data.system.auto_lock_policy} />
        </HealthSection>

        <HealthSection title="Data">
          <Row k="Data health" v={data.data.db_integrity} />
          <Row k="Rows" v={`sales=${data.data.rows_count.sales}, items=${data.data.rows_count.items}, customers=${data.data.rows_count.customers}`} />
          <Row k="Backup age (h)" v={data.data.backup_age_hours < 0 ? "never" : String(data.data.backup_age_hours)} />
        </HealthSection>

        <HealthSection title="Network">
          <Row k="Network discovery" v={data.network.mdns_active ? "yes" : "no"} />
          <Row k="LAN IP" v={data.network.lan_ip || "—"} />
          <Row k="Connected devices" v={String(data.network.connected_devices)} />
        </HealthSection>

        <HealthSection title="Operations" className="lg:col-span-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Row k="Day-close age (h)" v={String(data.ops.day_close_age_hours)} />
            <Row k="Low-stock count" v={String(data.ops.low_stock_count)} />
            <Row k="Pending sales" v={String(data.ops.pending_sales)} />
          </div>
        </HealthSection>
      </div>
    </div>
  );
}

function HealthSection({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <Card depth="flat" className={className}>
      <Card.Header>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
      </Card.Header>
      <Card.Body className="space-y-2">{children}</Card.Body>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="min-w-0 break-all text-right font-mono tabular-nums text-foreground">{v}</span>
    </div>
  );
}
