import { setHash } from "@/lib/navigate";
import type { AppShellTab } from "./AppShell";
import { SkeletonRow } from "@/components/ui";

/* ── Hash routing ───────────────────────────────────────── */
export const HASH_REDIRECTS: Record<string, string> = {
  "#/pos": "#/sales",
  "#/pos/inward": "#/inward",

  "#/pos/dayclose": "#/day-close",
  "#/pos/day-close": "#/day-close",
  "#/pos/reports": "#/reports/sales",
  "#/sales-report": "#/reports/sales",
};

// Restore hash from localStorage if the current hash is empty.
// Called once before React reads window.location.hash on startup.
export function restoreLastHash(): void {
  if (typeof window === "undefined") return;
  if (window.location.hash) return; // already has a route
  const saved = localStorage.getItem("pkb:lastHash");
  if (saved && saved !== "#/" && saved !== "") {
    setHash(saved);
    localStorage.removeItem("pkb:lastHash");
  }
}

export function readTab(): AppShellTab {
  const h = typeof window !== "undefined" ? window.location.hash : "";
  if (h.startsWith("#/reports") || h.startsWith("#/sales-report")) return "sales-report";
  if (h.startsWith("#/day-close")) return "day-close";
  if (h.startsWith("#/inward")) return "inward";
  if (h.startsWith("#/sales")) return "sales";
  if (h.startsWith("#/formulas")) return "formulas";
  if (h.startsWith("#/barcodes")) return "barcodes";
  if (h.startsWith("#/items")) return "items";
  if (h.startsWith("#/customers")) return "customers";
  if (h.startsWith("#/vendors")) return "vendors";
  if (h.startsWith("#/settings")) return "settings";
  if (h.startsWith("#/health")) return "health";
  if (h.startsWith("#/logs")) return "logs";
  return "dashboard";
}

export function readSalesSubRoute(): "list" | "new" | "return" | "return-list" | "return-detail" | "sale-detail" | "edit" {
  const h = window.location.hash.split("?")[0];
  if (h === "#/sales/new") return "new";
  if (h === "#/sales/return/new") return "return";
  const detailMatch = h.match(/^#\/sales\/return\/(.+)$/);
  if (h === "#/sales/return") return "return-list";
  if (detailMatch) return "return-detail";
  const editMatch = h.match(/^#\/sales\/edit\/(\d+)$/);
  if (editMatch) return "edit";
  const saleDetail = h.match(/^#\/sales\/(\d+)$/);
  if (saleDetail) return "sale-detail";
  return "list";
}

export function readFormulasSubRoute(): "list" | "detail" {
  const h = window.location.hash;
  if (h && /^#\/formulas\/\d+/.test(h)) return "detail";
  return "list";
}

export function readInwardSubRoute(): "list" | "new" | "detail" {
  const h = window.location.hash.split("?")[0];
  if (h === "#/inward/new") return "new";
  const detailMatch = h.match(/^#\/inward\/(\d+)$/);
  if (detailMatch) return "detail";
  return "list";
}

export function applyHashRedirect(): boolean {
  if (typeof window === "undefined") return false;
  const target = HASH_REDIRECTS[window.location.hash];
  if (target) {
    window.location.replace(target);
    return true;
  }
  return false;
}

export function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading page"
      className="space-y-3 py-4"
    >
      <SkeletonRow count={4} />
    </div>
  );
}
