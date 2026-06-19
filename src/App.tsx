import { invoke } from "@tauri-apps/api/core";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { FirstLaunch } from "./lib/security/firstLaunch";
import { LockScreen } from "./lib/security/lockScreen";
import { RestoreFromRecovery } from "./lib/security/restoreFromRecovery";
import { type Bootstrap, useSecurity } from "./lib/security/state";

const THIRTY_SECONDS = 30_000;

export default function App() {
  const phase = useSecurity((state) => state.phase);
  const session = useSecurity((state) => state.session);
  const setPhase = useSecurity((state) => state.setPhase);
  const setSession = useSecurity((state) => state.setSession);
  const lastTouchAt = useRef(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<Bootstrap>("app_bootstrap")
      .then((bootstrap) => {
        if (cancelled) return;
        if (bootstrap.kind === "first-launch") {
          setSession(null);
          setPhase("first-launch");
        } else if (bootstrap.kind === "locked") {
          setSession(null);
          setPhase("locked");
        } else {
          setSession({ user_id: 0, user_name: bootstrap.user, role: bootstrap.role });
          setPhase("unlocked");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setBootstrapError(error instanceof Error ? error.message : String(error));
        setSession(null);
        setPhase("locked");
      });

    return () => {
      cancelled = true;
    };
  }, [setPhase, setSession]);

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

  async function lockNow() {
    try {
      await invoke("lock");
    } finally {
      setSession(null);
      setPhase("locked");
    }
  }

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

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
        <div className="w-full rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-emerald-300">Database unlocked</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Welcome {session?.user_name ?? "Owner"}
              </h1>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {bootstrapError ? (
            <p className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
              Bootstrap warning: {bootstrapError}
            </p>
          ) : null}

          <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-4 text-sm leading-6 text-zinc-300">
            <p className="font-medium text-zinc-100">Slice A scaffold</p>
            <p className="mt-1 text-zinc-400">Domain features coming in slice B/C/D.</p>
          </div>

          <button
            className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            onClick={lockNow}
          >
            <Lock className="mr-2 h-4 w-4" aria-hidden="true" />
            Lock Now
          </button>
        </div>
      </section>
    </main>
  );
}
