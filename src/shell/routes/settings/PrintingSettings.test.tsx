// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabelSettings, ReceiptSettings, ScannerSettings } from "./PrintingSettings";

/* ── mocks ─────────────────────────────────────────────────────────── */

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    discoverSystemPrinters: vi.fn(),
  },
}));

vi.mock("../../../lib/feedback/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { ipc } from "../../lib/ipc";
import { toast } from "../../../lib/feedback/toast";

const mockedIpc = vi.mocked(ipc);
const mockedToast = vi.mocked(toast);

/* ── helpers ───────────────────────────────────────────────────────── */

const SAMPLE_PRINTERS = [
  {
    id: "p1",
    name: "Counter Thermal",
    connection_type: "usb" as const,
    address: "",
    is_default: true,
  },
  {
    id: "p2",
    name: "Office Laser",
    connection_type: "network" as const,
    address: "192.168.1.50:9100",
    is_default: false,
  },
];

function mockGetSetting(overrides: Record<string, string | null> = {}) {
  const defaults: Record<string, string | null> = {
    receipt_template: JSON.stringify({ label_line1: "", label_line2: "" }),
    label_printer_name: "",
    label_size: "50x25",
    printers: "[]",
    receipt_printer_name: "",
    receipt_paper_size: "thermal-80mm",
    scanner_min_length: "6",
    scanner_avg_ms_per_char: "30",
  };
  const merged = { ...defaults, ...overrides };
  mockedIpc.getSetting.mockImplementation(async (key: string) =>
    merged[key] ?? null,
  );
  mockedIpc.setSetting.mockResolvedValue(undefined);
  mockedIpc.discoverSystemPrinters.mockResolvedValue([]);
}

/** Set a field value via fireEvent.change (avoids userEvent curly-brace parsing). */
function setInputValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/* ── LabelSettings ─────────────────────────────────────────────────── */

describe("LabelSettings", () => {
  beforeEach(() => {
    mockGetSetting();
  });

  it("shows loading state initially (form inputs absent)", () => {
    mockedIpc.getSetting.mockImplementation(() => new Promise(() => {}));
    render(<LabelSettings />);
    expect(screen.queryByPlaceholderText("e.g. {shop_name}")).not.toBeInTheDocument();
  });

  it("renders form after settings load", async () => {
    render(<LabelSettings />);
    await screen.findByPlaceholderText("e.g. {shop_name}");
    expect(screen.getByPlaceholderText("e.g. {brand} {name}")).toBeInTheDocument();
    expect(screen.getByLabelText(/Label stock size/i)).toBeInTheDocument();
  });

  it("populates inputs from saved settings", async () => {
    mockGetSetting({
      receipt_template: JSON.stringify({
        label_line1: "{shop_name}",
        label_line2: "{brand} {name}",
      }),
      label_size: "50x50",
    });
    render(<LabelSettings />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. {shop_name}")).toHaveValue("{shop_name}");
      expect(screen.getByPlaceholderText("e.g. {brand} {name}")).toHaveValue("{brand} {name}");
    });
  });

  it("pre-selects printer by name from settings", async () => {
    mockGetSetting({
      printers: JSON.stringify(SAMPLE_PRINTERS),
      label_printer_name: "Office Laser",
    });
    render(<LabelSettings />);
    await waitFor(() => {
      const printerSelect = screen.getAllByRole("combobox")[0];
      expect(printerSelect).toHaveValue("p2");
    });
  });

  it("saves label settings via IPC on Save click", async () => {
    const user = userEvent.setup();
    render(<LabelSettings />);
    await screen.findByPlaceholderText("e.g. {shop_name}");

    const line1Input = screen.getByPlaceholderText("e.g. {shop_name}");
    setInputValue(line1Input, "{shop_name}");

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedIpc.setSetting).toHaveBeenCalledWith(
        "receipt_template",
        expect.stringContaining("{shop_name}"),
      );
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("label_printer_name", "");
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("label_size", "50x25");
    });
    expect(mockedToast.success).toHaveBeenCalledWith("Label settings saved");
  });

  it("shows error toast when save fails", async () => {
    mockedIpc.setSetting.mockRejectedValue(new Error("disk full"));
    const user = userEvent.setup();
    render(<LabelSettings />);
    await screen.findByPlaceholderText("e.g. {shop_name}");

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith("Failed to save", expect.any(String));
    });
  });

  it("handles corrupt receipt_template JSON gracefully", async () => {
    mockGetSetting({ receipt_template: "not-json{{{" });
    render(<LabelSettings />);
    await screen.findByPlaceholderText("e.g. {shop_name}");
    expect(screen.getByPlaceholderText("e.g. {shop_name}")).toHaveValue("");
    expect(screen.getByPlaceholderText("e.g. {brand} {name}")).toHaveValue("");
  });

  it("handles corrupt printers JSON gracefully", async () => {
    mockGetSetting({ printers: "}}}bad" });
    render(<LabelSettings />);
    await screen.findByPlaceholderText("e.g. {shop_name}");
    expect(screen.getAllByText(/No printers configured/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows printer list when printers are loaded", async () => {
    mockGetSetting({ printers: JSON.stringify(SAMPLE_PRINTERS) });
    render(<LabelSettings />);
    await screen.findByText("Counter Thermal");
    expect(screen.getAllByText("Office Laser").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  /* ── PrinterManager (rendered inside LabelSettings) ──────────── */

  describe("PrinterManager", () => {
    it("shows empty state when no printers configured", async () => {
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");
      expect(screen.getAllByText(/No printers configured/).length).toBeGreaterThanOrEqual(1);
    });

    it("adds a printer manually", async () => {
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.type(
        screen.getByPlaceholderText("e.g., Counter Thermal"),
        "Test Thermal",
      );
      await user.click(screen.getByRole("button", { name: "Add printer" }));

      await waitFor(() => {
        expect(screen.getAllByText("Test Thermal").length).toBeGreaterThanOrEqual(1);
      });
      expect(mockedToast.success).toHaveBeenCalledWith('Printer "Test Thermal" added');
    });

    it("rejects empty printer name with toast", async () => {
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(screen.getByRole("button", { name: "Add printer" }));

      expect(mockedToast.error).toHaveBeenCalledWith("Printer name is required");
    });

    it("rejects whitespace-only printer name", async () => {
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.type(screen.getByPlaceholderText("e.g., Counter Thermal"), "   ");
      await user.click(screen.getByRole("button", { name: "Add printer" }));

      expect(mockedToast.error).toHaveBeenCalledWith("Printer name is required");
    });

    it("removes a printer and shows toast", async () => {
      mockGetSetting({ printers: JSON.stringify(SAMPLE_PRINTERS) });
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByText("Counter Thermal");

      const deleteBtns = screen.getAllByTitle("Delete printer");
      await user.click(deleteBtns[0]);

      await waitFor(() => {
        expect(screen.queryAllByText("Counter Thermal").length).toBe(0);
      });
      expect(mockedToast.success).toHaveBeenCalledWith('Printer "Counter Thermal" removed');
    });

    it("toggles default status", async () => {
      mockGetSetting({ printers: JSON.stringify(SAMPLE_PRINTERS) });
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByText("Counter Thermal");

      const starBtns = screen.getAllByText("★");
      await user.click(starBtns[0]);

      await waitFor(() => {
        expect(screen.queryByText("★")).not.toBeInTheDocument();
      });
    });

    it("clears selected printer when it is removed", async () => {
      mockGetSetting({
        printers: JSON.stringify(SAMPLE_PRINTERS),
        label_printer_name: "Counter Thermal",
      });
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByText("Counter Thermal");

      await waitFor(() => {
        expect(screen.getAllByRole("combobox")[0]).toHaveValue("p1");
      });

      const deleteBtns = screen.getAllByTitle("Delete printer");
      await user.click(deleteBtns[0]);

      await waitFor(() => {
        expect(screen.getAllByRole("combobox")[0]).toHaveValue("");
      });
    });

    it("persists printers to IPC after add", async () => {
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.type(
        screen.getByPlaceholderText("e.g., Counter Thermal"),
        "LAN Printer",
      );
      await user.click(screen.getByRole("button", { name: "Add printer" }));

      await waitFor(() => {
        expect(mockedIpc.setSetting).toHaveBeenCalledWith(
          "printers",
          expect.stringContaining("LAN Printer"),
        );
      });
    });

    it("disables address input for USB connection type", async () => {
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      expect(screen.getByPlaceholderText("Not required for USB")).toBeDisabled();
    });

    /* ── Auto-discover ─────────────────────────────────────────── */

    it("discovers printers via IPC and shows results", async () => {
      mockedIpc.discoverSystemPrinters.mockResolvedValue([
        {
          name: "HP LaserJet",
          driver_name: "HP Universal",
          port_name: "USB001",
          connection_type: "usb",
        },
        {
          name: "Epson TM-T88",
          driver_name: "Epson ESC/POS",
          port_name: "COM3",
          connection_type: "serial",
        },
      ]);
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );

      await waitFor(() => {
        expect(screen.getAllByText("HP LaserJet").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Epson TM-T88").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText(/Found 2 printers/)).toBeInTheDocument();
      });
      expect(mockedToast.success).toHaveBeenCalledWith("Printer discovery complete");
    });

    it("adds a discovered printer", async () => {
      mockedIpc.discoverSystemPrinters.mockResolvedValue([
        {
          name: "HP LaserJet",
          driver_name: "HP Universal",
          port_name: "USB001",
          connection_type: "usb",
        },
      ]);
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );
      await screen.findByText("HP LaserJet");

      const addBtns = screen.getAllByRole("button", { name: "Add" });
      await user.click(addBtns[0]);

      await waitFor(() => {
        expect(screen.getAllByText("Added").length).toBeGreaterThanOrEqual(1);
      });
      expect(mockedToast.success).toHaveBeenCalledWith('Printer "HP LaserJet" added');
    });

    it("marks already-configured discovered printers as Added", async () => {
      mockGetSetting({
        printers: JSON.stringify([
          {
            id: "p1",
            name: "HP LaserJet",
            connection_type: "usb",
            address: "",
            is_default: false,
          },
        ]),
      });
      mockedIpc.discoverSystemPrinters.mockResolvedValue([
        {
          name: "HP LaserJet",
          driver_name: "HP Universal",
          port_name: "USB001",
          connection_type: "usb",
        },
      ]);
      const user = userEvent.setup();
      render(<LabelSettings />);
      (await screen.findAllByText("HP LaserJet")).length;

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );

      await waitFor(() => {
        expect(screen.getByText(/Found 1 printer/)).toBeInTheDocument();
      });
      const addedBtns = screen.getAllByText("Added");
      expect(addedBtns.some((btn) => (btn as HTMLButtonElement).disabled)).toBe(true);
    });

    it("shows error toast on discover failure", async () => {
      mockedIpc.discoverSystemPrinters.mockRejectedValue(
        new Error("no cups"),
      );
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );

      await waitFor(() => {
        expect(
          screen.getByText(/Auto-discovery not available on this platform/),
        ).toBeInTheDocument();
      });
      expect(mockedToast.error).toHaveBeenCalledWith(
        "Auto-discovery not available on this platform",
        expect.any(String),
      );
    });

    it("shows 'no printers found' when discover returns empty", async () => {
      mockedIpc.discoverSystemPrinters.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );

      await waitFor(() => {
        expect(
          screen.getByText(/No printers found\. Add one manually below/),
        ).toBeInTheDocument();
      });
    });

    it("maps unknown connection type to usb for discovered printers", async () => {
      mockedIpc.discoverSystemPrinters.mockResolvedValue([
        {
          name: "Mystery Printer",
          driver_name: null,
          port_name: null,
          connection_type: "unknown_type",
        },
      ]);
      const user = userEvent.setup();
      render(<LabelSettings />);
      await screen.findByPlaceholderText("e.g. {shop_name}");

      await user.click(
        screen.getByRole("button", { name: "Auto-discover printers" }),
      );
      await screen.findByText("Mystery Printer");

      const addBtns = screen.getAllByRole("button", { name: "Add" });
      await user.click(addBtns[0]);

      await waitFor(() => {
        expect(mockedIpc.setSetting).toHaveBeenCalledWith(
          "printers",
          expect.stringContaining('"usb"'),
        );
      });
    });
  });
});

