/**
 * ItemList feature flag (PR-3) — verifies the on/off path of the DataList migration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invokeMock = vi.hoisted(() => vi.fn());

// Settable flag mock — vi.doMock uses this at runtime.
let mockFlagValue = false;
vi.mock("../../src/lib/featureFlags", () => ({
  get useDataListPrimitive() {
    return mockFlagValue;
  },
}));

vi.mock("../../src/lib/security/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
  generateCorrelationId: () => "test-corr-id",
}));

vi.mock("../../src/pos/print", () => ({
  printLabel: vi.fn(),
}));

vi.mock("../../src/barcodes/seed", () => ({
  useLabelBatchSeed: { getState: () => ({ setSeed: vi.fn() }) },
}));

vi.mock("../../src/lib/security/ipc", () => ({
  invokeIpc: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { ItemList } from "../../src/domain/items/ItemList";

const summaryMock = {
  total_active_items: 142,
  healthy_count: 100,
  low_count: 30,
  zero_count: 10,
  negative_count: 2,
  retail_value_paise: 12345600,
};

const pageMock = () => ({
  rows: Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    sku_code: `SKU${i + 1}`,
    barcode: `${i}`.padStart(8, "0"),
    name: `Item ${i + 1}`,
    brand: "TestBrand",
    brand_id: 1,
    category: "TestCat",
    sell_unit: "pcs",
    units_per_pack: 1,
    retail_price_paise: 10000,
    cost_paise: 5000,
    promo_price_paise: null,
    min_stock: 5,
    is_active: 1,
    current_qty: 10,
    primary_location_id: null,
    sub_location_id: null,
    position: null,
    label_line1: null,
    label_line2: null,
    unit_code: "pcs",
    unit_label: "pieces",
    unit: "pcs",
    barcode_format: "EAN13",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  })),
  total: 250,
});

const locationsMock = [
  { id: 1, name: "Main", is_active: 1, is_default: 1, created_at: "2024-01-01T00:00:00Z" },
];

const brandsMock = [
  { id: 1, name: "TestBrand", prefix: "TB", is_active: 1, next_seq: 1000, created_at: "2024-01-01T00:00:00Z" },
];

function setupInvokeRouter() {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "list_locations":
        return locationsMock;
      case "list_sub_locations":
        return [];
      case "list_brands":
        return brandsMock;
      case "cmd_list_items_paged":
        return pageMock();
      case "cmd_stock_health_summary":
        return summaryMock;
      case "list_items":
        return [];
      default:
        return null;
    }
  });
}

function renderItemList(flagOn: boolean) {
  mockFlagValue = flagOn;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ItemList role="owner" />
    </QueryClientProvider>,
  );
}

describe("ItemList feature flag (PR-3)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setupInvokeRouter();
    mockFlagValue = false;
  });

  it("calls cmd_stock_health_summary when flag ON and shows summary values in metric cards", async () => {
    renderItemList(true);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("cmd_stock_health_summary");
    });
    await waitFor(() => {
      expect(screen.getByText("142")).toBeDefined();
    });
  });

  it("calls cmd_list_items_paged (server source) when flag ON", async () => {
    renderItemList(true);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("cmd_list_items_paged");
    });
  });

  it("does NOT call cmd_stock_health_summary when flag OFF (legacy chrome preserved)", async () => {
    renderItemList(false);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("cmd_stock_health_summary");
    });
    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("list_items");
      expect(calls).not.toContain("cmd_list_items_paged");
    });
  });
});