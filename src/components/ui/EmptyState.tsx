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
    <div className={cn("flex flex-col items-center justify-center px-4 py-10 text-center sm:py-12", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-surface-sunken text-muted-foreground [&>svg]:size-5">{renderIcon(icon)}</div>}
      <h3 className="text-balance text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-5 text-muted-foreground">{description}</p>
      )}
      {benefits && (
        <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
          {benefits.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
      )}
      {(primary || secondary) && (
        <div className="mt-5 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          {secondary}
          {primary}
        </div>
      )}
      {helpHint && <div className="mt-4 text-sm text-muted-foreground">{helpHint}</div>}
    </div>
  );
}
