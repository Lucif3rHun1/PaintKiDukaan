import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { UpdatePromptKind } from "@/domain/types";
import { extractError } from "@/lib/extractError";
import { toast } from "@/lib/feedback/toast";
import {
  cmdQuitApp,
  cmdUpdateApply,
  cmdUpdateCheck,
} from "@/shell/lib/ipc";

export interface UpdaterController {
  readonly pending: UpdatePromptKind;
  readonly currentVersion: string;
  readonly check: () => Promise<UpdatePromptKind>;
  readonly apply: () => Promise<void>;
}

function mergePending(previous: UpdatePromptKind, incoming: UpdatePromptKind): UpdatePromptKind {
  if (previous.kind === "updateAvailable") {
    return incoming.kind === "updateAvailable" ? incoming : previous;
  }
  if (previous.kind === "checkFailed" && incoming.kind === "upToDate") {
    return previous;
  }
  return incoming;
}

export function useUpdater(enabled = true): UpdaterController {
  const [pending, setPending] = useState<UpdatePromptKind>({ kind: "upToDate" });
  const [currentVersion, setCurrentVersion] = useState("Loading…");
  const didAutoCheck = useRef(false);

  const check = useCallback(async (): Promise<UpdatePromptKind> => {
    try {
      const result = await cmdUpdateCheck();
      setPending((previous) => mergePending(previous, result));
      return result;
    } catch (error) {
      const failed: UpdatePromptKind = { kind: "checkFailed", reason: extractError(error) };
      setPending((previous) => mergePending(previous, failed));
      toast.error(`Update check failed: ${failed.reason}`);
      return failed;
    }
  }, []);

  const apply = useCallback(async (): Promise<void> => {
    try {
      await cmdUpdateApply();
      await cmdQuitApp();
    } catch (error) {
      toast.error(`Update could not be applied: ${extractError(error)}`);
    }
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setCurrentVersion)
      .catch((error: unknown) => {
        setCurrentVersion("Unavailable");
        toast.error(`Current version unavailable: ${extractError(error)}`);
      });
  }, []);

  useEffect(() => {
    if (!enabled || didAutoCheck.current) return;
    didAutoCheck.current = true;
    void check();
  }, [check, enabled]);

  return { pending, currentVersion, check, apply };
}
