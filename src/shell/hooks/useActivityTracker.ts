import { useEffect, useRef } from "react";
import { lock, logoutForSwitch, touchActivity } from "@/lib/security/ipc";
import { useSecurity } from "@/lib/security/state";
import { queryClient } from "@/lib/query/queryClient";

const THIRTY_SECONDS = 30_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const LOCKED_SESSION = { user: null, locked: true, pinRole: "real" as const };

/**
 * Combined activity tracking + idle auto-lock.
 * Sends touch_activity every 30s and locks after 15min of inactivity.
 */
export function useActivityTracker() {
  const phase = useSecurity((s) => s.phase);
  const setPhase = useSecurity((s) => s.setPhase);
  const setSession = useSecurity((s) => s.setSession);
  const lastTouchAt = useRef(0);

  useEffect(() => {
    if (phase !== "unlocked") return;
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        try { await lock(); } finally {
          setSession(LOCKED_SESSION);
          setPhase("locked");
        }
      }, FIFTEEN_MINUTES);
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouchAt.current >= THIRTY_SECONDS) {
        lastTouchAt.current = now;
        void touchActivity().catch(() => undefined);
      }
      resetIdle();
    };
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("click", onActivity);
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("touchend", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("wheel", onActivity, { passive: true });
    resetIdle();
    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("click", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("touchend", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("wheel", onActivity);
    };
  }, [phase, setPhase, setSession]);

  async function lockNow() {
    try { await lock(); } finally {
      queryClient.clear();
      setSession(LOCKED_SESSION);
      setPhase("locked");
    }
  }

  async function logoutForSwitchFn() {
    const setLoginUsers = useSecurity.getState().setLoginUsers;
    try {
      setLoginUsers(await logoutForSwitch());
    } finally {
      queryClient.clear();
      setSession(LOCKED_SESSION);
      setPhase("locked");
    }
  }

  return { lockNow, logoutForSwitch: logoutForSwitchFn };
}
