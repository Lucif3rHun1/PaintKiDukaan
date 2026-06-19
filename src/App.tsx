import { invoke } from "@tauri-apps/api/core";
import { Loader2, Lock, Settings, ShieldCheck, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { FirstLaunch } from "./lib/security/firstLaunch";
import { LockScreen } from "./lib/security/lockScreen";
import { RestoreFromRecovery } from "./lib/security/restoreFromRecovery";
import { type Bootstrap, useSecurity } from "./lib/security/state";
import { UserManagement } from "./lib/security/userManagement";

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;

const LOCKED_SESSION = { user: null, locked: true } as const;

export default function App() {
  const phase = useSecurity((state) => state.phase);
  const session = useSecurity((state) => state.session);
  const setPhase = useSecurity((state) => state.setPhase);
  const setSession = useSecurity((state) => state.setSession);
  const lastTouchAt = useRef(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  // Bootstrap: determine initial app state
  useEffect(() => {
    let cancelled = false;

    invoke<Bootstrap>("app_bootstrap")
      .then((bootstrap) => {
        if (cancelled) return;
        if (bootstrap.kind === "first-launch") {
          setSession(LOCKED_SESSION);
          setPhase("first-launch");
        } else if (bootstrap.kind === "locked") {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        } else {
          setSession({
            user: { id: 0, name: bootstrap.user, role: bootstrap.role },
            locked: false,
          });
          setPhase("unlocked");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setBootstrapError(error instanceof Error ? error.message : String(error));
        setSession(LOCKED_SESSION);
        setPhase("locked");
      });

    return () => {
      cancelled = true;
    };
  }, [setPhase, setSession]);

  // Activity tracking + idle auto-lock
  useEffect(() => {
    if (phase !== "unlocked") return;

    const touch = () => {
      const now = Date.now();
      if (now - lastTouchAt.current < THIRTY_SECONDS) return;
      lastTouchAt.current = now;
      void invoke("touch_activity").catch(() => undefined);
    };

    window.addEventListener("mousemove", touch);
    window.addEventListener("keydown", touch);
    window.addEventListener("click", touch);

    return () => {
      window.removeEventListener("mousemove", touch);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("click", touch);
    };
  }, [phase]);

  // Idle auto-lock: lock after 15 minutes of no interaction
  useEffect(() => {
    if (phase !== "unlocked") return;

    let idleTimer: ReturnType<typeof setTimeout>;

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        try {
          await invoke("lock");
        } finally {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        }
      }, FIFTEEN_MINUTES);
    }

    function onActivity() {
      resetIdleTimer();
    }

    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("click", onActivity);

    resetIdleTimer();

    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("click", onActivity);
    };
  }, [phase, setPhase, setSession]);

  async function lockNow() {
    try {
      await invoke("lock");
    } finally {
      setSession(LOCKED_SESSION);
      setPhase("locked");
    }
  }

  // Loading screen
  if (phase === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/80 p-8 backdrop-blur">
          <Loader2 className="h-7 w-7 animate-spin text-indigo-400" aria-hidden="true" />
          <p className="text-sm text-zinc-400">Opening secure shop database…</p>
        </div>
      </main>
    );
  }

  if (phase === "first-launch") return <FirstLaunch />;
  if (phase === "locked") return <LockScreen />;
  if (phase === "restore-recovery") return <RestoreFromRecovery />;
  if (phase === "user-management") return <UserManagement />;

  // Unlocked dashboard
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
      <section className="mx-auto max-w-lg">
        <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-emerald-300">Database unlocked</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Welcome, {session.user?.name ?? "Owner"}
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                {session.user?.role === "owner" ? "You have full access to all features." : `Logged in as ${session.user?.role}.`}
              </p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {/* Bootstrap warning */}
          {bootstrapError ? (
            <p className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
              {bootstrapError}
            </p>
          ) : null}

          {/* Quick actions */}
          <div className="space-y-3">
            {session.user?.role === "owner" && (
              <button
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/60 p-4 text-left text-sm transition-colors duration-150 hover:border-white/20 hover:bg-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                type="button"
                onClick={() => setPhase("user-management")}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-300">
                  <Users className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-medium text-zinc-100">Staff accounts</p>
                  <p className="mt-0.5 text-xs text-zinc-500">Add cashiers and stockers</p>
                </div>
              </button>
            )}

            <button
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/60 p-4 text-left text-sm transition-colors duration-150 hover:border-white/20 hover:bg-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              type="button"
              disabled
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-zinc-500">
                <Settings className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="font-medium text-zinc-400">Shop settings</p>
                <p className="mt-0.5 text-xs text-zinc-600">Coming in future slice</p>
              </div>
            </button>
          </div>

          {/* Lock button */}
          <button
            className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            type="button"
            onClick={lockNow}
          >
            <Lock className="mr-2 h-4 w-4" aria-hidden="true" />
            Lock now
          </button>
        </div>
      </section>
    </main>
  );
}
