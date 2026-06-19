import { create } from "zustand";

import type { ScanTarget } from "../lib/ipc";

interface ScanTargetState {
  target: ScanTarget;
  setTarget: (t: ScanTarget) => void;
}

export const useScanTargetStore = create<ScanTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
