// ponytail: non-component exports must live in a separate file so Vite's
// React Fast Refresh can hot-reload the AppShell component cleanly.
import type { LucideIcon } from "lucide-react";
import { Building2, HardDrive, Package, Printer, Users } from "lucide-react";

export type SettingsCategoryId = "shop" | "catalog" | "printing" | "team" | "system";

export const SETTINGS_CATEGORIES: ReadonlyArray<{ id: SettingsCategoryId; label: string; icon: LucideIcon }> = [
  { id: "shop", label: "Shop", icon: Building2 },
  { id: "catalog", label: "Inventory", icon: Package },
  { id: "printing", label: "Printing", icon: Printer },
  { id: "team", label: "Team & Devices", icon: Users },
  { id: "system", label: "System", icon: HardDrive },
];

const SETTINGS_ITEM_CATEGORY_BY_PREFIX = [
  ["#/settings/shop-info", "shop"],
  ["#/settings/currency", "shop"],
  ["#/settings/customer-types", "catalog"],
  ["#/settings/locations", "catalog"],
  ["#/settings/catalog", "catalog"],
  ["#/settings/hardware", "printing"],
  ["#/settings/users", "team"],
  ["#/settings/devices", "team"],
  ["#/settings/backup", "system"],
  ["#/settings/security", "system"],
  ["#/settings/owner-security", "system"],
  ["#/settings/theme", "system"],
  ["#/settings/master-health", "system"],
] as const;

export function categoryForSettingsItemHash(hash: string): SettingsCategoryId | null {
  const match = SETTINGS_ITEM_CATEGORY_BY_PREFIX.find(([prefix]) => hash === prefix || hash.startsWith(`${prefix}/`));
  return match?.[1] ?? null;
}
