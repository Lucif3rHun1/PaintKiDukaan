/**
 * Locations API. Slice B owns the table and the create/rename/deactivate
 * commands. Read by ItemForm's LocationAutocomplete and Settings (Slice D).
 */
import { invoke } from "../ipc";
import type { Location, NewLocation } from "../types";

export async function listLocations(
  includeInactive = false,
): Promise<Location[]> {
  return invoke<Location[]>("list_locations", { include_inactive: includeInactive });
}

export async function createLocation(
  payload: NewLocation,
): Promise<Location> {
  return invoke<Location>("create_location", { payload });
}

export async function renameLocation(
  id: number,
  newName: string,
  newRack: string | null,
): Promise<Location> {
  return invoke<Location>("rename_location", {
    id,
    new_name: newName,
    new_rack: newRack,
  });
}

export async function deactivateLocation(id: number): Promise<void> {
  return invoke<void>("deactivate_location", { id });
}
