import { type ElementType, type ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  icon?: ElementType<{ className?: string }> | ReactNode;
  title: string;
  description?: string;
  primary?: ReactNode;
  secondary?: ReactNode;
  benefits?: string[];
  helpHint?: ReactNode;
  className?: string;
}

function renderIcon(icon: ElementType<{ className?: string }> | ReactNode) {
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && !("props" in icon))) {
    const Icon = icon as ElementType<{ className?: string }>;
    return <Icon className="h-8 w-8" />;
  }
  return icon;
}

export function EmptyState({
  icon,
  title,
  description,
  primary,
  secondary,
  benefits,
  helpHint,
  className,
}: Props) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 text-center", className)}>
      {icon && <div className="mb-4 text-muted-foreground">{renderIcon(icon)}</div>}
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {benefits && (
        <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
          {benefits.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex gap-3">
        {secondary}
        {primary}
      </div>
      {helpHint && <div className="mt-4">{helpHint}</div>}
    </div>
  );
}
