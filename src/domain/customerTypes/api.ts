/**
 * Customer-types domain API.
 */
import { invoke } from "../ipc";
import type { CustomerType, NewCustomerType } from "../types";

export async function listCustomerTypes(
  includeInactive = false,
): Promise<CustomerType[]> {
  return invoke<CustomerType[]>("list_customer_types", { includeInactive });
}

export async function addCustomerType(
  payload: NewCustomerType,
): Promise<CustomerType> {
  return invoke<CustomerType>("add_customer_type", { payload });
}

export async function renameCustomerType(
  id: number,
  newName: string,
): Promise<CustomerType> {
  return invoke<CustomerType>("rename_customer_type", { id, newName });
}

export async function deactivateCustomerType(id: number): Promise<void> {
  return invoke<void>("deactivate_customer_type", { id });
}
