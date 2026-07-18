import { describe, expect, it } from "vitest";

import {
  dashboardTabsForRole,
  quickActionIdsForRole,
  roleCanReadAlerts,
  roleCanReadBusiness,
  roleCanReadInventoryAnalytics,
  roleCanReadInventoryTurnover,
  roleCanReadDayClose,
} from "./access";
import { roleCanAccessShellTarget } from "../../access";

const SHELL_TARGETS = [
  "dashboard",
  "sales",
  "sales-return",
  "inward",
  "items",
  "formulas",
  "barcode-labels",
  "customers",
  "vendors",
  "sales-report",
  "day-close",
  "settings",
  "settings-shop",
  "settings-catalog",
  "settings-printing",
  "settings-team",
  "settings-system",
  "health",
  "logs",
] as const;

function visibleShellTargets(role: "owner" | "cashier" | "stocker") {
  return SHELL_TARGETS.filter((target) => roleCanAccessShellTarget(role, target));
}

describe("dashboard role access", () => {
  it("matches the backend ACL for owner", () => {
    expect(dashboardTabsForRole("owner")).toEqual(["business", "inventory"]);
    expect(roleCanReadBusiness("owner")).toBe(true);
    expect(roleCanReadInventoryAnalytics("owner")).toBe(true);
    expect(roleCanReadInventoryTurnover("owner")).toBe(true);
    expect(roleCanReadDayClose("owner")).toBe(true);
    expect(roleCanReadAlerts("owner")).toBe(true);
    expect(quickActionIdsForRole("owner")).toEqual([
      "new-sale",
      "new-inward",
      "day-close",
      "add-customer",
      "scan-barcode",
      "reports",
    ]);
  });

  it("matches the backend ACL for cashier", () => {
    expect(dashboardTabsForRole("cashier")).toEqual(["business", "inventory"]);
    expect(roleCanReadBusiness("cashier")).toBe(true);
    expect(roleCanReadInventoryAnalytics("cashier")).toBe(true);
    expect(roleCanReadInventoryTurnover("cashier")).toBe(false);
    expect(roleCanReadDayClose("cashier")).toBe(false);
    expect(roleCanReadAlerts("cashier")).toBe(true);
    expect(quickActionIdsForRole("cashier")).toEqual([
      "new-sale",
      "new-inward",
      "add-customer",
      "scan-barcode",
    ]);
  });

  it("keeps stocker on stocker-safe dashboard paths", () => {
    expect(dashboardTabsForRole("stocker")).toEqual(["inventory"]);
    expect(roleCanReadBusiness("stocker")).toBe(false);
    expect(roleCanReadInventoryAnalytics("stocker")).toBe(false);
    expect(roleCanReadInventoryTurnover("stocker")).toBe(false);
    expect(roleCanReadDayClose("stocker")).toBe(false);
    expect(roleCanReadAlerts("stocker")).toBe(false);
    expect(quickActionIdsForRole("stocker")).toEqual(["items", "barcodes"]);
  });

  it("keeps desktop links, mobile links, and shortcuts on the root RoleGuard matrix", () => {
    expect(visibleShellTargets("owner")).toEqual(SHELL_TARGETS);
    expect(visibleShellTargets("cashier")).toEqual([
      "dashboard",
      "sales",
      "sales-return",
      "inward",
      "items",
      "formulas",
      "barcode-labels",
      "customers",
      "vendors",
    ]);
    expect(visibleShellTargets("stocker")).toEqual([
      "dashboard",
      "items",
      "formulas",
      "barcode-labels",
    ]);
  });

  it("denies stocker every cashier-or-owner-only shell target", () => {
    const deniedForStocker = [
      "sales",
      "sales-return",
      "inward",
      "customers",
      "vendors",
      "sales-report",
      "day-close",
      "settings",
      "settings-shop",
      "settings-catalog",
      "settings-printing",
      "settings-team",
      "settings-system",
      "health",
      "logs",
    ] as const;
    for (const target of deniedForStocker) {
      expect(roleCanAccessShellTarget("stocker", target)).toBe(false);
    }
  });

  it("allows cashier all operational targets but not admin-only targets", () => {
    const operational: typeof SHELL_TARGETS[number][] = [
      "dashboard",
      "sales",
      "sales-return",
      "inward",
      "items",
      "formulas",
      "barcode-labels",
      "customers",
      "vendors",
    ];
    for (const target of operational) {
      expect(roleCanAccessShellTarget("cashier", target)).toBe(true);
    }
    const adminOnly: typeof SHELL_TARGETS[number][] = [
      "sales-report",
      "day-close",
      "settings",
      "settings-shop",
      "settings-catalog",
      "settings-printing",
      "settings-team",
      "settings-system",
      "health",
      "logs",
    ];
    for (const target of adminOnly) {
      expect(roleCanAccessShellTarget("cashier", target)).toBe(false);
    }
  });

  it("limits quick actions to role-reachable routes", () => {
    expect(quickActionIdsForRole("owner")).toContain("day-close");
    expect(quickActionIdsForRole("owner")).toContain("reports");
    expect(quickActionIdsForRole("cashier")).not.toContain("day-close");
    expect(quickActionIdsForRole("cashier")).not.toContain("reports");
    expect(quickActionIdsForRole("stocker")).toEqual(["items", "barcodes"]);
    expect(quickActionIdsForRole("stocker")).not.toContain("new-sale");
    expect(quickActionIdsForRole("stocker")).not.toContain("new-inward");
    expect(quickActionIdsForRole("stocker")).not.toContain("add-customer");
  });
});
