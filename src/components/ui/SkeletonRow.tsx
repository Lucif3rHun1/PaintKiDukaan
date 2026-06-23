export interface SkeletonRowProps {
  count?: number;
  className?: string;
}

export function SkeletonRow({ count = 3, className }: SkeletonRowProps) {
  return (
    <div className={["space-y-2", className].filter(Boolean).join(" ")}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
