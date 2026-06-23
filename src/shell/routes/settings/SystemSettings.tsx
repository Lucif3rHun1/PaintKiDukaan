import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AlertCircle,
  Loader2,
  Shield,
} from "lucide-react";

import { Card, Section, Button, Badge } from "../../../components/ui";
import { getPdeStatus, changeDecoyPin, changeDuressPin } from "../../../domain/ipc";
import { changePin, setRecoveryPassphrase } from "../../../lib/security/pin";
import type { PdeStatus, SecurityPolicy } from "../../../domain/types";
import { ipc } from "../../lib/ipc";
import { toast } from "../../../lib/feedback/toast";
import { PdeSetupWizard } from "../../../lib/security/pdeSetup";
import {
  changeDecoyPinSchema,
  type ChangeDecoyPinInput,
  changeDuressPinSchema,
  type ChangeDuressPinInput,
  changePinSchema,
  type ChangePinInput,
  changeRecoveryPassphraseSchema,
  type ChangeRecoveryPassphraseInput,
} from "../../../lib/security/pin";
import { BackupPanel } from "../../backup/BackupPanel";
import { ThemeSettings } from "./ThemeSettings";
import { RoleGuard } from "../../../lib/security/roleGuard";
import { extractError } from "../../../lib/extractError";

export function BackupSettings() {
  return (
    <RoleGuard minRole="owner">
      <Card>
        <Section title="Backup" description="Create encrypted backups and manage restore points.">
          <BackupPanel />
        </Section>
      </Card>
    </RoleGuard>
  );
}

export function SecuritySettings() {
  return (
    <div className="space-y-6">
      <PdeSettingsCard />
      <SecurityPolicyCard />
    </div>
  );
}

export function MasterHealthSettings() {
  return (
    <Card>
      <Section title="Master health" description="Run diagnostics across data, network, and operations.">
        <p className="text-sm text-muted-foreground">
          Visit the <a href="#/health" className="font-medium text-primary hover:underline">Health page</a> for full diagnostics.
        </p>
      </Section>
    </Card>
  );
}

function PdeSettingsCard() {
  const [pdeStatus, setPdeStatus] = useState<PdeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [showDecoyChange, setShowDecoyChange] = useState(false);
  const [showDuressChange, setShowDuressChange] = useState(false);

  async function loadStatus() {
    try {
      const status = await getPdeStatus();
      setPdeStatus(status);
    } catch {
      setPdeStatus({ enabled: false, has_decoy: false, has_duress: false });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  if (loading) {
    return (
      <Card>
        <Section title="Plausible Deniability" description="Decoy and duress PIN configuration.">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </Section>
      </Card>
    );
  }

  if (showWizard) {
    return (
      <Card>
        <Section title="Set up Plausible Deniability" description="Create decoy and duress PINs.">
          <PdeSetupWizard
            onComplete={() => {
              setShowWizard(false);
              void loadStatus();
            }}
            onCancel={() => setShowWizard(false)}
          />
        </Section>
      </Card>
    );
  }

  return (
    <Card>
      <Section
        title="Plausible Deniability"
        description="Decoy and duress PIN configuration for hostile environments."
        action={
          pdeStatus?.enabled ? (
            <Badge variant="success">Enabled</Badge>
          ) : (
            <Badge variant="muted">Disabled</Badge>
          )
        }
      >
        {!pdeStatus?.enabled ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              PDE creates a separate encrypted database with fake shop data. Use the decoy PIN to show
              plausible data to an intruder, or the duress PIN to silently wipe real data.
            </p>
            <Button onClick={() => setShowWizard(true)}>
              <Shield className="mr-2 h-4 w-4" />
              Set up PDE
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Decoy PIN</span>
                <div className="flex items-center gap-2">
                  <Badge variant={pdeStatus.has_decoy ? "success" : "muted"}>
                    {pdeStatus.has_decoy ? "Set" : "Not set"}
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => setShowDecoyChange(true)}>
                    Change
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Duress PIN</span>
                <div className="flex items-center gap-2">
                  <Badge variant={pdeStatus.has_duress ? "success" : "muted"}>
                    {pdeStatus.has_duress ? "Set" : "Not set"}
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => setShowDuressChange(true)}>
                    Change
                  </Button>
                </div>
              </div>
            </div>

            {showDecoyChange && (
              <ChangeDecoyPinForm
                onDone={() => { setShowDecoyChange(false); void loadStatus(); }}
                onCancel={() => setShowDecoyChange(false)}
              />
            )}
            {showDuressChange && (
              <ChangeDuressPinForm
                onDone={() => { setShowDuressChange(false); void loadStatus(); }}
                onCancel={() => setShowDuressChange(false)}
              />
            )}
          </div>
        )}
      </Section>
    </Card>
  );
}

function ChangeDecoyPinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(false);

  const {
    register,
    formState: { errors, isSubmitting },
    handleSubmit,
  } = useForm<ChangeDecoyPinInput>({
    resolver: zodResolver(changeDecoyPinSchema),
    mode: "onChange",
    defaultValues: { currentRealPin: "", newDecoyPin: "", newDecoyPinConfirm: "" },
  });

  async function onSubmit(input: ChangeDecoyPinInput) {
    setError(null);
    try {
      await changeDecoyPin({
        current_real_pin: input.currentRealPin,
        new_decoy_pin: input.newDecoyPin,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-muted p-3">
      <p className="text-sm font-medium text-foreground">Change decoy PIN</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Current real PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type={showPins ? "text" : "password"}
            {...register("currentRealPin")}
          />
        </div>
        {errors.currentRealPin && <p className="text-xs text-destructive">{errors.currentRealPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="New decoy PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type={showPins ? "text" : "password"}
            {...register("newDecoyPin")}
          />
        </div>
        {errors.newDecoyPin && <p className="text-xs text-destructive">{errors.newDecoyPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Confirm new decoy PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("newDecoyPinConfirm")}
          />
        </div>
        {errors.newDecoyPinConfirm && <p className="text-xs text-destructive">{errors.newDecoyPinConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Save</Button>
      </div>
    </form>
  );
}

function ChangeDuressPinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(false);

  const {
    register,
    formState: { errors, isSubmitting },
    handleSubmit,
  } = useForm<ChangeDuressPinInput>({
    resolver: zodResolver(changeDuressPinSchema),
    mode: "onChange",
    defaultValues: { currentRealPin: "", newDuressPin: "", newDuressPinConfirm: "" },
  });

  async function onSubmit(input: ChangeDuressPinInput) {
    setError(null);
    try {
      await changeDuressPin({
        current_real_pin: input.currentRealPin,
        new_duress_pin: input.newDuressPin,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-muted p-3">
      <p className="text-sm font-medium text-foreground">Change duress PIN</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <input
          className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          placeholder="Current real PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type={showPins ? "text" : "password"}
          {...register("currentRealPin")}
        />
        {errors.currentRealPin && <p className="text-xs text-destructive">{errors.currentRealPin.message}</p>}
        <input
          className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          placeholder="New duress PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type={showPins ? "text" : "password"}
          {...register("newDuressPin")}
        />
        {errors.newDuressPin && <p className="text-xs text-destructive">{errors.newDuressPin.message}</p>}
        <input
          className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          placeholder="Confirm new duress PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type="password"
          {...register("newDuressPinConfirm")}
        />
        {errors.newDuressPinConfirm && <p className="text-xs text-destructive">{errors.newDuressPinConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Save</Button>
      </div>
    </form>
  );
}

function SecurityPolicyCard() {
  const [policy, setPolicy] = useState<SecurityPolicy>({
    wipe_on_duress: true,
    wipe_timeout_minutes: 5,
    hostile_response: "lock",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadPolicy();
  }, []);

  async function loadPolicy() {
    try {
      const loaded = await ipc.getSecurityPolicy();
      setPolicy(loaded);
    } catch (e) {
      console.warn("Failed to load security policy, using defaults", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await ipc.updateSecurityPolicy(policy);
      toast.success("Security policy saved");
    } catch (e) {
      toast.error("Failed to save security policy", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <Section title="Security Policy" description="Hostile environment response and duress behavior.">
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </Section>
      </Card>
    );
  }

  return (
    <Card>
      <Section
        title="Security Policy"
        description="Hostile environment response and duress behavior."
        action={
          <Button onClick={handleSave} loading={saving} size="sm">
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted p-3">
            <div>
              <span className="text-sm font-medium text-foreground">Wipe on duress</span>
              <p className="text-xs text-muted-foreground">Silently erase real data when duress PIN is used.</p>
            </div>
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border bg-card text-primary focus:ring-primary"
              checked={policy.wipe_on_duress}
              onChange={(e) =>
                setPolicy((p) => ({ ...p, wipe_on_duress: e.target.checked }))
              }
            />
          </label>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="wipeTimeout">
              Wipe timeout (minutes)
            </label>
            <input
              id="wipeTimeout"
              type="range"
              min={1}
              max={30}
              value={policy.wipe_timeout_minutes}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  wipe_timeout_minutes: Number(e.target.value),
                }))
              }
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1 min</span>
              <span className="font-medium text-foreground">{policy.wipe_timeout_minutes} min</span>
              <span>30 min</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="hostileResponse">
              Hostile environment response
            </label>
            <select
              id="hostileResponse"
              className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              value={policy.hostile_response}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  hostile_response: e.target.value as "warn" | "lock" | "wipe",
                }))
              }
            >
              <option value="warn">Warn — show alert to user</option>
              <option value="lock">Lock — auto-lock the app immediately</option>
              <option value="wipe">Wipe — secure-erase real data</option>
            </select>
            <p className="text-xs text-muted-foreground">
              What to do when hostile environment indicators are detected (e.g., USB debugging, screen recording).
            </p>
          </div>
        </div>
      </Section>
    </Card>
  );
}

function ChangeOwnerPinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    formState: { errors, isSubmitting },
    handleSubmit,
    reset,
  } = useForm<ChangePinInput>({
    resolver: zodResolver(changePinSchema),
    mode: "onChange",
    defaultValues: { oldPin: "", newPin: "", newPinConfirm: "" },
  });

  async function onSubmit(input: ChangePinInput) {
    setError(null);
    try {
      await changePin({
        oldPin: input.oldPin,
        newPin: input.newPin,
      });
      reset();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-muted p-3">
      <p className="text-sm font-medium text-foreground">Change owner PIN</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Current PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("oldPin")}
          />
        </div>
        {errors.oldPin && <p className="text-xs text-destructive">{errors.oldPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="New PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("newPin")}
          />
        </div>
        {errors.newPin && <p className="text-xs text-destructive">{errors.newPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Confirm new PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("newPinConfirm")}
          />
        </div>
        {errors.newPinConfirm && <p className="text-xs text-destructive">{errors.newPinConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Change PIN</Button>
      </div>
    </form>
  );
}

function SetRecoveryPassphraseForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    formState: { errors, isSubmitting },
    handleSubmit,
    reset,
  } = useForm<ChangeRecoveryPassphraseInput>({
    resolver: zodResolver(changeRecoveryPassphraseSchema),
    mode: "onChange",
    defaultValues: { currentPin: "", newPassphrase: "", newPassphraseConfirm: "" },
  });

  async function onSubmit(input: ChangeRecoveryPassphraseInput) {
    setError(null);
    try {
      await setRecoveryPassphrase({
        currentPin: input.currentPin,
        newPassphrase: input.newPassphrase,
      });
      reset();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-muted p-3">
      <p className="text-sm font-medium text-foreground">Set recovery passphrase</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Current PIN (for verification)"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("currentPin")}
          />
        </div>
        {errors.currentPin && <p className="text-xs text-destructive">{errors.currentPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="New recovery passphrase"
            autoComplete="off"
            type="password"
            {...register("newPassphrase")}
          />
        </div>
        {errors.newPassphrase && <p className="text-xs text-destructive">{errors.newPassphrase.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Confirm recovery passphrase"
            autoComplete="off"
            type="password"
            {...register("newPassphraseConfirm")}
          />
        </div>
        {errors.newPassphraseConfirm && <p className="text-xs text-destructive">{errors.newPassphraseConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Set Passphrase</Button>
      </div>
    </form>
  );
}

function OwnerSecuritySettings() {
  const [showChangePin, setShowChangePin] = useState(false);
  const [showRecoveryPassphrase, setShowRecoveryPassphrase] = useState(false);

  return (
    <RoleGuard minRole="owner">
      <Card>
        <Section title="Owner Security" description="Change PIN and manage recovery passphrase. Owner access only.">
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="font-medium text-foreground">Change Owner PIN</p>
                  <p className="text-xs text-muted-foreground">Update the primary 6-digit PIN used to unlock the app.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setShowChangePin(!showChangePin)}>
                  {showChangePin ? "Hide" : "Change"}
                </Button>
              </div>
              {showChangePin && (
                <ChangeOwnerPinForm
                  onDone={() => setShowChangePin(false)}
                  onCancel={() => setShowChangePin(false)}
                />
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="font-medium text-foreground">Recovery Passphrase</p>
                  <p className="text-xs text-muted-foreground">Set a strong passphrase for emergency data recovery.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setShowRecoveryPassphrase(!showRecoveryPassphrase)}>
                  {showRecoveryPassphrase ? "Hide" : "Set"}
                </Button>
              </div>
              {showRecoveryPassphrase && (
                <SetRecoveryPassphraseForm
                  onDone={() => setShowRecoveryPassphrase(false)}
                  onCancel={() => setShowRecoveryPassphrase(false)}
                />
              )}
            </div>
          </div>
        </Section>
      </Card>
    </RoleGuard>
  );
}

/* Re-export components so they can be imported from Settings.tsx */
export { ThemeSettings, OwnerSecuritySettings };
