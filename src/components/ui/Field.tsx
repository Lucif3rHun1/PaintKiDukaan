export function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span>
      )}
      {error && (
        <span className="mt-1 block text-[10px] text-destructive">{error}</span>
      )}
    </label>
  );
}
