import { zodResolver } from "@hookform/resolvers/zod";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, KeyRound, Loader2, Lock } from "lucide-react";
import { useState } from "react";
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
  const name = result.user?.name ?? result.user_name ?? result.user?.name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null
    ? null
    : { id, name, role };
  return { user, locked: result.locked ?? false };
}

function extractAttemptCount(message: string): number | null {
  const match = message.match(/(?:attempts?|failed)\D*(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function LockScreen() {
  const [backendError, setBackendError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
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
  const canSubmit = unlockSchema.safeParse({ pin }).success;

  async function onSubmit(input: UnlockInput) {
    setBackendError(null);
    try {
      const session = normalizeSession(await invoke<UnlockResponse>("unlock", input));
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
      setFailedAttempts(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backendAttempts = extractAttemptCount(message);
      setFailedAttempts((current) => backendAttempts ?? current + 1);
      setBackendError(message);
    }
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
              <p className="text-sm font-medium text-indigo-300">Secure database locked</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Enter owner PIN</h1>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-300">
              <Lock className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {backendError ? (
            <div
              className="mb-5 flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{backendError}</span>
            </div>
          ) : null}

          <label className="text-sm font-medium text-zinc-200" htmlFor="pin">
            PIN
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

          <div className="mt-4 min-h-12 text-sm text-zinc-400">
            {failedAttempts > 0 ? (
              <p role="alert">
                Failed attempts: <span className="font-medium text-zinc-200">{failedAttempts}</span>/5
              </p>
            ) : (
              <p>Unlocking keeps the SQLCipher key in memory only for this session.</p>
            )}
            {failedAttempts >= 5 ? (
              <p className="mt-2 font-medium text-red-300" role="alert">
                Locked out. Wait 5 minutes or contact support.
              </p>
            ) : null}
          </div>

          <button className={`${buttonClass} mt-5`} type="submit" disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Unlock
          </button>

          <button
            className="mt-5 w-full text-center text-sm font-medium text-indigo-300 transition-colors duration-150 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            type="button"
            onClick={() => setPhase("restore-recovery")}
          >
            Use recovery passphrase instead
          </button>
        </form>
      </section>
    </main>
  );
}
