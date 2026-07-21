/**
 * Customer-type domain types — owned by Slice B.
 */

export interface CustomerType {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface NewCustomerType {
  name: string;
}
