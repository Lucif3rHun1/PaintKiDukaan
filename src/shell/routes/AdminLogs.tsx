import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileText, RefreshCw, ScrollText } from "lucide-react";
import { Alert, Badge, Button, Card, DataTable, EmptyState, Select, Skeleton, type ColumnDef } from "../../components/ui";
import { ipc, type LogEntry } from "../lib/ipc";
import { extractError } from "../../lib/extractError";

const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "Error" },
  { value: "WARN", label: "Warn" },
  { value: "INFO", label: "Info" },
  { value: "DEBUG", label: "Debug" },
  { value: "TRACE", label: "Trace" },
];

const columns: ColumnDef<LogEntry>[] = [
  {
    header: "Timestamp",
    id: "timestamp",
    width: "200px",
    cell: (row) => (
      <span className="font-mono text-xs text-muted-foreground">{row.timestamp}</span>
    ),
  },
  {
    header: "Level",
    id: "level",
    width: "80px",
    cell: (row) => <LevelBadge level={row.level} />,
  },
  {
    header: "Message",
    id: "message",
    flex: true,
    minWidth: "16rem",
    cell: (row) => (
      <span className="whitespace-pre-wrap break-all text-xs">{row.message}</span>
    ),
  },
];

export function AdminLogs() {
  const [levelFilter, setLevelFilter] = useState("all");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["adminLogs"],
    queryFn: () => ipc.readSessionLogs(500),
  });

  const filtered = (data ?? []).filter(
    (entry) => levelFilter === "all" || entry.level === levelFilter,
  );
  const errorCount = (data ?? []).filter((entry) => entry.level === "ERROR").length;
  const warningCount = (data ?? []).filter((entry) => entry.level === "WARN").length;

  return (
    <div className="space-y-3">
      <Card depth="raised">
        <Card.Body className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ScrollText className="h-4 w-4" aria-hidden="true" />
                Session entries
              </div>
              {isLoading ? <Skeleton className="h-7 w-16" /> : <p className="text-2xl font-bold leading-7 tabular-nums text-foreground">{data?.length ?? 0}</p>}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                Errors
              </div>
              {isLoading ? <Skeleton className="h-7 w-16" /> : <p className="text-2xl font-bold leading-7 tabular-nums text-foreground">{errorCount}</p>}
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Warnings</div>
              {isLoading ? <Skeleton className="h-7 w-16" /> : <p className="text-2xl font-bold leading-7 tabular-nums text-foreground">{warningCount}</p>}
            </div>
          </div>
          <Button type="button" onClick={() => refetch()} loading={isFetching} icon={RefreshCw}>
            Refresh logs
          </Button>
        </Card.Body>
      </Card>

      {error ? (
        <Alert variant="destructive" title="Logs could not be loaded">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{extractError(error)}</span>
            <Button type="button" variant="destructive" size="sm" onClick={() => refetch()} loading={isFetching}>Try again</Button>
          </div>
        </Alert>
      ) : errorCount > 0 ? (
        <Alert variant="destructive" title={`${errorCount} error ${errorCount === 1 ? "entry" : "entries"} need review`}>
          Filter to Error, inspect the latest failure, then refresh after taking corrective action.
        </Alert>
      ) : warningCount > 0 ? (
        <Alert variant="warning" title={`${warningCount} warning ${warningCount === 1 ? "entry" : "entries"} recorded`}>
          Review warnings for degraded operations. No session errors are currently recorded.
        </Alert>
      ) : (
        <Alert variant="success" title="No errors or warnings recorded">
          The current session log contains no entries requiring attention.
        </Alert>
      )}

      <Card depth="flat">
        <Card.Header className="flex-row items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Admin logs</h2>
            <p className="text-xs text-muted-foreground">Showing {filtered.length} of {data?.length ?? 0} entries</p>
          </div>
          <Select
            options={LEVEL_OPTIONS}
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            size="sm"
            className="w-36"
            aria-label="Filter by log level"
          />
        </Card.Header>
        <Card.Body>
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(row, i) => `${row.timestamp}-${i}`}
            loading={isLoading}
            stickyHeader
            emptyState={
              <EmptyState
                icon={FileText}
                title="No log entries"
                description={levelFilter !== "all" ? `No ${levelFilter} entries found.` : "The session log is empty."}
              />
            }
          />
        </Card.Body>
      </Card>
    </div>
  );
}

function LevelBadge({ level }: { level: string }) {
  const variant = level === "ERROR" ? "danger" : level === "WARN" ? "warning" : level === "DEBUG" || level === "TRACE" ? "muted" : "info";
  return <Badge variant={variant}>{level}</Badge>;
}
