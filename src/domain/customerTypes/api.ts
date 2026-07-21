/**
 * Customer-types domain API.
 */
import { invoke } from "../../lib/ipc";
import type { CustomerType, ListPage, ListQuery, NewCustomerType } from "../types";

export async function listCustomerTypes(
  includeInactive = false,
): Promise<CustomerType[]> {
  return invoke<CustomerType[]>("list_customer_types", { include_inactive: includeInactive });
}

export async function listCustomerTypesPaged(query: ListQuery): Promise<ListPage<CustomerType>> {
  return invoke<ListPage<CustomerType>>("cmd_list_customer_types_paged", { query });
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
  return invoke<CustomerType>("rename_customer_type", { id, new_name: newName });
}

export async function deactivateCustomerType(id: number): Promise<void> {
  return invoke<void>("deactivate_customer_type", { id });
}
