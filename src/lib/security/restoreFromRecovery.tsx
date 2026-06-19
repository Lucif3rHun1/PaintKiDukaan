import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-64.png";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  pinSchema,
  recoveryPassphraseSchema,
  restoreFromRecoverySchema,
  type RestoreFromRecoveryInput,
} from "./pin";
import { type Role, type Session, type User, useSecurity } from "./state";

interface RestoreResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-sm text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const labelClass = "text-sm font-medium text-zinc-200";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function normalizeSession(result: RestoreResponse): Session {
  const role: Role = result.user?.role ?? result.role ?? "owner";
  const name = result.user?.name ?? result.user_name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null ? null : { id, name, role };
  return { user, locked: result.locked ?? false };
}

function fieldError(message?: string) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-red-400" role="alert">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {message}
    </p>
  );
}

export function RestoreFromRecovery() {
  const [step, setStep] = useState<0 | 1>(0);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const setPhase = useSecurity((state) => state.setPhase);

  const {
    register,
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    trigger,
  } = useForm<RestoreFromRecoveryInput>({
    resolver: zodResolver(restoreFromRecoverySchema),
    mode: "onChange",
    defaultValues: {
      passphrase: "",
      newPin: "",
      newPinConfirm: "",
    },
  });

  const values = useWatch({ control });
  const passphraseValid = recoveryPassphraseSchema.safeParse(values.passphrase ?? "").success;
  const pinStepValid =
    pinSchema.safeParse(values.newPin ?? "").success &&
    pinSchema.safeParse(values.newPinConfirm ?? "").success &&
    values.newPin === values.newPinConfirm;

  async function goNext() {
    const ok = await trigger("passphrase");
    if (ok) setStep(1);
  }

  async function onSubmit(input: RestoreFromRecoveryInput) {
    setBackendError(null);
    try {
      const session = normalizeSession(
        await invoke<RestoreResponse>("restore_from_recovery", {
          passphrase: input.passphrase,
          new_pin: input.newPin,
        }),
      );
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
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
              <p className="text-sm font-medium text-indigo-300">Recovery access</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Restore with passphrase
              </h1>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          <div className="mb-6 flex items-center gap-2" aria-label="Recovery progress">
            <span className={step === 0 ? "h-2.5 flex-1 rounded-full bg-indigo-500" : "h-2.5 flex-1 rounded-full bg-emerald-500"} />
            <span className={step === 1 ? "h-2.5 flex-1 rounded-full bg-indigo-500" : "h-2.5 flex-1 rounded-full bg-zinc-800"} />
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

          {step === 0 ? (
            <div>
              <label className={labelClass} htmlFor="passphrase">
                Recovery passphrase
              </label>
              <div className="relative mt-2">
                <input
                  id="passphrase"
                  className={`${inputClass} pr-11`}
                  aria-label="Recovery passphrase"
                  aria-invalid={Boolean(errors.passphrase)}
                  autoComplete="off"
                  placeholder="Enter recovery passphrase"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphrase")}
                />
                <button
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-zinc-400 transition-colors duration-150 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  type="button"
                  onClick={() => setShowPassphrase((visible) => !visible)}
                  aria-label={showPassphrase ? "Hide recovery passphrase" : "Show recovery passphrase"}
                >
                  {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {fieldError(errors.passphrase?.message)}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="newPin">
                  New owner PIN
                </label>
                <input
                  id="newPin"
                  className={inputClass}
                  aria-label="New owner PIN"
                  aria-invalid={Boolean(errors.newPin)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 digits"
                  type="password"
                  {...register("newPin")}
                />
                {fieldError(errors.newPin?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="newPinConfirm">
                  Confirm new PIN
                </label>
                <input
                  id="newPinConfirm"
                  className={inputClass}
                  aria-label="Confirm new owner PIN"
                  aria-invalid={Boolean(errors.newPinConfirm)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Repeat PIN"
                  type="password"
                  {...register("newPinConfirm")}
                />
                {fieldError(errors.newPinConfirm?.message)}
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex gap-3">
            {step === 1 ? (
              <button className={ghostButtonClass} type="button" onClick={() => setStep(0)}>
                Back
              </button>
            ) : null}
            {step === 0 ? (
              <button className={`${buttonClass} flex-1`} type="button" onClick={goNext} disabled={!passphraseValid}>
                Next
              </button>
            ) : (
              <button className={`${buttonClass} flex-1`} type="submit" disabled={!pinStepValid || isSubmitting}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Restore and unlock
              </button>
            )}
          </div>

          <button
            className="mt-5 w-full text-center text-sm font-medium text-indigo-300 transition-colors duration-150 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            type="button"
            onClick={() => setPhase("locked")}
          >
            Back to PIN entry
          </button>
        </form>
      </section>
    </main>
  );
}
