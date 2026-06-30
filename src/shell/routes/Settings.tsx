import { useEffect, useMemo, useSyncExternalStore, type ComponentType } from "react";
import {
  BadgeIndianRupee,
  Building2,
  ChevronLeft,
  ClipboardList,
  DatabaseBackup,
  HardDrive,
  MapPin,
  Monitor,
  PaintBucket,
  ScanLine,
  ShieldCheck,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

import { SETTINGS_CATEGORIES, type SettingsCategoryId } from "../AppShell";
import { Button, PageHeader } from "../../components/ui";
import { CustomerTypesSettings, LocationsSettings, CatalogSettingsCombined } from "./settings/CatalogSettings";
import { HardwareSettings } from "./settings/HardwareSettings";
import { SettingsCategory } from "./settings/SettingsCategory";
import { ShopInfoSettings, CurrencySettings } from "./settings/ShopSettings";
import { BackupSettings, MasterHealthSettings, SecuritySettings, ThemeSettings } from "./settings/SystemSettings";
import { UsersSettings, DevicesSettings } from "./settings/TeamSettings";

type SettingsItemId =
  | "shop-info"
  | "currency"
  | "customer-types"
  | "locations"
  | "catalog"
  | "hardware"
  | "devices"
  | "users"
  | "backup"
  | "security"
  | "theme"
  | "master-health";

interface SettingsItem {
  id: SettingsItemId;
  category: SettingsCategoryId;
  title: string;
  description: string;
  icon: LucideIcon;
  Component: ComponentType;
}

interface ParsedSettingsRoute {
  category: SettingsCategoryId;
  item: SettingsItemId | null;
  redirect?: string;
}

const CATEGORY_DESCRIPTIONS: Record<SettingsCategoryId, string> = {
  shop: "Identity, currency, and tax defaults for this local shop profile.",
  catalog: "Manage inventory categories, brands, units, and locations.",
  printing: "Printers and barcode scanners used for receipts, labels, and stock ops.",
  team: "Users, devices, and permissions for sign-in.",
  system: "Backup, security, and health checks.",
};

const SETTINGS_ITEMS: SettingsItem[] = [
  { id: "shop-info", category: "shop", title: "Shop info", description: "Name, phone, GSTIN, and address shown on shop documents.", icon: Building2, Component: ShopInfoSettings },
  { id: "currency", category: "shop", title: "Currency", description: "Currency code, symbol, and decimal display precision.", icon: BadgeIndianRupee, Component: CurrencySettings },
  { id: "customer-types", category: "catalog", title: "Customer types", description: "Maintain customer groups used in billing and reporting.", icon: Tags, Component: CustomerTypesSettings },
  { id: "locations", category: "catalog", title: "Locations", description: "Configure stock locations for inventory movement.", icon: MapPin, Component: LocationsSettings },
  { id: "catalog", category: "catalog", title: "Catalog", description: "Brands, categories, and units used across items and billing.", icon: PaintBucket, Component: CatalogSettingsCombined },
  { id: "hardware", category: "printing", title: "Hardware", description: "Discover and manage printers (receipt or label) and tune the barcode scanner.", icon: ScanLine, Component: HardwareSettings },
  { id: "users", category: "team", title: "Users", description: "Create accounts and assign permissions.", icon: Users, Component: UsersSettings },
  { id: "devices", category: "team", title: "Enrolled devices", description: "Devices allowed to unlock the app and their permissions.", icon: HardDrive, Component: DevicesSettings },
  { id: "backup", category: "system", title: "Backup", description: "Create protected backups and manage restore points.", icon: DatabaseBackup, Component: BackupSettings },
  { id: "security", category: "system", title: "Security", description: "Idle auto-lock and lockout policy for this device.", icon: ShieldCheck, Component: SecuritySettings },
  { id: "theme", category: "system", title: "Appearance", description: "Theme mode — system, light, or dark.", icon: Monitor, Component: ThemeSettings },
  { id: "master-health", category: "system", title: "Master health", description: "Run diagnostics across data, network, and operations.", icon: ClipboardList, Component: MasterHealthSettings },
];

const CATEGORY_IDS = new Set<SettingsCategoryId>(SETTINGS_CATEGORIES.map((category) => category.id));
const ITEM_IDS = new Set<SettingsItemId>(SETTINGS_ITEMS.map((item) => item.id));

function subscribeHashChange(onStoreChange: () => void) {
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
}

function getHashSnapshot() {
  return typeof window === "undefined" ? "#/settings/shop" : window.location.hash;
}

function getServerHashSnapshot() {
  return "#/settings/shop";
}

export function parseSettingsHash(hash: string): ParsedSettingsRoute {
  const path = hash.replace(/^#\/?/, "").split("?")[0];
  const parts = path.split("/").filter(Boolean);

  if (parts[0] !== "settings") {
    return { category: "shop", item: null, redirect: "#/settings/shop" };
  }

  const first = parts[1];
  const second = parts[2];

  if (!first) {
    return { category: "shop", item: null, redirect: "#/settings/shop" };
  }

  if (CATEGORY_IDS.has(first as SettingsCategoryId)) {
    const category = first as SettingsCategoryId;
    if (second && ITEM_IDS.has(second as SettingsItemId)) {
      const item = SETTINGS_ITEMS.find((candidate) => candidate.id === second && candidate.category === category);
      return item ? { category, item: item.id } : { category, item: null };
    }
    return { category, item: null };
  }

  if (ITEM_IDS.has(first as SettingsItemId)) {
    const item = SETTINGS_ITEMS.find((candidate) => candidate.id === first);
    return { category: item?.category ?? "shop", item: item?.id ?? null };
  }

  return { category: "shop", item: null, redirect: "#/settings/shop" };
}

export function Settings() {
  const hash = useSyncExternalStore(subscribeHashChange, getHashSnapshot, getServerHashSnapshot);
  const route = parseSettingsHash(hash);

  useEffect(() => {
    if (route.redirect && typeof window !== "undefined") {
      window.location.hash = route.redirect;
    }
  }, [route.redirect]);

  const category = SETTINGS_CATEGORIES.find((candidate) => candidate.id === route.category) ?? SETTINGS_CATEGORIES[0];
  const item = route.item ? SETTINGS_ITEMS.find((candidate) => candidate.id === route.item && candidate.category === route.category) ?? null : null;

  const categoryItems = useMemo(
    () => SETTINGS_ITEMS.filter((candidate) => candidate.category === category.id).map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      icon: candidate.icon,
      href: `#/settings/${category.id}/${candidate.id}`,
    })),
    [category.id],
  );

  if (item) {
    const Page = item.Component;
    return (
      <div className="space-y-5">
        <SettingsSubPageHeader categoryLabel={category.label} itemTitle={item.title} description={item.description} backHref={`#/settings/${category.id}`} />
        <Page />
      </div>
    );
  }

  return (
    <SettingsCategory
      title={category.label}
      description={CATEGORY_DESCRIPTIONS[category.id]}
      items={categoryItems}
    />
  );
}

function SettingsSubPageHeader({ categoryLabel, itemTitle, description, backHref }: { categoryLabel: string; itemTitle: string; description: string; backHref: string }) {
  return (
    <PageHeader
      title={itemTitle}
      description={`Settings > ${categoryLabel}. ${description}`}
      accent="slate"
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={() => {
          window.location.hash = backHref;
        }}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back to {categoryLabel}
        </Button>
      }
    />
  );
}
