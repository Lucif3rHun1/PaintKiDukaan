// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Brand, Location, Unit } from "../../../domain/types";

/* ── mocks ─────────────────────────────────────────────────────────── */

const ipcMocks = vi.hoisted(() => ({
  addLocation: vi.fn(),
  removeLocation: vi.fn(),
  listSubLocations: vi.fn(),
  createSubLocation: vi.fn(),
  deactivateSubLocation: vi.fn(),
  listCustomerTypes: vi.fn(),
  addCustomerType: vi.fn(),
  removeCustomerType: vi.fn(),
  listUnits: vi.fn(),
  createUnit: vi.fn(),
  updateUnit: vi.fn(),
  deactivateUnit: vi.fn(),
}));

const locationsApiMocks = vi.hoisted(() => ({
  listLocations: vi.fn(),
  renameLocation: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  listBrands: vi.fn(),
  createBrand: vi.fn(),
  deactivateBrand: vi.fn(),
  updateBrandCodePrefix: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../../lib/ipc", () => ({ ipc: ipcMocks }));
vi.mock("../../../domain/locations/api", () => locationsApiMocks);
vi.mock("../../../domain/items/api", () => apiMocks);
vi.mock("../../../lib/feedback/toast", () => toastMocks);

import {
  LocationsSettings,
  CustomerTypesSettings,
  CatalogUnitsSettings,
} from "./CatalogSettings";
import { BrandAdmin } from "../../../domain/items/BrandAdmin";

/* ── helpers ───────────────────────────────────────────────────────── */

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

const SAMPLE_BRANDS: Brand[] = [
  { id: 1, name: "Asian Paints", prefix: "AP", next_seq: 5 },
  { id: 2, name: "Berger", prefix: "BG", next_seq: 12 },
];

const SAMPLE_UNITS: Unit[] = [
  { id: 1, code: "KG", label: "Kilogram", dimension: "mass", is_active: true },
  { id: 2, code: "L", label: "Litre", dimension: "volume", is_active: true },
  { id: 3, code: "OLD", label: "Deprecated", dimension: "count", is_active: false },
];

const SAMPLE_LOCATIONS: Location[] = [
  { id: 1, name: "Warehouse", rack: null, zone: "Godown", is_active: true, created_at: "2025-01-01" },
  { id: 2, name: "Counter", rack: null, zone: "Shop", is_active: true, created_at: "2025-01-01" },
];

beforeEach(() => {
  locationsApiMocks.listLocations.mockReset().mockResolvedValue([]);
  locationsApiMocks.renameLocation.mockReset().mockResolvedValue(SAMPLE_LOCATIONS[0]);
  ipcMocks.addLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.removeLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.listSubLocations.mockReset().mockResolvedValue([]);
  ipcMocks.createSubLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.deactivateSubLocation.mockReset().mockResolvedValue(undefined);
  ipcMocks.listCustomerTypes.mockReset().mockResolvedValue([]);
  ipcMocks.addCustomerType.mockReset().mockResolvedValue([]);
  ipcMocks.removeCustomerType.mockReset().mockResolvedValue([]);
  ipcMocks.listUnits.mockReset().mockResolvedValue([]);
  ipcMocks.createUnit.mockReset().mockResolvedValue(SAMPLE_UNITS[0]);
  ipcMocks.updateUnit.mockReset().mockResolvedValue(SAMPLE_UNITS[0]);
  ipcMocks.deactivateUnit.mockReset().mockResolvedValue(undefined);
  apiMocks.listBrands.mockReset().mockResolvedValue([]);
  apiMocks.createBrand.mockReset().mockResolvedValue(SAMPLE_BRANDS[0]);
  apiMocks.deactivateBrand.mockReset().mockResolvedValue(undefined);
  apiMocks.updateBrandCodePrefix.mockReset().mockResolvedValue(SAMPLE_BRANDS[0]);
  toastMocks.toast.success.mockReset();
  toastMocks.toast.error.mockReset();
});

/* ── 1. Soft-delete dependency handling ────────────────────────────── */

describe("Soft-delete dependency handling", () => {
  it("location removal calls ipc.removeLocation (soft-delete)", async () => {
    locationsApiMocks.listLocations.mockResolvedValue(SAMPLE_LOCATIONS);
    ipcMocks.removeLocation.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByText("Warehouse");

    const removeButtons = screen.getAllByText("Remove");
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(ipcMocks.removeLocation).toHaveBeenCalledWith("Warehouse");
    });
    expect(toastMocks.toast.success).toHaveBeenCalledWith("Location removed");
  });

  it("unit deactivation calls deactivateUnit (not delete)", async () => {
    ipcMocks.listUnits.mockResolvedValue(SAMPLE_UNITS);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<CatalogUnitsSettings />, { wrapper });

    await screen.findByText("KG");

    const deactivateBtns = screen.getAllByRole("button", { name: "Deactivate" });
    expect(deactivateBtns[0]).not.toBeDisabled();
    await user.click(deactivateBtns[0]);

    await waitFor(() => {
      expect(ipcMocks.deactivateUnit).toHaveBeenCalledWith(1);
    });
    expect(toastMocks.toast.success).toHaveBeenCalledWith("Unit deactivated");
  });

  it("brand deactivation calls deactivateBrand (soft-delete)", async () => {
    apiMocks.listBrands.mockResolvedValue(SAMPLE_BRANDS);
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByText("Asian Paints");

    const deactivateBtns = screen.getAllByRole("button", { name: "Deactivate" });
    await user.click(deactivateBtns[0]);

    await waitFor(() => {
      expect(apiMocks.deactivateBrand).toHaveBeenCalledWith(1);
    });
    expect(toastMocks.toast.success).toHaveBeenCalledWith('Brand "Asian Paints" deactivated');
  });

  it("deactivate button is disabled for already-inactive units", async () => {
    ipcMocks.listUnits.mockResolvedValue(SAMPLE_UNITS);
    const wrapper = createWrapper();
    render(<CatalogUnitsSettings />, { wrapper });

    await screen.findByText("KG");

    const deactivateBtns = screen.getAllByRole("button", { name: "Deactivate" });
    const inactiveBtn = deactivateBtns.find((btn) => btn.closest("tr")?.textContent?.includes("OLD"));
    expect(inactiveBtn).toBeDisabled();
  });
});

