/**
 * Draft (autosave) domain types — owned by Slice C (POS).
 */

export interface Draft {
  id: number;
  user_id: number;
  form_type: string;
  data_json: string;
  updated_at: number;
  created_at: number;
}
