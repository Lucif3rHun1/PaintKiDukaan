// @ts-nocheck
import { useEffect, useState } from "react";
import { toast } from "../../../lib/feedback/toast";
import { Button, Card, DataTable, Section, Skeleton, Badge } from "../../../components/ui";
import type { ColumnDef } from "../../../components/ui";
import { formatDateForDisplay } from "../../../lib/date";
import { ipc, type Device } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";

/* ── shared helpers ─────────────────────────────────────────────── */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary";

/* ── 1. UsersSettings ───────────────────────────────────────────── */

interface UserRecord {
  id: number;
  name: string;
  role: string;
  is_active: boolean;
}

function UsersTable({
  users,
  onDelete,
}: {
  users: UserRecord[];
  onDelete: (user: UserRecord) => void;
}) {
  const columns: ColumnDef<UserRecord>[] = [
    {
      header: "User",
      cell: (user) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{user.name}</span>
          <Badge variant="info" size="sm">
            {user.role}
          </Badge>
          {!user.is_active && (
            <Badge variant="muted" size="sm">
              Inactive
            </Badge>
          )}
        </div>
      ),
    },
    {
      header: "Action",
      align: "right",
      cell: (user) =>
        user.role === "owner" ? (
          <span
            className="cursor-not-allowed text-xs text-muted-foreground"
            title="The owner account cannot be deleted"
          >
            Owner
          </span>
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDelete(user)}
          >
            Delete
          </Button>
        ),
    },
  ];

  return (
    <DataTable
      data={users}
      columns={columns}
      keyExtractor={(user) => user.id}
      emptyState={
        <p className="px-3 py-3 text-center text-muted-foreground">
          No users configured.
        </p>
      }
    />
  );
}

export function UsersSettings() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<string>("cashier");
  const [newPin, setNewPin] = useState("");

  function load() {
    ipc
      .listUsers()
      .then((d) => setUsers(d ?? [])).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser() {
    if (!newName.trim() || newPin.length !== 6) return;
    setCreating(true);
    try {
      await ipc.createUser(newName.trim(), newRole, newPin);
      setNewName("");
      setNewPin("");
      setNewRole("cashier");
      toast.success("User created");
      load();
    } catch (e) {
      toast.error("Failed to create user", extractError(e));
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(user: UserRecord) {
    if (user.role === "owner") return;
    if (
      !window.confirm(
        `Delete user "${user.name}"? They will no longer be able to log in.`,
      )
    )
      return;
    try {
      await ipc.deleteUser(user.id);
      toast.success("User removed");
      load();
    } catch (e) {
      toast.error("Failed to delete user", extractError(e));
    }
  }

  if (loading) return <Skeleton variant="card" className="h-40" />;

  const pinValid = newPin.length === 6 && /^\d{6}$/.test(newPin);

  return (
    <Card>
      <Section
        title="Users"
        description="Create local accounts and assign operational roles."
      >
        <div className="space-y-4 text-sm">
          {/* user list */}
          <UsersTable users={users} onDelete={deleteUser} />

          {/* add user form */}
          <div className="flex items-end gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <Field label="Name">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Ravi"
                className={inputCls}
              />
            </Field>
            <Field label="Role">
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className={inputCls}
              >
                <option value="cashier">cashier</option>
                <option value="stocker">stocker</option>
              </select>
            </Field>
            <Field label="PIN (6 digits)">
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                pattern="\d{6}"
                value={newPin}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setNewPin(v);
                }}
                placeholder="••••••"
                className={inputCls}
              />
            </Field>
            <Button
              onClick={createUser}
              loading={creating}
              disabled={!newName.trim() || !pinValid}
            >
              Add user
            </Button>
          </div>
        </div>
      </Section>
    </Card>
  );
}

/* ── 2. DevicesSettings ─────────────────────────────────────────── */

const ROLES = ["owner", "cashier", "stocker"] as const;

function formatDate(ms: number): string {
  return formatDateForDisplay(ms);
}

export function DevicesSettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<string>("cashier");

  function load() {
    setLoading(true);
    ipc
      .listDevices()
      .then((d) => setDevices(d ?? [])).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function enroll() {
    if (!newName.trim()) return;
    setEnrolling(true);
    try {
      await ipc.enrollDevice(newName.trim(), newRole);
      setNewName("");
      toast.success("Device enrolled");
      load();
    } catch (e) {
      toast.error("Failed to enroll device", extractError(e));
    } finally {
      setEnrolling(false);
    }
  }

  async function revoke(device: Device) {
    if (
      !window.confirm(
        `Revoke device "${device.name}"? It will no longer be able to unlock the app.`,
      )
    )
      return;
    try {
      await ipc.revokeDevice(device.id);
      toast.success("Device revoked");
      load();
    } catch (e) {
      toast.error("Failed to revoke device", extractError(e));
    }
  }

  if (loading) return <Skeleton variant="card" className="h-60" />;

  return (
    <Card>
      <Section
        title="Trusted devices"
        description="Devices authorised to unlock this shop database. Each device gets a role-based PIN entry screen."
      >
        <div className="space-y-4 text-sm">
          {/* device table */}
          <DevicesTable devices={devices} onRevoke={revoke} />

          {/* enroll form */}
          <div className="flex items-end gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <Field label="Device name">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Counter PC"
                className={inputCls}
              />
            </Field>
            <Field label="Role">
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className={inputCls}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              onClick={enroll}
              loading={enrolling}
              disabled={!newName.trim()}
            >
              Enroll
            </Button>
          </div>
        </div>
      </Section>
    </Card>
  );
}
