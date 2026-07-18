export interface SkeletonRowProps {
  count?: number;
  className?: string;
}

export function SkeletonRow({ count = 3, className }: SkeletonRowProps) {
  return (
    <div aria-hidden="true" className={["overflow-hidden rounded-md border border-border", className].filter(Boolean).join(" ")}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse border-b border-border bg-surface-sunken last:border-b-0 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
