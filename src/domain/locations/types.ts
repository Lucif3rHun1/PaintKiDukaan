/**
 * Locations domain types — owned by Slice B.
 */

export interface Location {
  id: number;
  name: string;
  rack: string | null;
  zone: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SubLocation {
  id: number;
  location_id: number;
  name: string;
  position: string | null;
  is_active: boolean;
  created_at: string;
}

export interface NewLocation {
  name: string;
  rack?: string | null;
  zone?: string | null;
}
