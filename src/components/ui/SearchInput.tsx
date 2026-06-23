import {
  forwardRef,
  useEffect,
  useState,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { cn } from "./cn";

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Debounce delay in ms. If omitted, onChange fires immediately on every keystroke. */
  debounceMs?: number;
  icon?: ComponentType<{ className?: string }> | ReactNode;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      value,
      onChange,
      placeholder = "Search…",
      debounceMs,
      icon,
      className,
      inputClassName,
      ariaLabel,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = useState(value);

    // Keep internal value in sync when value changes from outside.
    useEffect(() => {
      setInternalValue(value);
    }, [value]);

    // Optional internal debounce.
    useEffect(() => {
      if (debounceMs === undefined) return;
      const timer = window.setTimeout(() => {
        onChange(internalValue);
      }, debounceMs);
      return () => window.clearTimeout(timer);
    }, [internalValue, debounceMs, onChange]);

    const IconComp =
      icon === undefined
        ? Search
        : typeof icon === "function" ||
            (typeof icon === "object" && icon !== null && !("props" in icon))
          ? (icon as ComponentType<{ className?: string }>)
          : null;

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const next = e.target.value;
      setInternalValue(next);
      if (debounceMs === undefined) {
        onChange(next);
      }
    }

    return (
      <div className={cn("relative min-w-[200px] flex-1", className)}>
        {IconComp ? (
          <IconComp
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            {icon as ReactNode}
          </span>
        )}
        <input
          ref={ref}
          type="search"
          value={internalValue}
          onChange={handleChange}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          className={cn("input w-full pl-9", inputClassName)}
          onKeyDown={onKeyDown}
          {...props}
        />
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
