import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Draft } from "../../domain/types";

const api = vi.hoisted(() => ({
  getDraft: vi.fn(),
  listSalesPaged: vi.fn(),
  salesPeriodSummary: vi.fn(),
  convertToFbill: vi.fn(),
}));

vi.mock("../api", () => api);

import { SalesListPage } from "./SalesListPage";
import { hasMeaningfulDraftContent } from "./SalesPage";

function draft(formType: string, lines: readonly unknown[]): Draft {
  return {
    id: 1,
    user_id: 1,
    form_type: formType,
    data_json: JSON.stringify({ lines }),
    updated_at: 1,
    created_at: 1,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SalesListPage onCreate={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("SalesListPage", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  beforeEach(() => {
    api.getDraft.mockResolvedValue(null);
    api.listSalesPaged.mockResolvedValue({ rows: [], total: 0 });
    api.salesPeriodSummary.mockResolvedValue({
      count: 2,
      total_paise: 10_000,
      avg_paise: 5_000,
      paid_paise: 7_000,
    });
  });

  it("hides the draft action when every saved draft has no items", async () => {
    api.getDraft.mockImplementation((formType: string) =>
      Promise.resolve(draft(formType, [])),
    );

    renderPage();

    await waitFor(() => expect(api.getDraft).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("button", { name: /draft.*open/i })).not.toBeInTheDocument();
  });

  it("shows the draft action when a saved draft has items", async () => {
    api.getDraft.mockImplementation((formType: string) =>
      Promise.resolve(formType === "sale-final" ? draft(formType, [{ item_id: 7 }]) : null),
    );

    renderPage();

    expect(await screen.findByRole("button", { name: /draft.*open \(1 item\)/i })).toBeInTheDocument();
  });

  it("explains total sales with collected and on-credit amounts", async () => {
    renderPage();

    expect(await screen.findByText("Total sales")).toBeInTheDocument();
    expect(screen.getByText("₹100.00")).toBeInTheDocument();
    expect(screen.getByText("Collected ₹70.00")).toBeInTheDocument();
    expect(screen.getByText("On credit ₹30.00")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Collected share" })).toHaveAttribute(
      "aria-valuenow",
      "70",
    );
  });
});

describe("sales draft content", () => {
  it("does not treat opening the form or adding a blank custom row as draft content", () => {
    expect(hasMeaningfulDraftContent([])).toBe(false);
    expect(
      hasMeaningfulDraftContent([
        {
          kind: "item",
          item_id: null,
          formula_id: null,
          item_name: "  ",
          display_name: "  ",
          qty: 1,
          price: 0,
          unit_type: "pcs",
          line_discount: 0,
          shade_note: null,
        },
      ]),
    ).toBe(false);
  });

  it("treats a selected item as meaningful draft content", () => {
    expect(
      hasMeaningfulDraftContent([
        {
          kind: "item",
          item_id: 7,
          formula_id: null,
          item_name: "Blue paint",
          display_name: "Blue paint",
          qty: 1,
          price: 5_000,
          unit_type: "pcs",
          line_discount: 0,
          shade_note: null,
        },
      ]),
    ).toBe(true);
  });
});
