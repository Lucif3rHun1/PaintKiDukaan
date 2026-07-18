import { type CSSProperties } from "react";
import { cn } from "./cn";

export type SkeletonVariant = "text" | "text-3-lines" | "card" | "circle";

export interface SkeletonProps {
  variant?: SkeletonVariant;
  className?: string;
  width?: string | number;
  height?: string | number;
}

export function Skeleton({
  variant = "text",
  className,
  width,
  height,
}: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;

  const bar = "bg-surface-sunken";
  const surface = "border-border bg-surface-panel";

  if (variant === "circle") {
    return (
      <div
        style={style}
        aria-hidden="true"
        className={cn("h-10 w-10 animate-pulse motion-reduce:animate-none rounded-full", bar, className)}
      />
    );
  }
  if (variant === "card") {
    return (
      <div
        style={style}
        aria-hidden="true"
        className={cn("space-y-3 rounded-lg border p-4", surface, className)}
      >
        <div className={cn("h-4 w-3/4 animate-pulse motion-reduce:animate-none rounded", bar)} />
        <div className={cn("h-3 w-1/2 animate-pulse motion-reduce:animate-none rounded", bar)} />
        <div className={cn("h-8 w-full animate-pulse motion-reduce:animate-none rounded", bar)} />
      </div>
    );
  }
  if (variant === "text-3-lines") {
    return (
      <div style={style} aria-hidden="true" className={cn("space-y-2", className)}>
        <div className={cn("h-3 w-full animate-pulse motion-reduce:animate-none rounded", bar)} />
        <div className={cn("h-3 w-5/6 animate-pulse motion-reduce:animate-none rounded", bar)} />
        <div className={cn("h-3 w-2/3 animate-pulse motion-reduce:animate-none rounded", bar)} />
      </div>
    );
  }
  return (
    <div
      style={style}
      aria-hidden="true"
      className={cn("h-3 w-full animate-pulse motion-reduce:animate-none rounded", bar, className)}
    />
  );
}
