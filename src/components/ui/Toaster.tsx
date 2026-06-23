import { createPortal } from "react-dom";
import {
  useToasts,
  toast,
  type Toast,
  type ToastVariant,
} from "../../lib/feedback/toast";
import { cn } from "./cn";
import {
  CheckCircle,
  XCircle,
  Info,
  AlertTriangle,
  X,
} from "lucide-react";

const icons: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle className="h-4 w-4 text-success" />,
  error: <XCircle className="h-4 w-4 text-destructive" />,
  info: <Info className="h-4 w-4 text-info" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" />,
};

const bg: Record<ToastVariant, string> = {
  success: "border-success/30 bg-success/10",
  error: "border-destructive/30 bg-destructive/10",
  info: "border-info/30 bg-info/10",
  warning: "border-warning/30 bg-warning/10",
};

function ToastItem({ toast: t }: { toast: Toast }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg",
        bg[t.variant],
      )}
    >
      {icons[t.variant]}
      <span className="text-foreground">{t.message}</span>
      <button
        onClick={() => toast.dismiss(t.id)}
        className="ml-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return createPortal(
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}
