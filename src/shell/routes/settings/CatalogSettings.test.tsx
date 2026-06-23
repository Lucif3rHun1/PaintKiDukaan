// @ts-nocheck
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, type Mock } from "vitest";

import { ipc } from "../../lib/ipc";
import { usePaginatedQuery } from "../../../lib/query";
import { listUnits, createUnit, updateUnit, deactivateUnit } from "../../../domain/units/api";
import { LocationsSettings, CustomerTypesSettings, CatalogUnitsSettings } from "./CatalogSettings";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    addLocation: vi.fn(),
    removeLocation: vi.fn(),
    listSubLocations: vi.fn(),
    createSubLocation: vi.fn(),
    deactivateSubLocation: vi.fn(),
    listCustomerTypes: vi.fn(),
    addCustomerType: vi.fn(),
    removeCustomerType: vi.fn(),
  },
}));

vi.mock("../../../domain/locations/api", () => ({
  listLocations: vi.fn(),
  renameLocation: vi.fn(),
}));

vi.mock("../../../domain/units/api", () => ({
  listUnits: vi.fn(),
  createUnit: vi.fn(),
  updateUnit: vi.fn(),
  deactivateUnit: vi.fn(),
}));

vi.mock("../../../lib/query", () => ({
  usePaginatedQuery: vi.fn(),
}));

vi.mock("../../../lib/feedback/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockIpc = vi.mocked(ipc);
const mockUsePaginatedQuery = usePaginatedQuery as Mock;
const mockListUnits = vi.mocked(listUnits);
const mockCreateUnit = vi.mocked(createUnit);
const mockUpdateUnit = vi.mocked(updateUnit);
const mockDeactivateUnit = vi.mocked(deactivateUnit);

const locationsApi = await import("../../../domain/locations/api");
const mockListLocations = vi.mocked(locationsApi.listLocations);
const mockRenameLocation = vi.mocked(locationsApi.renameLocation);

function mockPaginatedReturn<T>(overrides: Partial<ReturnType<typeof usePaginatedQuery<T>>> = {}) {
  return {
    data: [] as T[],
    allData: [] as T[],
    isLoading: false,
    isFetching: false,
    error: null,
    page: 1,
    setPage: vi.fn(),
    search: "",
    debouncedSearch: "",
    setSearch: vi.fn(),
    pageSize: 10,
    totalItems: 0,
    totalPages: 1,
    refetch: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockUsePaginatedQuery.mockReturnValue(mockPaginatedReturn());
  mockListLocations.mockReset();
  mockRenameLocation.mockReset();
  mockListUnits.mockReset().mockResolvedValue([]);
  mockCreateUnit.mockReset();
  mockUpdateUnit.mockReset();
  mockDeactivateUnit.mockReset();
  mockIpc.addLocation.mockReset();
  mockIpc.removeLocation.mockReset();
  mockIpc.listSubLocations.mockReset();
  mockIpc.createSubLocation.mockReset();
  mockIpc.deactivateSubLocation.mockReset();
  mockIpc.listCustomerTypes.mockReset();
  mockIpc.addCustomerType.mockReset();
  mockIpc.removeCustomerType.mockReset();
});

// ─── LocationsSettings ────────────────────────────────────────────────

describe("LocationsSettings", () => {
  beforeEach(() => {
    mockListLocations.mockResolvedValue([]);
  });

  it("renders empty state when no locations", async () => {
    render(<LocationsSettings />);
    expect(await screen.findByText("No locations configured")).toBeInTheDocument();
  });

  it("renders existing locations", async () => {
    mockListLocations.mockResolvedValue([
      { id: 1, name: "Warehouse A", rack: null, zone: null, is_active: true },
      { id: 2, name: "Store Front", rack: null, zone: null, is_active: true },
    ]);

    render(<LocationsSettings />);
    expect(await screen.findByText("Warehouse A")).toBeInTheDocument();
    expect(screen.getByText("Store Front")).toBeInTheDocument();
  });

  it("adds a location", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([]);
    mockIpc.addLocation.mockResolvedValue(undefined);

    render(<LocationsSettings />);

    await screen.findByText("No locations configured");

    const input = screen.getByPlaceholderText(/New location name/i);
    await user.type(input, "New Location");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockIpc.addLocation).toHaveBeenCalledWith("New Location", null);
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("removes a location", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([
      { id: 1, name: "Warehouse", rack: null, zone: null, is_active: true },
    ]);
    mockIpc.removeLocation.mockResolvedValue(undefined);

    render(<LocationsSettings />);

    const removeBtn = await screen.findByRole("button", { name: "Remove" });
    await user.click(removeBtn);

    expect(mockIpc.removeLocation).toHaveBeenCalledWith("Warehouse");
  });

  it("triggers add on Enter key", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([]);
    mockIpc.addLocation.mockResolvedValue(undefined);

    render(<LocationsSettings />);

    const input = screen.getByPlaceholderText(/New location name/i);
    await user.type(input, "Entered{Enter}");

    expect(mockIpc.addLocation).toHaveBeenCalledWith("Entered", null);
  });

  it("disables Add button when input is empty", async () => {
    mockListLocations.mockResolvedValue([]);
    render(<LocationsSettings />);
    await screen.findByText("No locations configured");

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("enables Add button when input has text", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([]);
    render(<LocationsSettings />);
    await screen.findByText("No locations configured");

    await user.type(screen.getByPlaceholderText(/New location name/i), "X");
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("shows error when addLocation fails", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([]);
    mockIpc.addLocation.mockRejectedValue(new Error("duplicate name"));

    render(<LocationsSettings />);
    await screen.findByText("No locations configured");

    await user.type(screen.getByPlaceholderText(/New location name/i), "Dup");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/duplicate name/)).toBeInTheDocument();
  });

  it("shows error when removeLocation fails", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([
      { id: 1, name: "Warehouse", rack: null, zone: null, is_active: true },
    ]);
    mockIpc.removeLocation.mockRejectedValue(new Error("cannot remove"));

    render(<LocationsSettings />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByText(/cannot remove/)).toBeInTheDocument();
  });

  it("trims whitespace before adding", async () => {
    const user = userEvent.setup();
    mockListLocations.mockResolvedValue([]);
    mockIpc.addLocation.mockResolvedValue(undefined);

    render(<LocationsSettings />);
    await screen.findByText("No locations configured");

    await user.type(screen.getByPlaceholderText(/New location name/i), "  Trimmed  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockIpc.addLocation).toHaveBeenCalledWith("Trimmed", null);
  });
});

