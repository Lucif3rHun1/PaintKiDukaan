import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-64.png";
import { AlertCircle, KeyRound, Loader2, Lock, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { type UnlockInput, unlockSchema } from "./pin";
import { type Role, type Session, type User, useSecurity } from "./state";

interface UnlockResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-center text-lg font-medium tracking-[0.35em] text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const buttonClass =
  "inline-flex h-11 w-full items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function normalizeSession(result: UnlockResponse): Session {
  const role: Role = result.user?.role ?? result.role ?? "owner";
  const name = result.user?.name ?? result.user_name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null ? null : { id, name, role };
  return { user, locked: result.locked ?? false };
}

function extractLockedUntil(message: string): number | null {
  const match = message.match(/locked out until unix (\d+)/i);
  return match ? Number(match[1]) : null;
}

function extractAttemptCount(message: string): number | null {
  const match = message.match(/(?:attempts?|failed)\D*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function formatTimeRemaining(untilSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = untilSeconds - now;
  if (diff <= 0) return "You can try now.";
  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

export function LockScreen() {
  const [backendError, setBackendError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [isWiped, setIsWiped] = useState(false);
  const setPhase = useSecurity((state) => state.setPhase);

  const {
    register,
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
  } = useForm<UnlockInput>({
    resolver: zodResolver(unlockSchema),
    mode: "onChange",
    defaultValues: { pin: "" },
  });

  const pin = useWatch({ control, name: "pin" });
  const canSubmit = unlockSchema.safeParse({ pin }).success && !lockedUntil;

  // Live countdown when locked out
  const timeDisplay = useMemo(() => {
    if (!lockedUntil) return null;
    return formatTimeRemaining(lockedUntil);
  }, [lockedUntil]);

  useEffect(() => {
    if (!lockedUntil) return;
    const interval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      if (now >= lockedUntil) {
        setLockedUntil(null);
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lockedUntil]);

  async function onSubmit(input: UnlockInput) {
    setBackendError(null);
    try {
      console.log("[LOCK-SCREEN] Attempting unlock...");
      const session = normalizeSession(await invoke<UnlockResponse>("unlock", input));
      console.log("[LOCK-SCREEN] Unlock success:", JSON.stringify(session));
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
      setFailedAttempts(0);
      setLockedUntil(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[LOCK-SCREEN] Unlock error:", message);

      // Check if wiped
      if (message.includes("data wiped")) {
        setIsWiped(true);
        setBackendError(null);
        return;
      }

      // Check for lockout with timestamp
      const until = extractLockedUntil(message);
      if (until) {
        setLockedUntil(until);
        setBackendError(null);
        return;
      }

      const backendAttempts = extractAttemptCount(message);
      setFailedAttempts((current) => backendAttempts ?? current + 1);
      setBackendError(message);
    }
  }

  // Wiped state — must use recovery
  if (isWiped) {
    return (
      <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
          <div className="w-full rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-red-300">Data wiped</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                  Recovery required
                </h1>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/10">
                <img
                  src={logo}
                  alt=""
                  className="h-10 w-10 rounded-xl"
                />
              </div>
            </div>

            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm leading-6 text-red-200">
              <p className="font-medium">Too many failed attempts — data has been wiped.</p>
              <p className="mt-1 text-red-300/80">
                You must use your recovery passphrase to restore your data and set a new PIN.
              </p>
            </div>

            <button
              className={`${buttonClass} mt-6`}
              type="button"
              onClick={() => setPhase("restore-recovery")}
            >
              Use recovery passphrase
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
        <form
          className="w-full rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8"
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-indigo-300">PaintKiDukaan</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Enter your PIN
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                Enter the 6-digit PIN to unlock the shop database.
              </p>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          {/* Error display */}
          {backendError ? (
            <div
              className="mb-5 flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{backendError}</span>
            </div>
          ) : null}

          {/* Lockout timer */}
          {lockedUntil ? (
            <div
              className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"
              role="alert"
            >
              <Timer className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-amber-200">Too many failed attempts</p>
                <p className="mt-0.5 text-xs text-amber-300/80">{timeDisplay}</p>
              </div>
            </div>
          ) : null}

          {/* PIN input */}
          <label className="text-sm font-medium text-zinc-200" htmlFor="pin">
            Owner PIN
          </label>
          <div className="relative mt-2">
            <input
              id="pin"
              className={inputClass}
              aria-label="Six digit PIN"
              aria-invalid={Boolean(errors.pin)}
              autoComplete="off"
              inputMode="numeric"
              maxLength={6}
              placeholder="••••••"
              type="password"
              disabled={!!lockedUntil}
              {...register("pin")}
            />
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
          </div>
          {errors.pin?.message ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-sm text-red-400" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              {errors.pin.message}
            </p>
          ) : null}

          {/* Attempt counter */}
          <div className="mt-4 min-h-12 text-sm text-zinc-400">
            {failedAttempts > 0 && !lockedUntil ? (
              <p role="alert">
                Failed attempts: <span className="font-medium text-zinc-200">{failedAttempts}</span>/5
                {failedAttempts >= 3 && (
                  <span className="ml-2 text-amber-300">
                    — more failures will lock you out
                  </span>
                )}
              </p>
            ) : (
              <p>Your PIN stays in memory only. It is never stored in plain text.</p>
            )}
          </div>

          <button
            className={`${buttonClass} mt-5`}
            type="submit"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {lockedUntil ? "Please wait..." : "Unlock"}
          </button>

          <button
            className="mt-5 w-full text-center text-sm font-medium text-indigo-300 transition-colors duration-150 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            type="button"
            onClick={() => setPhase("restore-recovery")}
          >
            Forgot PIN? Use recovery passphrase
          </button>
        </form>
      </section>
    </main>
  );
}
