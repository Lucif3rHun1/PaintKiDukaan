/**
 * Vendors domain API.
 */
import { invoke } from "../ipc";
import type {
  NewVendor,
  Vendor,
  VendorOutstanding,
  VendorPayment,
  VendorUpdate,
} from "../types";

export async function createVendor(payload: NewVendor): Promise<Vendor> {
  return invoke<Vendor>("create_vendor", { payload });
}

export async function listVendors(
  query?: string,
  includeInactive = false,
): Promise<Vendor[]> {
  return invoke<Vendor[]>("list_vendors", {
    query: query ?? null,
    include_inactive: includeInactive,
  });
}

export async function getVendor(id: number): Promise<Vendor> {
  return invoke<Vendor>("get_vendor", { id });
}

export async function updateVendor(
  id: number,
  patch: VendorUpdate,
): Promise<Vendor> {
  return invoke<Vendor>("update_vendor", { id, patch });
}

export async function recordVendorPayment(
  payload: VendorPayment,
): Promise<VendorOutstanding> {
  return invoke<VendorOutstanding>("record_vendor_payment", { payload });
}

export async function vendorOutstanding(
  id: number,
): Promise<VendorOutstanding> {
  return invoke<VendorOutstanding>("vendor_outstanding", { id });
}
