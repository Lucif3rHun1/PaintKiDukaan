import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";
import { pushModalScope, popModalScope } from "../../lib/shortcuts";

export interface InlineDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

const sizes = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

export function InlineDialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
  className,
  "aria-label": ariaLabel,
}: InlineDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [isClosing, setIsClosing] = useState(true);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    onClose();
  }, [isClosing, onClose]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!open) {
      if (el.open) setIsClosing(true);
      return;
    }

    if (!el.open) el.showModal();
    const frame = requestAnimationFrame(() => setIsClosing(false));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !dialogRef.current?.open) return;
    dialogRef.current
      .querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (open || !isClosing || !dialogRef.current?.open) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialogRef.current.close();
    }
  }, [isClosing, open]);

  useEffect(() => {
    if (!open) return;
    pushModalScope();
    return () => popModalScope();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      onClose={() => {
        if (!isClosing) onClose();
      }}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "opacity" &&
          !open &&
          isClosing
        ) {
          dialogRef.current?.close();
        }
      }}
      aria-labelledby={title ? titleId : undefined}
      aria-label={ariaLabel}
      className={cn(
        "rounded-xl border border-border bg-card p-0 transition-[opacity,transform] duration-normal ease-out will-change-transform backdrop:bg-foreground/60 backdrop:transition-opacity backdrop:duration-normal backdrop:ease-out motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:backdrop:transition-none motion-reduce:backdrop:opacity-100",
        isClosing
          ? "scale-[0.97] opacity-0 backdrop:opacity-0"
          : "scale-100 opacity-100 backdrop:opacity-100",
        sizes[size],
        className,
      )}
    >
      {(title || description) && (
        <div className="flex items-start justify-between border-b border-border px-6 py-4">
          <div>
            {title && (
              <h2 id={titleId} className="text-lg font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      )}
      <div className="relative p-6">
        <button
          onClick={requestClose}
          className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        {children}
      </div>
    </dialog>
  );
}
