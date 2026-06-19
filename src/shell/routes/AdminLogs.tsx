export function AdminLogs() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Admin logs</h2>
      <p className="text-sm text-slate-600">
        Tails the Tauri log plugin. Restricted to the owner role.
      </p>
      <div className="rounded-md border border-slate-200 bg-slate-900 p-3 font-mono text-xs text-slate-100">
        <div>[info] PaintKiDukaan master started</div>
        <div>[debug] plugins registered: log, single-instance, autostart, …</div>
        <div>[info] scanner hook started on thread pkb-scanner-hook</div>
        <div>[info] tray attached: pkb-master-tray</div>
      </div>
    </div>
  );
}
