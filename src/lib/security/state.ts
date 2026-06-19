import { create, type StoreApi, type UseBoundStore } from "zustand";

export type Role = "owner" | "cashier" | "stocker";

export interface Session {
  user_id: number;
  user_name: string;
  role: Role;
}

export type Bootstrap =
  | { kind: "first-launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; role: Role };

export type AppPhase =
  | "loading"
  | "first-launch"
  | "locked"
  | "unlocked"
  | "restore-recovery";

interface SecurityState {
  phase: AppPhase;
  session: Session | null;
  setPhase(p: AppPhase): void;
  setSession(s: Session | null): void;
  reset(): void;
  isUnlocked(): boolean;
  isOwner(): boolean;
}

export const useSecurity: UseBoundStore<StoreApi<SecurityState>> = create<SecurityState>(
  (set, get) => ({
    phase: "loading",
    session: null,
    setPhase: (phase) => set({ phase }),
    setSession: (session) => set({ session }),
    reset: () => set({ phase: "loading", session: null }),
    isUnlocked: () => get().phase === "unlocked" && get().session !== null,
    isOwner: () => get().session?.role === "owner",
  }),
);
