import { useEffect, useRef, useState } from "react";
import { saveDraft, getDraft } from "../api";
import type { Draft } from "../../domain/types";

interface UseAutosaveReturn {
  draft: Draft | null;
  loading: boolean;
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getDraft(formType)
      .then((existingDraft) => {
        if (!cancelled) {
          setDraft(existingDraft);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [formType]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (isEmptyData(data)) return;

    if (timer.current) clearTimeout(timer.current);

    timer.current = setTimeout(() => {
      const json = JSON.stringify(data);
      saveDraft(formType, json)
        .then(() => getDraft(formType))
        .then((existingDraft) => {
          if (existingDraft) setDraft(existingDraft);
        })
        .catch(() => {});
    }, 2000);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [formType, data]);

  return { draft, loading };
}
