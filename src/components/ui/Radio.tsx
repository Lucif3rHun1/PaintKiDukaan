import { cn } from "./cn";

export interface RadioProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  name?: string;
  className?: string;
}

export function Radio({ checked, onChange, label, name, className }: RadioProps) {
  return (
    <label className={cn("flex min-h-10 items-center gap-2 text-sm cursor-pointer", className)}>
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors",
          checked
            ? "border-primary bg-primary"
            : "border-muted-foreground/40 bg-background hover:border-muted-foreground/60",
        )}
      >
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
      </span>
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {label}
    </label>
  );
}
