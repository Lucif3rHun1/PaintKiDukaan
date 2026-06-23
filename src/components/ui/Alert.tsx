import { type ReactNode } from "react";
import { cn } from "./cn";

export type AlertVariant = "destructive" | "warning" | "info" | "success";

interface Props {
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
  variant?: AlertVariant;
}

const variantClasses: Record<AlertVariant, string> = {
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
  success: "border-success/30 bg-success/10 text-success",
};

const titleClasses: Record<AlertVariant, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  success: "text-success",
};

export function Alert({
  title,
  children,
  onDismiss,
  className,
  variant = "destructive",
}: Props) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border p-4",
        variantClasses[variant],
        className,
      )}
    >
      {title && (
        <h4 className={cn("font-medium", titleClasses[variant])}>{title}</h4>
      )}
      <div className="text-sm">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="mt-2 rounded text-xs underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
