const displayFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDateForDisplay(date: string | number | Date): string {
  return displayFormatter.format(new Date(date));
}
