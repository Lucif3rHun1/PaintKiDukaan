import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { Card } from "./Card";
import { cn } from "./cn";

interface UnsavedChangesModalProps {
  readonly open: boolean;
  readonly onSaveDraft: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
  readonly description?: string;
}

export function UnsavedChangesModal({
  open,
  onSaveDraft,
  onDiscard,
  onCancel,
  description,
}: UnsavedChangesModalProps) {
  const [isMounted, setIsMounted] = useState(open);
  const [isClosing, setIsClosing] = useState(true);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (open) {
      setIsMounted(true);
      if (reducedMotion) {
        setIsClosing(false);
        return;
      }

      setIsClosing(true);
      const frame = requestAnimationFrame(() => setIsClosing(false));
      return () => cancelAnimationFrame(frame);
    }

    if (reducedMotion || isClosing) {
      setIsMounted(false);
      return;
    }

    setIsClosing(true);
  }, [open]);

  if (!isMounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "opacity" &&
          !open &&
          isClosing
        ) {
          setIsMounted(false);
        }
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-foreground/60 transition-opacity duration-normal ease-out motion-reduce:transition-none motion-reduce:opacity-100",
        isClosing ? "opacity-0" : "opacity-100",
      )}
    >
      <Card
        className={cn(
          "w-full max-w-sm space-y-4 p-6 transition-[opacity,transform] ease-out will-change-transform motion-reduce:transition-none motion-reduce:scale-100 motion-reduce:opacity-100",
          isClosing
            ? "scale-[0.97] opacity-0 duration-fast"
            : "scale-100 opacity-100 duration-normal",
        )}
      >
        <h2
          id="unsaved-changes-title"
          className="text-lg font-semibold text-foreground"
        >
          Unsaved Changes
        </h2>
        <p className="text-sm text-muted-foreground">
          {description ?? "You have unsaved changes. What would you like to do?"}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onDiscard}>
            Discard
          </Button>
          <Button variant="primary" onClick={onSaveDraft}>
            Save as Draft
          </Button>
        </div>
      </Card>
    </div>,
    document.body,
  );
}
