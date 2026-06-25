import { useEffect, useRef } from "react";

import { useSecurity } from "../../lib/security/state";

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export interface UseIdleLockOptions {
  /** Idle period in ms before locking. Defaults to 5 min. */
  idleMs?: number;
  /** Called when the session should be locked (e.g. to navigate). */
  onLock?: () => void;
}

/**
 * Auto-lock the session after a period of user inactivity.
 *
 * The hook listens for mouse, keyboard and touch events and resets a
 * debounce timer on every interaction. When the timer fires it locks
 * the session via the canonical `useSecurity` store and (optionally)
 * calls `onLock`.
 */
export function useIdleLock(opts: UseIdleLockOptions = {}): void {
  const { idleMs = DEFAULT_IDLE_MS, onLock } = opts;
  const timer = useRef<number | null>(null);
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  useEffect(() => {
    const reset = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        const { session, setSession } = useSecurity.getState();
        if (session.user !== null) {
          setSession({ ...session, locked: true });
          onLockRef.current?.();
        }
      }, idleMs);
    };

    const events: (keyof DocumentEventMap)[] = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ];
    for (const ev of events) {
      document.addEventListener(ev, reset, { passive: true });
    }
    reset();
    return () => {
      for (const ev of events) {
        document.removeEventListener(ev, reset);
      }
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, [idleMs]);
}