/* ── ReceiptSettings ───────────────────────────────────────────────── */

describe("ReceiptSettings", () => {
  beforeEach(() => {
    mockGetSetting();
  });

  it("shows loading state initially", () => {
    mockedIpc.getSetting.mockImplementation(() => new Promise(() => {}));
    render(<ReceiptSettings />);
    expect(screen.queryByPlaceholderText("Paint Ki Dukaan")).not.toBeInTheDocument();
  });

  it("renders form after settings load", async () => {
    render(<ReceiptSettings />);
    await screen.findByPlaceholderText("Paint Ki Dukaan");
    expect(screen.getByPlaceholderText("Thank you for your purchase!")).toBeInTheDocument();
    expect(screen.getByLabelText(/Terms & conditions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Paper size/i)).toBeInTheDocument();
  });

  it("populates inputs from saved receipt template", async () => {
    mockGetSetting({
      receipt_template: JSON.stringify({
        receipt_header: "My Paint Shop",
        receipt_footer: "Come again!",
        receipt_terms: "No refunds.",
      }),
    });
    render(<ReceiptSettings />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Paint Ki Dukaan")).toHaveValue("My Paint Shop");
      expect(screen.getByPlaceholderText("Thank you for your purchase!")).toHaveValue("Come again!");
      expect(screen.getByLabelText(/Terms & conditions/i)).toHaveValue("No refunds.");
    });
  });

  it("loads paper size setting", async () => {
    mockGetSetting({ receipt_paper_size: "A4" });
    render(<ReceiptSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Paper size/i)).toHaveValue("A4");
    });
  });

  it("pre-selects receipt printer by name", async () => {
    mockGetSetting({
      printers: JSON.stringify(SAMPLE_PRINTERS),
      receipt_printer_name: "Counter Thermal",
    });
    render(<ReceiptSettings />);
    await waitFor(() => {
      expect(screen.getAllByRole("combobox")[0]).toHaveValue("p1");
    });
  });

  it("saves receipt settings via IPC", async () => {
    const user = userEvent.setup();
    render(<ReceiptSettings />);
    await screen.findByPlaceholderText("Paint Ki Dukaan");

    setInputValue(screen.getByPlaceholderText("Paint Ki Dukaan"), "My Shop");
    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedIpc.setSetting).toHaveBeenCalledWith(
        "receipt_template",
        expect.stringContaining("My Shop"),
      );
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("receipt_printer_name", "");
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("receipt_paper_size", "thermal-80mm");
    });
    expect(mockedToast.success).toHaveBeenCalledWith("Receipt settings saved");
  });

  it("saves receipt template with current field values", async () => {
    mockedIpc.getSetting.mockImplementation(async (key: string) => {
      if (key === "receipt_template") return JSON.stringify({ receipt_header: "Old" });
      if (key === "receipt_printer_name") return "";
      if (key === "receipt_paper_size") return "thermal-80mm";
      if (key === "printers") return "[]";
      return null;
    });
    const user = userEvent.setup();
    render(<ReceiptSettings />);
    await screen.findByPlaceholderText("Paint Ki Dukaan");

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("receipt_template", expect.any(String));
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("receipt_printer_name", "");
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("receipt_paper_size", "thermal-80mm");
    });
    expect(mockedToast.success).toHaveBeenCalledWith("Receipt settings saved");
  });

  it("shows error toast on save failure", async () => {
    mockedIpc.setSetting.mockRejectedValue(new Error("db locked"));
    const user = userEvent.setup();
    render(<ReceiptSettings />);
    await screen.findByPlaceholderText("Paint Ki Dukaan");

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith("Failed to save", expect.any(String));
    });
  });

  it("handles corrupt receipt_template JSON gracefully", async () => {
    mockGetSetting({ receipt_template: "bad{{json" });
    render(<ReceiptSettings />);
    await screen.findByPlaceholderText("Paint Ki Dukaan");
    expect(screen.getByPlaceholderText("Paint Ki Dukaan")).toHaveValue("");
    expect(screen.getByPlaceholderText("Thank you for your purchase!")).toHaveValue("");
  });

  it("renders printer list", async () => {
    mockGetSetting({ printers: JSON.stringify(SAMPLE_PRINTERS) });
    render(<ReceiptSettings />);
    await screen.findByText("Counter Thermal");
    expect(screen.getAllByText("Office Laser").length).toBeGreaterThanOrEqual(1);
  });

  it("includes all paper size options", async () => {
    render(<ReceiptSettings />);
    await screen.findByLabelText(/Paper size/i);
    const select = screen.getByLabelText(/Paper size/i);
    expect(select.querySelectorAll("option").length).toBe(4);
  });
});

