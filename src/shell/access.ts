import type { Role } from "../lib/security/state";

const ROLE_RANK: Readonly<Record<Role, number>> = {
  stocker: 0,
  cashier: 1,
  owner: 2,
};

const SHELL_TARGET_MIN_ROLE: Readonly<Record<string, Role>> = {
  sales: "cashier",
  "sales-return": "cashier",
  inward: "cashier",
  customers: "cashier",
  vendors: "cashier",
  "sales-report": "owner",
  "day-close": "owner",
  settings: "owner",
  "settings-shop": "owner",
  "settings-catalog": "owner",
  "settings-printing": "owner",
  "settings-team": "owner",
  "settings-system": "owner",
  health: "owner",
  logs: "owner",
};

export function roleCanAccessShellTarget(role: Role, targetId: string): boolean {
  const minimumRole = SHELL_TARGET_MIN_ROLE[targetId] ?? "stocker";
  return ROLE_RANK[role] >= ROLE_RANK[minimumRole];
}
