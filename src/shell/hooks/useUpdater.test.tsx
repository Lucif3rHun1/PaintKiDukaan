import { act, renderHook, waitFor } from "@testing-library/react";
import { getVersion } from "@tauri-apps/api/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as updaterIpc from "@/shell/lib/ipc";
import { useUpdater } from "./useUpdater";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.3.2"),
}));
vi.mock("@/shell/lib/ipc", () => ({
  cmdQuitApp: vi.fn(),
  cmdUpdateApply: vi.fn(),
  cmdUpdateCheck: vi.fn(),
}));
vi.mock("@/lib/feedback/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("useUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVersion).mockResolvedValue("0.3.2");
    vi.mocked(updaterIpc.cmdUpdateCheck).mockResolvedValue({ kind: "upToDate" });
    vi.mocked(updaterIpc.cmdUpdateApply).mockResolvedValue(undefined);
    vi.mocked(updaterIpc.cmdQuitApp).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks once when the unlocked flow becomes enabled", async () => {
    // Given: the updater hook mounts while the app is locked.
    const { result, rerender } = renderHook(({ enabled }) => useUpdater(enabled), {
      initialProps: { enabled: false },
    });
    expect(updaterIpc.cmdUpdateCheck).not.toHaveBeenCalled();

    // When: the app unlocks and then re-renders again.
    rerender({ enabled: true });
    rerender({ enabled: true });

    // Then: one update check runs and the installed version is exposed.
    await waitFor(() => expect(updaterIpc.cmdUpdateCheck).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.currentVersion).toBe("0.3.2"));
  });

  it("applies the pending update before requesting graceful shutdown", async () => {
    // Given: an available update is loaded into the hook.
    vi.mocked(updaterIpc.cmdUpdateCheck).mockResolvedValue({
      kind: "updateAvailable",
      version: "0.3.3",
      notes: null,
    });
    const { result } = renderHook(() => useUpdater(true));
    await waitFor(() => expect(result.current.pending.kind).toBe("updateAvailable"));

    // When: the required restart action is used.
    await act(() => result.current.apply());

    // Then: the update is prepared before the app follows its shutdown choke-point.
    expect(updaterIpc.cmdUpdateApply).toHaveBeenCalledTimes(1);
    expect(updaterIpc.cmdQuitApp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updaterIpc.cmdUpdateApply).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(updaterIpc.cmdQuitApp).mock.invocationCallOrder[0],
    );
  });

  it("does not overwrite updateAvailable with checkFailed when a manual recheck fails", async () => {
    // Given: the automatic check has established that an update is required.
    const checkSpy = vi.spyOn(updaterIpc, "cmdUpdateCheck")
      .mockResolvedValueOnce({ kind: "updateAvailable", version: "0.3.3", notes: null })
      .mockRejectedValueOnce(new Error("network unavailable"));
    const { result } = renderHook(() => useUpdater(true));
    await waitFor(() => expect(result.current.pending.kind).toBe("updateAvailable"));

    // When: a manual recheck fails.
    await act(() => result.current.check());

    // Then: the known required update remains blocking.
    expect(result.current.pending).toEqual({ kind: "updateAvailable", version: "0.3.3", notes: null });
    checkSpy.mockRestore();
  });

  it("does not overwrite checkFailed with upToDate", async () => {
    // Given: the automatic check failed.
    const checkSpy = vi.spyOn(updaterIpc, "cmdUpdateCheck")
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ kind: "upToDate" });
    const { result } = renderHook(() => useUpdater(true));
    await waitFor(() => expect(result.current.pending.kind).toBe("checkFailed"));

    // When: a later check reports no available update.
    await act(() => result.current.check());

    // Then: the unresolved failure remains visible.
    expect(result.current.pending).toEqual({ kind: "checkFailed", reason: "network unavailable" });
    checkSpy.mockRestore();
  });
});