// ─── CustomerTypesSettings ────────────────────────────────────────────

describe("CustomerTypesSettings", () => {
  beforeEach(() => {
    mockIpc.listCustomerTypes.mockResolvedValue([]);
  });

  it("renders empty state when no types", async () => {
    render(<CustomerTypesSettings />);
    expect(await screen.findByText("No customer types configured")).toBeInTheDocument();
  });

  it("renders existing customer types", async () => {
    mockIpc.listCustomerTypes.mockResolvedValue(["Retailer", "Wholesale"]);
    mockUsePaginatedQuery.mockReturnValue(
      mockPaginatedReturn({ data: ["Retailer", "Wholesale"], allData: ["Retailer", "Wholesale"], totalItems: 2 }),
    );

    render(<CustomerTypesSettings />);
    expect(await screen.findByText("Retailer")).toBeInTheDocument();
    expect(screen.getByText("Wholesale")).toBeInTheDocument();
  });

  it("adds a customer type", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue([]);
    mockIpc.addCustomerType.mockResolvedValue(["Corporate"]);

    render(<CustomerTypesSettings />);
    await screen.findByText("No customer types configured");

    await user.type(screen.getByPlaceholderText("New customer type"), "corporate");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockIpc.addCustomerType).toHaveBeenCalledWith("Corporate");
    await waitFor(() => expect(screen.getByPlaceholderText("New customer type")).toHaveValue(""));
  });

  it("removes a customer type", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue(["Retailer"]);
    mockIpc.removeCustomerType.mockResolvedValue([]);
    mockUsePaginatedQuery.mockReturnValue(
      mockPaginatedReturn({ data: ["Retailer"], allData: ["Retailer"], totalItems: 1 }),
    );

    render(<CustomerTypesSettings />);

    const removeBtn = await screen.findByRole("button", { name: "Remove" });
    await user.click(removeBtn);

    expect(mockIpc.removeCustomerType).toHaveBeenCalledWith("Retailer");
  });

  it("formats display label: title-case words", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue([]);
    mockIpc.addCustomerType.mockResolvedValue(["Walk In"]);

    render(<CustomerTypesSettings />);
    await screen.findByText("No customer types configured");

    await user.type(screen.getByPlaceholderText("New customer type"), "walk in");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockIpc.addCustomerType).toHaveBeenCalledWith("Walk In");
  });

  it("formats display label: preserves hyphenated words", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue([]);
    mockIpc.addCustomerType.mockResolvedValue(["Walk-In"]);

    render(<CustomerTypesSettings />);
    await screen.findByText("No customer types configured");

    await user.type(screen.getByPlaceholderText("New customer type"), "walk-in");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mockIpc.addCustomerType).toHaveBeenCalledWith("Walk-In");
  });

  it("disables Add button when input is empty", async () => {
    render(<CustomerTypesSettings />);
    await screen.findByText("No customer types configured");

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("shows error on failed add", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue([]);
    mockIpc.addCustomerType.mockRejectedValue(new Error("duplicate"));

    render(<CustomerTypesSettings />);
    await screen.findByText("No customer types configured");

    await user.type(screen.getByPlaceholderText("New customer type"), "Dup");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/duplicate/)).toBeInTheDocument();
  });

  it("shows error on failed remove", async () => {
    const user = userEvent.setup();
    mockIpc.listCustomerTypes.mockResolvedValue(["Retailer"]);
    mockIpc.removeCustomerType.mockRejectedValue(new Error("cannot remove"));
    mockUsePaginatedQuery.mockReturnValue(
      mockPaginatedReturn({ data: ["Retailer"], allData: ["Retailer"], totalItems: 1 }),
    );

    render(<CustomerTypesSettings />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByText(/cannot remove/)).toBeInTheDocument();
  });
});

