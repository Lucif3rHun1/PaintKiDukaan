import { forwardRef, type SelectHTMLAttributes } from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "./cn"

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: SelectOption[]
  placeholder?: string
  size?: "sm" | "md"
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, placeholder, size = "md", children, ...props }, ref) => {
    return (
      <div className="relative inline-flex">
        <select
          ref={ref}
          className={cn(
            "appearance-none rounded-lg border border-input bg-transparent pr-8 pl-2.5 text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            size === "sm" ? "h-7 text-[0.8rem]" : "h-8",
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    )
  }
)
Select.displayName = "Select"

export { Select, type SelectProps, type SelectOption }
