import { useState } from "react";
import {
  AlertTriangle,
  BadgeIndianRupee,
  Box,
  CheckCircle2,
  Info,
  PackageSearch,
  Save,
  Trash2,
} from "lucide-react";

import {
  Alert,
  ActionMenu,
  Badge,
  BarcodeThumb,
  Button,
  Card,
  ConcernCard,
  DataTable,
  DatePicker,
  EmptyState,
  Field,
  InlineDialog,
  MetricCard,
  Money,
  MoneyInput,
  PageHeader,
  QtyInput,
  Radio,
  SearchInput,
  Section,
  Select,
  Skeleton,
  Tabs,
  TopItemsCard,
  type LegacyColumnDef,
} from "../components/ui";
import { useTheme, type ThemeMode } from "../lib/theme";
import {
  longShowcaseCopy,
  showcaseConcerns,
  showcaseItems,
  showcaseSelectOptions,
  showcaseTopItems,
  type ShowcaseItem,
} from "./showcaseFixtures";

const statusVariants = {
  "In stock": "success",
  "Low stock": "warning",
  "Out of stock": "danger",
} as const satisfies Record<ShowcaseItem["status"], "success" | "warning" | "danger">;

const columns: LegacyColumnDef<ShowcaseItem>[] = [
  {
    header: "Item",
    cell: (item) => (
      <div className="min-w-56">
        <div className="font-medium text-foreground text-pretty">{item.name}</div>
        <div className="font-mono text-xs text-muted-foreground">{item.sku}</div>
      </div>
    ),
  },
  {
    header: "Stock",
    align: "right",
    cell: (item) => <span className="tabular-nums">{item.stock} {item.unit}</span>,
  },
  {
    header: "Price",
    align: "right",
    cell: (item) => <Money paise={item.pricePaise} />,
  },
  {
    header: "Status",
    cell: (item) => <Badge variant={statusVariants[item.status]}>{item.status}</Badge>,
  },
];

