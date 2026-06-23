export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40">
      <div className="w-full max-w-sm rounded-lg bg-card p-5 shadow-lg">
        <h2 className="text-lg font-semibold">{title}</h2>
        {body && <p className="mt-2 text-sm text-muted-foreground">{body}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              "rounded-md px-3 py-1.5 text-sm font-medium " +
              (destructive
                ? "btn-destructive"
                : "btn-primary")
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
