import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAnyFormDirty } from "../../../pos/hooks/useDirtyForm";
import { CurrencySettings, ShopInfoSettings } from "./ShopSettings";
import { ipc } from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
  },
}));
vi.mock("../../../lib/feedback/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const getSetting = vi.mocked(ipc.getSetting);
const setSetting = vi.mocked(ipc.setSetting);

describe("Shop settings state", () => {
  beforeEach(() => {
    getSetting.mockResolvedValue(null);
    setSetting.mockResolvedValue(undefined);
  });

  it("registers edits as dirty and resets after a successful sequential save", async () => {
    // Given: an unloaded Shop profile becomes ready.
    const user = userEvent.setup();
    render(<ShopInfoSettings />);
    const name = await screen.findByLabelText("Shop name");

    // When: the name changes and the form is saved.
    await user.type(name, "Paint House");
    expect(isAnyFormDirty()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Then: writes occur in key order and the saved baseline is clean.
    await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(4));
    expect(setSetting.mock.calls.map(([key]) => key)).toEqual(["shop_name", "phone", "gstin", "address"]);
    await waitFor(() => expect(isAnyFormDirty()).toBe(false));
  });

  it("rejects an invalid GSTIN before saving", async () => {
    // Given: Shop settings are loaded with no saved GSTIN.
    const user = userEvent.setup();
    render(<ShopInfoSettings />);
    const gstin = await screen.findByLabelText("GSTIN");

    // When: an invalid GSTIN is entered and Save is pressed.
    await user.type(gstin, "invalid");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Then: inline validation blocks persistence.
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid 15-character GSTIN");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("shows Default and rejects decimal precision outside 0 to 4", async () => {
    // Given: no currency setting has been persisted.
    const user = userEvent.setup();
    render(<CurrencySettings />);
    expect(await screen.findByText("Default")).toBeInTheDocument();

    // When: decimal precision is outside the supported range.
    const decimals = screen.getByLabelText("Decimal places");
    await user.clear(decimals);
    await user.type(decimals, "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Then: inline validation blocks persistence.
    expect(screen.getByRole("alert")).toHaveTextContent("Use a whole number from 0 to 4");
    expect(setSetting).not.toHaveBeenCalled();
  });
});
