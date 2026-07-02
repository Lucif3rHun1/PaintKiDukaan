import { type ReactNode } from "react";
import {
  ArrowDownToLine,
  BarChart3,
  CalendarCheck,
  ChevronRight,
  PlusCircle,
  ScanLine,
  UserPlus,
} from "lucide-react";
import { Badge } from "../../../components/ui";

interface QuickActionItem {
  icon: React.ElementType<{ className?: string }>;
  title: string;
  subtitle: string;
  href: string;
  badge?: ReactNode;
}

function QuickAction({ icon: Icon, title, subtitle, href, badge }: QuickActionItem) {
  return (
    <a
      href={href}
      className="group relative flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm shadow-foreground/5 ring-1 ring-border/30 transition-[transform,colors,box-shadow] duration-150 motion-reduce:transition-none hover:-translate-y-0.5 hover:bg-accent hover:shadow-md motion-reduce:hover:translate-y-0 active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-card-foreground">{title}</span>
        {badge ? <div className="mt-0.5">{badge}</div> : null}
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100" />
    </a>
  );
}

export function QuickActionsBar({ dayCloseOverdue }: { dayCloseOverdue: boolean }) {
  return (
    <section aria-label="Quick actions" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6">
      <QuickAction
        icon={PlusCircle}
        title="New Sale"
        subtitle="Create a bill"
        href="#/sales/new"
      />
      <QuickAction
        icon={ArrowDownToLine}
        title="New Inward"
        subtitle="Record purchase"
        href="#/inward"
      />
      <QuickAction
        icon={CalendarCheck}
        title="Day Close"
        subtitle="Close today’s books"
        href="#/day-close"
        badge={
          dayCloseOverdue ? (
            <Badge variant="warning" size="sm">Overdue</Badge>
          ) : null
        }
      />
      <QuickAction
        icon={UserPlus}
        title="Add Customer"
        subtitle="Register new party"
        href="#/customers"
      />
      <QuickAction
        icon={ScanLine}
        title="Scan Barcode"
        subtitle="Open inward scanner"
        href="#/inward"
      />
      <QuickAction
        icon={BarChart3}
        title="View Reports"
        subtitle="Sales & inventory"
        href="#/reports/sales"
      />
    </section>
  );
}