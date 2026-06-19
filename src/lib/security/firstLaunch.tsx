import { zodResolver } from "@hookform/resolvers/zod";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  addressSchema,
  firstLaunchSchema,
  type FirstLaunchInput,
  phoneSchema,
  pinSchema,
  recoveryPassphraseSchema,
  shopNameSchema,
} from "./pin";
import { type Role, type Session, useSecurity } from "./state";

type SetupResponse = Partial<Session> & { user?: string; role?: Role };
type Step = 0 | 1 | 2;

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-sm text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const labelClass = "text-sm font-medium text-zinc-200";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function normalizeSession(result: SetupResponse): Session {
  return {
    user_id: result.user_id ?? 0,
    user_name: result.user_name ?? result.user ?? "Owner",
    role: result.role ?? "owner",
  };
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

export function FirstLaunch() {
  const [step, setStep] = useState<Step>(0);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const {
    register,
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    trigger,
  } = useForm<FirstLaunchInput>({
    resolver: zodResolver(firstLaunchSchema),
    mode: "onChange",
    defaultValues: {
      pin: "",
      pinConfirm: "",
      passphrase: "",
      passphraseConfirm: "",
      shopName: "",
      address: "",
      phone: "",
    },
  });

  const values = useWatch({ control });
  const shopStepValid =
    shopNameSchema.safeParse(values.shopName ?? "").success &&
    addressSchema.safeParse(values.address ?? "").success &&
    phoneSchema.safeParse(values.phone ?? "").success;
  const pinStepValid =
    pinSchema.safeParse(values.pin ?? "").success &&
    pinSchema.safeParse(values.pinConfirm ?? "").success &&
    values.pin === values.pinConfirm;
  const recoveryStepValid =
    recoveryPassphraseSchema.safeParse(values.passphrase ?? "").success &&
    recoveryPassphraseSchema.safeParse(values.passphraseConfirm ?? "").success &&
    values.passphrase === values.passphraseConfirm;

  const canContinue = [shopStepValid, pinStepValid, recoveryStepValid][step];
  const stepFields = [
    ["shopName", "address", "phone"],
    ["pin", "pinConfirm"],
    ["passphrase", "passphraseConfirm"],
  ] as const;

  async function goNext() {
    const ok = await trigger(stepFields[step]);
    if (ok) setStep((current) => Math.min(current + 1, 2) as Step);
  }

  async function onSubmit(input: FirstLaunchInput) {
    setBackendError(null);
    try {
      const session = normalizeSession(await invoke<SetupResponse>("first_launch_setup", input));
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
              <p className="text-sm font-medium text-indigo-300">PaintKiDukaan security</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                First-launch setup
              </h1>
            </div>
            <ShieldCheck className="h-8 w-8 text-emerald-400" aria-hidden="true" />
          </div>

          <button
            className="mb-5 flex w-full items-start justify-between rounded-xl border border-white/10 bg-zinc-950/60 p-3 text-left text-sm text-zinc-300 transition-colors duration-150 hover:bg-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            type="button"
            onClick={() => setShowWhy((open) => !open)}
            aria-expanded={showWhy}
          >
            <span>
              <span className="block font-medium text-zinc-100">Why we need this</span>
              {showWhy ? (
                <span className="mt-1 block leading-6 text-zinc-400">
                  Your PIN unlocks the app daily. Your recovery passphrase is the ONLY way to
                  recover your data if you forget your PIN.
                </span>
              ) : null}
            </span>
            <KeyRound className="mt-0.5 h-4 w-4 text-indigo-300" aria-hidden="true" />
          </button>

          <div className="mb-6 flex items-center gap-2" aria-label="Setup progress">
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className={
                  dot < step
                    ? "h-2.5 flex-1 rounded-full bg-emerald-500"
                    : dot === step
                      ? "h-2.5 flex-1 rounded-full bg-indigo-500"
                      : "h-2.5 flex-1 rounded-full bg-zinc-800"
                }
              />
            ))}
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
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="shopName">
                  Shop name
                </label>
                <input
                  id="shopName"
                  className={inputClass}
                  aria-label="Shop name"
                  aria-invalid={Boolean(errors.shopName)}
                  autoComplete="organization"
                  placeholder="Paint shop name"
                  {...register("shopName")}
                />
                {fieldError(errors.shopName?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="address">
                  Address
                </label>
                <textarea
                  id="address"
                  className={`${inputClass} min-h-24 py-3`}
                  aria-label="Shop address"
                  aria-invalid={Boolean(errors.address)}
                  autoComplete="street-address"
                  placeholder="Full shop address"
                  {...register("address")}
                />
                {fieldError(errors.address?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="phone">
                  Phone
                </label>
                <input
                  id="phone"
                  className={inputClass}
                  aria-label="Shop phone number"
                  aria-invalid={Boolean(errors.phone)}
                  autoComplete="tel"
                  inputMode="tel"
                  placeholder="9876543210"
                  {...register("phone")}
                />
                {fieldError(errors.phone?.message)}
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="pin">
                  Owner PIN
                </label>
                <input
                  id="pin"
                  className={inputClass}
                  aria-label="Owner PIN"
                  aria-invalid={Boolean(errors.pin)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 digits"
                  type="password"
                  {...register("pin")}
                />
                {fieldError(errors.pin?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="pinConfirm">
                  Confirm PIN
                </label>
                <input
                  id="pinConfirm"
                  className={inputClass}
                  aria-label="Confirm owner PIN"
                  aria-invalid={Boolean(errors.pinConfirm)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Repeat PIN"
                  type="password"
                  {...register("pinConfirm")}
                />
                {fieldError(errors.pinConfirm?.message)}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="passphrase">
                  Recovery passphrase
                </label>
                <div className="relative">
                  <input
                    id="passphrase"
                    className={`${inputClass} pr-11`}
                    aria-label="Recovery passphrase"
                    aria-invalid={Boolean(errors.passphrase)}
                    autoComplete="off"
                    placeholder="At least 12 characters"
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
              <div>
                <label className={labelClass} htmlFor="passphraseConfirm">
                  Confirm recovery passphrase
                </label>
                <input
                  id="passphraseConfirm"
                  className={inputClass}
                  aria-label="Confirm recovery passphrase"
                  aria-invalid={Boolean(errors.passphraseConfirm)}
                  autoComplete="off"
                  placeholder="Repeat passphrase"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphraseConfirm")}
                />
                {fieldError(errors.passphraseConfirm?.message)}
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex gap-3">
            {step > 0 ? (
              <button className={ghostButtonClass} type="button" onClick={() => setStep((step - 1) as Step)}>
                Back
              </button>
            ) : null}
            {step < 2 ? (
              <button className={`${buttonClass} flex-1`} type="button" onClick={goNext} disabled={!canContinue}>
                Next
              </button>
            ) : (
              <button className={`${buttonClass} flex-1`} type="submit" disabled={!canContinue || isSubmitting}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Finish setup
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
