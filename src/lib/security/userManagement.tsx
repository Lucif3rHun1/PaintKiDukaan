import { zodResolver } from "@hookform/resolvers/zod";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
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

import { createUserSchema, type CreateUserInput, pinSchema } from "./pin";
import { type Role, useSecurity } from "./state";

interface ListedUser {
  id: number;
  name: string;
  role: Role;
}

const inputClass =
  "h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 text-sm text-zinc-100 outline-none transition-colors duration-150 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50";
const labelClass = "text-sm font-medium text-zinc-200";
const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const ghostButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";
const dangerButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-red-500/30 px-3 text-sm font-medium text-red-300 transition-colors duration-150 hover:border-red-500/50 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50";

function fieldError(message?: string) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-red-400" role="alert">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {message}
    </p>
  );
}

function roleBadge(role: Role) {
  const colors: Record<Role, string> = {
    owner: "bg-amber-500/20 text-amber-300",
    cashier: "bg-emerald-500/20 text-emerald-300",
    stocker: "bg-sky-500/20 text-sky-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[role]}`}>
      {role}
    </span>
  );
}

export function UserManagement() {
  const [users, setUsers] = useState<ListedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const setPhase = useSecurity((state) => state.setPhase);

  const loadUsers = useCallback(async () => {
    try {
      const result = await invoke<ListedUser[]>("list_users");
      setUsers(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDeleteUser(userId: number, userName: string) {
    if (!window.confirm(`Remove ${userName} from the system? They will no longer be able to log in.`)) {
      return;
    }
    setError(null);
    try {
      await invoke("delete_user", { user_id: userId });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const cashiers = users.filter((u) => u.role === "cashier");
  const stockers = users.filter((u) => u.role === "stocker");

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6">
      <section className="mx-auto max-w-lg">
        <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-indigo-300">Team management</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                Staff accounts
              </h1>
              <p className="mt-1 text-sm text-zinc-400">
                Add cashiers and stockers who can log in with their own PIN.
              </p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-300">
              <Users className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>

          {/* Error */}
          {error ? (
            <div
              className="mb-5 flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {/* Create form */}
          {showCreateForm ? (
            <form
              className="mb-6 rounded-xl border border-white/10 bg-zinc-950/60 p-4 space-y-4"
              onSubmit={handleSubmit(onCreateUser)}
            >
              <p className="text-sm font-medium text-zinc-100">Add staff member</p>
              <div>
                <label className={labelClass} htmlFor="staffName">
                  Name *
                </label>
                <input
                  id="staffName"
                  className={inputClass}
                  placeholder="e.g. Ramesh"
                  autoComplete="off"
                  {...register("name")}
                />
                {fieldError(errors.name?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="staffRole">
                  Role *
                </label>
                <select
                  id="staffRole"
                  className={inputClass}
                  {...register("role")}
                >
                  <option value="">Select role</option>
                  <option value="cashier">Cashier — handles sales and billing</option>
                  <option value="stocker">Stocker — manages inventory and purchases</option>
                </select>
                <p className="mt-1 text-xs text-zinc-500">
                  Cashiers can process sales. Stockers can manage stock and purchases.
                </p>
                {fieldError(errors.role?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="staffPin">
                  PIN *
                </label>
                <div className="relative">
                  <input
                    id="staffPin"
                    className={`${inputClass} pr-11`}
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6 digits"
                    type={showPin ? "text" : "password"}
                    {...register("pin")}
                  />
                  <button
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-zinc-400 transition-colors duration-150 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    type="button"
                    onClick={() => setShowPin((v) => !v)}
                    aria-label={showPin ? "Hide PIN" : "Show PIN"}
                  >
                    {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {fieldError(errors.pin?.message)}
              </div>
              <div>
                <label className={labelClass} htmlFor="staffPinConfirm">
                  Confirm PIN *
                </label>
                <input
                  id="staffPinConfirm"
                  className={inputClass}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Repeat PIN"
                  type="password"
                  {...register("pinConfirm")}
                />
                {fieldError(errors.pinConfirm?.message)}
              </div>
              <div className="flex gap-3">
                <button
                  className={ghostButtonClass}
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    reset();
                  }}
                >
                  Cancel
                </button>
                <button
                  className={`${buttonClass} flex-1`}
                  type="submit"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Add staff member
                </button>
              </div>
            </form>
          ) : (
            <button
              className={`${buttonClass} mb-6 w-full`}
              type="button"
              onClick={() => setShowCreateForm(true)}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Add staff member
            </button>
          )}

          {/* User list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-400" aria-hidden="true" />
            </div>
          ) : users.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-6 text-center">
              <Users className="mx-auto h-8 w-8 text-zinc-600" aria-hidden="true" />
              <p className="mt-2 text-sm text-zinc-400">
                No staff members yet. Add cashiers and stockers above.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {cashiers.length > 0 && (
                <div>
                  <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Cashiers
                  </h2>
                  <div className="space-y-2">
                    {cashiers.map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center justify-between rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-zinc-100">{user.name}</span>
                          {roleBadge(user.role)}
                        </div>
                        <button
                          className={dangerButtonClass}
                          type="button"
                          onClick={() => onDeleteUser(user.id, user.name)}
                          aria-label={`Remove ${user.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {stockers.length > 0 && (
                <div>
                  <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Stockers
                  </h2>
                  <div className="space-y-2">
                    {stockers.map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center justify-between rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-zinc-100">{user.name}</span>
                          {roleBadge(user.role)}
                        </div>
                        <button
                          className={dangerButtonClass}
                          type="button"
                          onClick={() => onDeleteUser(user.id, user.name)}
                          aria-label={`Remove ${user.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Back button */}
          <button
            className={`${ghostButtonClass} mt-6 w-full`}
            type="button"
            onClick={() => setPhase("unlocked")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to shop
          </button>
        </div>
      </section>
    </main>
  );
}
