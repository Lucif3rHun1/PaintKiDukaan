import { cn } from "./cn";

interface Props {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "muted" | "info" | "neutral";
  size?: "sm" | "md";
  className?: string;
  onClick?: () => void;
}

const variants = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success/25 text-success ring-1 ring-inset ring-success/40",
  warning: "bg-warning/25 text-warning ring-1 ring-inset ring-warning/40",
  danger: "bg-destructive/20 text-destructive ring-1 ring-inset ring-destructive/40 font-semibold",
  muted: "bg-muted text-muted-foreground",
  info: "bg-info/25 text-info ring-1 ring-inset ring-info/40",
  neutral: "bg-muted text-muted-foreground",
};

export function Badge({ children, variant = "default", size = "md", className, onClick }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        variants[variant],
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </span>
  );
}