// ─── CatalogUnitsSettings ─────────────────────────────────────────────

describe("CatalogUnitsSettings", () => {
  const unitA = { id: 1, code: "KG", label: "Kilogram", dimension: "mass" as const, is_active: true };
  const unitB = { id: 2, code: "L", label: "Litre", dimension: "volume" as const, is_active: true };
  const inactiveUnit = { id: 3, code: "BOX", label: "Box", dimension: "count" as const, is_active: false };

  beforeEach(() => {
    mockListUnits.mockResolvedValue([]);
  });

  it("renders empty state when no units", async () => {
    render(<CatalogUnitsSettings />);
    expect(await screen.findByText("No units configured")).toBeInTheDocument();
  });

  it("renders skeleton while loading", () => {
    mockListUnits.mockReturnValue(new Promise(() => {}));

    render(<CatalogUnitsSettings />);
    // Skeleton renders a div with role or class — we check no empty state or table appears
    expect(screen.queryByText("No units configured")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders unit rows", async () => {
    mockListUnits.mockResolvedValue([unitA, unitB]);

    render(<CatalogUnitsSettings />);

    expect(await screen.findByText("KG")).toBeInTheDocument();
    expect(screen.getByText("Kilogram")).toBeInTheDocument();
    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.getByText("Litre")).toBeInTheDocument();
  });

  it("creates a new unit", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([]);
    mockCreateUnit.mockResolvedValue({ id: 99, code: "ML", label: "Millilitre", dimension: "volume", is_active: true });

    render(<CatalogUnitsSettings />);
    await screen.findByText("No units configured");

    const codeInput = screen.getByPlaceholderText("e.g. L");
    const labelInput = screen.getByPlaceholderText("e.g. Litre");

    await user.type(codeInput, "ml");
    await user.type(labelInput, "Millilitre");
    await user.selectOptions(screen.getByDisplayValue("Count"), "volume");
    await user.click(screen.getByRole("button", { name: /add unit/i }));

    expect(mockCreateUnit).toHaveBeenCalledWith("ML", "Millilitre", "volume");
    await waitFor(() => {
      expect(codeInput).toHaveValue("");
      expect(labelInput).toHaveValue("");
    });
    await waitFor(() => expect(mockListUnits).toHaveBeenCalledTimes(2));
  });

  it("disables Add button when code is empty", async () => {
    render(<CatalogUnitsSettings />);
    await screen.findByText("No units configured");

    expect(screen.getByRole("button", { name: /add unit/i })).toBeDisabled();
  });

  it("enables Add button when code has text", async () => {
    const user = userEvent.setup();
    render(<CatalogUnitsSettings />);
    await screen.findByText("No units configured");

    await user.type(screen.getByPlaceholderText("e.g. L"), "X");
    expect(screen.getByRole("button", { name: /add unit/i })).toBeEnabled();
  });

  it("auto-uppercases code input", async () => {
    const user = userEvent.setup();
    render(<CatalogUnitsSettings />);
    await screen.findByText("No units configured");

    await user.type(screen.getByPlaceholderText("e.g. L"), "abc");
    expect(screen.getByPlaceholderText("e.g. L")).toHaveValue("ABC");
  });

  it("edits a unit inline", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([unitA]);
    mockUpdateUnit.mockResolvedValue({ id: 1, code: "KILOGRAM", label: "Kilogram", dimension: "mass", is_active: true });

    render(<CatalogUnitsSettings />);

    const editBtn = await screen.findByRole("button", { name: "Edit" });
    await user.click(editBtn);

    // Inline editing fields appear
    const codeInputs = screen.getAllByDisplayValue("KG");
    const editCodeInput = codeInputs.find((el) => el.tagName === "INPUT")!;
    await user.clear(editCodeInput);
    await user.type(editCodeInput, "kilogram");

    const saveBtn = screen.getByRole("button", { name: "Save" });
    await user.click(saveBtn);

    expect(mockUpdateUnit).toHaveBeenCalledWith(1, "KILOGRAM", "Kilogram", "mass");
    await waitFor(() => expect(mockListUnits).toHaveBeenCalledTimes(2));
  });

  it("cancel edit reverts changes", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([unitA]);

    render(<CatalogUnitsSettings />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(mockUpdateUnit).not.toHaveBeenCalled();
  });

  it("deactivates a unit", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([unitA]);
    mockDeactivateUnit.mockResolvedValue(undefined);

    render(<CatalogUnitsSettings />);

    const deactivateBtn = await screen.findByRole("button", { name: "Deactivate" });
    await user.click(deactivateBtn);

    expect(mockDeactivateUnit).toHaveBeenCalledWith(1);
    await waitFor(() => expect(mockListUnits).toHaveBeenCalledTimes(2));
  });

  it("disables Deactivate button for already-inactive units", async () => {
    mockListUnits.mockResolvedValue([inactiveUnit]);

    render(<CatalogUnitsSettings />);

    const deactivateBtn = await screen.findByRole("button", { name: "Deactivate" });
    expect(deactivateBtn).toBeDisabled();
  });

  it("filters units by search", async () => {
    const user = userEvent.setup();
    const setSearch = vi.fn();
    mockUsePaginatedQuery.mockReturnValue(
      mockPaginatedReturn({
        data: [unitA],
        allData: [unitA],
        totalItems: 1,
        search: "",
        setSearch,
      }),
    );

    render(<CatalogUnitsSettings />);

    await user.type(screen.getByPlaceholderText("Search units…"), "K");
    expect(setSearch).toHaveBeenCalledWith("K");
  });

  it("shows no-matching-units state when search has no results", async () => {
    mockUsePaginatedQuery.mockReturnValue(
      mockPaginatedReturn({
        data: [],
        allData: [unitA, unitB],
        totalItems: 2,
        search: "zzz",
      }),
    );

    render(<CatalogUnitsSettings />);
    expect(await screen.findByText("No matching units")).toBeInTheDocument();
  });

  it("shows error on failed create", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([]);
    mockCreateUnit.mockRejectedValue(new Error("duplicate code"));

    render(<CatalogUnitsSettings />);
    await screen.findByText("No units configured");

    await user.type(screen.getByPlaceholderText("e.g. L"), "dup");
    await user.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByText(/duplicate code/)).toBeInTheDocument();
  });

  it("shows error on failed update", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([unitA]);
    mockUpdateUnit.mockRejectedValue(new Error("conflict"));

    render(<CatalogUnitsSettings />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  });

  it("shows error on failed deactivate", async () => {
    const user = userEvent.setup();
    mockListUnits.mockResolvedValue([unitA]);
    mockDeactivateUnit.mockRejectedValue(new Error("cannot deactivate"));

    render(<CatalogUnitsSettings />);

    await user.click(await screen.findByRole("button", { name: "Deactivate" }));

    expect(await screen.findByText(/cannot deactivate/)).toBeInTheDocument();
  });
});
