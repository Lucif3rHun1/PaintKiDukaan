/**
 * Formulas domain types — owned by Slice B.
 */

export interface Formula {
  id: number;
  id_code: string;
  name: string | null;
  with_base: boolean;
  base_item_id: number | null;
  base_item_name: string | null;
  retail_price_paise: number;
  is_active: boolean;
  created_at: string;
  created_by_user_id: number | null;
  sales_count: number;
  last_sold_at: string | null;
}

export interface FormulaFilter {
  query?: string;
  active?: boolean | null;
}

export interface NewFormula {
  id_code: string;
  name?: string | null;
  with_base: boolean;
  base_item_id?: number | null;
  retail_price_paise: number;
}

export interface UpdateFormula {
  name?: string | null;
  with_base?: boolean;
  base_item_id?: number | null;
  retail_price_paise?: number;
  is_active?: boolean;
}

export interface FormulaSaleRow {
  sale_id: number;
  sale_no: string;
  sale_kind: "quotation" | "final" | "fbill";
  date: string;
  customer_id: number | null;
  customer_name: string | null;
  price: number;
  qty: number;
  line_total: number;
}

export interface FormulaSearchHit {
  kind: "formula";
  id: number;
  id_code: string;
  name: string | null;
  retail_price_paise: number;
  with_base: boolean;
  base_item_name: string | null;
}
