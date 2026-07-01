import { useSyncExternalStore } from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
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

function addToast(variant: ToastVariant, message: string) {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts, { id, variant, message }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
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
    const loadingId = Math.random().toString(36).slice(2);
    toasts = [...toasts, { id: loadingId, variant: "info", message: msgs.loading }];
    emit();
    return p
      .then((v) => {
        toasts = toasts.filter((t) => t.id !== loadingId);
        emit();
        const msg = typeof msgs.success === "function" ? msgs.success(v) : msgs.success;
        addToast("success", msg);
        return v;
      })
      .catch((e) => {
        toasts = toasts.filter((t) => t.id !== loadingId);
        emit();
        const msg = typeof msgs.error === "function" ? msgs.error(e) : msgs.error;
        addToast("error", msg);
        throw e;
      });
  },
  dismiss: (id: string) => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
};

// React hooks for Toaster component
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
