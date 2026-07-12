import type { PaymentSplit, ReturnCartLine } from "../types";

export const RETURN_DRAFT_KEY = "paintkiduakan.sales.return-draft";

export interface ReturnDraft {
  source_no: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  sale_id: number;
  lines: ReturnCartLine[];
  payment_modes: PaymentSplit[];
  reason: string;
}
