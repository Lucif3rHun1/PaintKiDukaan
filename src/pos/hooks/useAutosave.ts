import { useCallback, useEffect, useRef, useState } from "react";
import { saveDraft, getDraft, deleteDraft } from "../api";
import type { Draft } from "../../domain/types";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

interface UseAutosaveReturn {
  draft: Draft | null;
  loading: boolean;
  status: SaveStatus;
  resetDraft: () => Promise<void>;
}

const isEmptyData = (data: unknown): boolean => {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data as Record<string, unknown>).length === 0;
  return false;
};

export function useAutosave(formType: string, data: unknown): UseAutosaveReturn {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMount = useRef(true);

  // Load existing draft on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getDraft(formType)
      .then((existingDraft) => {
        if (!cancelled) {
          setDraft(existingDraft);
          setStatus(existingDraft ? "saved" : "idle");
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [formType]);

  // Auto-save on data change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (isEmptyData(data)) return;

    if (timer.current) clearTimeout(timer.current);

    setStatus("dirty");

    timer.current = setTimeout(() => {
      setStatus("saving");
      const json = JSON.stringify(data);
      saveDraft(formType, json)
        .then((saved) => {
          setDraft(saved);
          setStatus("saved");
        })
        .catch(() => {
          setStatus("error");
        });
    }, 2000);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [formType, data]);

  // Reset draft: cancel pending save, delete from DB and clear local state
  const resetDraft = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await deleteDraft(formType);
    } catch {
      // ignore — best effort
    }
    setDraft(null);
    setStatus("idle");
  }, [formType]);

  return { draft, loading, status, resetDraft };
}
