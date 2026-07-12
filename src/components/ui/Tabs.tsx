import { cn } from "./cn";

/**
 * A single tab item.
 */
export type TabItem<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
};

/**
 * Controlled tab strip. Mirrors the dashboard's inline tablist styling so
 * other surfaces can adopt it without re-rolling the markup.
 */
export type TabsProps<T extends string> = {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
};

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex border-b border-border", className)}
    >
      {items.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2 text-sm transition-colors",
              active
                ? "-mb-px border-b-2 border-primary bg-card font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}