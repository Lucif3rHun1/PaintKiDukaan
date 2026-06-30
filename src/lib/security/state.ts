import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { PinRole } from "../../domain/types";

export type Role = "owner" | "cashier" | "stocker";

export interface User {
  id: number;
  name: string;
  role: Role;
}

export interface Session {
  user: User | null;
  locked: boolean;
  pinRole: PinRole;
}

export type Bootstrap =
  | { kind: "first_launch" }
  | { kind: "locked" }
  | { kind: "unlocked"; user: string; role: Role; pin_role?: PinRole }
  | { kind: "keystore_error"; reason: string };

export type AppPhase =
  | "loading"
  | "first-launch"
  | "locked"
  | "unlocked"
  | "restore-recovery"
  | "user-management"
  | "keystore-error";

interface SecurityState {
  phase: AppPhase;
  session: Session;
  setPhase(p: AppPhase): void;
  setSession(s: Session): void;
  reset(): void;
  isUnlocked(): boolean;
  isOwner(): boolean;
  isDecoy(): boolean;
  isDuress(): boolean;
}

const emptySession: Session = { user: null, locked: true, pinRole: "real" };

export const useSecurity: UseBoundStore<StoreApi<SecurityState>> = create<SecurityState>(
  (set, get) => ({
    phase: "loading",
    session: emptySession,
    setPhase: (phase) => set({ phase }),
    setSession: (session) => set({ session }),
    reset: () => set({ phase: "loading", session: emptySession }),
    isUnlocked: () => get().phase === "unlocked" && get().session.user !== null,
    isOwner: () => get().session.user?.role === "owner",
    isDecoy: () => get().session.pinRole === "decoy",
    isDuress: () => get().session.pinRole === "duress",
  }),
);