/* ── 2. Validation edge cases ──────────────────────────────────────── */

describe("Validation edge cases", () => {
  it("empty location name silently does nothing", async () => {
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByPlaceholderText(/New location name/);

    const addBtn = screen.getByRole("button", { name: "Add" });
    await user.click(addBtn);

    expect(ipcMocks.addLocation).not.toHaveBeenCalled();
  });

  it("whitespace-only location name silently does nothing", async () => {
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByPlaceholderText(/New location name/);

    await user.type(screen.getByPlaceholderText(/New location name/), "   ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(ipcMocks.addLocation).not.toHaveBeenCalled();
  });

  it("empty unit code shows validation error", async () => {
    ipcMocks.listUnits.mockResolvedValue([]);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<CatalogUnitsSettings />, { wrapper });

    const codeInput = await screen.findByPlaceholderText("e.g. L");
    await user.type(codeInput, "{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Unit code is required.")).toBeInTheDocument();
    });
    expect(toastMocks.toast.error).toHaveBeenCalledWith("Unit code is required");
    expect(ipcMocks.createUnit).not.toHaveBeenCalled();
  });

  it("brand prefix rejects special characters", async () => {
    apiMocks.listBrands.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByLabelText(/Brand name/i);

    await user.type(screen.getByLabelText(/Brand name/i), "Test Brand");
    await user.type(screen.getByLabelText(/Code prefix/i), "A@#");
    await user.click(screen.getByRole("button", { name: "Add brand" }));

    await waitFor(() => {
      expect(screen.getByText("Prefix must be alphanumeric.")).toBeInTheDocument();
    });
    expect(apiMocks.createBrand).not.toHaveBeenCalled();
  });

  it("brand prefix enforces max length via HTML attribute", async () => {
    apiMocks.listBrands.mockResolvedValue([]);
    render(<BrandAdmin role="owner" />);

    await screen.findByLabelText(/Code prefix/i);

    const prefixInput = screen.getByLabelText(/Code prefix/i);
    expect(prefixInput).toHaveAttribute("maxlength", "4");
  });

  it("brand name required before add", async () => {
    apiMocks.listBrands.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByLabelText(/Brand name/i);

    await user.type(screen.getByLabelText(/Code prefix/i), "AB");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Brand name is required.")).toBeInTheDocument();
    });
    expect(apiMocks.createBrand).not.toHaveBeenCalled();
  });

  it("brand edit prefix validates empty prefix", async () => {
    apiMocks.listBrands.mockResolvedValue(SAMPLE_BRANDS);
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByText("Asian Paints");

    const editBtns = screen.getAllByRole("button", { name: "Edit prefix" });
    await user.click(editBtns[0]);

    const prefixInput = screen.getByDisplayValue("AP");
    await user.clear(prefixInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Prefix can't be blank.")).toBeInTheDocument();
    });
    expect(apiMocks.updateBrandCodePrefix).not.toHaveBeenCalled();
  });

  it("duplicate location name surfaces error from IPC", async () => {
    locationsApiMocks.listLocations.mockResolvedValue(SAMPLE_LOCATIONS);
    ipcMocks.addLocation.mockRejectedValue(new Error("duplicate name"));
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByText("Warehouse");

    await user.type(screen.getByPlaceholderText(/New location name/), "Warehouse");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(screen.getByText(/duplicate name/)).toBeInTheDocument();
    });
  });
});

