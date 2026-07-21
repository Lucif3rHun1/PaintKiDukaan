/**
 * Sale-return domain types — owned by Slice C (POS).
 */

export interface CreateSaleReturnPayload {
  sale_id: number;
  customer_id?: number | null;
  date?: string; // YYYY-MM-DD
  reason?: string;
  payment_modes: Array<{ mode: string; amount: number }>;
  owner_pin: string;
  lines: Array<{
    sale_item_id: number;
    item_id?: number;
    qty: number;
    refund_paise: number;
    shade_note?: string;
  }>;
}

export interface SaleReturn {
  id: number;
  no: string; // "RET/DD-MM-YYYY/NNN"
  sale_id: number;
  date: string; // YYYY-MM-DD
  reason: string | null;
  refund_total: number; // paise
  payment_modes: Array<{ mode: string; amount: number }>;
  lines: SaleReturnLine[];
  created_at: string;
  created_by: number;
}

export interface SaleReturnLine {
  sale_item_id: number;
  item_name: string;
  qty: number;
  refund_paise: number;
  shade_note: string | null;
}
