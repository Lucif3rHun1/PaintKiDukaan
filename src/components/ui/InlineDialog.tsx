import { type ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

export interface InlineDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

const sizes = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

export function InlineDialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
}: InlineDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className={cn(
        "rounded-xl border border-border bg-card p-0 backdrop:bg-foreground/60",
        sizes[size],
      )}
    >
      {(title || description) && (
        <div className="flex items-start justify-between px-6 py-4">
          <div>
            {title && (
              <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      <div className="px-6 pb-6">{children}</div>
    </dialog>
  );
}
