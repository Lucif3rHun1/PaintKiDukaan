import { zodResolver } from "@hookform/resolvers/zod";
import logo from "../../assets/logo-64.png";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  FileWarning,
  HardDrive,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  firstLaunchRestoreSchema,
  type FirstLaunchRestoreInput,
  recoveryPassphraseSchema,
} from "./pin";
import { type Role, useSecurity } from "./state";
import { ipc } from "../../shell/lib/ipc";

interface FirstLaunchRestoreProps {
  onCancel: () => void;
}

const STEPS = [
  { label: "Pick backup file", icon: HardDrive, description: "Point PaintKiDukaan at your .pkb1 backup envelope" },
  { label: "Recovery passphrase", icon: ShieldCheck, description: "Unlock the encrypted backup with your recovery passphrase" },
  { label: "Confirm restore", icon: FileWarning, description: "Replace the first-launch database with the restored backup" },
] as const;

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-sm text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const labelClass = "text-sm font-medium text-zinc-200";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const dangerButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function fieldError(message?: string) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-red-400" role="alert">
      <FileWarning className="h-4 w-4" aria-hidden="true" />
      {message}
    </p>
  );
}

function truncateMiddle(value: string) {
  if (value.length <= 54) return value;
  return `${value.slice(0, 25)}…${value.slice(-24)}`;
}

function isRole(role: string): role is Role {
  return role === "owner" || role === "cashier" || role === "stocker";
}

export function FirstLaunchRestore({ onCancel }: FirstLaunchRestoreProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);

  const {
    register,
    control,
    formState: { errors },
    handleSubmit,
    trigger,
  } = useForm<FirstLaunchRestoreInput>({
    resolver: zodResolver(firstLaunchRestoreSchema),
    mode: "onChange",
    defaultValues: {
      envelopePath: "",
      passphrase: "",
    },
  });

  const values = useWatch({ control });
  const envelopePath = values.envelopePath ?? "";
  const passphrase = values.passphrase ?? "";
  const pathValid = envelopePath.trim().length > 0;
  const passphraseValid = recoveryPassphraseSchema.safeParse(passphrase).success;
  const CurrentStepIcon = STEPS[step].icon;

  async function goToPassphrase() {
    const ok = await trigger("envelopePath");
    if (ok && pathValid) setStep(1);
  }

  async function goToConfirm() {
    const ok = await trigger("passphrase");
    if (ok) setStep(2);
  }

  async function onSubmit(input: FirstLaunchRestoreInput) {
    setBackendError(null);
    setLoading(true);
    try {
      await ipc.restoreIntoFirstLaunch(input.envelopePath.trim());
      const boot = await ipc.appBootstrap();
      const security = useSecurity.getState();

      if (boot.kind === "locked") {
        security.setSession({ user: null, locked: true, pinRole: "real" });
        security.setPhase("locked");
        onCancel();
        return;
      }

      if (boot.kind === "unlocked") {
        const role = isRole(boot.role) ? boot.role : "owner";
        security.setSession({ user: { id: 0, name: boot.user, role }, locked: false, pinRole: "real" });
        security.setPhase("unlocked");
        onCancel();
        return;
      }

      if (boot.kind === "first_launch") {
        setBackendError("Restore completed but app couldn't detect the new state. Please restart.");
        setLoading(false);
        return;
      }

      setBackendError(boot.kind === "error" ? boot.message : "Restore completed but app returned an unexpected state. Please restart.");
      setLoading(false);
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
      setLoading(false);
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
              <p className="text-sm font-medium text-indigo-300">PaintKiDukaan</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Restore from backup
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                Bring back a shop database from an encrypted backup file.
              </p>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          <div className="mb-6" aria-label="Restore progress">
            <div className="mb-2 flex items-center gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2">
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
                    className={`hidden text-xs font-medium sm:inline ${
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
                    i < step ? "bg-emerald-500" : i === step ? "bg-indigo-500" : "bg-zinc-800"
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/60 p-3">
            <CurrentStepIcon className="h-5 w-5 shrink-0 text-indigo-300" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-zinc-100">{STEPS[step].label}</p>
              <p className="text-xs text-zinc-400">{STEPS[step].description}</p>
            </div>
          </div>

          {backendError ? (
            <div
              className="mb-5 flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              role="alert"
            >
              <FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{backendError}</span>
            </div>
          ) : null}

          {step === 0 ? (
            <div>
              <label className={labelClass} htmlFor="envelopePath">
                Backup file path *
              </label>
              <input
                id="envelopePath"
                className={inputClass}
                aria-label="Backup file path"
                aria-invalid={Boolean(errors.envelopePath)}
                autoComplete="off"
                placeholder="/abs/path/to/backup.pkb1"
                type="text"
                {...register("envelopePath")}
              />
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                Absolute path to a .pkb1 backup file. E.g. /Users/me/backups/shop-2025-01-15.pkb1
              </p>
              {fieldError(errors.envelopePath?.message)}
            </div>
          ) : null}

          {step === 1 ? (
            <div>
              <label className={labelClass} htmlFor="restorePassphrase">
                Recovery passphrase *
              </label>
              <div className="relative">
                <input
                  id="restorePassphrase"
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
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm font-medium text-red-200">This will replace the first-launch database.</p>
                <p className="mt-1 text-xs leading-5 text-red-200/80">
                  PaintKiDukaan will restore the backup, then lock the app so you can unlock with the original PIN.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-3 text-sm">
                <p className="text-xs font-medium text-zinc-500">Backup file</p>
                <p className="mt-1 break-all font-mono text-xs text-zinc-100">{truncateMiddle(envelopePath.trim())}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-3 text-sm text-zinc-100">
                Passphrase: {passphrase.length} characters
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex gap-3">
            {step > 0 ? (
              <button
                className={ghostButtonClass}
                type="button"
                onClick={() => setStep(step === 2 ? 1 : 0)}
                disabled={loading}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Back
              </button>
            ) : null}
            {step === 0 ? (
              <button
                className={`${buttonClass} flex-1`}
                type="button"
                onClick={goToPassphrase}
                disabled={!pathValid || loading}
              >
                Continue
              </button>
            ) : null}
            {step === 1 ? (
              <button
                className={`${buttonClass} flex-1`}
                type="button"
                onClick={goToConfirm}
                disabled={!passphraseValid || loading}
              >
                Continue
              </button>
            ) : null}
            {step === 2 ? (
              <button
                className={`${dangerButtonClass} flex-1`}
                type="submit"
                disabled={loading}
              >
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Restore and continue
              </button>
            ) : null}
          </div>

          <button
            className="mt-5 flex w-full items-center justify-center gap-2 text-center text-sm font-medium text-indigo-300 transition-colors duration-150 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50"
            type="button"
            onClick={onCancel}
            disabled={loading}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Cancel restore
          </button>
        </form>
      </section>
    </main>
  );
}
