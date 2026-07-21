/**
 * Customers domain API.
 */
import { invoke } from "../../lib/ipc";
import type {
  CreateCustomerCreditInvoiceArgs,
  Customer,
  CustomerLedger,
  CustomerOutstanding,
  CustomerUpdate,
  ListPage,
  ListQuery,
  NewCustomer,
  RecordCustomerPaymentArgs,
} from "../types";

export interface CustomerMetrics {
  total: number;
  active: number;
  inactive: number;
  flagged: number;
}

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

export async function listCustomersPaged(query: ListQuery): Promise<ListPage<Customer>> {
  return invoke<ListPage<Customer>>("cmd_list_customers_paged", { query });
}

export async function listCustomerMetrics(): Promise<CustomerMetrics> {
  return invoke<CustomerMetrics>("cmd_customer_metrics");
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
