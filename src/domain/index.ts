/**
 * Public entry for Slice B's domain layer. Other slices import from here
 * (e.g. Slice C reads `Item`, `Customer`, `Vendor` types).
 */
export * from "./types";
export * as itemsApi from "./items/api";
export * as customersApi from "./customers/api";
export * as vendorsApi from "./vendors/api";
export * as customerTypesApi from "./customerTypes/api";
export { ItemForm } from "./items/ItemForm";
export { ItemList } from "./items/ItemList";
export { CustomerForm } from "./customers/CustomerForm";
export { CustomerList } from "./customers/CustomerList";
export { CustomerDetail } from "./customers/CustomerDetail";
export { CustomerLedgerView } from "./customers/CustomerLedgerView";
export { VendorForm } from "./vendors/VendorForm";
export { VendorList } from "./vendors/VendorList";
export { VendorPaymentForm } from "./vendors/VendorPaymentForm";
export { ManageTypes } from "./customerTypes/ManageTypes";
