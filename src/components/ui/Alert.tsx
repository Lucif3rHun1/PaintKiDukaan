import { type ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function Alert({ title, children, onDismiss, className }: Props) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/10 p-4",
        className,
      )}
    >
      {title && <h4 className="font-medium text-destructive">{title}</h4>}
      <div className="text-sm text-destructive">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="mt-2 text-xs text-destructive hover:text-destructive"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
