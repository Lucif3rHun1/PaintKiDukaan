import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMocks = vi.hoisted(() => ({
  getPurchase: vi.fn(),
}));

vi.mock("../../src/pos/api", () => apiMocks);
vi.mock("../../src/lib/feedback/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { InwardDetailPage } from "../../src/pos/purchases/InwardDetailPage";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

const SAMPLE_PURCHASE = {
  id: 42,
  vendor_id: 1,
  vendor_name: "Acme Paints",
  date: "2025-01-15",
  total: 500000,
  user_id: 1,
  notes: null,
  items: [
    {
      item_id: 100,
      item_name: "Premium White",
      qty: 10,
      unit_price_paise: 50000,
      location_id: 1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getPurchase.mockResolvedValue(SAMPLE_PURCHASE);
});

describe("InwardDetailPage", () => {
  it("renders loading state initially", () => {
    apiMocks.getPurchase.mockReturnValue(new Promise(() => {}));
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    expect(screen.getByText(/loading inward/i)).toBeInTheDocument();
  });

  it("renders purchase header with id after data loads", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText(/Inward #42/i)).toBeInTheDocument();
    });
  });

  it("renders item name in the items table", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText("Premium White")).toBeInTheDocument();
    });
  });

  it("renders item quantity from purchase items", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText("10")).toBeInTheDocument();
    });
  });

  it("renders unit price formatted as INR (bug fix verification)", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(apiMocks.getPurchase).toHaveBeenCalledWith(42);
    });
    await waitFor(() => {
      expect(screen.getByText("Premium White")).toBeInTheDocument();
    });
    expect(screen.getByText(/₹500/)).toBeInTheDocument();
  });

  it("renders Items section heading", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText(/^Items$/i)).toBeInTheDocument();
    });
  });

  it("renders Back button accessible", async () => {
    render(<InwardDetailPage id={42} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      const backBtns = screen.getAllByRole("button", { name: /Inward|Back/i });
      expect(backBtns.length).toBeGreaterThan(0);
    });
  });

  it("renders error state when purchase not found", async () => {
    apiMocks.getPurchase.mockResolvedValue(null);
    render(<InwardDetailPage id={999} onBack={() => {}} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText(/Inward not found/i)).toBeInTheDocument();
    });
  });

  it("calls onBack when Back button is clicked", async () => {
    const onBack = vi.fn();
    render(<InwardDetailPage id={42} onBack={onBack} />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText("Premium White")).toBeInTheDocument();
    });
    const backBtn = screen.getAllByRole("button")[0];
    backBtn.click();
    expect(onBack).toHaveBeenCalled();
  });
});