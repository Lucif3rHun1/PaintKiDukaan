import { useEffect, useRef, useState } from "react";
import { Bell, Check } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listAlerts,
  unreadAlertCount,
  markAlertRead,
  markAllAlertsRead,
  ALERTS_QUERY_KEY,
  type Severity,
  type Alert,
} from "../../domain/alerts";
import { Badge, cn, EmptyState } from "../../components/ui";
import type { Role } from "../../lib/security/state";
import { SkeletonRow } from "../../components/ui/SkeletonRow";

const severityClasses: Record<Severity, string> = {
  info: "border-l-4 border-info bg-info/10",
  warning: "border-l-4 border-warning bg-warning/10",
  error: "border-l-4 border-destructive bg-destructive/10",
};

const severityDot: Record<Severity, string> = {
  info: "bg-info",
  warning: "bg-warning",
  error: "bg-destructive",
};

const ROLE_HIERARCHY: Record<Role, number> = {
  stocker: 0,
  cashier: 1,
  owner: 2,
};

function alertTitle(alert: Alert): string {
  return alert.title;
}

interface AlertBellProps {
  currentRole?: Role;
}

export function AlertBell({ currentRole }: AlertBellProps) {
  // ponytail: early return AFTER all hooks to satisfy React hooks rules.
  // Hooks below must execute unconditionally — role check done in render return.
  const currentLevel = currentRole ? ROLE_HIERARCHY[currentRole] ?? 0 : 0;
  const hide = currentLevel < ROLE_HIERARCHY.cashier;

  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: [...ALERTS_QUERY_KEY, "withCount"],
    queryFn: async () => {
      const [alerts, count] = await Promise.all([listAlerts(), unreadAlertCount()]);
      return { alerts, count };
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });

  const alerts = data?.alerts ?? [];
  const count = data?.count ?? 0;

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (!panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handle);
      return () => document.removeEventListener("mousedown", handle);
    }
  }, [open]);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-alert-bell", handler);
    return () => window.removeEventListener("open-alert-bell", handler);
  }, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });

  const handleMarkRead = async (id: number) => {
    await markAlertRead(id);
    await refresh();
  };

  const handleMarkAll = async () => {
    await markAllAlertsRead();
    await refresh();
  };

  if (hide) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-full hover:bg-muted transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5 text-foreground" />
        {count > 0 && (
          <Badge
            className="absolute -top-1 -right-1 h-5 min-w-[1.25rem] px-1 flex items-center justify-center text-xs bg-destructive text-destructive-foreground border-0"
          >
            {count > 99 ? "99+" : count}
          </Badge>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-card rounded-lg shadow-lg border border-border z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-foreground">Alerts</h3>
            {count > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                className="text-xs text-primary hover:text-primary/80 font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {isLoading && alerts.length === 0 && (
              <div className="px-4 py-6">
                <SkeletonRow count={3} />
              </div>
            )}

            {!isLoading && alerts.length === 0 && (
              <div className="px-4 py-2">
                <EmptyState
                  icon={Bell}
                  title="No alerts"
                  description="You’re all caught up."
                />
              </div>
            )}

            {alerts.map((alert) => {
              const isRead = Object.keys(alert.read_by).length > 0;
              return (
                <div
                  key={alert.id}
                  className={cn(
                    "px-4 py-3 border-b border-border last:border-0",
                    severityClasses[alert.severity],
                    isRead && "opacity-70"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-1 w-2 h-2 rounded-full flex-shrink-0",
                        severityDot[alert.severity]
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {alertTitle(alert)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {alert.message}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {new Date(alert.created_at).toLocaleString()}
                      </p>
                    </div>
                    {!isRead && (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(alert.id)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                        title="Mark read"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
