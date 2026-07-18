import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { LockScreen } from "./lockScreen";
import { useSecurity } from "./state";

describe("LockScreen account switcher", () => {
  beforeEach(() => {
    useSecurity.getState().reset();
    useSecurity.getState().setPhase("locked");
    useSecurity.getState().setLoginUsers([
      { id: 1, name: "Owner", role: "owner" },
      { id: 2, name: "Asha", role: "cashier" },
    ]);
  });

  it("focuses the PIN immediately and submits it with Enter", async () => {
    globalThis.__tauriInvokeMock.mockResolvedValue({
      user: { id: 1, name: "Owner", role: "owner" },
      locked: false,
      pin_role: "real",
    });

    render(<LockScreen />);

    const pin = screen.getByLabelText("Six digit PIN");
    expect(pin).toHaveFocus();

    await userEvent.type(pin, "123456{Enter}");

    await waitFor(() => {
      expect(globalThis.__tauriInvokeMock).toHaveBeenCalledWith(
        "unlock",
        expect.objectContaining({ pin: "123456" }),
        undefined,
      );
    });
  });

  it("logs in the selected staff account when multiple users are available", async () => {
    globalThis.__tauriInvokeMock.mockResolvedValue({
      user: { id: 2, name: "Asha", role: "cashier" },
      locked: false,
      pin_role: "real",
    });

    render(<LockScreen />);

    await userEvent.selectOptions(screen.getByLabelText("Account"), "2");
    expect(screen.getByLabelText("Asha PIN")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Six digit PIN"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(globalThis.__tauriInvokeMock).toHaveBeenCalledWith(
        "login_user",
        expect.objectContaining({ name: "Asha", pin: "123456" }),
        undefined,
      );
    });
    expect(useSecurity.getState().session.user?.name).toBe("Asha");
  });
});
