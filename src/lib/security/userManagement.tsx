import { zodResolver } from "@hookform/resolvers/zod";
import { tauriInvoke as invoke } from "./tauri";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { extractError } from "../../lib/extractError";

import { createUserSchema, type CreateUserInput } from "./pin";
import { type Role, useSecurity } from "./state";
import { Alert, Badge, Button, Field, InlineDialog, Select } from "../../components/ui";

interface ListedUser {
  id: number;
  name: string;
  role: Role;
}

const inputClass =
  "h-11 w-full rounded-md border border-input bg-surface-sunken px-3 text-sm text-foreground outline-none transition-[color,background-color,border-color,box-shadow] duration-fast ease-standard placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

function roleBadge(role: Role) {
  const variant: Record<Role, "warning" | "success" | "info"> = {
    owner: "warning",
    cashier: "success",
    stocker: "info",
  };
  return (
    <Badge variant={variant[role]} className="uppercase tracking-wide">
      {role}
    </Badge>
  );
}

export function UserManagement() {
  const [users, setUsers] = useState<ListedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const setPhase = useSecurity((state) => state.setPhase);
  const setLoginUsers = useSecurity((state) => state.setLoginUsers);
  const currentRole = useSecurity((s) => s.session.user?.role ?? "stocker");

  const loadUsers = useCallback(async () => {
    if (currentRole !== "owner") {
      setLoading(false);
      return;
    }
    try {
      const result = await invoke<ListedUser[]>("list_users");
      setUsers(result);
      setLoginUsers(result);
      setError(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [currentRole, setLoginUsers]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const {
    register,
    formState: { errors, isSubmitting },
    handleSubmit,
    reset,
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    mode: "onChange",
    defaultValues: { name: "", role: undefined, pin: "", pinConfirm: "" },
  });

  async function onCreateUser(input: CreateUserInput) {
    setError(null);
    try {
      await invoke("create_user", {
        name: input.name,
        role: input.role,
        pin: input.pin,
      });
      reset();
      setShowCreateForm(false);
      await loadUsers();
    } catch (err) {
      setError(extractError(err));
    }
  }

  function onDeleteUser(userId: number, userName: string) {
    setConfirmDeleteTarget({ id: userId, name: userName });
  }

  async function confirmDeleteAction() {
    if (!confirmDeleteTarget) return;
    setError(null);
    try {
      await invoke("delete_user", { user_id: confirmDeleteTarget.id });
      setConfirmDeleteTarget(null);
      await loadUsers();
    } catch (err) {
      setError(extractError(err));
    }
  }

  const cashiers = users.filter((u) => u.role === "cashier");
  const stockers = users.filter((u) => u.role === "stocker");

  return (
    <main className="min-h-dvh bg-surface-canvas px-4 py-8 text-foreground sm:px-6">
      <section className="mx-auto max-w-lg">
        <div className="rounded-xl border border-border bg-surface-raised p-5 shadow-raised sm:p-6">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">Team management</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                Staff accounts
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Add cashiers and stockers who can log in with their own PIN.
              </p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {/* Error */}
          {error ? (
            <Alert variant="destructive" className="mb-5">
              {error}
            </Alert>
          ) : null}

          {/* Create form */}
          {showCreateForm ? (
            <form
              className="surface-sunken mb-6 space-y-4 rounded-lg border border-border p-4"
              onSubmit={handleSubmit(onCreateUser)}
            >
              <p className="text-sm font-medium text-foreground">Add staff member</p>
              <Field label="Name" required error={errors.name?.message}>
                <input
                  className={inputClass}
                  placeholder="e.g. Ramesh"
                  autoComplete="off"
                  {...register("name")}
                />
              </Field>
              <Field label="Role" required error={errors.role?.message} hint="Cashiers can process sales. Stockers can manage stock and purchases.">
                <Select
                  className={inputClass}
                  placeholder="Select role"
                  options={[
                    { value: "cashier", label: "Cashier — handles sales and billing" },
                    { value: "stocker", label: "Stocker — manages inventory and purchases" },
                  ]}
                  size="md"
                  {...register("role")}
                />
              </Field>
              <Field label="PIN" required error={errors.pin?.message}>
                <div className="relative">
                  <input
                    className={`${inputClass} pr-11`}
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6 digits"
                    type={showPin ? "text" : "password"}
                    {...register("pin")}
                  />
                  <button
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none"
                    type="button"
                    onClick={() => setShowPin((v) => !v)}
                    aria-label={showPin ? "Hide PIN" : "Show PIN"}
                  >
                    {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Confirm PIN" required error={errors.pinConfirm?.message}>
                <input
                  className={inputClass}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Repeat PIN"
                  type="password"
                  {...register("pinConfirm")}
                />
              </Field>
              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => {
                    setShowCreateForm(false);
                    reset();
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="flex-1"
                  loading={isSubmitting}
                >
                  Add staff member
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="primary"
              size="lg"
              icon={Plus}
              className="mb-6 w-full"
              type="button"
              onClick={() => setShowCreateForm(true)}
            >
              Add staff member
            </Button>
          )}

          {/* User list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            </div>
          ) : users.length === 0 ? (
              <div className="surface-sunken rounded-lg border border-border p-6 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm text-muted-foreground">
                No staff members yet. Add cashiers and stockers above.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {cashiers.length > 0 && (
                <div>
                  <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                    Cashiers
                  </h2>
                  <ul className="space-y-1.5">
                    {cashiers.map((user) => (
                      <li
                        key={user.id}
                        className="flex min-h-11 items-center justify-between rounded-lg border border-border bg-surface-panel px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-foreground">{user.name}</span>
                          {roleBadge(user.role)}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          type="button"
                          onClick={() => onDeleteUser(user.id, user.name)}
                          aria-label={`Remove ${user.name}`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stockers.length > 0 && (
                <div>
                  <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                    Stockers
                  </h2>
                  <ul className="space-y-1.5">
                    {stockers.map((user) => (
                      <li
                        key={user.id}
                        className="flex min-h-11 items-center justify-between rounded-lg border border-border bg-surface-panel px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-foreground">{user.name}</span>
                          {roleBadge(user.role)}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          type="button"
                          onClick={() => onDeleteUser(user.id, user.name)}
                          aria-label={`Remove ${user.name}`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Back button */}
          <Button
            variant="secondary"
            size="lg"
            icon={ArrowLeft}
            type="button"
            className="mt-6 w-full"
            onClick={() => setPhase("unlocked")}
          >
            Back to shop
          </Button>
        </div>
      </section>

      <InlineDialog
        open={confirmDeleteTarget !== null}
        onClose={() => setConfirmDeleteTarget(null)}
        title="Remove user"
        description={`Remove ${confirmDeleteTarget?.name ?? ""}? They will no longer be able to log in.`}
        size="sm"
      >
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirmDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmDeleteAction}>Remove</Button>
        </div>
      </InlineDialog>
    </main>
  );
}
