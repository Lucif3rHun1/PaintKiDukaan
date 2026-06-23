// @ts-nocheck
import { useEffect, useState } from "react";
import { toast } from "../../../lib/feedback/toast";
import { Button, Card, Section, Skeleton, Badge } from "../../../components/ui";
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
      .then(setUsers).catch((err: unknown) => console.error("Silent catch replaced:", err))
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
          {users.length === 0 ? (
            <p className="text-muted-foreground">No users configured.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {users.map((user) => (
                <li
                  key={user.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">
                      {user.name}
                    </span>
                    <Badge variant="info" size="sm">
                      {user.role}
                    </Badge>
                    {!user.is_active && (
                      <Badge variant="muted" size="sm">
                        Inactive
                      </Badge>
                    )}
                  </div>
                  {user.role === "owner" ? (
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
                      onClick={() => deleteUser(user)}
                    >
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

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
      .then(setDevices).catch((err: unknown) => console.error("Silent catch replaced:", err))
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
          {devices.length === 0 ? (
            <p className="text-muted-foreground">No devices enrolled yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Enrolled</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {devices.map((d) => (
                    <tr key={d.id} className="text-foreground">
                      <td className="px-3 py-2 font-medium">{d.name}</td>
                      <td className="px-3 py-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                          {d.role}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(d.enrolled_at_unix_ms)}
                      </td>
                      <td className="px-3 py-2">
                        {d.is_active ? (
                          <span className="text-success">Active</span>
                        ) : (
                          <span className="text-muted-foreground">Inactive</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => revoke(d)}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
