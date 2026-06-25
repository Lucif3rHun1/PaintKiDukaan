import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-64.png";
import {
  AlertCircle,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
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
import { FirstLaunchRestore } from "./firstLaunchRestore";
import { type Role, type Session, type User, useSecurity } from "./state";

interface SetupResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}
type Step = "path" | "shop" | "pin" | "passphrase";
type FreshStep = Exclude<Step, "path">;

const STEPS = [
  { key: "path", label: "Setup Path", icon: ShoppingBag, description: "Choose how you want to start PaintKiDukaan" },
  { label: "Shop Details", icon: ShoppingBag, description: "Basic information about your shop" },
  { label: "Owner PIN", icon: Lock, description: "Set a 6-digit PIN to lock and unlock the app" },
  { label: "Recovery Passphrase", icon: FileKey, description: "A secret phrase to recover your data if you forget your PIN" },
] as const;
const FRESH_STEP_INDEX: Record<FreshStep, 0 | 1 | 2> = {
  shop: 0,
  pin: 1,
  passphrase: 2,
};
const NEXT_STEP: Record<FreshStep, FreshStep> = {
  shop: "pin",
  pin: "passphrase",
  passphrase: "passphrase",
};
const PREVIOUS_STEP: Record<FreshStep, Step> = {
  shop: "path",
  pin: "shop",
  passphrase: "pin",
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const labelClass = "text-sm font-medium text-foreground";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-all duration-150 hover:bg-primary/90 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-border bg-background px-5 text-sm font-medium text-foreground shadow-sm transition-all duration-150 hover:bg-muted active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

function normalizeSession(result: SetupResponse): Session {
  const role: Role = result.user?.role ?? result.role ?? "stocker";
  const name = result.user?.name ?? result.user_name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null ? null : { id, name, role };
  return { user, locked: result.locked ?? false, pinRole: "real" };
}

function fieldError(message?: string) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive" role="alert">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {message}
    </p>
  );
}

export function FirstLaunch() {
  const [step, setStep] = useState<Step>("path");
  const [showRestore, setShowRestore] = useState(false);
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

  const currentFreshIndex = step === "path" ? 0 : FRESH_STEP_INDEX[step];
  const canContinue = step === "path" ? false : [shopStepValid, pinStepValid, recoveryStepValid][currentFreshIndex];
  const stepFields: Record<FreshStep, readonly (keyof FirstLaunchInput)[]> = {
    shop: ["shopName", "address", "phone"],
    pin: ["pin", "pinConfirm"],
    passphrase: ["passphrase", "passphraseConfirm"],
  };

  async function goNext() {
    if (step === "path") return;
    const ok = await trigger(stepFields[step]);
    if (ok) setStep(NEXT_STEP[step]);
  }

  async function onSubmit(input: FirstLaunchInput) {
    setBackendError(null);
    try {
      console.log("[FIRST-LAUNCH] Submitting first_launch_setup...");
      const session = normalizeSession(
        await invoke<SetupResponse>("first_launch_setup", {
          pin: input.pin,
          passphrase: input.passphrase,
          shop_name: input.shopName,
          address: input.address,
          phone: input.phone,
        }),
      );
      console.log("[FIRST-LAUNCH] Setup complete, session:", JSON.stringify(session));
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
    } catch (error) {
      console.error("[FIRST-LAUNCH] Setup failed:", error);
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  }

  if (showRestore) {
    return <FirstLaunchRestore onCancel={() => {
      setShowRestore(false);
      setStep("path");
    }} />;
  }

  const currentStepMeta = step === "path" ? STEPS[0] : STEPS[currentFreshIndex + 1];
  const CurrentStepIcon = currentStepMeta.icon;
  const stepNumber = step === "path" ? 0 : currentFreshIndex + 1;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
        <form
          className="w-full rounded-2xl border border-border bg-card/80 p-6 shadow-2xl shadow-background/40 backdrop-blur sm:p-8"
          onSubmit={handleSubmit(onSubmit)}
        >
          {/* Header */}
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">PaintKiDukaan</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                Set up your shop
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                A few quick steps to get your shop management system running.
              </p>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          {/* Step indicator */}
          <div className="mb-6" aria-label="Setup progress">
            <div className="flex items-center gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-1 items-center gap-1.5">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all duration-200 ${
                      i < stepNumber
                        ? "bg-success text-success-foreground"
                        : i === stepNumber
                          ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i < stepNumber ? "✓" : i + 1}
                  </div>
                  {i < 3 && (
                    <div className={`h-0.5 flex-1 rounded-full transition-all duration-200 ${i < stepNumber - 1 ? "bg-success" : "bg-muted"}`} />
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[10px] font-medium text-muted-foreground">
              {STEPS.map((s, i) => (
                <span key={i} className={i === stepNumber ? "text-foreground" : ""}>{s.label}</span>
              ))}
            </div>
          </div>

          {/* Step description */}
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CurrentStepIcon className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{currentStepMeta.label}</p>
              <p className="text-xs text-muted-foreground">{currentStepMeta.description}</p>
            </div>
          </div>

          {/* Backend error */}
          {backendError ? (
            <div
              className="mb-5 flex gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="leading-snug">{backendError}</span>
            </div>
          ) : null}

          {step === "path" ? (
            <div className="space-y-3">
              <button
                className="group flex w-full items-start gap-4 rounded-xl border border-border bg-background p-4 text-left shadow-sm transition-all duration-150 hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                type="button"
                onClick={() => setStep("shop")}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-150 group-hover:bg-primary group-hover:text-primary-foreground">
                  <ShoppingBag className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-foreground">Set up a new shop</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Start fresh with a new shop. You'll set your shop details, owner PIN, and recovery passphrase.
                  </span>
                </span>
              </button>
              <button
                className="group flex w-full items-start gap-4 rounded-xl border border-border bg-background p-4 text-left shadow-sm transition-all duration-150 hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                type="button"
                onClick={() => setShowRestore(true)}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-150 group-hover:bg-primary group-hover:text-primary-foreground">
                  <HardDrive className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-foreground">Restore from a backup</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Restore from a .pkb1 backup file. Use this if you previously backed up and want to continue.
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          {step === "shop" ? (
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
                <p className="mt-1 text-xs text-muted-foreground">The name of your paint shop or business.</p>
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
                <p className="mt-1 text-xs text-muted-foreground">10-digit Indian mobile number.</p>
                {fieldError(errors.phone?.message)}
              </div>
            </div>
          ) : null}

          {step === "pin" ? (
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
                <p className="mt-1 text-xs text-muted-foreground">
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

          {step === "passphrase" ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
                <p className="text-sm font-semibold text-warning">Important — read this first</p>
                <p className="mt-1.5 text-xs leading-5 text-warning/90">
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
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                    onClick={() => setShowPassphrase((visible) => !visible)}
                    aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  >
                    {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
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
          {step !== "path" ? (
            <div className="mt-6 flex gap-3">
              <button
                className={ghostButtonClass}
                type="button"
                onClick={() => setStep(PREVIOUS_STEP[step])}
              >
                Back
              </button>
              {step !== "passphrase" ? (
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
          ) : null}
        </form>
      </section>
    </main>
  );
}
