import { zodResolver } from "@hookform/resolvers/zod";
import logo from "../../assets/logo-64.png";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  FileWarning,
  FolderOpen,
  HardDrive,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
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
  { key: "file", label: "File", icon: HardDrive, description: "Select your backup file to restore from" },
  { key: "passphrase", label: "Passphrase", icon: ShieldCheck, description: "Enter your recovery password to unlock the backup" },
  { key: "confirm", label: "Confirm", icon: FileWarning, description: "Replace the starting shop data with the restored backup" },
] as const;

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-muted px-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const labelClass = "text-sm font-medium text-foreground";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:border-border hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
const dangerButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-colors duration-150 hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

function fieldError(message?: string) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive" role="alert">
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
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const {
    register,
    control,
    setValue,
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

  const animateToStep = useCallback((next: 0 | 1 | 2) => {
    clearTimeout(timerRef.current);
    setVisible(false);
    timerRef.current = setTimeout(() => {
      setStep(next);
      setVisible(true);
    }, 150);
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const path = await ipc.pickBackupFile();
      if (path) {
        setValue("envelopePath", path, { shouldValidate: true });
      }
    } catch {
      // noop
    }
  }, [setValue]);

  async function goToPassphrase() {
    const ok = await trigger("envelopePath");
    if (ok && pathValid) animateToStep(1);
  }

  async function goToConfirm() {
    const ok = await trigger("passphrase");
    if (ok) animateToStep(2);
  }

  async function onSubmit(input: FirstLaunchRestoreInput) {
    setBackendError(null);
    setLoading(true);
    try {
      await ipc.restoreIntoFirstLaunch(input.envelopePath.trim(), input.passphrase);
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
        security.setSession({ user: { id: boot.user_id, name: boot.user, role }, locked: false, pinRole: "real" });
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
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
        <form
          className="w-full rounded-2xl border border-border bg-card/80 p-6 shadow-2xl shadow-background/40 backdrop-blur sm:p-8"
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">PaintKiDukaan</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                Restore from backup
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Bring back your shop data from a backup file.
              </p>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          <div className="flex items-center justify-between px-2" aria-label="Restore progress">
            {STEPS.map((s, i) => {
              const done = i < step;
              const active = i === step;
              return (
                <div key={i} className="flex items-center">
                  {i > 0 && (
                    <div className="mx-1 h-px w-6 sm:w-10">
                      <div
                        className={`h-full transition-colors duration-200 ${i <= step ? "bg-success" : "bg-border"}`}
                      />
                    </div>
                  )}
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold transition-[transform,colors,box-shadow] duration-200 ${
                        done
                          ? "bg-success text-success-foreground"
                          : active
                            ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                    <span
                      className={`text-[10px] font-medium leading-none ${active ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      {s.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-3.5 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {(() => {
                const Icon = STEPS[step].icon;
                return <Icon className="h-4 w-4" aria-hidden="true" />;
              })()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{STEPS[step].label}</p>
              <p className="text-xs text-muted-foreground">{STEPS[step].description}</p>
            </div>
          </div>

          {backendError ? (
            <div
              className="flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-sm text-destructive"
              role="alert"
            >
              <FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="leading-snug">{backendError}</span>
            </div>
          ) : null}

          <div className={`transition-[opacity,transform] duration-200 ease-in-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>
          {step === 0 ? (
            <div>
              <label className={labelClass} htmlFor="envelopePath">
                Backup file path *
              </label>
              <div className="flex gap-2">
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
                <button
                  className={ghostButtonClass}
                  type="button"
                  onClick={pickFile}
                  aria-label="Browse for backup file"
                >
                  <FolderOpen className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Browse
                </button>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Absolute path to a backup file. E.g. /Users/me/backups/shop-2025-01-15.pkb1
              </p>
              {fieldError(errors.envelopePath?.message)}
            </div>
          ) : null}

          {step === 1 ? (
            <div>
              <label className={labelClass} htmlFor="restorePassphrase">
                Recovery password *
              </label>
              <div className="relative">
                <input
                  id="restorePassphrase"
                  className={`${inputClass} pr-11`}
                  aria-label="Recovery password"
                  aria-invalid={Boolean(errors.passphrase)}
                  autoComplete="off"
                  placeholder="At least 12 characters"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphrase")}
                />
                <button
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => setShowPassphrase((v) => !v)}
                  aria-label={showPassphrase ? "Hide recovery password" : "Show recovery password"}
                >
                  {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {fieldError(errors.passphrase?.message)}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3">
                <p className="text-sm font-medium text-destructive">This will replace the starting shop data.</p>
                <p className="mt-1 text-xs leading-5 text-destructive/80">
                  PaintKiDukaan will restore the backup, then lock the app so you can unlock with the original PIN.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background/60 p-3 text-sm">
                <p className="text-xs font-medium text-muted-foreground">Backup file</p>
                <p className="mt-1 break-all font-mono text-xs text-foreground">{truncateMiddle(envelopePath.trim())}</p>
              </div>
              <div className="rounded-xl border border-border bg-background/60 p-3 text-sm text-foreground">
                Password: {passphrase.length} characters
              </div>
            </div>
          ) : null}
          </div>

          <div className="mt-6 flex gap-3">
            {step > 0 ? (
              <button
                className={ghostButtonClass}
                type="button"
                onClick={() => animateToStep(step === 2 ? 1 : 0)}
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
            className="mt-5 flex w-full items-center justify-center gap-2 text-center text-sm font-medium text-primary transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
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
