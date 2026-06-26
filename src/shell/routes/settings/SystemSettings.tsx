import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AlertCircle,
  Loader2,
  Shield,
} from "lucide-react";

import { Card, Section, Button, Badge, Select } from "../../../components/ui";
import { SkeletonRow } from "../../../components/ui/SkeletonRow";
import { getPdeStatus, changeDecoyPin, changeDuressPin } from "../../../domain/ipc";
import { changePin, setRecoveryPassphrase } from "../../../lib/security/pin";
import type { PdeStatus, SecurityPolicy } from "../../../domain/types";
import { ipc, type MasterHealth } from "../../lib/ipc";
import { fetchMasterHealth } from "../../health/api";
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
        <Section title="Backup" description="Create protected backups and manage restore points.">
          <BackupPanel />
        </Section>
      </Card>
    </RoleGuard>
  );
}

export function SecuritySettings() {
  return (
    <RoleGuard minRole="owner">
      <div className="space-y-6">
        <PdeSettingsCard />
        <SecurityPolicyCard />
      </div>
    </RoleGuard>
  );
}

export function MasterHealthSettings() {
  const [data, setData] = useState<MasterHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMasterHealth()
      .then((d) => setData(d ?? null))
      .catch((e: unknown) => setError(extractError(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonRow count={6} />;
  if (error) {
    return (
      <Card>
        <Section title="Master health" description="Run diagnostics across data, network, and operations.">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        </Section>
      </Card>
    );
  }

  const overallBadge =
    data?.overall === "ok"
      ? "bg-success/20 text-success"
      : data?.overall === "warn"
        ? "bg-warning/20 text-warning"
        : "bg-destructive/20 text-destructive";

  return (
    <Card>
      <Section title="Master health" description="Run diagnostics across data, network, and operations.">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Overall</span>
            {data && (
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${overallBadge}`}>
                {data.overall}
              </span>
            )}
          </div>

          <HealthSection title="App">
            <HealthRow k="Version" v={data?.app.version} />
            <HealthRow k="Browser engine" v={data?.app.webview2} />
            <HealthRow k="Database engine" v={data?.app.sqlcipher} />
            <HealthRow k="Last backup" v={data?.app.last_backup} />
            <HealthRow k="Last test-restore" v={data?.app.last_test_restore} />
          </HealthSection>

          <HealthSection title="System">
            <HealthRow k="Drive protection (C:)" v={data?.system.bitlocker_c_drive} />
            <HealthRow k="Disk free (GB)" v={data?.system.disk_free_gb?.toFixed(1)} />
            <HealthRow k="Sleep prevented" v={data?.system.sleep_prevented ? "yes" : "no"} />
            <HealthRow k="Auto-lock policy" v={data?.system.auto_lock_policy} />
          </HealthSection>

          <HealthSection title="Data">
            <HealthRow k="Data health" v={data?.data.db_integrity} />
            <HealthRow
              k="Rows"
              v={data?.data.rows_count
                ? `sales=${data.data.rows_count.sales}, items=${data.data.rows_count.items}, customers=${data.data.rows_count.customers}`
                : undefined}
            />
            <HealthRow
              k="Backup age (h)"
              v={data?.data.backup_age_hours != null
                ? (data.data.backup_age_hours < 0 ? "never" : String(data.data.backup_age_hours))
                : undefined}
            />
          </HealthSection>

          <HealthSection title="Network">
            <HealthRow k="Network discovery" v={data?.network.mdns_active ? "yes" : "no"} />
            <HealthRow k="LAN IP" v={data?.network.lan_ip || "—"} />
            <HealthRow k="Connected devices" v={data?.network.connected_devices != null ? String(data.network.connected_devices) : undefined} />
          </HealthSection>

          <HealthSection title="Ops">
            <HealthRow k="Day-close age (h)" v={data?.ops.day_close_age_hours != null ? String(data.ops.day_close_age_hours) : undefined} />
            <HealthRow k="Low-stock count" v={data?.ops.low_stock_count != null ? String(data.ops.low_stock_count) : undefined} />
            <HealthRow k="Pending sales" v={data?.ops.pending_sales != null ? String(data.ops.pending_sales) : undefined} />
          </HealthSection>

          {data?.checked_at && (
            <p className="text-xs text-muted-foreground">Checked at {data.checked_at}</p>
          )}
        </div>
      </Section>
    </Card>
  );
}

function HealthSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <h4 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function HealthRow({ k, v }: { k: string; v: string | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono text-foreground">{v ?? "—"}</span>
    </div>
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
        <Section title="Plausible Deniability" description="Decoy and duress PIN setup.">
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
        description="Decoy and duress PIN setup for emergencies."
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
              PDE creates a separate protected shop data store with fake data. Use the decoy PIN to show
              fake data to an intruder, or the duress PIN to silently delete real data.
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
      toast.success("Safety settings saved");
    } catch (e) {
      toast.error("Failed to save safety settings", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <Section title="Safety Settings" description="Emergency response and duress behavior.">
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
        title="Safety Settings"
        description="Emergency response and duress behavior."
        action={
          <Button onClick={handleSave} loading={saving} size="sm">
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted p-3">
            <div>
              <span className="text-sm font-medium text-foreground">Delete data on duress</span>
              <p className="text-xs text-muted-foreground">Silently delete real data when duress PIN is used.</p>
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
              Delete timeout (minutes)
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
              Emergency response
            </label>
            <Select
              id="hostileResponse"
              value={policy.hostile_response}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  hostile_response: e.target.value as "warn" | "lock" | "wipe",
                }))
              }
              options={[
                { value: "warn", label: "Warn — show alert to user" },
                { value: "lock", label: "Lock — auto-lock the app immediately" },
                { value: "wipe", label: "Delete — erase real data" },
              ]}
              size="md"
            />
            <p className="text-xs text-muted-foreground">
              What to do when suspicious activity is detected (e.g., USB debugging, screen recording).
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
      <p className="text-sm font-medium text-foreground">Set recovery password</p>
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
            placeholder="New recovery password"
            autoComplete="off"
            type="password"
            {...register("newPassphrase")}
          />
        </div>
        {errors.newPassphrase && <p className="text-xs text-destructive">{errors.newPassphrase.message}</p>}
        <div className="relative">
          <input
            className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="Confirm recovery password"
            autoComplete="off"
            type="password"
            {...register("newPassphraseConfirm")}
          />
        </div>
        {errors.newPassphraseConfirm && <p className="text-xs text-destructive">{errors.newPassphraseConfirm.message}</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" loading={isSubmitting}>Set Password</Button>
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
        <Section title="Owner Security" description="Change PIN and manage recovery password. Owner access only.">
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
                  <p className="font-medium text-foreground">Recovery Password</p>
                  <p className="text-xs text-muted-foreground">Set a strong password for emergency data recovery.</p>
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
