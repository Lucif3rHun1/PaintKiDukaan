import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { UpdatePromptKind } from "@/domain/types";
import { Alert, Badge, Button, InlineDialog } from "@/components/ui";

interface UpdateBannerProps {
  readonly pending: UpdatePromptKind;
  readonly apply: () => Promise<void>;
}

export function UpdateBanner({ pending, apply }: UpdateBannerProps) {
  const [restarting, setRestarting] = useState(false);

  if (pending.kind !== "updateAvailable") return null;

  const restart = async () => {
    setRestarting(true);
    await apply();
    setRestarting(false);
  };

  return (
    <InlineDialog
      open
      dismissible={false}
      size="sm"
      title="Update required"
      description={`Version ${pending.version} must be applied before work continues.`}
      aria-label="Update required"
    >
      <div className="space-y-4 pt-2">
        <Badge variant="warning">Version {pending.version}</Badge>
        <Alert variant="warning" title="Restart required">
          {pending.notes ?? "A newer version is ready. Restart PaintKiDukaan to apply it."}
        </Alert>
        <Button
          type="button"
          className="w-full"
          icon={RefreshCw}
          loading={restarting}
          onClick={() => void restart()}
        >
          Restart now
        </Button>
      </div>
    </InlineDialog>
  );
}
