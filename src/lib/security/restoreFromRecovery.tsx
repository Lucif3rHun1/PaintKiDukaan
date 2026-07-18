import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import logo from "../../assets/logo-64.png";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { extractError } from "../../lib/extractError";

import {
  pinSchema,
  recoveryPassphraseSchema,
  restoreFromRecoverySchema,
  type RestoreFromRecoveryInput,
} from "./pin";
import { type Role, type Session, type User, useSecurity } from "./state";
import { Alert, Button, Field } from "../../components/ui";

interface RestoreResponse {
  user?: { id?: number; name?: string; role?: Role } | null;
  user_id?: number;
  user_name?: string;
  role?: Role;
  locked?: boolean;
}

const inputClass =
  "h-11 w-full rounded-md border border-input bg-surface-sunken px-3 text-sm text-foreground outline-none transition-[color,background-color,border-color,box-shadow] duration-fast ease-standard placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

function normalizeSession(result: RestoreResponse): Session {
  const role: Role = result.user?.role ?? result.role ?? "stocker";
  const name = result.user?.name ?? result.user_name ?? "Owner";
  const id = result.user?.id ?? result.user_id ?? 0;
  const user: User | null = result.user === null ? null : { id, name, role };
  return { user, locked: result.locked ?? false, pinRole: "real" };
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
          app: "master",
          passphrase: input.passphrase,
          new_pin: input.newPin,
        }),
      );
      const security = useSecurity.getState();
      security.setSession(session);
      security.setPhase("unlocked");
    } catch (error) {
      setBackendError(extractError(error));
    }
  }

  return (
    <main className="min-h-dvh bg-surface-canvas px-4 py-8 text-foreground sm:px-6">
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-md items-center">
        <form
          className="w-full rounded-xl border border-border bg-surface-raised p-5 shadow-raised sm:p-6"
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">Recovery access</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                Restore with password
              </h1>
            </div>
            <img
              src={logo}
              alt="PaintKiDukaan"
              className="h-12 w-12 rounded-xl"
            />
          </div>

          <div className="mb-6 flex items-center gap-2" aria-label="Recovery progress">
            <span className={step === 0 ? "h-2.5 flex-1 rounded-full bg-primary" : "h-2.5 flex-1 rounded-full bg-success"} />
            <span className={step === 1 ? "h-2.5 flex-1 rounded-full bg-primary" : "h-2.5 flex-1 rounded-full bg-muted"} />
          </div>

          {backendError ? (
            <Alert variant="destructive" className="mb-5">
              {backendError}
            </Alert>
          ) : null}

          {step === 0 ? (
            <Field label="Recovery password" error={errors.passphrase?.message}>
              <div className="relative">
                <input
                  className={`${inputClass} pr-11`}
                  aria-label="Recovery password"
                  aria-invalid={Boolean(errors.passphrase)}
                  autoComplete="off"
                  placeholder="Enter recovery password"
                  type={showPassphrase ? "text" : "password"}
                  {...register("passphrase")}
                />
                <button
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none"
                  type="button"
                  onClick={() => setShowPassphrase((visible) => !visible)}
                  aria-label={showPassphrase ? "Hide recovery password" : "Show recovery password"}
                >
                  {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <Field label="New owner PIN" error={errors.newPin?.message}>
                <input
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
              </Field>
              <Field label="Confirm new PIN" error={errors.newPinConfirm?.message}>
                <input
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
              </Field>
            </div>
          ) : null}

          <div className="mt-6 flex gap-3">
            {step === 1 ? (
              <Button variant="secondary" size="lg" type="button" onClick={() => setStep(0)}>
                Back
              </Button>
            ) : null}
            {step === 0 ? (
              <Button className="flex-1" variant="primary" size="lg" type="button" onClick={goNext} disabled={!passphraseValid}>
                Next
              </Button>
            ) : (
              <Button className="flex-1" variant="primary" size="lg" type="submit" loading={isSubmitting} disabled={!pinStepValid}>
                Restore and unlock
              </Button>
            )}
          </div>

          <Button
            className="mt-5 w-full"
            variant="ghost"
            size="md"
            type="button"
            onClick={() => setPhase("locked")}
          >
            Back to PIN entry
          </Button>
        </form>
      </section>
    </main>
  );
}
