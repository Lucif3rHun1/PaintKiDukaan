import { createContext, useContext } from "react";
import type { SaveStatus } from "./useAutosave";
import type { Draft } from "../../domain/types";

interface PageBadgeValue {
  status: SaveStatus;
  draft: Draft | null;
}

export const PageBadgeCtx = createContext<PageBadgeValue>({ status: "idle", draft: null });

export function usePageBadge(): PageBadgeValue {
  return useContext(PageBadgeCtx);
}
