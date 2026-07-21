/**
 * Vendors domain types — owned by Slice B.
 */

export interface Vendor {
  id: number;
  name: string;
  phone: string | null;
  contact_person: string | null;
  credit_limit: number | null;
  opening_balance: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewVendor {
  name: string;
  phone?: string | null;
  contact_person?: string | null;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
}

export interface VendorUpdate {
  name?: string;
  phone?: string | null;
  contact_person?: string | null;
  credit_limit?: number | null;
  opening_balance?: number;
  notes?: string | null;
  is_active?: boolean;
}

export interface VendorPayment {
  vendor_id: number;
  amount: number;
  mode: string;
  date: string;
  notes?: string | null;
}

export interface VendorPaymentRecord {
  id: number;
  vendor_id: number;
  amount: number;
  mode: string;
  date: string;
  notes: string | null;
  user_id: number;
  created_at: string;
}
