import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InvoiceSearchInput } from "../../src/pos/sales/InvoiceSearchInput";
import type { Sale } from "../../src/pos/types";

vi.mock("../../src/pos/api", () => ({
  listSales: vi.fn(),
}));

import { listSales } from "../../src/pos/api";

const mockedListSales = vi.mocked(listSales);

function makeSale(id: number, no: string): Sale {
  return {
    id,
    no,
    customer_id: 1,
    customer_name: "Acme",
    date: "2025-01-01",
    status: "final",
    subtotal: 0,
    bill_discount: 0,
    total: 100_00,
    paid_amount: 100_00,
    payment_modes: [],
    validity_days: null,
    converted_from_id: null,
    user_id: 1,
    created_at: "2025-01-01T00:00:00Z",
    items: [],
  };
}

beforeEach(() => {
  mockedListSales.mockReset();
  mockedListSales.mockResolvedValue([
    makeSale(1, "INV-001"),
    makeSale(2, "INV-002"),
    makeSale(3, "INV-003"),
  ]);
});

describe("InvoiceSearchInput", () => {
  it("calls onLink exactly once on row click and does not refetch", async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();

    render(<InvoiceSearchInput linked={[]} onLink={onLink} onUnlink={() => {}} />);

    const input = screen.getByLabelText(/search invoices/i);
    await user.type(input, "INV");

    await waitFor(() => expect(screen.getByText("INV-001")).toBeInTheDocument());

    const callsBefore = mockedListSales.mock.calls.length;
    await user.click(screen.getByText("INV-001"));

    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, no: "INV-001" }),
    ]);
    expect(mockedListSales.mock.calls.length).toBe(callsBefore);
  });

  it("clears picked row from the dropdown immediately on click", async () => {
    const user = userEvent.setup();
    render(<InvoiceSearchInput linked={[]} onLink={() => {}} onUnlink={() => {}} />);

    const input = screen.getByLabelText(/search invoices/i);
    await user.type(input, "INV");
    await waitFor(() => expect(screen.getByText("INV-001")).toBeInTheDocument());

    await user.click(screen.getByText("INV-001"));

    await waitFor(() => expect(screen.queryByText("INV-001")).not.toBeInTheDocument());
    expect(screen.getByText("INV-002")).toBeInTheDocument();
  });

});
