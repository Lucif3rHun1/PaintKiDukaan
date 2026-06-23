import type { ReactNode } from "react";

import { Alert, Skeleton } from "../../../../components/ui";

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {help ? <span className="block text-xs leading-5 text-muted-foreground">{help}</span> : null}
    </label>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton width="33%" />
      <Skeleton variant="card" className="h-20" />
      <Skeleton variant="card" className="h-20" />
    </div>
  );
}

export function SettingsError({ children }: { children: ReactNode }) {
  return <Alert title="Could not load settings">{children}</Alert>;
}

export async function loadString(getSetting: (key: string) => Promise<string | null>, key: string, fallback = ""): Promise<string> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

export async function loadNumber(getSetting: (key: string) => Promise<string | null>, key: string, fallback = 0): Promise<number> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try {
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
}

export async function loadBool(getSetting: (key: string) => Promise<string | null>, key: string, fallback = false): Promise<boolean> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try {
    return Boolean(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export async function saveSetting(setSetting: (key: string, value: unknown) => Promise<void>, key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}
