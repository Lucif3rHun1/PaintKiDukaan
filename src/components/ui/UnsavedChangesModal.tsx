import { Button } from "./Button";
import { Card } from "./Card";

interface UnsavedChangesModalProps {
  readonly open: boolean;
  readonly onSaveDraft: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}

export function UnsavedChangesModal({
  open,
  onSaveDraft,
  onDiscard,
  onCancel,
}: UnsavedChangesModalProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/60"
    >
      <Card className="w-full max-w-sm space-y-4 p-6">
        <h2
          id="unsaved-changes-title"
          className="text-lg font-semibold text-foreground"
        >
          Unsaved Changes
        </h2>
        <p className="text-sm text-muted-foreground">
          You have unsaved changes. What would you like to do?
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
    </div>
  );
}
