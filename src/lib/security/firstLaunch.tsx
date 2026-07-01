import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-128.png";
import {
  AlertCircle,
  ChevronRight,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  ShoppingBag,
  Lock,
  FileKey,
  Check,
  Package,
  Store,
  Warehouse,
  Shield,
} from "lucide-react";
import { useCallback, useState } from "react";
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
import { PdeSetupWizard } from "./pdeSetup";
import { type Role, type Session, type User, useSecurity } from "./state";

interface SetupResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}
type Step = "path" | "shop" | "pin" | "passphrase" | "inventory" | "pde"
type FreshStep = Exclude<Step, "path">

const STEPS = [
  { key: "path", label: "Get Started", shortLabel: "Start", icon: Store, description: "Choose how you want to start PaintKiDukaan" },
  { label: "Shop", shortLabel: "Shop", icon: ShoppingBag, description: "Basic information about your shop" },
  { label: "Security", shortLabel: "PIN", icon: Lock, description: "Set a 6-digit PIN to lock and unlock the app" },
  { label: "Recovery", shortLabel: "Recov...", icon: FileKey, description: "A secret phrase to recover your data if you forget your PIN" },
  { label: "Inventory", shortLabel: "Inven...", icon: Package, description: "Your inventory setup" },
  { label: "Emergency", shortLabel: "Emerg...", icon: Shield, description: "Emergency protection" },
] as const;
const FRESH_STEP_INDEX: Record<FreshStep, number> = {
  shop: 0,
  pin: 1,
  passphrase: 2,
  inventory: 3,
  pde: 4,
};
const NEXT_STEP: Record<FreshStep, FreshStep> = {
  shop: "pin",
  pin: "passphrase",
  passphrase: "inventory",
  inventory: "pde",
  pde: "pde",
};
const PREVIOUS_STEP: Record<FreshStep, Step> = {
  shop: "path",
  pin: "shop",
  passphrase: "pin",
  inventory: "passphrase",
  pde: "inventory",
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
const labelClass = "text-[13px] font-medium text-foreground";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-all duration-150 hover:bg-primary/90 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-border bg-background px-5 text-sm font-medium text-foreground shadow-sm transition-all duration-150 hover:bg-muted active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

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
    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive" role="alert">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <nav className="w-full" aria-label="Setup progress">
      <ol className="flex w-full items-start">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={i} className="relative flex min-w-0 flex-1 flex-col items-center gap-2">
            {i < STEPS.length - 1 ? (
              <div className={`absolute left-1/2 right-[-50%] top-[18px] h-0.5 ${done ? "bg-success" : "bg-border"}`} />
            ) : null}
              <div
                className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold shadow-sm transition-all duration-200 ${
                  done
                    ? "bg-success text-success-foreground"
                    : active
                      ? "bg-primary text-primary-foreground ring-4 ring-primary/20"
                      : "bg-muted text-muted-foreground ring-1 ring-border"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {done ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
              </div>
              <span
                className={`max-w-12 truncate text-center text-[11px] font-medium leading-none sm:max-w-none sm:text-xs ${active ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span className="sm:hidden">{s.shortLabel}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </span>
          </li>
        );
      })}
      </ol>
    </nav>
  );
}

export function FirstLaunch() {
  const [step, setStep] = useState<Step>("path");
  const [showRestore, setShowRestore] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [sessionData, setSessionData] = useState<Session | null>(null);

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
      gstin: "",
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
  const canContinue = step === "path" ? false : [shopStepValid, pinStepValid, recoveryStepValid, true, true][currentFreshIndex];
  const stepFields: Record<FreshStep, readonly (keyof FirstLaunchInput)[]> = {
    shop: ["shopName", "address", "phone"],
    pin: ["pin", "pinConfirm"],
    passphrase: ["passphrase", "passphraseConfirm"],
    inventory: [],
    pde: [],
  };

  async function goNext() {
    if (step === "path") return;
    const ok = await trigger(stepFields[step]);
    if (ok) setStep(NEXT_STEP[step]);
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
          gstin: input.gstin || null,
        }),
      );
      setSessionData(session);
      setStep("pde");
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  }

  const finalizeSetup = useCallback(() => {
    if (sessionData) {
      const security = useSecurity.getState();
      security.setSession(sessionData);
      security.setPhase("unlocked");
    }
  }, [sessionData]);

  if (showRestore) {
    return (
      <FirstLaunchRestore
        onCancel={() => {
          setShowRestore(false);
          setStep("path");
        }}
      />
    );
  }

  const stepNumber = step === "path" ? 0 : currentFreshIndex + 1;

  return (
    <main className="flex h-screen w-screen bg-background text-foreground">
      {/* Left: branding panel */}
      <div className="relative hidden w-1/2 items-center justify-center bg-zinc-900 lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(#3f3f46_1px,transparent_1px)] bg-[length:4px_4px] opacity-30" />
        <div className="relative z-10 flex flex-col items-center text-center">
          <img src={logo} alt="PaintKiDukaan" className="mb-6 h-24 w-24 rounded-2xl shadow-2xl" />
          <h1 className="text-4xl font-bold tracking-tight text-white">PaintKiDukaan</h1>
          <p className="mt-2 text-sm font-medium uppercase tracking-[4px] text-zinc-400">Paint Shop Manager</p>
          <div className="mt-10 space-y-3 text-left text-sm text-zinc-400">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                <ShoppingBag className="h-4 w-4 text-white" />
              </div>
              <span>Manage inventory &amp; sales</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                <Lock className="h-4 w-4 text-white" />
              </div>
              <span>Protected PIN security</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                <FileKey className="h-4 w-4 text-white" />
              </div>
              <span>Recovery password backup</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right: form panel */}
      <div className="flex w-full items-center justify-center overflow-y-auto px-6 py-8 lg:w-1/2">
        <form className="w-full max-w-md space-y-5" onSubmit={handleSubmit(onSubmit)}>
          {/* Mobile branding */}
          <div className="flex flex-col items-center text-center lg:hidden">
            <img src={logo} alt="PaintKiDukaan" className="mb-3 h-16 w-16 rounded-xl" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">PaintKiDukaan</h1>
          </div>

           {/* Header */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">PaintKiDukaan</p>
              <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">
                {step === "pde" ? "Emergency Protection" : step === "inventory" ? "Inventory Ready" : "Set up your shop"}
              </h2>
            </div>
            <img src={logo} alt="" className="h-10 w-10 rounded-xl lg:hidden" />
          </div>

          {/* Step indicator — hidden on PDE step (PDE wizard has its own) */}
          {step !== "pde" ? <StepIndicator current={stepNumber} /> : null}

          {/* Backend error */}
          {backendError ? (
            <div className="flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="leading-snug">{backendError}</span>
            </div>
          ) : null}

          <div key={step} className="animate-in fade-in slide-in-from-right-2 duration-300 motion-reduce:animate-none">
            {/* ── Step: Path ── */}
            {step === "path" ? (
              <div className="space-y-3">
                <button
                  className="group flex w-full items-center gap-3.5 rounded-xl border border-border bg-background p-4 text-left shadow-sm transition-all duration-150 hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  type="button"
                  onClick={() => setStep("shop")}
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-150 group-hover:bg-primary group-hover:text-primary-foreground">
                    <Store className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">Set up a new shop</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      Start fresh with a new shop. You'll set your shop details, owner PIN, and recovery password.
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden="true" />
                </button>
                <button
                  className="group flex w-full items-center gap-3.5 rounded-xl border border-border bg-background p-4 text-left shadow-sm transition-all duration-150 hover:border-info/50 hover:bg-info/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  type="button"
                  onClick={() => setShowRestore(true)}
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info transition-all duration-150 group-hover:bg-info group-hover:text-info-foreground">
                    <HardDrive className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">Restore from a backup</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      Restore from a backup file. Use this if you previously backed up and want to continue.
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-info" aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {/* ── Step: Shop ── */}
            {step === "shop" ? (
              <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="shopName">Shop name</label>
                <input
                  id="shopName"
                  className={inputClass}
                  aria-invalid={Boolean(errors.shopName)}
                  autoComplete="organization"
                  placeholder="e.g. Paint World"
                  {...register("shopName")}
                />
                <p className="mt-1 text-xs text-muted-foreground">The name of your paint shop or business.</p>
                {fieldError(errors.shopName?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="address">Address</label>
                <textarea
                  id="address"
                  className={`${inputClass} min-h-[4.5rem] py-3`}
                  aria-invalid={Boolean(errors.address)}
                  autoComplete="street-address"
                  placeholder="Full address including city and PIN code"
                  {...register("address")}
                />
                {fieldError(errors.address?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="phone">Phone number</label>
                <input
                  id="phone"
                  className={inputClass}
                  aria-invalid={Boolean(errors.phone)}
                  autoComplete="tel"
                  inputMode="tel"
                  placeholder="9876543210"
                  {...register("phone")}
                />
                <p className="mt-1 text-xs text-muted-foreground">10-digit Indian mobile number.</p>
                {fieldError(errors.phone?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="gstin">
                  GSTIN <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <input
                  id="gstin"
                  className={inputClass}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="22AAAAA0000A1Z5"
                  maxLength={15}
                  {...register("gstin")}
                />
                <p className="mt-1 text-xs text-muted-foreground/70">Required for tax invoices. You can add this later from Settings.</p>
              </div>
              </div>
            ) : null}

            {/* ── Step: PIN ── */}
            {step === "pin" ? (
              <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="pin">Create owner PIN</label>
                <input
                  id="pin"
                  className={inputClass}
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
                <label className={labelClass} htmlFor="pinConfirm">Confirm PIN</label>
                <input
                  id="pinConfirm"
                  className={inputClass}
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

            {/* ── Step: Passphrase ── */}
            {step === "passphrase" ? (
              <div className="space-y-4">
              <div className="rounded-xl border border-warning/30 bg-warning/10 p-3.5">
                <p className="text-sm font-semibold text-warning">Important — read this first</p>
                <p className="mt-1 text-xs leading-5 text-warning/80">
                  Your recovery password is the <strong>only way</strong> to regain access if you
                  forget your PIN. Write it down and store it somewhere safe (not on this device).
                  We cannot recover it for you.
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="passphrase">Recovery password</label>
                <div className="relative">
                  <input
                    id="passphrase"
                    className={`${inputClass} pr-11`}
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
                    aria-label={showPassphrase ? "Hide password" : "Show password"}
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
                <label className={labelClass} htmlFor="passphraseConfirm">Confirm recovery password</label>
                <input
                  id="passphraseConfirm"
                  className={inputClass}
                  aria-invalid={Boolean(errors.passphraseConfirm)}
                  autoComplete="off"
                  placeholder="Re-enter the same password"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphraseConfirm")}
                />
                {fieldError(errors.passphraseConfirm?.message)}
              </div>
              </div>
            ) : null}

            {/* ── Step: Inventory ── */}
            {step === "inventory" ? (
              <div className="space-y-4">
              <div className="text-center mb-6">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                  <Package className="h-6 w-6 text-success" />
                </div>
                <h2 className="text-lg font-semibold text-foreground">Your Inventory is Ready</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  We've set up your default locations. You can add items and customize further from the Items page.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Store className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Shop</p>
                    <p className="text-xs text-muted-foreground">Default location with rack storage</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Warehouse className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Godown</p>
                    <p className="text-xs text-muted-foreground">Warehouse storage location</p>
                  </div>
                </div>
              </div>
              </div>
            ) : null}

            {/* ── Step: PDE ── */}
            {step === "pde" ? (
              <div className="-mx-1 space-y-4">
                <button
                  type="button"
                  onClick={() => finalizeSetup()}
                  className="w-full rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground"
                >
                  Skip for now — I'll set this up later from Settings
                </button>
                <div className="px-1">
                  <PdeSetupWizard
                    onComplete={() => finalizeSetup()}
                    onCancel={() => finalizeSetup()}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {/* Navigation */}
          {step !== "path" && step !== "pde" ? (
            <div className="flex gap-3 pt-1">
              <button
                className={ghostButtonClass}
                type="button"
                onClick={() => setStep(PREVIOUS_STEP[step])}
              >
                Back
              </button>
              {step === "inventory" ? (
                <button
                  className={`${buttonClass} flex-1`}
                  type="submit"
                  disabled={!canContinue || isSubmitting}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Continue
                </button>
              ) : (
                <button
                  className={`${buttonClass} flex-1`}
                  type="button"
                  onClick={goNext}
                  disabled={!canContinue}
                >
                  Continue
                </button>
              )}
            </div>
          ) : null}
        </form>
      </div>
    </main>
  );
}
