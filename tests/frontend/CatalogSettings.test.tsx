import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ipcMocks = vi.hoisted(() => ({
  addLocation: vi.fn(),
  removeLocation: vi.fn(),
  listSubLocations: vi.fn(),
  createSubLocation: vi.fn(),
  deactivateSubLocation: vi.fn(),
  listCustomerTypes: vi.fn(),
  addCustomerType: vi.fn(),
  removeCustomerType: vi.fn(),
}));

const unitsApiMocks = vi.hoisted(() => ({
  listUnits: vi.fn(),
  createUnit: vi.fn(),
  deactivateUnit: vi.fn(),
}));

const locationsApiMocks = vi.hoisted(() => ({
  listLocations: vi.fn(),
  renameLocation: vi.fn(),
}));

vi.mock("../../src/shell/lib/ipc", () => ({ ipc: ipcMocks }));
vi.mock("../../src/domain/locations/api", () => locationsApiMocks);
vi.mock("../../src/domain/units/api", () => unitsApiMocks);
vi.mock("../../src/lib/feedback/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const tauriInvokeMock = vi.fn();
vi.mock("../../src/lib/security/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => tauriInvokeMock(...args),
}));

import {
  LocationsSettings,
  CustomerTypesSettings,
  CatalogUnitsSettings,
} from "../../src/shell/routes/settings/CatalogSettings";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

const SAMPLE_LOCATIONS = [
  { id: 1, name: "Warehouse", rack: null, zone: "Godown", is_active: true, created_at: "2025-01-01" },
];

const SAMPLE_UNITS = [
  { id: 1, code: "KG", label: "Kilogram", dimension: "mass" as const, is_active: true },
];

beforeEach(() => {
  tauriInvokeMock.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "list_locations") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  locationsApiMocks.listLocations.mockReset().mockResolvedValue([]);
  ipcMocks.addLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.removeLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.listSubLocations.mockReset().mockResolvedValue([]);
  ipcMocks.createSubLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.deactivateSubLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.listCustomerTypes.mockReset().mockResolvedValue([]);
  ipcMocks.addCustomerType.mockReset().mockResolvedValue([]);
  ipcMocks.removeCustomerType.mockReset().mockResolvedValue([]);
  unitsApiMocks.listUnits.mockReset().mockResolvedValue([]);
  unitsApiMocks.createUnit.mockReset().mockResolvedValue(SAMPLE_UNITS[0]);
  unitsApiMocks.deactivateUnit.mockReset().mockResolvedValue(undefined);
});

describe("LocationsSettings", () => {
  it("renders empty state", async () => {
    render(<LocationsSettings />, { wrapper: createWrapper() });
    expect(await screen.findByText("No locations configured")).toBeInTheDocument();
  });

  it("adds a location", async () => {
    const user = userEvent.setup();
    render(<LocationsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No locations configured");

    const input = screen.getByPlaceholderText(/New location name/i);
    await user.type(input, "New Location");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(ipcMocks.addLocation).toHaveBeenCalledWith("New Location");
    });
  });

  it("removes a location", async () => {
    const user = userEvent.setup();
    tauriInvokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_locations") return Promise.resolve(SAMPLE_LOCATIONS);
      return Promise.resolve(undefined);
    });
    render(<LocationsSettings />, { wrapper: createWrapper() });

    await screen.findByText("Warehouse");
    await user.click(screen.getByRole("button", { name: "Remove Warehouse" }));

    await waitFor(() => {
      expect(ipcMocks.removeLocation).toHaveBeenCalledWith("Warehouse");
    });
  });

  it("disables Add when input empty", async () => {
    render(<LocationsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No locations configured");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("shows error on duplicate", async () => {
    const user = userEvent.setup();
    ipcMocks.addLocation.mockRejectedValue(new Error("duplicate name"));
    render(<LocationsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No locations configured");

    await user.type(screen.getByPlaceholderText(/New location name/i), "Dup");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/duplicate name/)).toBeInTheDocument();
  });
});

describe("CustomerTypesSettings", () => {
  it("renders empty state", async () => {
    render(<CustomerTypesSettings />, { wrapper: createWrapper() });
    expect(await screen.findByText("No customer types configured")).toBeInTheDocument();
  });

  it("adds a customer type", async () => {
    const user = userEvent.setup();
    ipcMocks.addCustomerType.mockResolvedValue(["Retailer"]);
    render(<CustomerTypesSettings />, { wrapper: createWrapper() });
    await screen.findByText("No customer types configured");

    await user.type(screen.getByPlaceholderText("New customer type"), "Retailer");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(ipcMocks.addCustomerType).toHaveBeenCalledWith("Retailer");
    });
  });

  it("disables Add when empty", async () => {
    render(<CustomerTypesSettings />, { wrapper: createWrapper() });
    await screen.findByText("No customer types configured");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});

describe("CatalogUnitsSettings", () => {
  it("renders empty state", async () => {
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    expect(await screen.findByText("No units configured")).toBeInTheDocument();
  });

  it("renders unit rows", async () => {
    unitsApiMocks.listUnits.mockResolvedValue(SAMPLE_UNITS);
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    expect(await screen.findByText("KG")).toBeInTheDocument();
    expect(screen.getByText("Kilogram")).toBeInTheDocument();
  });

  it("creates a unit via the gated form", async () => {
    const user = userEvent.setup();
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No units configured");

    await user.click(screen.getByRole("button", { name: "Add Unit" }));

    const codeInput = screen.getByPlaceholderText("e.g. L, KG");
    const labelInput = screen.getByPlaceholderText("e.g. Liter, Kilogram");
    await user.type(codeInput, "ML");
    await user.type(labelInput, "Millilitre");
    await user.click(screen.getByRole("button", { name: "Create Unit" }));

    await waitFor(() => {
      expect(unitsApiMocks.createUnit).toHaveBeenCalledWith("ML", "Millilitre", "count");
    });
  });

  it("auto-uppercases code", async () => {
    const user = userEvent.setup();
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No units configured");
    await user.click(screen.getByRole("button", { name: "Add Unit" }));

    const codeInput = screen.getByPlaceholderText("e.g. L, KG");
    await user.type(codeInput, "abc");
    expect(codeInput).toHaveValue("ABC");
  });

  it("deactivates a unit", async () => {
    const user = userEvent.setup();
    unitsApiMocks.listUnits.mockResolvedValue(SAMPLE_UNITS);
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    await screen.findByText("KG");

    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => {
      expect(unitsApiMocks.deactivateUnit).toHaveBeenCalledWith(1);
    });
  });

  it("disables Create when fields empty", async () => {
    render(<CatalogUnitsSettings />, { wrapper: createWrapper() });
    await screen.findByText("No units configured");
    await userEvent.click(screen.getByRole("button", { name: "Add Unit" }));
    expect(screen.getByRole("button", { name: "Create Unit" })).toBeDisabled();
  });
});