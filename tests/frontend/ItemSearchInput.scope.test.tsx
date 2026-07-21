import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ItemSearchInput } from "../../src/components/ui/ItemSearchInput";
import type { ItemSearchHit } from "../../src/pos/types";

vi.mock("../../src/pos/api", () => ({
  listSales: vi.fn(),
}));

vi.mock("../../src/domain/items/api", () => ({
  listItems: vi.fn(),
  lookupItem: vi.fn(),
  listSaleUnits: vi.fn(),
  listLocations: vi.fn(),
  listFormulas: vi.fn(),
  createItem: vi.fn(),
}));

vi.mock("../../src/lib/hooks/useBarcodeScan", () => ({
  useBarcodeScan: () => ({ scanHint: null }),
}));

import { listItems } from "../../src/domain/items/api";

const mockedListItems = vi.mocked(listItems);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeHit(id: number, name: string): ItemSearchHit {
  return {
    id,
    sku_code: `SKU${id}`,
    barcode: null,
    name,
    brand: null,
    retail_price_paise: 5000,
    cost_paise: 4000,
    unit_code: "pcs",
    unit_label: "pcs",
    sell_unit: undefined,
    current_qty: 100,
    min_stock: 0,
  };
}

beforeEach(() => {
  mockedListItems.mockReset();
  mockedListItems.mockResolvedValue([makeHit(1, "Item One"), makeHit(2, "Item Two")]);
});

describe("ItemSearchInput scope (linked invoices)", () => {
  it("renders Bought/Refundable/Retail rows when itemsByItemId has the item", async () => {
    const user = userEvent.setup();
    const itemsByItemId = new Map([
      [1, { bought: 10, refundable: 7, retail_price_paise: 5000, display_name: "Item One" }],
      [2, { bought: 5, refundable: 5, retail_price_paise: 4500, display_name: "Item Two" }],
    ]);

    render(
      <ItemSearchInput
        onPick={() => {}}
        scope={{ kind: "linked_invoices", itemsByItemId }}
      />,
      { wrapper: createWrapper() },
    );

    const input = screen.getByPlaceholderText(/search/i);
    await user.type(input, "Item");

    await waitFor(() => expect(screen.getByText("Item One")).toBeInTheDocument());

    expect(screen.getByText("Refundable 7")).toBeInTheDocument();
    expect(screen.getByText("Refundable 5")).toBeInTheDocument();
    expect(screen.queryByText(/^Bought/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Retail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/IN STOCK/i)).not.toBeInTheDocument();
  });

  it("disables the row + labels 'fully refunded' when refundable <= 0", async () => {
    const user = userEvent.setup();
    const itemsByItemId = new Map([
      [1, { bought: 10, refundable: 0, retail_price_paise: 5000, display_name: "Item One" }],
      [2, { bought: 5, refundable: 5, retail_price_paise: 4500, display_name: "Item Two" }],
    ]);

    render(
      <ItemSearchInput
        onPick={() => {}}
        scope={{ kind: "linked_invoices", itemsByItemId }}
      />,
      { wrapper: createWrapper() },
    );

    const input = screen.getByPlaceholderText(/search/i);
    await user.type(input, "Item");
    await waitFor(() => expect(screen.getByText("Item One")).toBeInTheDocument());

    expect(screen.getByText(/fully refunded/i)).toBeInTheDocument();
    const itemOne = screen.getByRole("option", { name: /item one/i });
    expect(itemOne).toHaveAttribute("aria-disabled", "true");
    expect(itemOne).toBeDisabled();
  });
});
