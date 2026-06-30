import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Store,
} from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { provisionDecoyDb } from "../../domain/ipc";
import { extractError } from "../../lib/extractError";
import {
  pdeSetupSchema,
  type PdeSetupInput,
  pinSchema,
  shopNameSchema,
} from "./pin";

type Step = "opt-in" | "decoy-pin" | "duress-pin" | "fake-data" | "confirm";

const STEPS: ReadonlyArray<{ key: Step; label: string; icon: typeof Shield }> = [
  { key: "opt-in", label: "Enable Fake Shop", icon: Shield },
  { key: "decoy-pin", label: "Fake PIN", icon: ShieldCheck },
  { key: "duress-pin", label: "Emergency PIN", icon: ShieldAlert },
  { key: "fake-data", label: "Fake Shop", icon: Store },
  { key: "confirm", label: "Confirm", icon: CheckCircle2 },
];

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-muted px-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const labelClass = "text-sm font-medium text-foreground";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:border-border hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

function fieldError(message?: string) {
  if (!message) return null;
  return (
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive" role="alert">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {message}
    </p>
  );
}

function pinStrength(pin: string): { label: string; color: string; width: string } {
  if (pin.length === 0) return { label: "", color: "bg-muted", width: "w-0" };
  if (pin.length < 4) return { label: "Weak", color: "bg-destructive", width: "w-1/4" };
  const uniqueDigits = new Set(pin).size;
  const isSequential = /0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210/.test(pin);
  const isRepeating = /^(\d)\1{5}$/.test(pin);
  if (isRepeating || isSequential) return { label: "Weak", color: "bg-destructive", width: "w-1/4" };
  if (uniqueDigits <= 2) return { label: "Fair", color: "bg-warning", width: "w-2/4" };
  if (uniqueDigits <= 4) return { label: "Good", color: "bg-success", width: "w-3/4" };
  return { label: "Strong", color: "bg-success", width: "w-full" };
}

function PinStrengthMeter({ pin }: { pin: string }) {
  const s = pinStrength(pin);
  if (!s.label) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-muted">
        <div className={`h-full rounded-full transition-[color,background-color,border-color,opacity] duration-300 ${s.color} ${s.width}`} />
      </div>
      <span className={`text-xs font-medium ${s.color.replace("bg-", "text-")}`}>{s.label}</span>
    </div>
  );
}

