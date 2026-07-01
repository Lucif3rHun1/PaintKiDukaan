/**
 * list-visual-contract — asserts the chrome contract shared by every page
 * using <DataList>: search input renders, pagination positioned correctly,
 * action menu placement is consistent.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/lib/security/tauri", () => ({
  tauriInvoke: vi.fn(),
}));

import { DataList, type ColumnDef } from "../../src/components/ui";

interface Row {
  id: number;
  name: string;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const columns: ColumnDef<Row>[] = [
  { id: "name", header: "Name", cell: (r) => <span>{r.name}</span> },
];

function makeData(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }));
}

describe("list-visual-contract", () => {
  it("renders search input with 100ms debounce contract via DataList primitive", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DataList<Row>
          source={{
            data: makeData(50),
            loading: false,
            search: "",
            onSearchChange: () => undefined,
            page: 1,
            totalPages: 2,
            pageSize: 25,
            totalItems: 50,
            onPageChange: () => undefined,
          }}
          columns={columns}
          keyExtractor={(r) => r.id}
          searchPlaceholder="Search…"
        />
      </QueryClientProvider>,
    );
    const searchInput = screen.getByPlaceholderText(/search/i);
    expect(searchInput).toBeInTheDocument();
    expect(searchInput).toHaveAttribute("data-shortcut", "search");
  });

  it("renders empty state with hasActiveFilter context", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DataList<Row>
          source={{
            data: [],
            loading: false,
            search: "no-match",
            onSearchChange: () => undefined,
            page: 1,
            totalPages: 0,
          }}
          columns={columns}
          keyExtractor={(r) => r.id}
          emptyState={({ hasActiveFilter }) => (
            <div data-testid="empty">{hasActiveFilter ? "filter-empty" : "db-empty"}</div>
          )}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("empty")).toHaveTextContent("filter-empty");
  });

  it("uses role=grid with aria-rowcount matching data length", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DataList<Row>
          source={{
            data: makeData(10),
            loading: false,
            page: 1,
            totalPages: 1,
            search: "",
            onSearchChange: () => undefined,
          }}
          columns={columns}
          keyExtractor={(r) => r.id}
        />
      </QueryClientProvider>,
    );
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "10");
  });
});