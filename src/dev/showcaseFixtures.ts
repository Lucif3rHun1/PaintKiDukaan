export type ShowcaseItem = {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly stock: number;
  readonly unit: string;
  readonly pricePaise: number;
  readonly status: "In stock" | "Low stock" | "Out of stock";
};

export const showcaseItems: readonly ShowcaseItem[] = [
  {
    id: "item-1",
    name: "WeatherGuard Exterior Emulsion, Brilliant White, twenty litre contractor pack",
    sku: "WG-EXT-BW-20L",
    stock: 18,
    unit: "bucket",
    pricePaise: 486_500,
    status: "In stock",
  },
  {
    id: "item-2",
    name: "Synthetic Enamel Signal Red",
    sku: "SE-SR-4L",
    stock: 3,
    unit: "tin",
    pricePaise: 147_900,
    status: "Low stock",
  },
  {
    id: "item-3",
    name: "Wall Primer Interior",
    sku: "WP-INT-10L",
    stock: 0,
    unit: "bucket",
    pricePaise: 221_000,
    status: "Out of stock",
  },
] as const;

export const showcaseSelectOptions = [
  { value: "retail", label: "Retail counter" },
  { value: "contractor", label: "Contractor account" },
  { value: "wholesale", label: "Wholesale" },
  { value: "archived", label: "Archived option", disabled: true },
] as const;

export const showcaseTopItems = showcaseItems.map((item) => ({
  id: item.id,
  name: item.name,
  subtitle: `${item.sku} · ${item.stock} ${item.unit}`,
  value: `₹${(item.pricePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
}));

export const showcaseConcerns = showcaseItems.slice(1).map((item) => ({
  id: item.id,
  name: item.name,
  status: item.status,
  stock: item.stock,
}));

export const longShowcaseCopy =
  "This intentionally long operational message verifies that headings, descriptions, alerts, table cells, actions, and narrow layouts remain readable when a paint name or recovery instruction exceeds the usual counter-day copy length without clipping or forcing viewport-wide overflow.";
