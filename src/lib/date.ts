const displayFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDateForDisplay(date: string | number | Date | null | undefined): string {
  if (date === null || date === undefined || date === "") return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return displayFormatter.format(d);
}

/**
 * Today's date in the user's local timezone, formatted as `YYYY-MM-DD`.
 *
 * Use this whenever a transaction date is recorded — the backend's
 * `chrono::Local::now()` runs in the SERVER's timezone (often UTC on a dev
 * box), which produces a date that's wrong for the user. Sending the
 * browser's local date keeps the invoice aligned with the day the user
 * perceives themselves to be working in.
 */
export function todayLocalYyyymmdd(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Shift today's date by `daysBack` days (positive = past) in local timezone. */
export function shiftDaysLocal(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return todayLocalYyyymmddFrom(d);
}

function todayLocalYyyymmddFrom(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
