import { type ElementType } from "react";
import { AlertCircle } from "lucide-react";

/**
 * Shared field-level validation error display.
 * Renders a small inline error message with an icon, or null if no message.
 */
export function fieldError(
  message?: string | null,
  { icon: Icon = AlertCircle }: { icon?: ElementType } = {},
) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive" role="alert">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
