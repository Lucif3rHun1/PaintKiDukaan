import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SplitPayment } from "../../src/pos/sales/SplitPayment";

vi.mock("../../src/lib/storage", () => ({
  getPref: () => "cash",
  setPref: vi.fn(),
}));

describe("SplitPayment balance tender button", () => {
  it("is hidden when balanceTenderAvailable is omitted or false", () => {
    const { rerender } = render(
      <SplitPayment total={1000} splits={[]} onChange={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /balance/i })).not.toBeInTheDocument();

    rerender(
      <SplitPayment
        total={1000}
        splits={[]}
        onChange={() => {}}
        balanceTenderAvailable={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /balance/i })).not.toBeInTheDocument();
  });

  it("renders when balanceTenderAvailable is true", () => {
    render(
      <SplitPayment
        total={1000}
        splits={[]}
        onChange={() => {}}
        balanceTenderAvailable
      />,
    );
    const btn = screen.getByRole("button", { name: /balance/i });
    expect(btn).toBeInTheDocument();
    expect(btn.title).toMatch(/outstanding/i);
  });
});
