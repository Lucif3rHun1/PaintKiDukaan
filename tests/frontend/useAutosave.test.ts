import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutosave } from "../../src/pos/hooks/useAutosave";
import type { Draft } from "../../src/domain/types";

// Mock at IPC boundary — not component level
vi.mock("../../src/pos/api", () => ({
  saveDraft: vi.fn(),
  getDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock("../../src/lib/feedback/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { saveDraft, getDraft, deleteDraft } from "../../src/pos/api";

const mockGetDraft = vi.mocked(getDraft);
const mockSaveDraft = vi.mocked(saveDraft);
const mockDeleteDraft = vi.mocked(deleteDraft);

const SAMPLE_DRAFT: Draft = {
  id: 1,
  user_id: 42,
  form_type: "purchase",
  data_json: JSON.stringify([{ item_id: 1, qty: 5 }]),
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  mockGetDraft.mockResolvedValue(null);
  mockSaveDraft.mockResolvedValue(SAMPLE_DRAFT);
  mockDeleteDraft.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutosave", () => {
  it("loads existing draft on mount", async () => {
    mockGetDraft.mockResolvedValue(SAMPLE_DRAFT);

    const { result } = renderHook(() => useAutosave("purchase", []));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.draft).toEqual(SAMPLE_DRAFT);
    expect(result.current.status).toBe("saved");
  });

  it("sets idle status when no draft exists", async () => {
    mockGetDraft.mockResolvedValue(null);

    const { result } = renderHook(() => useAutosave("purchase", []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.draft).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("does not save on initial mount", async () => {
    const { result } = renderHook(() => useAutosave("purchase", []));

    // Wait for draft load
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Empty data should never trigger save regardless of timer
    act(() => vi.advanceTimersByTime(3000));
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it("saves after debounce when data changes", async () => {
    const { result, rerender } = renderHook(
      ({ data }) => useAutosave("purchase", data),
      { initialProps: { data: [] as unknown[] } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Change data
    rerender({ data: [{ item_id: 1, qty: 5 }] });

    // Should be dirty immediately
    expect(result.current.status).toBe("dirty");

    // Not saved yet — debounce is 2s
    act(() => vi.advanceTimersByTime(1500));
    expect(mockSaveDraft).not.toHaveBeenCalled();

    // After 2s, save triggers
    act(() => vi.advanceTimersByTime(500));
    expect(mockSaveDraft).toHaveBeenCalledWith("purchase", JSON.stringify([{ item_id: 1, qty: 5 }]));

    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(result.current.draft).toEqual(SAMPLE_DRAFT);
  });

  it("does not save when data is empty", async () => {
    const { result, rerender } = renderHook(
      ({ data }) => useAutosave("purchase", data),
      { initialProps: { data: [] as unknown[] } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Change to another empty value
    rerender({ data: [] });
    act(() => vi.advanceTimersByTime(3000));
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it("cancels pending save on unmount", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ data }) => useAutosave("purchase", data),
      { initialProps: { data: [] as unknown[] } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Trigger data change → dirty
    rerender({ data: [{ item_id: 1 }] });
    expect(result.current.status).toBe("dirty");

    // Unmount before debounce fires
    unmount();

    // Advance past debounce — save should NOT have been called
    act(() => vi.advanceTimersByTime(3000));
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it("resets draft: cancels pending, deletes from DB, clears state", async () => {
    mockGetDraft.mockResolvedValue(SAMPLE_DRAFT);

    const { result } = renderHook(() => useAutosave("purchase", []));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.draft).toEqual(SAMPLE_DRAFT);
    });

    await act(async () => {
      await result.current.resetDraft();
    });

    expect(mockDeleteDraft).toHaveBeenCalledWith("purchase");
    expect(result.current.draft).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("handles getDraft failure gracefully", async () => {
    mockGetDraft.mockRejectedValue(new Error("IPC failed"));

    const { result } = renderHook(() => useAutosave("purchase", []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.draft).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("handles saveDraft failure gracefully", async () => {
    const { result, rerender } = renderHook(
      ({ data }) => useAutosave("purchase", data),
      { initialProps: { data: [] as unknown[] } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockSaveDraft.mockRejectedValue(new Error("save failed"));

    // Trigger data change
    rerender({ data: [{ item_id: 1 }] });
    expect(result.current.status).toBe("dirty");

    // Advance past debounce
    act(() => vi.advanceTimersByTime(2000));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("resets debounce timer on rapid data changes", async () => {
    const { result, rerender } = renderHook(
      ({ data }) => useAutosave("purchase", data),
      { initialProps: { data: [] as unknown[] } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // First change
    rerender({ data: [{ item_id: 1 }] });
    act(() => vi.advanceTimersByTime(1500));

    // Second change resets the timer
    rerender({ data: [{ item_id: 2 }] });
    act(() => vi.advanceTimersByTime(1500));

    // Still not saved — timer was reset
    expect(mockSaveDraft).not.toHaveBeenCalled();

    // Now advance the full 2s from last change
    act(() => vi.advanceTimersByTime(500));
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    expect(mockSaveDraft).toHaveBeenCalledWith("purchase", JSON.stringify([{ item_id: 2 }]));
  });
});
