/**
 * Customers domain types — owned by Slice B.
 */

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type_id: number | null;
  type_name: string | null;
  opening_balance_paise: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  is_flagged?: boolean;
  credit_limit?: number | null;
  notes?: string | null;
}

export interface CustomerOutstanding {
  customer_id: number;
  opening_balance_paise: number;
  total_sales: number;
  total_paid: number;
  total_payments: number;
  outstanding: number;
}

export interface NewCustomer {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  customer_type_id?: number | null;
  opening_balance_paise?: number;
}

export interface CustomerUpdate {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  customer_type_id?: number | null;
  opening_balance_paise?: number;
  is_active?: boolean;
}

// ── Credit invoice / payment args (customers slice C boundary) ──────────────

export interface CustomerBill {
  sale_id: number;
  sale_number: string;
  created_at: string;
  total_paise: number;
  paid_paise: number;
  status: string;
}

export interface CreditInvoiceLine {
  item_id: number;
  qty: number;
  unit_price_paise: number;
}

export interface CreateCustomerCreditInvoiceArgs {
  customer_id: number;
  date: string; // ISO YYYY-MM-DD
  description: string | null;
  lines: CreditInvoiceLine[];
}

export interface RecordCustomerPaymentArgs {
  customer_id: number;
  amount: number; // paise
  mode: string;
  date: string; // ISO YYYY-MM-DD
  note: string | null;
}

export interface CreateCustomerInlinePayload {
  name: string;
  phone: string;
  type_id: number | null;
}
