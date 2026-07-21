/**
 * Locations API. Slice B owns the table and the create/rename/deactivate
 * commands. Read by ItemForm and Settings (Slice D).
 */
import { invoke } from "../../lib/ipc";
import type { Location, NewLocation, SubLocation } from "../types";

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
  newZone: string | null,
): Promise<Location> {
  return invoke<Location>("rename_location", {
    id,
    new_name: newName,
    new_zone: newZone,
  });
}

export async function listSubLocations(
  locationId?: number,
): Promise<SubLocation[]> {
  return invoke<SubLocation[]>("list_sub_locations", {
    location_id: locationId ?? null,
    include_inactive: false,
  });
}

export async function createSubLocation(
  locationId: number,
  name: string,
  position?: string,
): Promise<SubLocation> {
  return invoke<SubLocation>("create_sub_location", {
    location_id: locationId,
    name,
    position: position ?? null,
  });
}

export async function deactivateSubLocation(id: number): Promise<void> {
  return invoke<void>("deactivate_sub_location", { id });
}
