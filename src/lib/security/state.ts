import { create, type StoreApi, type UseBoundStore } from "zustand";

export type Role = "owner" | "cashier" | "stocker";

export interface User {
  id: number;
  name: string;
  role: Role;
}

export interface Session {
  user: User | null;
  locked: boolean;
}

export type Bootstrap =
  | { kind: "first_launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; role: Role };

export type AppPhase =
  | "loading"
  | "first-launch"
  | "locked"
  | "unlocked"
  | "restore-recovery"
  | "user-management";

interface SecurityState {
  phase: AppPhase;
  session: Session;
  setPhase(p: AppPhase): void;
  setSession(s: Session): void;
  reset(): void;
  isUnlocked(): boolean;
  isOwner(): boolean;
}

const emptySession: Session = { user: null, locked: true };

export const useSecurity: UseBoundStore<StoreApi<SecurityState>> = create<SecurityState>(
  (set, get) => ({
    phase: "loading",
    session: emptySession,
    setPhase: (phase) => set({ phase }),
    setSession: (session) => set({ session }),
    reset: () => set({ phase: "loading", session: emptySession }),
    isUnlocked: () => get().phase === "unlocked" && get().session.user !== null,
    isOwner: () => get().session.user?.role === "owner",
  }),
);
