import { beforeEach, describe, expect, it, vi } from "vitest";

const quitMocks = vi.hoisted(() => ({
  close: vi.fn(),
  isAnyFormDirty: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: quitMocks.close }),
}));

vi.mock("./pos/hooks", () => ({
  isAnyFormDirty: quitMocks.isAnyFormDirty,
}));

import { requestGracefulQuit } from "./App";

describe("requestGracefulQuit", () => {
  beforeEach(() => {
    quitMocks.close.mockReset().mockResolvedValue(undefined);
    quitMocks.isAnyFormDirty.mockReset();
  });

  it("requests confirmation instead of closing when a form is dirty", () => {
    const requestConfirmation = vi.fn();
    quitMocks.isAnyFormDirty.mockReturnValue(true);

    requestGracefulQuit(requestConfirmation);

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(quitMocks.close).not.toHaveBeenCalled();
  });

  it("closes immediately when no form is dirty", () => {
    const requestConfirmation = vi.fn();
    quitMocks.isAnyFormDirty.mockReturnValue(false);

    requestGracefulQuit(requestConfirmation);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(quitMocks.close).toHaveBeenCalledOnce();
  });
});