interface PdeSetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function PdeSetupWizard({ onComplete, onCancel }: PdeSetupWizardProps) {
  const [step, setStep] = useState<Step>("opt-in");
  const [showPins, setShowPins] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    control,
    formState: { errors },
    handleSubmit,
    trigger,
    getValues,
  } = useForm<PdeSetupInput>({
    resolver: zodResolver(pdeSetupSchema),
    mode: "onChange",
    defaultValues: {
      enabled: true,
      decoyPin: "",
      decoyPinConfirm: "",
      duressPin: "",
      duressPinConfirm: "",
      fakeShopName: "Sunrise Paints",
    },
  });

  const values = useWatch({ control });
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const currentMeta = STEPS[stepIndex];

  const decoyValid =
    pinSchema.safeParse(values.decoyPin).success &&
    pinSchema.safeParse(values.decoyPinConfirm).success &&
    values.decoyPin === values.decoyPinConfirm;

  const duressValid =
    pinSchema.safeParse(values.duressPin).success &&
    pinSchema.safeParse(values.duressPinConfirm).success &&
    values.duressPin === values.duressPinConfirm &&
    values.duressPin !== values.decoyPin;

  const fakeDataValid = shopNameSchema.safeParse(values.fakeShopName ?? "").success;

  const canContinue: Record<Step, boolean> = {
    "opt-in": true,
    "decoy-pin": decoyValid,
    "duress-pin": duressValid,
    "fake-data": fakeDataValid,
    confirm: true,
  };

  const stepFields: Record<Step, readonly (keyof PdeSetupInput)[]> = {
    "opt-in": [],
    "decoy-pin": ["decoyPin", "decoyPinConfirm"],
    "duress-pin": ["duressPin", "duressPinConfirm"],
    "fake-data": ["fakeShopName"],
    confirm: [],
  };

  async function goNext() {
    if (step === "opt-in") {
      const enabled = getValues("enabled");
      if (!enabled) {
        onComplete();
        return;
      }
      setStep("decoy-pin");
      return;
    }
    const ok = await trigger(stepFields[step]);
    if (ok) {
      const order: Step[] = ["opt-in", "decoy-pin", "duress-pin", "fake-data", "confirm"];
      const next = order[order.indexOf(step) + 1];
      if (next) setStep(next);
    }
  }

  function goBack() {
    const order: Step[] = ["opt-in", "decoy-pin", "duress-pin", "fake-data", "confirm"];
    const prev = order[order.indexOf(step) - 1];
    if (prev) setStep(prev);
  }

  async function onSubmit() {
    setBackendError(null);
    setSubmitting(true);
    try {
      const v = getValues();
      await provisionDecoyDb({
        decoy_pin: v.decoyPin,
        duress_pin: v.duressPin,
        fake_shop_name: v.fakeShopName,
      });
      onComplete();
    } catch (err) {
      setBackendError(extractError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Step indicator */}
      <div aria-label="Fake Shop setup progress">
        <div className="flex items-center gap-2 mb-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors duration-200 ${
                  i < stepIndex
                    ? "bg-success text-success-foreground"
                    : i === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {i < stepIndex ? "✓" : i + 1}
              </div>
              <span
                className={`text-xs font-medium hidden ${
                  i === stepIndex ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ${
                i < stepIndex
                  ? "bg-success"
                  : i === stepIndex
                    ? "bg-primary"
                    : "bg-muted"
              }`}
            />
          ))}
        </div>
      </div>

      {/* Step description */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-3">
        <currentMeta.icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">{currentMeta.label}</p>
          <p className="text-xs text-muted-foreground">
            {step === "opt-in" && "Set up a Fake Shop with a fake PIN and an emergency PIN."}
            {step === "decoy-pin" && "This PIN opens the fake shop."}
            {step === "duress-pin" && "This PIN permanently deletes your real shop data, then opens the fake shop."}
            {step === "fake-data" && "Configure what the fake shop looks like to an intruder."}
            {step === "confirm" && "Review your Fake Shop settings before finishing setup."}
          </p>
        </div>
      </div>

      {/* Backend error */}
      {backendError && (
        <div className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{backendError}</span>
        </div>
      )}

      {/* Step: opt-in */}
      {step === "opt-in" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
            <p className="text-sm font-medium text-warning">What is a Fake Shop?</p>
            <p className="mt-1 text-xs leading-5 text-warning/80">
              A Fake Shop creates a separate protected shop with sample data. If someone forces you
              to unlock the app, the <strong>fake PIN</strong> shows believable sample data. The{" "}
              <strong>emergency PIN</strong> permanently deletes your real shop data and shows the fake shop.
              An intruder cannot tell which PIN is real.
            </p>
          </div>
          <label className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4 cursor-pointer">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border bg-muted text-primary focus:ring-ring"
              {...register("enabled")}
            />
            <div>
              <span className="text-sm font-medium text-foreground">Enable Fake Shop</span>
              <p className="text-xs text-muted-foreground">Create fake and emergency PINs for emergencies.</p>
            </div>
          </label>
        </div>
      )}

      {/* Step: decoy PIN */}
      {step === "decoy-pin" && (
        <div className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="decoyPin">Fake PIN *</label>
            <div className="relative">
              <input
                id="decoyPin"
                className={`${inputClass} pr-11`}
                autoComplete="off"
                inputMode="numeric"
                maxLength={6}
                placeholder="6 digits"
                type={showPins ? "text" : "password"}
                {...register("decoyPin")}
              />
              <button
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                type="button"
                onClick={() => setShowPins((v) => !v)}
                aria-label={showPins ? "Hide PINs" : "Show PINs"}
              >
                {showPins ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {fieldError(errors.decoyPin?.message)}
          </div>
          <div>
            <label className={labelClass} htmlFor="decoyPinConfirm">Confirm fake PIN *</label>
            <input
              id="decoyPinConfirm"
              className={inputClass}
              autoComplete="off"
              inputMode="numeric"
              maxLength={6}
              placeholder="Re-enter fake PIN"
              type={showPins ? "text" : "password"}
              {...register("decoyPinConfirm")}
            />
            {fieldError(errors.decoyPinConfirm?.message)}
          </div>
        </div>
      )}

      {/* Step: duress PIN */}
      {step === "duress-pin" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-sm font-medium text-destructive">Warning</p>
            <p className="mt-1 text-xs leading-5 text-destructive/80">
              The emergency PIN will <strong>permanently and irreversibly</strong> delete your real shop
              data after unlock. Only set this if you understand the consequences.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="duressPin">Emergency PIN *</label>
            <div className="relative">
              <input
                id="duressPin"
                className={`${inputClass} pr-11`}
                autoComplete="off"
                inputMode="numeric"
                maxLength={6}
                placeholder="6 digits — different from fake PIN"
                type={showPins ? "text" : "password"}
                {...register("duressPin")}
              />
              <button
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                type="button"
                onClick={() => setShowPins((v) => !v)}
                aria-label={showPins ? "Hide PINs" : "Show PINs"}
              >
                {showPins ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <PinStrengthMeter pin={values.duressPin ?? ""} />
            {fieldError(errors.duressPin?.message)}
          </div>
          <div>
            <label className={labelClass} htmlFor="duressPinConfirm">Confirm emergency PIN *</label>
            <input
              id="duressPinConfirm"
              className={inputClass}
              autoComplete="off"
              inputMode="numeric"
              maxLength={6}
              placeholder="Re-enter emergency PIN"
              type={showPins ? "text" : "password"}
              {...register("duressPinConfirm")}
            />
            {fieldError(errors.duressPinConfirm?.message)}
          </div>
        </div>
      )}

      {/* Step: fake data */}
      {step === "fake-data" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Configure the fake shop that appears when the fake or emergency PIN is used.
            Default values create a believable paint shop.
          </p>
          <div>
            <label className={labelClass} htmlFor="fakeShopName">Fake shop name *</label>
            <input
              id="fakeShopName"
              className={inputClass}
              autoComplete="organization"
              placeholder="e.g. Sunrise Paints"
              {...register("fakeShopName")}
            />
            {fieldError(errors.fakeShopName?.message)}
          </div>
        </div>
      )}

      {/* Step: confirm */}
      {step === "confirm" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-success/30 bg-success/10 p-4 space-y-3">
            <p className="text-sm font-medium text-success">Fake Shop Summary</p>
            <div className="space-y-2 text-sm text-success/80">
              <div className="flex justify-between">
                <span>Fake PIN:</span>
                <span className="font-mono text-success">{"•".repeat(6)}</span>
              </div>
              <div className="flex justify-between">
                <span>Emergency PIN:</span>
                <span className="font-mono text-success">{"•".repeat(6)}</span>
              </div>
              <div className="flex justify-between">
                <span>Fake shop name:</span>
                <span className="font-medium text-success">{values.fakeShopName}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 space-y-2">
            <p className="text-sm font-medium text-primary">What happens next</p>
            <ul className="space-y-1 text-xs leading-5 text-primary/80">
              <li>• A separate protected fake shop will be created with sample data.</li>
              <li>• Your <strong>fake PIN</strong> shows believable sample data — the intruder sees a real-looking shop.</li>
              <li>• Your <strong>emergency PIN</strong> permanently deletes your real shop data after unlock, then shows the fake shop.</li>
              <li>• An intruder cannot distinguish real, fake, or emergency PINs from each other.</li>
            </ul>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3">
        {step !== "opt-in" && (
          <button className={ghostButtonClass} type="button" onClick={goBack}>
            Back
          </button>
        )}
        {step === "opt-in" && (
          <button className={ghostButtonClass} type="button" onClick={onCancel}>
            Skip
          </button>
        )}
        {step !== "confirm" ? (
          <button
            className={`${buttonClass} flex-1`}
            type="button"
            onClick={goNext}
            disabled={!canContinue[step]}
          >
            Continue
          </button>
        ) : (
          <button
            className={`${buttonClass} flex-1`}
            type="button"
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Set up fake shop
          </button>
        )}
      </div>
    </div>
  );
}
