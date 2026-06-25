import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-64.png";
import { AlertCircle, KeyRound, Loader2, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import type { PinRole } from "../../domain/types";
import { isAppError } from "../../domain/types";
import { type UnlockInput, unlockSchema } from "./pin";
import { type Role, type Session, type User, useSecurity } from "./state";

interface UnlockResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
  pin_role?: PinRole;
  wipe_triggered?: boolean;
}

function normalizeSession(result: UnlockResponse): Session {
  const role: Role = result.user?.role ?? result.role ?? "stocker";
  const name = result.user?.name ?? result.user_name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null ? null : { id, name, role };
  const pinRole: PinRole = result.pin_role ?? "real";
  return { user, locked: result.locked ?? false, pinRole };
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
  const lastUser = useSecurity((state) => state.session?.user);

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
      const session = normalizeSession(await invoke<UnlockResponse>("unlock", input));
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
      setFailedAttempts(0);
      setLockedUntil(null);
    } catch (error) {
      if (isAppError(error) && error.code === "wiped") {
        setIsWiped(true);
        setBackendError(null);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
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
      <main className="flex h-screen w-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-destructive/10">
              <img src={logo} alt="" className="h-14 w-14 rounded-xl" />
            </div>
            <p className="text-sm font-semibold uppercase tracking-[3px] text-destructive">Data wiped</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Recovery required</h1>
          </div>
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm leading-6 text-destructive">
            <p className="font-medium">Too many failed attempts — data has been wiped.</p>
            <p className="mt-1.5 text-destructive/80">
              You must use your recovery passphrase to restore your data and set a new PIN.
            </p>
          </div>
          <button
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            type="button"
            onClick={() => setPhase("restore-recovery")}
          >
            Use recovery passphrase
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen w-screen bg-background text-foreground">
      {/* Left: branding panel */}
      <div className="relative hidden w-1/2 items-center justify-center bg-zinc-900 lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(#3f3f46_1px,transparent_1px)] bg-[length:4px_4px] opacity-30" />
        <div className="relative z-10 flex flex-col items-center text-center">
          <img src={logo} alt="PaintKiDukaan" className="mb-6 h-24 w-24 rounded-2xl shadow-2xl" />
          <h1 className="text-4xl font-bold tracking-tight text-white">PaintKiDukaan</h1>
          <p className="mt-2 text-sm font-medium uppercase tracking-[4px] text-zinc-400">Paint Shop Manager</p>
          <div className="mt-8 flex items-center gap-2 text-xs text-zinc-500">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Secure &amp; Encrypted
          </div>
        </div>
      </div>

      {/* Right: PIN form */}
      <div className="flex w-full items-center justify-center px-6 lg:w-1/2">
        <form className="w-full max-w-md space-y-6" onSubmit={handleSubmit(onSubmit)}>
          {/* Mobile branding */}
          <div className="flex flex-col items-center text-center lg:hidden">
            <img src={logo} alt="PaintKiDukaan" className="mb-3 h-16 w-16 rounded-xl" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">PaintKiDukaan</h1>
          </div>

          {/* Welcome */}
          <div>
            {lastUser ? (
              <>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  Welcome back, {lastUser.name}
                </h2>
                <div className="mt-2 inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary ring-1 ring-primary/20">
                  {lastUser.role}
                </div>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">Enter your PIN</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">Unlock the shop database</p>
              </>
            )}
          </div>

          {/* Error */}
          {backendError ? (
            <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="leading-snug">{backendError}</span>
            </div>
          ) : null}

          {/* Lockout */}
          {lockedUntil ? (
            <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4" role="alert">
              <Timer className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-warning">Account locked</p>
                <p className="mt-0.5 text-sm text-warning/80">{timeDisplay}</p>
              </div>
            </div>
          ) : null}

          {/* PIN input */}
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground" htmlFor="pin">
              Owner PIN
            </label>
            <div className="relative">
              <input
                id="pin"
                className="h-14 w-full rounded-xl border-2 border-border bg-background px-4 text-center text-2xl font-semibold tracking-[0.5em] text-foreground outline-none transition-all duration-150 placeholder:text-muted-foreground/60 focus:border-primary focus:ring-4 focus:ring-primary/20 disabled:opacity-50"
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
              <KeyRound className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground/60" aria-hidden="true" />
            </div>
            {errors.pin?.message ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive" role="alert">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                {errors.pin.message}
              </p>
            ) : null}
          </div>

          {/* Attempt counter */}
          <div className="min-h-[48px] text-sm text-muted-foreground">
            {failedAttempts > 0 && !lockedUntil ? (
              <p role="alert" className="rounded-lg bg-muted/50 px-4 py-3">
                Failed attempts: <span className="font-semibold text-foreground">{failedAttempts}</span>/5
                {failedAttempts >= 3 && (
                  <span className="ml-2 text-warning">— more failures will lock you out</span>
                )}
              </p>
            ) : (
              <p className="px-1 text-muted-foreground/80">Your PIN stays in memory only. Never stored in plain text.</p>
            )}
          </div>

          {/* Submit */}
          <button
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            type="submit"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {lockedUntil ? "Please wait..." : "Unlock"}
          </button>

          <button
            className="w-full text-center text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            type="button"
            onClick={() => setPhase("restore-recovery")}
          >
            Forgot PIN? Use recovery passphrase
          </button>
        </form>
      </div>
    </main>
  );
}
