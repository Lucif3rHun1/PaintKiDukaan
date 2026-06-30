import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Barcode,
  Building2,
  ChevronDown,
  ClipboardCheck,
  Activity,
  HardDrive,
  LayoutDashboard,
  Lock,
  LogOut,
  Package,
  Paintbrush,
  Printer,
  RotateCcw,
  Settings,
  ShoppingCart,
  Truck,
  UserCheck,
  Users,
} from "lucide-react";

import logo32 from "../assets/logo-32.png";
import logo64 from "../assets/logo-64.png";
const LOGO_64 = logo64;
import { cn, Toaster } from "../components/ui";
import { DraftBadge } from "../components/ui/DraftBadge";
import { KbdHint } from "../components/ui/KbdHint";
import { ShortcutOverlay, type ShortcutGroup } from "../components/ui/ShortcutOverlay";
import { usePageBadge } from "../pos/hooks";
import { useShortcut } from "../lib/shortcuts";
import { toTitleCase } from "../lib/format/titleCase";
import { AlertBell } from "./components/AlertBell";
import type { Role } from "../lib/security/state";
import { ipc } from "./lib/ipc";
import { useGlobalShortcuts } from "../lib/shortcuts/useGlobalShortcuts";

export type AppShellTab =
  | "dashboard"
  | "sales"
  | "inward"
  | "items"
  | "barcodes"
  | "formulas"
  | "customers"
  | "vendors"
  | "sales-report"
  | "day-close"
  | "settings"
  | "health"
  | "logs";

interface AppShellUser {
  name?: string;
  role?: string;
}

interface AppShellProps {
  activeTab: AppShellTab;
  user: AppShellUser | null;
  bootstrapError?: string | null;
  onNavigate: (tab: AppShellTab, hash?: string) => void;
  onLock: () => void;
  onLogout?: () => void;
  onSwitchUser?: () => void;
  children: ReactNode;
}

export type SettingsCategoryId = "shop" | "catalog" | "printing" | "team" | "system";

interface SidebarLink {
  id: string;
  label: string;
  icon: LucideIcon;
  tab: AppShellTab;
  hash?: string;
  category?: SettingsCategoryId;
}

interface SidebarGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  items: SidebarLink[];
}

export const SETTINGS_CATEGORIES: ReadonlyArray<{ id: SettingsCategoryId; label: string; icon: LucideIcon }> = [
  { id: "shop", label: "Shop", icon: Building2 },
  { id: "catalog", label: "Inventory", icon: Package },
  { id: "printing", label: "Printing", icon: Printer },
  { id: "team", label: "Team & Devices", icon: Users },
  { id: "system", label: "System", icon: HardDrive },
];

const dashboardLink: SidebarLink = {
  id: "dashboard",
  label: "Dashboard",
  icon: LayoutDashboard,
  tab: "dashboard",
  hash: "#/",
};

const mobileLinks: SidebarLink[] = [
  dashboardLink,
  { id: "sales", label: "Sales", icon: ShoppingCart, tab: "sales", hash: "#/sales" },
  { id: "inward", label: "Inward", icon: Truck, tab: "inward", hash: "#/inward" },
  { id: "items", label: "Items", icon: Package, tab: "items", hash: "#/items" },
  { id: "formulas", label: "Formulas", icon: Paintbrush, tab: "formulas", hash: "#/formulas" },
  { id: "customers", label: "Customers", icon: Users, tab: "customers", hash: "#/customers" },
  { id: "vendors", label: "Vendors", icon: UserCheck, tab: "vendors", hash: "#/vendors" },
  { id: "sales-report", label: "Reports", icon: BarChart3, tab: "sales-report", hash: "#/reports/sales" },
  { id: "day-close", label: "Close Day", icon: ClipboardCheck, tab: "day-close", hash: "#/day-close" },
  { id: "sales-return", label: "Returns", icon: RotateCcw, tab: "sales", hash: "#/sales/return" },
  { id: "barcode-labels", label: "Barcodes", icon: Barcode, tab: "barcodes", hash: "#/barcodes" },
  { id: "settings", label: "Settings", icon: Settings, tab: "settings", hash: "#/settings" },
];

