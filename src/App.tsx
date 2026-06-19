import { useEffect, useState } from "react";

type BootState =
  | { kind: "loading" }
  | { kind: "first-launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; role: "owner" | "cashier" | "stocker" }
  | { kind: "error"; message: string };

export default function App() {
  const [state, setState] = useState<BootState>({ kind: "loading" });

  useEffect(() => {
    // Tauri 2 IPC bridge to Rust core. Until Rust implements `app_bootstrap`,
    // surface a clean loading state so the UI shell is verifiable.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      // Real Tauri runtime: call Rust bootstrap.
      (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const result = await invoke<{
            kind: "first-launch" | "locked";
            user?: string;
            role?: "owner" | "cashier" | "stocker";
          }>("app_bootstrap");
          if (result.kind === "first-launch") {
            setState({ kind: "first-launch" });
          } else if (result.kind === "locked") {
            setState({ kind: "locked" });
          } else if (result.user && result.role) {
            setState({ kind: "unlocked", user: result.user, role: result.role });
          }
        } catch (e) {
          setState({ kind: "error", message: String(e) });
        }
      })();
    } else {
      // Browser-only preview (vite dev without Tauri).
      setState({ kind: "first-launch" });
    }
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-screen items-center justify-center text-red-600">
        Error: {state.message}
      </div>
    );
  }
  if (state.kind === "first-launch") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">First-launch setup</h1>
          <p className="mt-2 text-slate-600">
            Set owner PIN and recovery passphrase to begin. (UI coming in M1.2.)
          </p>
        </div>
      </div>
    );
  }
  if (state.kind === "locked") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">Locked</h1>
          <p className="mt-2 text-slate-600">Enter PIN to unlock. (UI coming in M1.3.)</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen p-8">
      <header className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold">PaintKiDukaan</h1>
        <p className="text-sm text-slate-500">
          Signed in as {state.user} ({state.role})
        </p>
      </header>
      <main className="mt-6">
        <p className="text-slate-700">Dashboard (M1 owner home coming next).</p>
      </main>
    </div>
  );
}
