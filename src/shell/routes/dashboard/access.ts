import type { Role } from "../../../lib/security/state";

export type DashTab = "inventory" | "business";
export type QuickActionId =
  | "new-sale"
  | "new-inward"
  | "day-close"
  | "add-customer"
  | "scan-barcode"
  | "reports"
  | "items"
  | "barcodes";

const BUSINESS_TABS = ["business", "inventory"] as const;
const STOCKER_TABS = ["inventory"] as const;
const OWNER_ACTIONS = [
  "new-sale",
  "new-inward",
  "day-close",
  "add-customer",
  "scan-barcode",
  "reports",
] as const;
const CASHIER_ACTIONS = [
  "new-sale",
  "new-inward",
  "add-customer",
  "scan-barcode",
] as const;
const STOCKER_ACTIONS = ["items", "barcodes"] as const;

export function dashboardTabsForRole(role: Role): readonly DashTab[] {
  return role === "stocker" ? STOCKER_TABS : BUSINESS_TABS;
}

export function quickActionIdsForRole(role: Role): readonly QuickActionId[] {
  if (role === "owner") return OWNER_ACTIONS;
  if (role === "cashier") return CASHIER_ACTIONS;
  return STOCKER_ACTIONS;
}

export function roleCanReadBusiness(role: Role): boolean {
  return role !== "stocker";
}

export function roleCanReadInventoryAnalytics(role: Role): boolean {
  return role !== "stocker";
}

export function roleCanReadInventoryTurnover(role: Role): boolean {
  return role === "owner";
}

export function roleCanReadDayClose(role: Role): boolean {
  return role === "owner";
}

export function roleCanReadAlerts(role: Role): boolean {
  return role !== "stocker";
}
