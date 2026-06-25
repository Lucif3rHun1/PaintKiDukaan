import { forwardRef, type SelectHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: SelectOption[];
  placeholder?: string;
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
}

const sizeMap = {
  sm: "h-7 text-xs",
  md: "h-9 text-sm",
} as const;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    { options, placeholder, size = "md", className, disabled, children, ...rest },
    ref,
  ) => {
    return (
      <div className={cn("relative w-full", className)}>
        <select
          ref={ref}
          disabled={disabled}
          aria-label={rest["aria-label"]}
          className={cn(
            "w-full appearance-none rounded-md border border-border bg-background pl-2 pr-7 text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
            sizeMap[size],
          )}
          {...rest}
        >
          {placeholder !== undefined ? (
            <option value="" disabled hidden>
              {placeholder}
            </option>
          ) : null}
          {children ??
            options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground",
            size === "sm" ? "h-3 w-3" : "h-4 w-4",
            disabled && "opacity-50",
          )}
        />
      </div>
    );
  },
);
Select.displayName = "Select";