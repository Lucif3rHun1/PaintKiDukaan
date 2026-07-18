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
            "appearance-none rounded-md border border-input bg-background pr-8 pl-3 text-sm outline-none select-none transition-[color,background-color,border-color,box-shadow] duration-fast ease-standard focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 motion-reduce:transition-none dark:bg-input/30 dark:hover:bg-input/50",
            size === "sm" ? "h-8 text-xs" : "h-10",
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
