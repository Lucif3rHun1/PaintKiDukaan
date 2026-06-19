import { create } from "zustand";

import type { Session, User } from "../lib/ipc";

interface SessionState {
  session: Session;
  setUser: (u: User | null) => void;
  setLocked: (locked: boolean) => void;
  reset: () => void;
}

const empty: Session = { user: null, locked: true };

export const useSessionStore = create<SessionState>((set) => ({
  session: empty,
  setUser: (user) =>
    set((s) => ({ session: { ...s.session, user, locked: user === null } })),
  setLocked: (locked) => set((s) => ({ session: { ...s.session, locked } })),
  reset: () => set({ session: empty }),
}));
