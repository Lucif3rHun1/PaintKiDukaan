import { forwardRef, isValidElement, type ElementType, type ReactNode } from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "./cn"
import { KbdHint } from "./KbdHint"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none transition-[color,background-color,transform,box-shadow] duration-fast ease-standard focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 active:not-aria-[haspopup]:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-10",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-11",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        size: "default",
        className: "min-h-11 sm:min-h-10",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

// Old API variant mapping: primary→default, danger→destructive
type OldVariant = "primary" | "danger"
type ShadcnVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link"

interface ButtonProps
  extends Omit<ButtonPrimitive.Props, "children">,
    Omit<VariantProps<typeof buttonVariants>, "variant" | "size"> {
  variant?: OldVariant | ShadcnVariant
  size?: "md" | NonNullable<VariantProps<typeof buttonVariants>["size"]>
  icon?: ElementType<{ className?: string }> | ReactNode
  loading?: boolean
  shortcut?: string
  children?: ReactNode
}

function resolveVariant(variant: ButtonProps["variant"]): ShadcnVariant {
  if (variant === "primary") return "default"
  if (variant === "danger") return "destructive"
  return (variant as ShadcnVariant) ?? "default"
}

function resolveSize(size: ButtonProps["size"]): NonNullable<VariantProps<typeof buttonVariants>["size"]> {
  if (size === "md") return "default"
  return (size as NonNullable<VariantProps<typeof buttonVariants>["size"]>) ?? "default"
}

function isIconComponent(icon: unknown): icon is ElementType<{ className?: string }> {
  return typeof icon === "function" || (typeof icon === "object" && icon !== null && "render" in icon)
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size = "default", icon, loading, shortcut, children, disabled, ...props }, ref) => {
    const IconComponent = isIconComponent(icon) ? icon : null
    const IconNode: ReactNode = isValidElement(icon) ? icon : null

    return (
      <ButtonPrimitive
        ref={ref}
        data-slot="button"
        className={cn(buttonVariants({ variant: resolveVariant(variant), size: resolveSize(size), className }))}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
        {!loading && IconComponent && <IconComponent className="size-4" />}
        {!loading && IconNode && <span className="inline-flex shrink-0 [&>svg]:size-4">{IconNode}</span>}
        {children}
        {shortcut && <KbdHint keys={shortcut} />}
      </ButtonPrimitive>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants, type ButtonProps }
