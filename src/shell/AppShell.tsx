import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Barcode,
  Building2,
  ChevronDown,
  HardDrive,
  LayoutDashboard,
  Lock,
  LogOut,
  Package,
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
import { AlertBell } from "./components/AlertBell";
import type { Role } from "../lib/security/state";

export type AppShellTab =
  | "dashboard"
  | "sales"
  | "inward"
  | "items"
  | "barcodes"
  | "customers"
  | "vendors"
  | "sales-report"
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
  { id: "catalog", label: "Catalog", icon: Package },
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
  { id: "items", label: "Items", icon: Package, tab: "items", hash: "#/items" },
  { id: "customers", label: "Customers", icon: Users, tab: "customers", hash: "#/customers" },
  { id: "vendors", label: "Vendors", icon: UserCheck, tab: "vendors", hash: "#/vendors" },
  { id: "sales-report", label: "Reports", icon: BarChart3, tab: "sales-report", hash: "#/sales-report" },
  { id: "settings", label: "Settings", icon: Settings, tab: "settings", hash: "#/settings" },
];

const groups: SidebarGroup[] = [
  {
    id: "sales",
    label: "Sales",
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
      { id: "sales-report", label: "Sales Report", icon: BarChart3, tab: "sales-report", hash: "#/sales-report" },
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

const sectionLabels = ["Main", "Sales", "Inventory", "Parties", "Reports", "Settings"] as const;

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

export function AppShell({ activeTab, user, bootstrapError, onNavigate, onLock, onLogout, children }: AppShellProps) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const collapsed = !wide;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    sales: true,
    inventory: true,
    parties: true,
    reports: true,
    settings: true,
  });

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

          {groups.map((group, index) => {
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
                        active={isLinkActive(item, activeTab, group.items)}
                        collapsed={collapsed}
                        onNavigate={onNavigate}
                        nested
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <AccountMenu user={user} collapsed={collapsed} onLock={onLock} onLogout={onLogout ?? onLock} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <img src={LOGO_64} alt="PaintKiDukaan" width={28} height={28} className="h-7 w-7 rounded-md object-contain" />
            <span className="text-sm font-semibold text-sidebar-foreground">PaintKiDukaan</span>
          </div>
          <div className="flex items-center gap-1">
            <AlertBell currentRole={user?.role as Role | undefined} />
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

        <header className="hidden md:flex items-center justify-end border-b border-border bg-card px-4 py-2">
          <AlertBell currentRole={user?.role as Role | undefined} />
        </header>

        <nav className="flex overflow-x-auto border-b border-border bg-muted px-2 py-1 md:hidden">
          {mobileLinks.map((item) => (
            <SidebarLinkButton key={item.id} link={item} active={isLinkActive(item, activeTab)} collapsed={false} onNavigate={onNavigate} mobile />
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto bg-background p-4 text-foreground sm:p-6">
          {bootstrapError ? (
            <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {bootstrapError}
            </p>
          ) : null}
          {children}
        </main>
      </div>
      <Toaster />
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
    </button>
  );
}

function AccountMenu({ user, collapsed, onLock, onLogout }: { user: AppShellUser | null; collapsed: boolean; onLock: () => void; onLogout: () => void }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => firstItemRef.current?.focus(), 0);
    }
  }, [open]);

  function close() {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
      <div className="border-t border-sidebar-border pt-3">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/80",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          {(user?.name ?? "Owner").slice(0, 1).toUpperCase()}
        </div>
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-sidebar-foreground">{user?.name ?? "Owner"}</div>
              <div className="truncate text-xs text-sidebar-foreground/60">{user?.role ?? "owner"}</div>
            </div>
            <ChevronDown className="h-4 w-4 text-sidebar-foreground/60" aria-hidden="true" />
          </>
        ) : null}
      </button>
      {open ? (
        <dialog
          ref={dialogRef}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClose={() => setOpen(false)}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          className="fixed bottom-16 left-3 m-0 w-52 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground"
        >
          <button ref={firstItemRef} type="button" onClick={() => { onLock(); close(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Lock
          </button>
          <button type="button" onClick={() => { onLogout(); close(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Logout
          </button>
        </dialog>
      ) : null}
    </div>
  );
}
