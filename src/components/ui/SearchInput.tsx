import {
  forwardRef,
  useEffect,
  useRef,
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
    // ponytail: stash onChange in ref to prevent debounce reset on parent re-render
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
      if (debounceMs === undefined) return;
      const timer = window.setTimeout(() => {
        onChangeRef.current(internalValue);
      }, debounceMs);
      return () => window.clearTimeout(timer);
    }, [internalValue, debounceMs]);

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
          className={cn(
            "input peer w-full pl-9 focus:border-input focus:ring-0 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 motion-reduce:transition-none",
            inputClassName,
          )}
          onKeyDown={onKeyDown}
          {...props}
        />
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
