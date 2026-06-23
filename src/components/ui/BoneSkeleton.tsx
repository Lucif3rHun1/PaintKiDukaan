import { type ReactNode } from "react";
import { Skeleton as BoneyardSkeleton } from "boneyard-js/react";
import { Skeleton } from "./Skeleton";
import { cn } from "./cn";

export interface BoneSkeletonProps {
  /**
   * When true the skeleton overlay is shown; when false the real children
   * render. Defaults to true when children are provided.
   */
  loading?: boolean;
  /**
   * Optional fixture name. When boneyard has captured a `.bones.json` fixture
   * for this name it will be used instead of the generic fallback.
   */
  name?: string;
  /** CSS class applied to the skeleton container. */
  className?: string;
  /**
   * Custom fallback rendered when boneyard has no fixture for the name or when
   * the library is not yet configured. Defaults to the hand-rolled Skeleton.
   */
  fallback?: ReactNode;
  /** Tone passed to the default fallback skeleton. */
  tone?: "light" | "dark";
  children?: ReactNode;
}

/**
 * Drop-in boneyard skeleton wrapper.
 *
 * Uses the captured UI fixture when available, otherwise falls back to the
 * project's own Skeleton primitive so screens stay usable while boneyard is
 * being configured.
 */
export function BoneSkeleton({
  loading = true,
  name,
  className,
  fallback,
  tone = "dark",
  children,
}: BoneSkeletonProps) {
  return (
    <BoneyardSkeleton
      loading={loading}
      name={name}
      className={cn("inline-block w-full", className)}
      fallback={fallback ?? <Skeleton className={className} />}
    >
      {children}
    </BoneyardSkeleton>
  );
}
