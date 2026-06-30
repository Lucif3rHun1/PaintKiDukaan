import { create } from "zustand";
import type { BatchLabel } from "@/pos/print";

export type SeedRow = {
  id: number;
  label: BatchLabel;
  itemId?: number;
  itemName: string;
};

type LabelBatchSeed = {
  rows: SeedRow[];
  source: string | null;
  setSeed: (rows: SeedRow[], source: string) => void;
  consume: () => SeedRow[];
  clear: () => void;
};

// Cross-page handoff: InwardPage (or InwardDetailPage) writes a pre-built
// label batch here, then navigates to #/barcodes. BulkLabelsPage consumes
// the seed on mount and clears it.
export const useLabelBatchSeed = create<LabelBatchSeed>((set, get) => ({
  rows: [],
  source: null,
  setSeed: (rows, source) => set({ rows, source }),
  consume: () => {
    const { rows } = get();
    set({ rows: [], source: null });
    return rows;
  },
  clear: () => set({ rows: [], source: null }),
}));