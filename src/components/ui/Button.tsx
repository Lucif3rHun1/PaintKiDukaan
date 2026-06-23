import {
  forwardRef,
  type ComponentType,
  type ReactNode,
  isValidElement,
} from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: ComponentType<{ className?: string }> | ReactNode;
  loading?: boolean;
  children?: React.ReactNode;
}

const variants = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/90",
  secondary:
    "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/80",
  ghost:
    "text-muted-foreground hover:bg-muted hover:text-foreground",
  danger:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive",
};

const sizes = {
  sm: "h-7 px-2 text-xs gap-1",
  md: "h-9 px-3 text-sm gap-1.5",
  lg: "h-11 px-4 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  (
    {
      variant = "primary",
      size = "md",
      icon,
      loading,
      children,
      className,
      disabled,
      ...props
    },
    ref,
  ) => {
    const IconComp =
      typeof icon === "function" ||
      (typeof icon === "object" && icon !== null && !isValidElement(icon))
        ? (icon as ComponentType<{ className?: string }>)
        : null;

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-colors",
          "disabled:pointer-events-none disabled:opacity-50",
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {!loading && IconComp && <IconComp className="h-4 w-4" />}
        {!loading && !IconComp && icon && <span>{icon as ReactNode}</span>}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
