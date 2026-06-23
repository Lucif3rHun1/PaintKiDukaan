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
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
  info: "bg-info/15 text-info",
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
