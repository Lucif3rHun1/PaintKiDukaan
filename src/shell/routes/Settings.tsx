import { useEffect, useMemo, useSyncExternalStore, type ComponentType } from "react";
import {
  BadgeIndianRupee,
  Barcode,
  Building2,
  ChevronLeft,
  ClipboardList,
  DatabaseBackup,
  HardDrive,
  MapPin,
  PaintBucket,
  ReceiptText,
  ScanBarcode,
  ShieldCheck,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

import { SETTINGS_CATEGORIES, type SettingsCategoryId } from "../AppShell";
import { Button } from "../../components/ui";
import { CustomerTypesSettings, LocationsSettings, CatalogBrandsSettings } from "./settings/CatalogSettings";
import { LabelSettings, ReceiptSettings } from "./settings/PrintingSettings";
import { SettingsCategory } from "./settings/SettingsCategory";
import { ShopInfoSettings, CurrencySettings } from "./settings/ShopSettings";
import { BackupSettings, MasterHealthSettings, SecuritySettings } from "./settings/SystemSettings";
import { DevicesSettings, ScannerSettings, UsersSettings } from "./settings/TeamSettings";

type SettingsItemId =
  | "shop-info"
  | "currency"
  | "customer-types"
  | "locations"
  | "brands"
  | "label"
  | "receipt"
  | "users"
  | "devices"
  | "scanner"
  | "backup"
  | "security"
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
  catalog: "Reusable catalog lists that shape inventory, customers, and stock movement.",
  printing: "Label and receipt templates for counter printing workflows.",
  team: "Users, registered devices, and scanner wedge behavior.",
  system: "Backup, security, and operational health controls.",
};

const SETTINGS_ITEMS: SettingsItem[] = [
  { id: "shop-info", category: "shop", title: "Shop info", description: "Name, phone, GSTIN, and address shown on shop documents.", icon: Building2, Component: ShopInfoSettings },
  { id: "currency", category: "shop", title: "Currency", description: "Currency code, paise display precision, and tax-inclusive pricing.", icon: BadgeIndianRupee, Component: CurrencySettings },
  { id: "customer-types", category: "catalog", title: "Customer types", description: "Maintain customer groups used in billing and reporting.", icon: Tags, Component: CustomerTypesSettings },
  { id: "locations", category: "catalog", title: "Locations", description: "Configure stock locations for inventory movement.", icon: MapPin, Component: LocationsSettings },
  { id: "brands", category: "catalog", title: "Brands", description: "Paint brand prefixes used by auto-generated CODE128 barcodes.", icon: PaintBucket, Component: CatalogBrandsSettings },
  { id: "label", category: "printing", title: "Shelf labels", description: "Edit the barcode and shelf-label print template.", icon: Barcode, Component: LabelSettings },
  { id: "receipt", category: "printing", title: "Receipts", description: "Receipt header, footer, and terms printed for customers.", icon: ReceiptText, Component: ReceiptSettings },
  { id: "users", category: "team", title: "Users", description: "Create local accounts and assign operational roles.", icon: Users, Component: UsersSettings },
  { id: "devices", category: "team", title: "Devices", description: "Enroll and revoke devices trusted to unlock the app.", icon: HardDrive, Component: DevicesSettings },
  { id: "scanner", category: "team", title: "Scanner", description: "Tune barcode wedge detection for fast counter scans.", icon: ScanBarcode, Component: ScannerSettings },
  { id: "backup", category: "system", title: "Backup", description: "Create encrypted backups and manage restore points.", icon: DatabaseBackup, Component: BackupSettings },
  { id: "security", category: "system", title: "Security", description: "Idle auto-lock and lockout policy for this device.", icon: ShieldCheck, Component: SecuritySettings },
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
    <header className="space-y-3">
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => {
        window.location.hash = backHref;
      }}>
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Back to {categoryLabel}
      </Button>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300/80">
          Settings &gt; {categoryLabel} &gt; {itemTitle}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{itemTitle}</h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-400">{description}</p>
      </div>
    </header>
  );
}
