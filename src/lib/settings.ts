/**
 * Shared settings helpers for loading and saving settings from the database.
 * These functions handle JSON parsing with fallbacks for backward compatibility.
 */
import { invokeRaw } from "./ipc";

/** Get a setting value from the database. */
export async function getSetting(key: string): Promise<string | null> {
  return invokeRaw<string | null>("get_setting", { key });
}

/** Set a setting value in the database. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  return invokeRaw<void>("set_setting", { key, value });
}

export async function loadString(
  getSetting: (key: string) => Promise<string | null>,
  key: string,
  fallback = ""
): Promise<string> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

export async function loadNumber(
  getSetting: (key: string) => Promise<string | null>,
  key: string,
  fallback = 0
): Promise<number> {
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

export async function loadBool(
  getSetting: (key: string) => Promise<string | null>,
  key: string,
  fallback = false
): Promise<boolean> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try {
    return Boolean(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export async function saveSetting(
  setSetting: (key: string, value: unknown) => Promise<void>,
  key: string,
  value: unknown
): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}