/* ── 3. UI state edge cases ────────────────────────────────────────── */

describe("UI state edge cases", () => {
  it("Enter key submits location form", async () => {
    locationsApiMocks.listLocations.mockResolvedValue([]);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByPlaceholderText(/New location name/);

    await user.type(screen.getByPlaceholderText(/New location name/), "NewLoc");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(ipcMocks.addLocation).toHaveBeenCalledWith("NewLoc", null);
    });
  });

  it("Enter key submits customer type form", async () => {
    ipcMocks.listCustomerTypes.mockResolvedValue([]);
    ipcMocks.addCustomerType.mockResolvedValue(["Retailer"]);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<CustomerTypesSettings />, { wrapper });

    await screen.findByPlaceholderText("New customer type");

    await user.type(screen.getByPlaceholderText("New customer type"), "Retailer");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(ipcMocks.addCustomerType).toHaveBeenCalledWith("Retailer");
    });
  });

  it("Enter key submits unit form via code input", async () => {
    ipcMocks.listUnits.mockResolvedValue([]);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<CatalogUnitsSettings />, { wrapper });

    await screen.findByPlaceholderText("e.g. L");

    await user.type(screen.getByPlaceholderText("e.g. L"), "KG");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(ipcMocks.createUnit).toHaveBeenCalledWith("KG", "", "count");
    });
  });

  it("error state clears on new location submission", async () => {
    locationsApiMocks.listLocations.mockResolvedValue([]);
    ipcMocks.addLocation
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<LocationsSettings />, { wrapper });

    await screen.findByPlaceholderText(/New location name/);

    await user.type(screen.getByPlaceholderText(/New location name/), "Dup");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(/conflict/);

    await user.clear(screen.getByPlaceholderText(/New location name/));
    await user.type(screen.getByPlaceholderText(/New location name/), "NewLoc");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(screen.queryByText(/conflict/)).not.toBeInTheDocument();
    });
  });

  it("brand success message appears after add", async () => {
    apiMocks.listBrands.mockResolvedValue([]);
    apiMocks.createBrand.mockResolvedValue({ id: 3, name: "Nerolac", prefix: "NR", next_seq: 1 });
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByLabelText(/Brand name/i);

    await user.type(screen.getByLabelText(/Brand name/i), "Nerolac");
    await user.type(screen.getByLabelText(/Code prefix/i), "NR");
    await user.click(screen.getByRole("button", { name: "Add brand" }));

    await waitFor(() => {
      expect(screen.getByText("Brand added.")).toBeInTheDocument();
    });
    expect(toastMocks.toast.success).toHaveBeenCalledWith("Brand added");
  });

  it("brand error clears on new submission", async () => {
    apiMocks.listBrands.mockResolvedValue([]);
    apiMocks.createBrand
      .mockRejectedValueOnce(new Error("duplicate"))
      .mockResolvedValueOnce(SAMPLE_BRANDS[0]);
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByLabelText(/Brand name/i);

    await user.type(screen.getByLabelText(/Brand name/i), "Test");
    await user.type(screen.getByLabelText(/Code prefix/i), "TS");
    await user.click(screen.getByRole("button", { name: "Add brand" }));
    await screen.findByText(/duplicate/);

    await user.clear(screen.getByLabelText(/Brand name/i));
    await user.type(screen.getByLabelText(/Brand name/i), "New Brand");
    await user.clear(screen.getByLabelText(/Code prefix/i));
    await user.type(screen.getByLabelText(/Code prefix/i), "NB");
    await user.click(screen.getByRole("button", { name: "Add brand" }));

    await waitFor(() => {
      expect(screen.queryByText(/duplicate/)).not.toBeInTheDocument();
    });
  });

  it("brand deactivate button is disabled while busy", async () => {
    apiMocks.listBrands.mockResolvedValue(SAMPLE_BRANDS);
    let resolveDeactivate: () => void;
    apiMocks.deactivateBrand.mockImplementation(
      () => new Promise<void>((resolve) => { resolveDeactivate = resolve; }),
    );
    const user = userEvent.setup();
    render(<BrandAdmin role="owner" />);

    await screen.findByText("Asian Paints");

    const deactivateBtns = screen.getAllByRole("button", { name: "Deactivate" });
    await user.click(deactivateBtns[0]);

    await waitFor(() => {
      const allBtns = screen.getAllByRole("button", { name: "Deactivate" });
      allBtns.forEach((btn) => expect(btn).toBeDisabled());
    });

    resolveDeactivate!();
  });

  it("unit add button disables while saving", async () => {
    ipcMocks.listUnits.mockResolvedValue([]);
    let resolveCreate: (value: Unit) => void;
    ipcMocks.createUnit.mockImplementation(
      () => new Promise<Unit>((resolve) => { resolveCreate = resolve; }),
    );
    const user = userEvent.setup();
    const wrapper = createWrapper();
    render(<CatalogUnitsSettings />, { wrapper });

    await screen.findByPlaceholderText("e.g. L");

    await user.type(screen.getByPlaceholderText("e.g. L"), "KG");
    await user.click(screen.getByRole("button", { name: "Add unit" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add unit" })).toBeDisabled();
    });

    resolveCreate!(SAMPLE_UNITS[0]);
  });
});

/* ── 4. Role-based access ──────────────────────────────────────────── */

describe("Role-based access", () => {
  it("BrandAdmin shows full UI for owner", async () => {
    apiMocks.listBrands.mockResolvedValue(SAMPLE_BRANDS);
    render(<BrandAdmin role="owner" />);

    await screen.findByText("Asian Paints");

    expect(screen.getByLabelText(/Brand name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Code prefix/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add brand" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit prefix" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Deactivate" }).length).toBe(2);
  });

  it("BrandAdmin shows restricted message for cashier", () => {
    render(<BrandAdmin role="cashier" />);

    expect(screen.getByText(/Owners only\. Switch to an owner account/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add brand" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit prefix" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });

  it("BrandAdmin shows restricted message for stocker", () => {
    render(<BrandAdmin role="stocker" />);

    expect(screen.getByText(/Owners only\. Switch to an owner account/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add brand" })).not.toBeInTheDocument();
  });

  it("non-owner BrandAdmin does not show brand table", () => {
    render(<BrandAdmin role="cashier" />);

    expect(screen.queryByText("Configured brands")).not.toBeInTheDocument();
    expect(screen.queryByText("Asian Paints")).not.toBeInTheDocument();
  });
});
