import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { Card, Section, Button, Badge } from "../../../components/ui";
import { getPdeStatus, changeDecoyPin, changeDuressPin } from "../../../domain/ipc";
import type { PdeStatus } from "../../../domain/types";
import { PdeSetupWizard } from "../../../lib/security/pdeSetup";
import {
  changeDecoyPinSchema,
  type ChangeDecoyPinInput,
  changeDuressPinSchema,
  type ChangeDuressPinInput,
} from "../../../lib/security/pin";
import { BackupPanel } from "../../backup/BackupPanel";
import { ThemeSettings } from "./ThemeSettings";
import { RoleGuard } from "../../../lib/security/roleGuard";

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
        <p className="text-sm text-ink-muted">
          Visit the <a href="#/health" className="font-medium text-accent hover:underline">Health page</a> for full diagnostics.
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
            <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
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
            <p className="text-sm text-ink-muted">
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
            <div className="rounded-lg border border-border bg-surface-sunken p-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">Decoy PIN</span>
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
                <span className="text-ink-muted">Duress PIN</span>
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-sm font-medium text-ink">Change decoy PIN</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-red-500" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            placeholder="Current real PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type={showPins ? "text" : "password"}
            {...register("currentRealPin")}
          />
        </div>
        {errors.currentRealPin && <p className="text-xs text-red-500">{errors.currentRealPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            placeholder="New decoy PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type={showPins ? "text" : "password"}
            {...register("newDecoyPin")}
          />
        </div>
        {errors.newDecoyPin && <p className="text-xs text-red-500">{errors.newDecoyPin.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            placeholder="Confirm new decoy PIN"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            type="password"
            {...register("newDecoyPinConfirm")}
          />
        </div>
        {errors.newDecoyPinConfirm && <p className="text-xs text-red-500">{errors.newDecoyPinConfirm.message}</p>}
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-sm font-medium text-ink">Change duress PIN</p>
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-red-500" role="alert">
          <AlertCircle className="h-4 w-4" />{error}
        </p>
      )}
      <div className="space-y-2">
        <input
          className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          placeholder="Current real PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type={showPins ? "text" : "password"}
          {...register("currentRealPin")}
        />
        {errors.currentRealPin && <p className="text-xs text-red-500">{errors.currentRealPin.message}</p>}
        <input
          className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          placeholder="New duress PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type={showPins ? "text" : "password"}
          {...register("newDuressPin")}
        />
        {errors.newDuressPin && <p className="text-xs text-red-500">{errors.newDuressPin.message}</p>}
        <input
          className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          placeholder="Confirm new duress PIN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          type="password"
          {...register("newDuressPinConfirm")}
        />
        {errors.newDuressPinConfirm && <p className="text-xs text-red-500">{errors.newDuressPinConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Save</Button>
      </div>
    </form>
  );
}

function SecurityPolicyCard() {
  const [wipeOnDuress, setWipeOnDuress] = useState(true);
  const [wipeTimeout, setWipeTimeout] = useState(5);
  const [hostileResponse, setHostileResponse] = useState<"warn" | "lock" | "wipe">("lock");

  return (
    <Card>
      <Section title="Security Policy" description="Hostile environment response and duress behavior.">
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken p-3">
            <div>
              <span className="text-sm font-medium text-ink">Wipe on duress</span>
              <p className="text-xs text-ink-muted">Silently erase real data when duress PIN is used.</p>
            </div>
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border bg-surface text-accent focus:ring-accent"
              checked={wipeOnDuress}
              onChange={(e) => setWipeOnDuress(e.target.checked)}
            />
          </label>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-ink" htmlFor="wipeTimeout">
              Wipe timeout (minutes)
            </label>
            <input
              id="wipeTimeout"
              type="range"
              min={1}
              max={30}
              value={wipeTimeout}
              onChange={(e) => setWipeTimeout(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-ink-muted">
              <span>1 min</span>
              <span className="font-medium text-ink">{wipeTimeout} min</span>
              <span>30 min</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-ink" htmlFor="hostileResponse">
              Hostile environment response
            </label>
            <select
              id="hostileResponse"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              value={hostileResponse}
              onChange={(e) => setHostileResponse(e.target.value as "warn" | "lock" | "wipe")}
            >
              <option value="warn">Warn — show alert to user</option>
              <option value="lock">Lock — auto-lock the app immediately</option>
              <option value="wipe">Wipe — secure-erase real data</option>
            </select>
            <p className="text-xs text-ink-muted">
              What to do when hostile environment indicators are detected (e.g., USB debugging, screen recording).
            </p>
          </div>
        </div>
      </Section>
    </Card>
  );
}

/* Re-export the new theme settings page so existing imports keep working. */
export { ThemeSettings };
