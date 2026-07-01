/**
 * list-ergonomics — smoke test asserting that a hypothetical new list page
 * renders in ≤30 LOC using the public DataList API.
 *
 * This is the acceptance gate for PR-2 §"future pages use ≤30 lines".
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { DataList, type ColumnDef } from "../../src/components/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface Warranty { id: number; code: string; item_name: string; expiry: string; }

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function WarrantyListPage() {
  const cols: ColumnDef<Warranty>[] = [
    { id: "code", header: "Code", cell: (w) => <span>{w.code}</span>, sortable: true, sortField: "code" },
    { id: "item_name", header: "Item", cell: (w) => <span>{w.item_name}</span>, sortable: true, sortField: "item_name" },
    { id: "expiry", header: "Expiry", cell: (w) => <span>{w.expiry}</span>, sortable: true, sortField: "expiry_date" }];
  return <DataList<Warranty> source={{ data: [], loading: false, search: "", onSearchChange: () => undefined, page: 1, totalPages: 1 }} columns={cols} keyExtractor={(w) => w.id} searchPlaceholder="Search warranties…" />;
}

describe("list-ergonomics", () => {
  it("renders the warranty list page using only the public DataList API", () => {
    const body = WarrantyListPage.toString();
    const lines = body.split("\n").filter((l) => l.trim().length > 0).length;
    expect(lines).toBeLessThanOrEqual(30);
    render(
      <QueryClientProvider client={queryClient}>
        <WarrantyListPage />
      </QueryClientProvider>,
    );
    expect(screen.getByPlaceholderText(/search warranties/i)).toBeInTheDocument();
  });
});