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
const CLOSE_DELAY_MS = 120;

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
  const descriptionId = useId();
  // ponytail: native <dialog> doesn't restore focus on close; capture trigger before open
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isClosing, setIsClosing] = useState(true);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    onClose();
  }, [isClosing, onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }, [open]);

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
    const dialog = dialogRef.current;
    if (open || !isClosing || !dialog?.open) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialog.close();
      return;
    }
    const timeout = window.setTimeout(() => dialog.close(), CLOSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
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
        previouslyFocusedRef.current?.focus();
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
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      aria-label={ariaLabel}
      className={cn(
        "surface-overlay rounded-xl border border-border p-0 text-foreground shadow-overlay transition-[opacity,transform] backdrop:bg-foreground/60 backdrop:transition-opacity backdrop:duration-normal backdrop:ease-standard motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:backdrop:transition-none motion-reduce:backdrop:opacity-100",
        isClosing
          ? "scale-[0.98] opacity-0 duration-fast ease-exit backdrop:opacity-0"
          : "scale-100 opacity-100 duration-normal ease-enter backdrop:opacity-100",
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
              <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      )}
      <div className="relative p-6">
        <button
          onClick={requestClose}
          className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,background-color,transform] duration-fast ease-standard hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        {children}
      </div>
    </dialog>
  );
}
