import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UpdateBanner } from "./UpdateBanner";

describe("UpdateBanner", () => {
  it("cannot be dismissed when an update is available", async () => {
    // Given: a required update is available.
    const apply = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UpdateBanner
        pending={{ kind: "updateAvailable", version: "0.3.3", notes: "Security fixes" }}
        apply={apply}
      />,
    );

    // When: the user tries Escape and a backdrop click.
    const dialog = screen.getByRole("dialog", { name: "Update required" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(dialog);

    // Then: no close affordance exists and the modal remains blocking.
    expect(screen.queryByRole("button", { name: /close|later|skip/i })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Update required" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
