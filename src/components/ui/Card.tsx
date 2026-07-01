import { type ElementType, type ReactNode } from "react";
import { cn } from "./cn";

interface CardProps {
  as?: ElementType;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}

function CardRoot({ as: Tag = "div", bare, className, children }: CardProps) {
  return (
    <Tag
        className={cn(
        bare ? "" : "rounded-xl bg-card text-card-foreground shadow-md shadow-foreground/5 ring-1 ring-border/30",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

function CardHeader({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("border-b border-border px-4 py-3", className)}>
      {children}
    </div>
  );
}

function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

function CardFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("border-t border-border px-4 py-3", className)}>
      {children}
    </div>
  );
}

export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Body: CardBody,
  Footer: CardFooter,
});
