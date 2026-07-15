import { useSyncExternalStore } from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  readonly id: string;
  readonly variant: ToastVariant;
  readonly message: string;
  readonly exiting: boolean;
}

// External store
let listeners: (() => void)[] = [];
let toasts: Toast[] = [];

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot() {
  return toasts;
}

// ponytail: cap at 8 to prevent unbounded growth on error loops
const MAX_TOASTS = 8;
const EXIT_DURATION_MS = 120;

function removeToast(id: string) {
  const target = toasts.find((t) => t.id === id);
  if (!target || target.exiting) return;

  toasts = toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, EXIT_DURATION_MS);
}

function addToast(variant: ToastVariant, message: string) {
  const id = crypto.randomUUID();
  const next = [...toasts, { id, variant, message, exiting: false }];
  if (next.length > MAX_TOASTS) next.splice(0, next.length - MAX_TOASTS);
  toasts = next;
  emit();
  setTimeout(() => {
    removeToast(id);
  }, 4000);
}

export const toast = {
  success: (msg: string, _description?: string) => addToast("success", msg),
  error: (msg: string, _description?: string) => addToast("error", msg),
  info: (msg: string, _description?: string) => addToast("info", msg),
  warning: (msg: string, _description?: string) => addToast("warning", msg),
  promise: <T>(
    p: Promise<T>,
    msgs: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((error: unknown) => string);
    },
  ): Promise<T> => {
    const loadingId = crypto.randomUUID();
    toasts = [
      ...toasts,
      { id: loadingId, variant: "info", message: msgs.loading, exiting: false },
    ];
    emit();
    return p
      .then((v) => {
        removeToast(loadingId);
        const msg = typeof msgs.success === "function" ? msgs.success(v) : msgs.success;
        addToast("success", msg);
        return v;
      })
      .catch((e) => {
        removeToast(loadingId);
        const msg = typeof msgs.error === "function" ? msgs.error(e) : msgs.error;
        addToast("error", msg);
        throw e;
      });
  },
  dismiss: removeToast,
};

// React hooks for Toaster component
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
