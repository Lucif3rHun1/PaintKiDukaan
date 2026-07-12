import { type ReactNode } from "react";

interface RowProps {
  icon: React.ElementType<{ className?: string }>;
  label: string;
  value: ReactNode;
}

export function Row({ icon: Icon, label, value }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
