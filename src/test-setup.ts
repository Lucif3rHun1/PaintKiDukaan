import "@testing-library/jest-dom/vitest";
import { vi, beforeEach } from "vitest";

// Mock Tauri IPC bridge — every test gets a fresh mock per suite
const mockInvoke = vi.fn();

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: { invoke: mockInvoke },
  writable: true,
});

// Expose mock globally so tests can configure it
declare global {
  // eslint-disable-next-line no-var
  var __tauriInvokeMock: typeof mockInvoke;
}
globalThis.__tauriInvokeMock = mockInvoke;

// Reset mocks between tests
beforeEach(() => {
  mockInvoke.mockReset();
});

// Silence console noise in tests
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
