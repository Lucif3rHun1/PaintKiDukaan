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
  | { kind: "unlocked"; user: string; user_id: number; role: Role; pin_role?: PinRole }
  | { kind: "keystore_error"; reason: string };

export type AppPhase =
  | "loading"
  | "first-launch"
  | "locked"
  | "unlocked"
  | "restore-recovery"
  | "keystore-error";

interface SecurityState {
  phase: AppPhase;
  session: Session;
  loginUsers: User[];
  setPhase(p: AppPhase): void;
  setSession(s: Session): void;
  setLoginUsers(users: User[]): void;
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
    loginUsers: [],
    setPhase: (phase) => set({ phase }),
    setSession: (session) => set({ session }),
    setLoginUsers: (loginUsers) => set({ loginUsers }),
    reset: () => set({ phase: "loading", session: emptySession, loginUsers: [] }),
    isUnlocked: () => get().phase === "unlocked" && get().session.user !== null,
    isOwner: () => get().session.user?.role === "owner",
    isDecoy: () => get().session.pinRole === "decoy",
    isDuress: () => get().session.pinRole === "duress",
  }),
);
