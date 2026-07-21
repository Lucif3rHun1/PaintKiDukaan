import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null }),
}));
vi.mock("../lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => true }));
vi.mock("../pos/hooks", () => ({ usePageBadge: () => ({ draft: false }) }));
vi.mock("../lib/shortcuts", () => ({ useShortcut: () => undefined }));
vi.mock("../lib/shortcuts/useGlobalShortcuts", () => ({ useGlobalShortcuts: () => undefined }));
vi.mock("../lib/security/state", () => ({
  useSecurity: (selector: (state: { phase: string }) => unknown) => selector({ phase: "locked" }),
}));
vi.mock("./components/AlertBell", () => ({ AlertBell: () => null }));
vi.mock("./lib/ipc", () => ({
  ipc: {
    getSetting: vi.fn(),
    backupStatus: vi.fn(),
    listUsers: vi.fn(),
  },
}));

function renderShell() {
  return render(
    <AppShell
      activeTab="settings"
      user={{ name: "Owner", role: "owner" }}
      onNavigate={vi.fn()}
      onLock={vi.fn()}
      updater={{
        pending: { kind: "upToDate" },
        currentVersion: "0.3.2",
        check: vi.fn(),
        apply: vi.fn(),
      }}
    >
      <div>Settings content</div>
    </AppShell>,
  );
}

function expectActive(label: string) {
  expect(screen.getByRole("button", { name: label })).toHaveClass("bg-sidebar-primary");
}

describe("AppShell Settings navigation", () => {
  beforeEach(() => {
    window.location.hash = "#/settings/shop";
  });

  it("updates the active category when the hash changes within Settings", () => {
    // Given: the Settings shell starts on Shop.
    renderShell();
    expectActive("Shop");

    // When: navigation changes only the Settings category hash.
    act(() => {
      window.location.hash = "#/settings/system";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    // Then: System is highlighted without changing the active top-level tab.
    expectActive("System");
    expect(screen.getByRole("button", { name: "Shop" })).not.toHaveClass("bg-sidebar-primary");
  });

  it("highlights the category for a legacy bare item route", () => {
    // Given: the app opens a legacy Shop item hash.
    window.location.hash = "#/settings/shop-info";

    // When: the Settings shell renders.
    renderShell();

    // Then: the owning Shop category is highlighted.
    expectActive("Shop");
  });
});
