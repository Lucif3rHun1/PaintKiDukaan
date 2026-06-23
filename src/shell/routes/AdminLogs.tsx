export function AdminLogs() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Admin logs</h2>
      <p className="text-sm text-muted-foreground">
        Tails the Tauri log plugin. Restricted to the owner role.
      </p>
      <div className="rounded-md border border-border bg-muted p-3 font-mono text-xs text-foreground">
        <div>[info] PaintKiDukaan master started</div>
        <div>[debug] plugins registered: log, single-instance, autostart, …</div>
        <div>[info] scanner hook started on thread pkb-scanner-hook</div>
        <div>[info] tray attached: pkb-master-tray</div>
      </div>
    </div>
  );
}
