/**
 * Customers domain API.
 */
import { invoke } from "../ipc";
import type {
  Customer,
  CustomerOutstanding,
  CustomerUpdate,
  NewCustomer,
} from "../types";

export async function createCustomer(
  payload: NewCustomer,
): Promise<Customer> {
  return invoke<Customer>("create_customer", { payload });
}

export async function updateCustomer(
  id: number,
  patch: CustomerUpdate,
): Promise<Customer> {
  return invoke<Customer>("update_customer", { id, patch });
}

export async function listCustomers(
  query?: string,
  includeInactive = false,
): Promise<Customer[]> {
  return invoke<Customer[]>("list_customers", {
    query: query ?? null,
    includeInactive,
  });
}

export async function lookupCustomer(
  phone: string,
): Promise<Customer | null> {
  return invoke<Customer | null>("lookup_customer", { phone });
}

export async function customerOutstanding(
  id: number,
): Promise<CustomerOutstanding> {
  return invoke<CustomerOutstanding>("customer_outstanding", { id });
}
