export interface SkeletonRowProps {
  count?: number;
  className?: string;
}

export function SkeletonRow({ count = 3, className }: SkeletonRowProps) {
  return (
    <div className={"space-y-2 " + (className ?? "")}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse motion-reduce:animate-none rounded-md bg-muted/70"
        />
      ))}
    </div>
  );
}
