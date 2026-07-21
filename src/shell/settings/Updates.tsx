import { CheckCircle2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Section } from "@/components/ui";
import type { UpdaterController } from "@/shell/hooks/useUpdater";

interface UpdatesProps {
  readonly updater: UpdaterController;
}

function UpdateState({ pending, currentVersion }: Pick<UpdaterController, "pending" | "currentVersion">) {
  switch (pending.kind) {
    case "upToDate":
      return (
        <EmptyState
          icon={CheckCircle2}
          title="You're up to date"
          description={`PaintKiDukaan ${currentVersion} is the latest installed version.`}
          className="py-6 sm:py-8"
        />
      );
    case "updateAvailable":
      return (
        <Alert variant="warning" title={`Version ${pending.version} is required`}>
          {pending.notes ?? "Restart PaintKiDukaan to apply the latest version."}
        </Alert>
      );
    case "checkFailed":
      return (
        <Alert variant="destructive" title="Update check failed">
          {pending.reason}
        </Alert>
      );
  }
}

export function Updates({ updater }: UpdatesProps) {
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const updateAvailable = updater.pending.kind === "updateAvailable";

  const checkNow = async () => {
    setChecking(true);
    await updater.check();
    setChecking(false);
  };

  const restart = async () => {
    setApplying(true);
    await updater.apply();
    setApplying(false);
  };

  return (
    <Section
      title="Application updates"
      description="PaintKiDukaan checks for required updates after unlock. Available releases must be applied."
      actions={
        <Button type="button" variant="secondary" icon={RefreshCw} loading={checking} onClick={() => void checkNow()}>
          Check now
        </Button>
      }
    >
      <Card>
        <Card.Header className="flex-row items-center justify-between">
          <div>
            <p className="text-base font-medium text-foreground">Installed version</p>
            <p className="text-sm text-muted-foreground">Version {updater.currentVersion}</p>
          </div>
          <Badge variant={updateAvailable ? "warning" : updater.pending.kind === "checkFailed" ? "danger" : "success"}>
            {updateAvailable ? "Update required" : updater.pending.kind === "checkFailed" ? "Check failed" : "Current"}
          </Badge>
        </Card.Header>
        <Card.Body>
          <UpdateState pending={updater.pending} currentVersion={updater.currentVersion} />
        </Card.Body>
        {updateAvailable ? (
          <Card.Footer className="justify-end">
            <Button type="button" icon={RefreshCw} loading={applying} onClick={() => void restart()}>
              Restart to update
            </Button>
          </Card.Footer>
        ) : null}
      </Card>
    </Section>
  );
}