export function PrimitiveShowcase() {
  const { mode, resolved, setMode } = useTheme();
  const [search, setSearch] = useState("Exterior emulsion");
  const [customerType, setCustomerType] = useState("retail");
  const [payment, setPayment] = useState("cash");
  const [tab, setTab] = useState("populated");
  const [amount, setAmount] = useState(486_500);
  const [quantity, setQuantity] = useState(2);
  const [date, setDate] = useState("2026-07-17");
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <main className="min-h-[100dvh] bg-surface-canvas text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader
          title="Shared primitive verification"
          description={longShowcaseCopy}
          accent="slate"
          actions={<ThemeControls mode={mode} resolved={resolved} setMode={setMode} />}
        >
          <div className="flex flex-wrap gap-2" aria-label="Showcase coverage">
            <Badge variant="info">Tier A · interaction</Badge>
            <Badge variant="success">Tier B · state</Badge>
            <Badge variant="warning">Tier C · composition</Badge>
            <Badge variant="outline">Zero IPC</Badge>
          </div>
        </PageHeader>

        <Section title="Tier A · interactive controls" description="Use Tab, Shift+Tab, Enter, Space, arrows, and Escape to inspect the full keyboard path.">
          <Card>
            <Card.Body className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button icon={Save}>Save bill</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="destructive" icon={AlertTriangle}>Archive</Button>
                <Button variant="ghost">Ghost</Button>
                <Button loading>Saving</Button>
                <Button disabled>Disabled</Button>
                <Button size="icon" variant="outline" aria-label="Inspect package"><Box /></Button>
                <ActionMenu
                  label="Showcase actions"
                  actions={[
                    { label: "Inspect item", icon: Box, onSelect: () => undefined },
                    { label: "Archive item", icon: Trash2, danger: true, onSelect: () => undefined },
                    { label: "Unavailable action", disabled: true, onSelect: () => undefined },
                  ]}
                />
                <Button variant="outline" onClick={() => setDialogOpen(true)}>Open dialog</Button>
              </div>

              <InlineDialog
                open={dialogOpen}
                onClose={() => setDialogOpen(false)}
                title="Review inventory change"
                description="Keyboard focus stays within the decision and returns to its trigger on close."
              >
                <div className="space-y-4 pr-10">
                  <p className="text-sm text-muted-foreground">No inventory is changed by this deterministic showcase.</p>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={() => setDialogOpen(false)}>Confirm</Button>
                  </div>
                </div>
              </InlineDialog>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Search inventory" hint="Filled state with long content">
                  <SearchInput value={search} onChange={setSearch} ariaLabel="Search inventory showcase" />
                </Field>
                <Field label="Customer type" required>
                  <Select className="w-full" value={customerType} onChange={(event) => setCustomerType(event.target.value)} options={[...showcaseSelectOptions]} />
                </Field>
                <Field label="Invalid search" error="Choose an item that exists in the current location.">
                  <SearchInput value="Unknown coating" onChange={() => undefined} ariaLabel="Invalid search showcase" aria-invalid="true" />
                </Field>
                <Field label="Amount">
                  <MoneyInput value={amount} onChange={setAmount} />
                </Field>
                <Field label="Quantity">
                  <QtyInput value={quantity} onChange={setQuantity} max={24} />
                </Field>
                <Field label="Billing date">
                  <DatePicker value={date} onChange={setDate} />
                </Field>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Payment method</legend>
                <div className="flex flex-wrap gap-4">
                  <Radio name="payment" checked={payment === "cash"} onChange={() => setPayment("cash")} label="Cash" />
                  <Radio name="payment" checked={payment === "credit"} onChange={() => setPayment("credit")} label="Credit" />
                </div>
              </fieldset>

              <Tabs value={tab} onValueChange={setTab}>
                <Tabs.List aria-label="Data state examples">
                  <Tabs.Trigger value="populated">Populated</Tabs.Trigger>
                  <Tabs.Trigger value="loading">Loading</Tabs.Trigger>
                  <Tabs.Trigger value="empty">Empty</Tabs.Trigger>
                  <Tabs.Trigger value="disabled" disabled>Disabled</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="populated" className="pt-3">Three deterministic inventory rows are ready for review.</Tabs.Content>
                <Tabs.Content value="loading" className="pt-3"><Skeleton variant="text-3-lines" /></Tabs.Content>
                <Tabs.Content value="empty" className="pt-3 text-muted-foreground">No rows match this deterministic state.</Tabs.Content>
              </Tabs>
            </Card.Body>
          </Card>
        </Section>

        <Section title="Tier B · feedback and data states" description="Semantic status always includes text; loading geometry matches the loaded content.">
          <div className="grid gap-3 lg:grid-cols-2">
            <Alert variant="info" title="Information"><Info aria-hidden="true" />The selected location has a pending stock count.</Alert>
            <Alert variant="success" title="Saved"><CheckCircle2 aria-hidden="true" />The deterministic bill is ready for the next action.</Alert>
            <Alert variant="warning" title="Review required"><AlertTriangle aria-hidden="true" />{longShowcaseCopy}</Alert>
            <Alert variant="destructive" title="Unable to load"><AlertTriangle aria-hidden="true" />The fixture exposes recovery copy without backend details.</Alert>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={BadgeIndianRupee} label="Focal total" tone="primary"><strong className="text-2xl"><Money paise={1_121_300} /></strong></MetricCard>
            <MetricCard icon={Box} label="Low stock" tone="warning"><strong className="text-2xl">3</strong></MetricCard>
            <MetricCard icon={CheckCircle2} label="Healthy items" tone="success"><strong className="text-2xl">18</strong></MetricCard>
            <MetricCard icon={PackageSearch} label="Loading metric" loading>0</MetricCard>
          </div>

          <DataTable data={[...showcaseItems]} columns={columns} keyExtractor={(item) => item.id} caption="Populated deterministic inventory table" />
          <div className="grid gap-3 lg:grid-cols-2">
            <DataTable data={[]} columns={columns} keyExtractor={(item) => item.id} caption="Empty inventory table" emptyState={<EmptyState icon={PackageSearch} title="No items yet" description="Add an item to begin tracking stock at this location." primary={<Button>Add item</Button>} />} />
            <DataTable data={[]} columns={columns} keyExtractor={(item) => item.id} caption="Error inventory table" error="Inventory fixtures could not be read." onRetry={() => undefined} />
          </div>
        </Section>

        <Section title="Tier C · responsive composition" description="Dense lists remain flat; focal summaries rise; long content truncates or wraps without viewport overflow.">
          <div className="grid gap-3 lg:grid-cols-2">
            <TopItemsCard title="Top items" subtitle="Long labels and tabular values" items={showcaseTopItems} badgeTone="primary" />
            <ConcernCard title="Stock concerns" subtitle="Risk plus explicit text" items={showcaseConcerns} statusFn={(item) => item.stock === 0 ? "destructive" : "warning"} renderStatus={(item) => `${item.stock} remaining`} />
          </div>
          <Card>
            <Card.Header><h3 className="text-base font-semibold">Barcode preview and passive content</h3></Card.Header>
            <Card.Body className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <BarcodeThumb value="WG-EXT-BW-20L" />
              <p className="max-w-[70ch] text-sm leading-5 text-muted-foreground text-pretty">{longShowcaseCopy}</p>
            </Card.Body>
          </Card>
        </Section>
      </div>
    </main>
  );
}

function ThemeControls({ mode, resolved, setMode }: { readonly mode: ThemeMode; readonly resolved: "light" | "dark"; readonly setMode: (mode: ThemeMode) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={`Theme controls. Resolved theme: ${resolved}`}>
      {(["system", "light", "dark"] as const).map((option) => (
        <Button key={option} size="sm" variant={mode === option ? "default" : "outline"} onClick={() => setMode(option)} aria-pressed={mode === option}>
          {option[0].toUpperCase() + option.slice(1)}
        </Button>
      ))}
    </div>
  );
}
