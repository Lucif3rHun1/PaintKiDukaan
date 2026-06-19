import { useEffect, useState } from "react";

import { ipc, type Bootstrap, type Role } from "../lib/ipc";
import { useScanTargetStore } from "../store/scanTarget";
import { useSessionStore } from "../store/session";
import { useIdleLock } from "../hooks/useIdleLock";
import { Dashboard } from "./Dashboard";
import { Settings } from "./Settings";
import { AdminLogs } from "./AdminLogs";
import { MasterHealthPage } from "../health/MasterHealthPage";

type Route =
  | { name: "dashboard" }
  | { name: "settings" }
  | { name: "health" }
  | { name: "admin-logs" };

function readRoute(): Route {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/settings")) return { name: "settings" };
  if (h.startsWith("#/health")) return { name: "health" };
  if (h.startsWith("#/admin/logs")) return { name: "admin-logs" };
  return { name: "dashboard" };
}

export function ShellApp() {
  const [boot, setBoot] = useState<Bootstrap>({ kind: "loading" });
  const [route, setRoute] = useState<Route>(readRoute);
  const [idleLockMinutes, setIdleLockMinutes] = useState(5);
  const session = useSessionStore((s) => s.session);
  const setUser = useSessionStore((s) => s.setUser);
  const setLocked = useSessionStore((s) => s.setLocked);
  const scanTarget = useScanTargetStore((s) => s.target);

  useEffect(() => {
    void ipc
      .appBootstrap()
      .then((b) => {
        setBoot(b);
        if (b.kind === "unlocked") {
          setUser({
            id: 0,
            name: b.user,
            role: b.role as Role,
            is_active: true,
          });
          setLocked(false);
        } else if (b.kind === "locked") {
          setLocked(true);
        }
      })
      .catch((e: unknown) =>
        setBoot({ kind: "error", message: String(e) }),
      );
  }, [setUser, setLocked]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    ipc
      .getSetting("idle_lock_minutes")
      .then((raw) => {
        const minutes = raw ? (JSON.parse(raw) as number) : 5;
        setIdleLockMinutes(Number.isFinite(minutes) && minutes > 0 ? minutes : 5);
      })
      .catch(() => setIdleLockMinutes(5));
  }, []);

  useIdleLock({
    idleMs: idleLockMinutes * 60 * 1000,
    onLock: () => (window.location.hash = "#/lock"),
  });

  if (boot.kind === "loading") {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }

  if (boot.kind === "error") {
    return (
      <div className="flex h-screen items-center justify-center text-red-600">
        Error: {boot.message}
      </div>
    );
  }

  if (boot.kind === "first_launch") {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">First-launch setup</h1>
          <p className="mt-2 text-sm text-slate-600">
            Set owner PIN and recovery passphrase to begin. The setup wizard
            ships in M1.2; the lock screen in M1.3.
          </p>
        </div>
      </div>
    );
  }

  if (boot.kind === "locked" || session.locked) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="w-80 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">Locked</h1>
          <p className="mt-2 text-sm text-slate-600">
            Enter PIN to unlock. (Lock screen coming in M1.3.)
          </p>
          <button
            type="button"
            className="mt-4 w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            onClick={() => {
              setLocked(false);
            }}
          >
            Unlock (dev)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between p-3">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold">PaintKiDukaan</h1>
            <nav className="flex gap-1 text-sm">
              <a href="#/" className="rounded px-2 py-1 hover:bg-slate-100">
                Dashboard
              </a>
              <a
                href="#/settings"
                className="rounded px-2 py-1 hover:bg-slate-100"
              >
                Settings
              </a>
              <a
                href="#/health"
                className="rounded px-2 py-1 hover:bg-slate-100"
              >
                Health
              </a>
              <a
                href="#/admin/logs"
                className="rounded px-2 py-1 hover:bg-slate-100"
              >
                Logs
              </a>
            </nav>
          </div>
          <div className="text-sm text-slate-500">
            {session.user?.name ?? "no user"} ({session.user?.role ?? "—"}) ·
            scan: <span className="font-mono">{scanTarget ?? "none"}</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "settings" && <Settings />}
        {route.name === "health" && <MasterHealthPage />}
        {route.name === "admin-logs" && <AdminLogs />}
      </main>
    </div>
  );
}

export default ShellApp;
