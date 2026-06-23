/**
 * Theme system — Light / Dark with System default.
 *
 * Persists user preference to localStorage under `paintkiduakan.theme`.
 * Default is `system`, which follows `prefers-color-scheme`.
 *
 * The resolved theme ("light" | "dark") is applied to <html data-theme="…">
 * so Tailwind's dark variant flips everywhere with one source of truth.
 *
 * Reading order on first load:
 *   1. localStorage "paintkiduakan.theme" (if set to "light"|"dark"|"system")
 *   2. matchMedia("(prefers-color-scheme: dark)") when "system"
 *   3. fallback "light"
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "paintkiduakan.theme";
const VALID_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>(["system", "light", "dark"]);

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return VALID_MODES.has(raw as ThemeMode) ? (raw as ThemeMode) : "system";
}

function writeStoredMode(mode: ThemeMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, mode);
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark() ? "dark" : "light";
}

function applyThemeAttribute(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

/* Inline script run before React mounts to prevent FOUC.
 * Reads the stored mode (or system preference) and sets data-theme on <html>. */
export function applyInitialTheme(): void {
  if (typeof document === "undefined") return;
  const mode = readStoredMode();
  applyThemeAttribute(resolveTheme(mode));
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // Track system preference while in "system" mode.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolved: ResolvedTheme = useMemo(() => {
    if (mode === "light") return "light";
    if (mode === "dark") return "dark";
    return systemDark ? "dark" : "light";
  }, [mode, systemDark]);

  // Apply to <html data-theme> whenever resolved changes.
  useEffect(() => {
    applyThemeAttribute(resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeStoredMode(next);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback so non-provider contexts (e.g. tests) don't crash.
    return { mode: "system", resolved: "light", setMode: () => undefined };
  }
  return ctx;
}
