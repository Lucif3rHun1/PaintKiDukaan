import { type ReactNode } from "react";
import {
  ArrowDownToLine,
  Barcode,
  BarChart3,
  CalendarCheck,
  ChevronRight,
  Package,
  PlusCircle,
  ScanLine,
  UserPlus,
} from "lucide-react";
import { Badge } from "../../../components/ui";
import type { Role } from "../../../lib/security/state";
import { quickActionIdsForRole, type QuickActionId } from "./access";

interface QuickActionItem {
  readonly id: QuickActionId;
  readonly icon: React.ElementType<{ className?: string }>;
  readonly title: string;
  readonly subtitle: string;
  readonly href: string;
  readonly badge?: ReactNode;
}

function QuickAction({ icon: Icon, title, subtitle, href, badge }: QuickActionItem) {
  return (
    <a
      href={href}
      className="group relative flex min-h-14 min-w-0 items-center gap-3 rounded-lg bg-surface-raised p-3 text-foreground shadow-raised ring-1 ring-foreground/10 outline-none transition-[transform,background-color,color] duration-fast ease-standard hover:bg-surface-selected active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors duration-fast group-hover:bg-primary group-hover:text-primary-foreground motion-reduce:transition-none">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-card-foreground">{title}</span>
        {badge ? <div className="mt-0.5">{badge}</div> : null}
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors duration-fast group-hover:text-foreground motion-reduce:transition-none" aria-hidden="true" />
    </a>
  );
}

const QUICK_ACTIONS: Readonly<Record<QuickActionId, Omit<QuickActionItem, "badge">>> = {
  "new-sale": { id: "new-sale", icon: PlusCircle, title: "New Sale", subtitle: "Create a bill", href: "#/sales/new" },
  "new-inward": { id: "new-inward", icon: ArrowDownToLine, title: "New Inward", subtitle: "Record purchase", href: "#/inward" },
  "day-close": { id: "day-close", icon: CalendarCheck, title: "Day Close", subtitle: "Close today’s books", href: "#/day-close" },
  "add-customer": { id: "add-customer", icon: UserPlus, title: "Add Customer", subtitle: "Register new party", href: "#/customers" },
  "scan-barcode": { id: "scan-barcode", icon: ScanLine, title: "Scan Barcode", subtitle: "Open inward scanner", href: "#/inward" },
  reports: { id: "reports", icon: BarChart3, title: "View Reports", subtitle: "Sales & inventory", href: "#/reports/sales" },
  items: { id: "items", icon: Package, title: "Manage Items", subtitle: "Review stock and catalog", href: "#/items" },
  barcodes: { id: "barcodes", icon: Barcode, title: "Barcode Labels", subtitle: "Prepare and print labels", href: "#/barcodes" },
};

interface QuickActionsBarProps {
  readonly role: Role;
  readonly dayCloseOverdue: boolean;
}

export function QuickActionsBar({ role, dayCloseOverdue }: QuickActionsBarProps) {
  const actionIds = quickActionIdsForRole(role);

  return (
    <section aria-labelledby="quick-actions-title" className="min-w-0 space-y-2">
      <h2 id="quick-actions-title" className="text-sm font-semibold text-foreground">Next actions</h2>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actionIds.map((id) => (
          <QuickAction
            key={id}
            {...QUICK_ACTIONS[id]}
            badge={id === "day-close" && dayCloseOverdue ? <Badge variant="warning" size="sm">Overdue</Badge> : undefined}
          />
        ))}
      </div>
    </section>
  );
}
