/**
 * Customers domain API.
 */
import { invoke } from "../ipc";
import type {
  CreateCustomerCreditInvoiceArgs,
  Customer,
  CustomerLedger,
  CustomerOutstanding,
  CustomerUpdate,
  NewCustomer,
  RecordCustomerPaymentArgs,
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
    include_inactive: includeInactive,
  });
}

export async function customerOutstanding(
  id: number,
): Promise<CustomerOutstanding> {
  return invoke<CustomerOutstanding>("customer_outstanding", { id });
}

export async function fetchCustomerLedger(
  customerId: number,
  limit = 100,
): Promise<CustomerLedger> {
  return invoke<CustomerLedger>("customer_ledger", {
    customer_id: customerId,
    limit,
  });
}

export async function createCustomerCreditInvoice(
  args: CreateCustomerCreditInvoiceArgs,
): Promise<void> {
  await invoke<void>("create_customer_credit_invoice", { args });
}

export async function recordCustomerPayment(
  args: RecordCustomerPaymentArgs,
): Promise<CustomerOutstanding> {
  return invoke<CustomerOutstanding>("record_customer_payment", { args });
}