/* ── ScannerSettings ───────────────────────────────────────────────── */

describe("ScannerSettings", () => {
  beforeEach(() => {
    mockGetSetting();
  });

  it("shows loading state initially", () => {
    mockedIpc.getSetting.mockImplementation(() => new Promise(() => {}));
    render(<ScannerSettings />);
    expect(screen.queryByLabelText(/Minimum barcode length/i)).not.toBeInTheDocument();
  });

  it("renders form after settings load", async () => {
    render(<ScannerSettings />);
    await screen.findByLabelText(/Minimum barcode length/i);
    expect(screen.getByLabelText(/Average ms per character/i)).toBeInTheDocument();
  });

  it("loads saved scanner settings", async () => {
    mockGetSetting({
      scanner_min_length: "10",
      scanner_avg_ms_per_char: "50",
    });
    render(<ScannerSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Minimum barcode length/i)).toHaveValue(10);
      expect(screen.getByLabelText(/Average ms per character/i)).toHaveValue(50);
    });
  });

  it("uses defaults when settings are null", async () => {
    mockGetSetting({ scanner_min_length: null, scanner_avg_ms_per_char: null });
    render(<ScannerSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Minimum barcode length/i)).toHaveValue(6);
      expect(screen.getByLabelText(/Average ms per character/i)).toHaveValue(30);
    });
  });

  it("saves scanner settings via IPC", async () => {
    const user = userEvent.setup();
    render(<ScannerSettings />);
    await screen.findByLabelText(/Minimum barcode length/i);

    await user.clear(screen.getByLabelText(/Minimum barcode length/i));
    await user.type(screen.getByLabelText(/Minimum barcode length/i), "8");

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("scanner_min_length", "8");
      expect(mockedIpc.setSetting).toHaveBeenCalledWith("scanner_avg_ms_per_char", "30");
    });
    expect(mockedToast.success).toHaveBeenCalledWith("Scanner settings saved");
  });

  it("shows error toast on save failure", async () => {
    mockedIpc.setSetting.mockRejectedValue(new Error("io error"));
    const user = userEvent.setup();
    render(<ScannerSettings />);
    await screen.findByLabelText(/Minimum barcode length/i);

    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith("Failed to save", expect.any(String));
    });
  });

  it("displays calculated threshold description", async () => {
    mockGetSetting({
      scanner_min_length: "6",
      scanner_avg_ms_per_char: "30",
    });
    render(<ScannerSettings />);
    await waitFor(() => {
      expect(screen.getByText(/6 × 30 ms = 180 ms/)).toBeInTheDocument();
    });
  });

  it("updates threshold description when values change", async () => {
    const user = userEvent.setup();
    render(<ScannerSettings />);
    await screen.findByLabelText(/Minimum barcode length/i);

    await user.clear(screen.getByLabelText(/Minimum barcode length/i));
    await user.type(screen.getByLabelText(/Minimum barcode length/i), "10");

    expect(screen.getByText(/10 × 30 ms = 300 ms/)).toBeInTheDocument();
  });

  it("renders test scanner input area", async () => {
    render(<ScannerSettings />);
    await screen.findByLabelText(/Scan input/i);
    expect(
      screen.getByPlaceholderText(/Click here, then scan a barcode/),
    ).toBeInTheDocument();
  });
});
