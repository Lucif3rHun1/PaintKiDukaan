import { tauriInvoke } from "../../lib/security/tauri";
import type { Unit, UnitConversion } from "../types";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type UnitDimension = "volume" | "mass" | "area" | "count";

export const listUnits = (includeInactive = false): Promise<Unit[]> =>
  isTauri()
    ? tauriInvoke<Unit[]>("list_units", { include_inactive: includeInactive })
    : Promise.resolve([]);

export const listUnitConversions = (): Promise<UnitConversion[]> =>
  isTauri()
    ? tauriInvoke<UnitConversion[]>("list_unit_conversions")
    : Promise.resolve([]);

export const createUnit = (
  code: string,
  label: string,
  dimension: UnitDimension,
): Promise<Unit> =>
  isTauri()
    ? tauriInvoke<Unit>("create_unit", { code, label, dimension })
    : Promise.reject(new Error("createUnit unavailable outside Tauri"));

export const updateUnit = (
  id: number,
  code?: string,
  label?: string,
  dimension?: UnitDimension,
): Promise<Unit> =>
  isTauri()
    ? tauriInvoke<Unit>("update_unit", { id, code, label, dimension })
    : Promise.reject(new Error("updateUnit unavailable outside Tauri"));

export const deactivateUnit = (id: number): Promise<void> =>
  isTauri()
    ? tauriInvoke<void>("deactivate_unit", { id })
    : Promise.reject(new Error("deactivateUnit unavailable outside Tauri"));
