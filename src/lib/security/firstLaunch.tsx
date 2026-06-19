import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import {
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShoppingBag,
  Lock,
  FileKey,
} from "lucide-react";
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
import { type Role, type Session, type User, useSecurity } from "./state";

interface SetupResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}
type Step = 0 | 1 | 2;

const STEPS = [
  { label: "Shop Details", icon: ShoppingBag, description: "Basic information about your shop" },
  { label: "Owner PIN", icon: Lock, description: "Set a 6-digit PIN to lock and unlock the app" },
  { label: "Recovery Passphrase", icon: FileKey, description: "A secret phrase to recover your data if you forget your PIN" },
] as const;

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-sm text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const labelClass = "text-sm font-medium text-zinc-200";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function normalizeSession(result: SetupResponse): Session {
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

export function FirstLaunch() {
  const [step, setStep] = useState<Step>(0);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);

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
      const session = normalizeSession(
        await invoke<SetupResponse>("first_launch_setup", {
          pin: input.pin,
          passphrase: input.passphrase,
          shop_name: input.shopName,
          address: input.address,
          phone: input.phone,
        }),
      );
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  }

  const CurrentStepIcon = STEPS[step].icon;

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
        <form
          className="w-full rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8"
          onSubmit={handleSubmit(onSubmit)}
        >
          {/* Header */}
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-indigo-300">PaintKiDukaan</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Set up your shop
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                A few quick steps to get your shop management system running.
              </p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-300">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {/* Step indicator with labels */}
          <div className="mb-6" aria-label="Setup progress">
            <div className="flex items-center gap-2 mb-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-2"
                >
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors duration-200 ${
                      i < step
                        ? "bg-emerald-500 text-white"
                        : i === step
                          ? "bg-indigo-500 text-white"
                          : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {i < step ? "✓" : i + 1}
                  </div>
                  <span
                    className={`text-xs font-medium hidden sm:inline ${
                      i === step ? "text-zinc-100" : "text-zinc-500"
                    }`}
                  >
                    {STEPS[i].label}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ${
                    i < step
                      ? "bg-emerald-500"
                      : i === step
                        ? "bg-indigo-500"
                        : "bg-zinc-800"
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Step description */}
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/60 p-3">
            <CurrentStepIcon className="h-5 w-5 shrink-0 text-indigo-300" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-zinc-100">{STEPS[step].label}</p>
              <p className="text-xs text-zinc-400">{STEPS[step].description}</p>
            </div>
          </div>

          {/* Backend error */}
          {backendError ? (
            <div
              className="mb-5 flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{backendError}</span>
            </div>
          ) : null}

          {/* Step 0: Shop Details */}
          {step === 0 ? (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="shopName">
                  Shop name *
                </label>
                <input
                  id="shopName"
                  className={inputClass}
                  aria-label="Shop name"
                  aria-invalid={Boolean(errors.shopName)}
                  autoComplete="organization"
                  placeholder="e.g. Paint World"
                  {...register("shopName")}
                />
                <p className="mt-1 text-xs text-zinc-500">The name of your paint shop or business.</p>
                {fieldError(errors.shopName?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="address">
                  Address *
                </label>
                <textarea
                  id="address"
                  className={`${inputClass} min-h-20 py-3`}
                  aria-label="Shop address"
                  aria-invalid={Boolean(errors.address)}
                  autoComplete="street-address"
                  placeholder="Full address including city and PIN code"
                  {...register("address")}
                />
                {fieldError(errors.address?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="phone">
                  Phone number *
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
                <p className="mt-1 text-xs text-zinc-500">10-digit Indian mobile number.</p>
                {fieldError(errors.phone?.message)}
              </div>
            </div>
          ) : null}

          {/* Step 1: Owner PIN */}
          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="pin">
                  Create owner PIN *
                </label>
                <input
                  id="pin"
                  className={inputClass}
                  aria-label="Owner PIN"
                  aria-invalid={Boolean(errors.pin)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 digits (e.g. 123456)"
                  type="password"
                  {...register("pin")}
                />
                <p className="mt-1 text-xs text-zinc-500">
                  This PIN will be used every time you open the app. Only you (the owner) know this.
                </p>
                {fieldError(errors.pin?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="pinConfirm">
                  Confirm PIN *
                </label>
                <input
                  id="pinConfirm"
                  className={inputClass}
                  aria-label="Confirm owner PIN"
                  aria-invalid={Boolean(errors.pinConfirm)}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Re-enter the same PIN"
                  type="password"
                  {...register("pinConfirm")}
                />
                {fieldError(errors.pinConfirm?.message)}
              </div>
            </div>
          ) : null}

          {/* Step 2: Recovery Passphrase */}
          {step === 2 ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-sm font-medium text-amber-200">Important — read this first</p>
                <p className="mt-1 text-xs leading-5 text-amber-200/80">
                  Your recovery passphrase is the <strong>only way</strong> to regain access if you
                  forget your PIN. Write it down and store it somewhere safe (not on this device).
                  We cannot recover it for you.
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="passphrase">
                  Recovery passphrase *
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
                    aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  >
                    {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Use a memorable sentence, e.g. "my shop opened in 2024 summer"
                </p>
                {fieldError(errors.passphrase?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="passphraseConfirm">
                  Confirm recovery passphrase *
                </label>
                <input
                  id="passphraseConfirm"
                  className={inputClass}
                  aria-label="Confirm recovery passphrase"
                  aria-invalid={Boolean(errors.passphraseConfirm)}
                  autoComplete="off"
                  placeholder="Re-enter the same passphrase"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphraseConfirm")}
                />
                {fieldError(errors.passphraseConfirm?.message)}
              </div>
            </div>
          ) : null}

          {/* Navigation buttons */}
          <div className="mt-6 flex gap-3">
            {step > 0 ? (
              <button
                className={ghostButtonClass}
                type="button"
                onClick={() => setStep((step - 1) as Step)}
              >
                Back
              </button>
            ) : null}
            {step < 2 ? (
              <button
                className={`${buttonClass} flex-1`}
                type="button"
                onClick={goNext}
                disabled={!canContinue}
              >
                Continue
              </button>
            ) : (
              <button
                className={`${buttonClass} flex-1`}
                type="submit"
                disabled={!canContinue || isSubmitting}
              >
                {isSubmitting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                Complete setup
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
