import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, FileText } from "lucide-react";
import { DataTable, Button, EmptyState, Select, type ColumnDef } from "../../components/ui";
import { ipc, type LogEntry } from "../lib/ipc";
import { extractError } from "../../lib/extractError";
import { Skeleton } from "boneyard-js/react";

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

  return (
  <Skeleton name="admin-logs" loading={isLoading} select="viewport">
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Admin logs</h2>
        <div className="flex items-center gap-2">
          <Select
            options={LEVEL_OPTIONS}
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            size="sm"
            className="w-36"
            aria-label="Filter by log level"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh logs"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {extractError(error)}
        </div>
      ) : (
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
      )}
    </div>
  </Skeleton>
  );
}

function LevelBadge({ level }: { level: string }) {
  const cls =
    level === "ERROR"
      ? "bg-destructive/15 text-destructive"
      : level === "WARN"
        ? "bg-warning/15 text-warning"
        : level === "DEBUG" || level === "TRACE"
          ? "bg-muted text-muted-foreground"
          : "bg-primary/10 text-primary";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {level}
    </span>
  );
}