const groups: SidebarGroup[] = [
  {
    id: "transactions",
    label: "Transactions",
    icon: ShoppingCart,
    items: [
      { id: "sales", label: "Sales", icon: ShoppingCart, tab: "sales", hash: "#/sales" },
      { id: "sales-return", label: "Returns", icon: RotateCcw, tab: "sales", hash: "#/sales/return" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: Package,
    items: [
      { id: "inward", label: "Inward", icon: Truck, tab: "inward", hash: "#/inward" },
      { id: "items", label: "Items", icon: Package, tab: "items", hash: "#/items" },
      { id: "formulas", label: "Shade formulas", icon: Paintbrush, tab: "formulas", hash: "#/formulas" },
      { id: "barcode-labels", label: "Barcode Labels", icon: Barcode, tab: "barcodes", hash: "#/barcodes" },
    ],
  },
  {
    id: "parties",
    label: "Parties",
    icon: Users,
    items: [
      { id: "customers", label: "Customers", icon: Users, tab: "customers", hash: "#/customers" },
      { id: "vendors", label: "Vendors", icon: UserCheck, tab: "vendors", hash: "#/vendors" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: BarChart3,
    items: [
      { id: "sales-report", label: "Sales Report", icon: BarChart3, tab: "sales-report", hash: "#/reports/sales" },
      { id: "day-close", label: "Close Day", icon: ClipboardCheck, tab: "day-close", hash: "#/day-close" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    items: SETTINGS_CATEGORIES.map((category) => ({
      id: `settings-${category.id}`,
      label: category.label,
      icon: category.icon,
      tab: "settings",
      hash: `#/settings/${category.id}`,
      category: category.id,
    })),
  },
];

const sectionLabels = ["Main", "Transactions", "Inventory", "Parties", "Reports", "Settings"] as const;

const SIDEBAR_SHORTCUTS: Record<string, string> = {
  dashboard: "Alt+1",
  sales: "Alt+2",
  inward: "Alt+3",
  customers: "Alt+4",
  "sales-report": "Alt+5",
  "settings-shop": "Alt+6",
  items: "Alt+7",
  vendors: "Alt+8",
  "sales-return": "Alt+9",
  "barcode-labels": "Alt+0",
};

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

export function AppShell({ activeTab, user, bootstrapError, onNavigate, onLock, onLogout, onSwitchUser, children }: AppShellProps) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const collapsed = !wide;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    transactions: true,
    sales: true,
    inventory: true,
    parties: true,
    reports: true,
    settings: true,
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const contextPageBadge = usePageBadge();
  const [pageBadge, setPageBadge] = useState(contextPageBadge);

  useEffect(() => {
    const onPageBadge = (event: Event) => {
      const detail = (event as CustomEvent<typeof contextPageBadge>).detail;
      if (detail) setPageBadge(detail);
    };
    window.addEventListener("paintkiduakan:page-badge", onPageBadge);
    return () => window.removeEventListener("paintkiduakan:page-badge", onPageBadge);
  }, []);

  const shopNameQuery = useQuery({
    queryKey: ["app", "shopName"],
    queryFn: () => ipc.getSetting("shop_name"),
    refetchInterval: 60_000,
  });
  const backupQuery = useQuery({
    queryKey: ["app", "backup"],
    queryFn: () => ipc.backupStatus(),
    refetchInterval: 45_000,
  });
  const shopName = shopNameQuery.data || "PaintKiDukaan";
  const displayRole = toTitleCase(user?.role ?? "owner");

  useShortcut({ key: "1", alt: true, scope: "global", description: "Dashboard", onMatch: () => onNavigate("dashboard") });
  useShortcut({ key: "2", alt: true, scope: "global", description: "Sales", onMatch: () => onNavigate("sales", "#/sales") });
  useShortcut({ key: "3", alt: true, scope: "global", description: "Inward", onMatch: () => onNavigate("inward", "#/inward") });
  useShortcut({ key: "4", alt: true, scope: "global", description: "Customers", onMatch: () => onNavigate("customers", "#/customers") });
  useShortcut({ key: "5", alt: true, scope: "global", description: "Sales Report", onMatch: () => onNavigate("sales-report", "#/reports/sales") });
  useShortcut({ key: "6", alt: true, scope: "global", description: "Settings (Shop)", onMatch: () => onNavigate("settings", "#/settings/shop") });
  useShortcut({ key: "7", alt: true, scope: "global", description: "Items", onMatch: () => onNavigate("items", "#/items") });
  useShortcut({ key: "8", alt: true, scope: "global", description: "Vendors", onMatch: () => onNavigate("vendors", "#/vendors") });
  useShortcut({ key: "9", alt: true, scope: "global", description: "Returns", onMatch: () => onNavigate("sales", "#/sales/return") });
  useShortcut({ key: "0", alt: true, scope: "global", description: "Barcodes", onMatch: () => onNavigate("barcodes", "#/barcodes") });

  useGlobalShortcuts({ onHelp: () => setShowShortcuts((v) => !v) });

  const shortcutGroups: ShortcutGroup[] = [
    {
      title: "Global Navigation",
      items: [
        { key: "1", alt: true, label: "Dashboard" },
        { key: "2", alt: true, label: "Sales" },
        { key: "3", alt: true, label: "Inward" },
        { key: "4", alt: true, label: "Customers" },
        { key: "5", alt: true, label: "Sales Report" },
        { key: "6", alt: true, label: "Settings" },
        { key: "7", alt: true, label: "Items" },
        { key: "8", alt: true, label: "Vendors" },
        { key: "9", alt: true, label: "Returns" },
        { key: "0", alt: true, label: "Barcodes" },
      ],
    },
    {
      title: "Global Actions",
      items: [
        { key: "S", ctrl: true, label: "Save" },
        { key: "Esc", label: "Close / Cancel" },
        { key: "?", shift: true, label: "Toggle this cheatsheet" },
      ],
    },
    {
      title: "Sales Entry",
      items: [
        { key: "F2", label: "Scan item" },
        { key: "F5", label: "Refresh" },
        { key: "F6", label: "New bill" },
        { key: "F9", label: "Save bill" },
      ],
    },
    {
      title: "Inward",
      items: [
        { key: "F2", label: "Scan item" },
        { key: "F9", label: "Save inward" },
      ],
    },
  ];

  return (
      <div className="flex h-screen overflow-hidden bg-sidebar text-sidebar-foreground">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 transition-[width] duration-200 motion-reduce:transition-none md:flex",
            collapsed ? "w-14" : "w-60",
          )}
        >
        <div className={cn("flex items-center gap-2 px-1 py-1.5", collapsed && "justify-center")}>
          <img
            src={collapsed ? logo32 : LOGO_64}
            alt="PaintKiDukaan"
            width={collapsed ? 32 : 64}
            height={collapsed ? 32 : 64}
            className={cn("shrink-0 rounded-md object-contain ring-1 ring-inset ring-border/40", collapsed ? "h-8 w-8" : "h-10 w-10")}
          />
          {!collapsed ? (
            <span className="flex-1 truncate text-sm font-semibold tracking-tight text-sidebar-foreground">PaintKiDukaan</span>
          ) : null}
        </div>

        <nav className="mt-2 flex-1 overflow-y-auto overflow-x-hidden">
          <SidebarSectionLabel collapsed={collapsed}>{sectionLabels[0]}</SidebarSectionLabel>
          <SidebarLinkButton link={dashboardLink} active={activeTab === "dashboard"} collapsed={collapsed} onNavigate={onNavigate} />

          {(() => {
            // Flatten every sidebar link across all groups so isLinkActive can
            // detect cross-group yield (e.g. "Sales" at #/sales must yield to
            // "Returns" at #/sales/return even though they live in different
            // groups). Without this both entries would light up simultaneously
            // when the user is on a Returns sub-route.
            const allLinks: SidebarLink[] = groups.flatMap((g) => g.items);
            return groups.map((group, index) => {
            const singleItem = group.items.length === 1;
            if (singleItem && collapsed) {
              return (
                <div key={group.id} className="mt-2">
                  <SidebarLinkButton
                    link={group.items[0]}
                    active={isLinkActive(group.items[0], activeTab)}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                </div>
              );
            }
            if (singleItem && !collapsed) {
              return (
                <div key={group.id} className="mt-2">
                  <SidebarSectionLabel collapsed={collapsed}>{sectionLabels[index + 1]}</SidebarSectionLabel>
                  <SidebarLinkButton
                    link={group.items[0]}
                    active={isLinkActive(group.items[0], activeTab)}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                </div>
              );
            }
            return (
              <div key={group.id} className="mt-1">
                <SidebarSectionLabel collapsed={collapsed}>{sectionLabels[index + 1]}</SidebarSectionLabel>
                <button
                  type="button"
                  onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <group.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed ? <span className="flex-1 text-left">{group.label}</span> : null}
                  {!collapsed ? <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", !expanded[group.id] && "-rotate-90")} /> : null}
                </button>
                {expanded[group.id] && !collapsed ? (
                  <div className="mt-0.5 space-y-0.5">
                    {group.items.map((item) => (
                      <SidebarLinkButton
                        key={item.id}
                        link={item}
                        active={isLinkActive(item, activeTab, allLinks)}
                        collapsed={collapsed}
                        onNavigate={onNavigate}
                        nested
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
            });
          })()}
        </nav>

        <AccountMenu
          user={user}
          shopName={shopNameQuery.data ?? null}
          collapsed={collapsed}
          onLock={onLock}
          onLogout={onLogout ?? onLock}
          onSwitchUser={onSwitchUser ?? onLock}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Desktop top bar */}
        <header className="hidden md:flex h-14 items-center justify-between border-b border-border bg-background px-4 sticky top-0 z-40">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground tracking-tight">
            <span>{tabTitle(activeTab)}</span>
            {activeTab !== "dashboard" ? <DraftBadge draft={pageBadge.draft} /> : null}
            {activeTab === "dashboard" ? (
              <span className="font-normal text-muted-foreground">
                {" · "}{shopName}{" · "}{displayRole}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <AlertBell currentRole={user?.role as Role | undefined} />
            <BackupActivity backupAge={backupQuery.data?.backup_age_hours ?? null} />
            <button
              type="button"
              onClick={onLock}
              aria-label="Lock app"
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Lock className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <img src={LOGO_64} alt="PaintKiDukaan" width={28} height={28} className="h-7 w-7 rounded-md object-contain" />
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-sidebar-foreground">{shopName}</span>
              <span className="text-[11px] text-muted-foreground">{displayRole}</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <AlertBell currentRole={user?.role as Role | undefined} />
            <BackupActivity backupAge={backupQuery.data?.backup_age_hours ?? null} />
            <button
              type="button"
              onClick={onLock}
              aria-label="Lock app"
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <Lock className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav className="flex overflow-x-auto border-b border-border bg-muted px-2 py-1 md:hidden">
          {mobileLinks.slice(0, 7).map((item) => (
            <SidebarLinkButton key={item.id} link={item} active={isLinkActive(item, activeTab)} collapsed={false} onNavigate={onNavigate} mobile />
          ))}
          <MobileMoreMenu links={mobileLinks.slice(7)} activeTab={activeTab} onNavigate={onNavigate} />
        </nav>

        <main className="flex-1 overflow-y-auto bg-background px-4 pt-3 pb-4 text-foreground sm:px-6 sm:pt-4 sm:pb-6">
          {bootstrapError ? (
            <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {bootstrapError}
            </p>
          ) : null}
          {children}
        </main>
      </div>
      <Toaster />
      <ShortcutOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} groups={shortcutGroups} />
    </div>
  );
}

function SidebarSectionLabel({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  if (collapsed) return <div className="mt-2" />;
  return <div className="mb-1 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">{children}</div>;
}

function isLinkActive(
  link: SidebarLink,
  activeTab: AppShellTab,
  siblings: SidebarLink[] = [],
): boolean {
  if (link.tab !== activeTab) return false;
  if (typeof window === "undefined") return true;
  const hash = window.location.hash;
  if (link.tab === "settings") {
    if (link.category) return hash === link.hash || hash.startsWith(`${link.hash}/`);
    return hash === "" || hash === "#/" || hash === "#/settings";
  }
  // A parent link (e.g. "Items" at #/items) must yield to a more specific
  // sibling (e.g. "Barcode Labels" at #/items/barcodes) when one exists in
  // the same sidebar group. Otherwise both light up simultaneously.
  if (!link.hash) return false;
  const linkHash = link.hash;
  const hasMoreSpecificSibling = siblings.some(
    (other) =>
      other !== link &&
      !!other.hash &&
      other.hash.length > linkHash.length &&
      hash.startsWith(other.hash),
  );
  if (hasMoreSpecificSibling) return false;
  return hash === linkHash || (linkHash !== "#/" && hash.startsWith(`${linkHash}/`));
}

function SidebarLinkButton({
  link,
  active,
  collapsed,
  nested = false,
  mobile = false,
  onNavigate,
}: {
  link: SidebarLink;
  active: boolean;
  collapsed: boolean;
  nested?: boolean;
  mobile?: boolean;
  onNavigate: (tab: AppShellTab, hash?: string) => void;
}) {
  const Icon = link.icon;
  const shortcut = SIDEBAR_SHORTCUTS[link.id];
  return (
    <button
      type="button"
      onClick={() => onNavigate(link.tab, link.hash)}
      className={cn(
        "flex items-center gap-2 rounded-md text-sm transition-colors",
        mobile ? "shrink-0 px-3 py-1.5 text-xs" : "h-9 w-full px-2",
        nested && "pl-9",
        collapsed && !mobile && "justify-center px-0",
        active ? "bg-sidebar-primary text-sidebar-primary-foreground" : mobile ? "text-sidebar-foreground/60 hover:text-sidebar-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      title={collapsed ? link.label : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed || mobile ? <span className="truncate">{link.label}</span> : null}
      {shortcut && !collapsed && !mobile ? <KbdHint keys={shortcut} /> : null}
    </button>
  );
}

function tabTitle(tab: AppShellTab): string {
  switch (tab) {
    case "dashboard": return "Dashboard";
    case "sales": return "Sales";
    case "inward": return "Inward";
    case "items": return "Items";
    case "barcodes": return "Barcode Labels";
    case "formulas": return "Shade formulas";
    case "customers": return "Customers";
    case "vendors": return "Vendors";
    case "sales-report": return "Sales Report";
    case "day-close": return "Close Day";
    case "settings": return "Settings";
    case "health": return "Health";
    case "logs": return "Logs";
    default: return "PaintKiDukaan";
  }
}

function BackupActivity({ backupAge }: { backupAge: number | null }) {
  const tone = backupAge === null ? "text-muted-foreground" : backupAge > 24 ? "text-destructive" : backupAge > 12 ? "text-warning" : "text-success";
  const status = backupAge === null ? "Backup status unknown" : backupAge > 24 ? "Backup overdue" : backupAge > 12 ? "Backup aging" : "Backup healthy";
  return (
    <div className="group relative">
      <Activity className={cn("h-4 w-4", tone)} aria-label={status} />
      <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100">
        <div className="font-medium">Backup Status</div>
        <div>{status}</div>
        <div>Age: {backupAge === null ? "Unknown" : `${Math.round(backupAge)}h`}</div>
      </div>
    </div>
  );
}

function AccountMenu({ user, shopName, collapsed, onLock, onLogout, onSwitchUser }: { user: AppShellUser | null; shopName?: string | null; collapsed: boolean; onLock: () => void; onLogout: () => void; onSwitchUser: () => void }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [hasOtherUsers, setHasOtherUsers] = useState(false);

  useEffect(() => {
    ipc.listUsers().then((users) => setHasOtherUsers(users.length > 1)).catch(() => setHasOtherUsers(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    const firstItem = firstItemRef.current;
    window.setTimeout(() => firstItem?.focus(), 0);

    function handleOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const displayName = toTitleCase(user?.name ?? "Owner");
  const displayRole = user?.role ?? "stocker";

  return (
    <div ref={wrapperRef} className="relative border-t border-sidebar-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/80",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          {displayName.slice(0, 1)}
        </div>
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-sidebar-foreground">{displayName}</div>
              <div className="truncate text-xs text-sidebar-foreground/60">{displayRole}</div>
            </div>
            <ChevronDown className={cn("h-4 w-4 text-sidebar-foreground/60 transition-transform", open && "rotate-180")} aria-hidden="true" />
          </>
        ) : null}
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-border bg-popover p-1.5 text-sm text-popover-foreground shadow-xl">
          {/* User header */}
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {displayName.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">{displayName}</div>
              <div className="truncate text-xs text-muted-foreground">{shopName || "PaintKiDukaan"} · {displayRole}</div>
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          {/* Menu items */}
          <button
            ref={firstItemRef}
            type="button"
            onClick={() => { onLock(); setOpen(false); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
          >
            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Lock
          </button>
          {hasOtherUsers ? (
            <button
              type="button"
              onClick={() => { onSwitchUser(); setOpen(false); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
            >
              <UserCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Switch User
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { onLogout(); setOpen(false); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-destructive transition-colors hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MobileMoreMenu({ links, activeTab, onNavigate }: { links: SidebarLink[]; activeTab: AppShellTab; onNavigate: (tab: AppShellTab, hash?: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 px-3 py-1.5 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
      >
        More ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 rounded-lg border border-border bg-popover p-1 shadow-xl z-50">
          {links.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onNavigate(item.tab, item.hash);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm",
                isLinkActive(item, activeTab) ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
