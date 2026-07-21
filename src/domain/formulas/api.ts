import { invoke } from "../../lib/ipc";
import type { Formula, FormulaSaleRow, ListPage, ListQuery } from "../types";

export {
  listFormulas,
  getFormula,
  createFormula,
  updateFormula,
  deactivateFormula,
  listFormulaSales,
} from "../ipc";
export type {
  Formula,
  FormulaFilter,
  NewFormula,
  UpdateFormula,
  FormulaSaleRow,
} from "../types";

export interface FormulaMetrics {
  total: number;
  active: number;
  inactive: number;
}

export async function listFormulasPaged(query: ListQuery): Promise<ListPage<Formula>> {
  return invoke<ListPage<Formula>>("cmd_list_formulas_paged", { query });
}

export async function listFormulaMetrics(): Promise<FormulaMetrics> {
  return invoke<FormulaMetrics>("cmd_formula_metrics");
}

export async function listFormulaSalesPaged(query: ListQuery): Promise<ListPage<FormulaSaleRow>> {
  return invoke<ListPage<FormulaSaleRow>>("cmd_list_formula_sales_paged", { query });
}
