import * as XLSX from "xlsx";

export interface ParsedSpreadsheet {
  headers: string[];
  rows: string[][];
}

/** Parse a CSV/XLSX/XLS file into headers and rows. */
export async function parseSpreadsheet(file: File): Promise<ParsedSpreadsheet> {
  const ext = file.name.split(".").pop()?.toLowerCase();

  if (ext === "csv" || ext === "txt") {
    const text = await file.text();
    return parseCsvText(text);
  }

  if (ext === "xlsx" || ext === "xls") {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("Workbook has no sheets");
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    if (data.length < 2) {
      throw new Error("File must have a header row and at least one data row");
    }
    return {
      headers: data[0].map(String),
      rows: data.slice(1).map((r) => r.map((c) => String(c ?? ""))),
    };
  }

  throw new Error("Unsupported file format. Use CSV, XLSX, or XLS.");
}

/** Convert parsed spreadsheet rows back to CSV text for the backend API. */
export function toCsvText(headers: string[], rows: string[][]): string {
  const escape = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers, ...rows].map((row) => row.map(escape).join(","));
  return lines.join("\n");
}

/** Build column definitions for template download. */
export interface TemplateColumn {
  name: string;
  example?: string;
}

/** Download a blank template file (CSV or XLSX). */
export function downloadTemplate(
  columns: TemplateColumn[],
  filename: string,
  format: "csv" | "xlsx",
): void {
  if (format === "csv") {
    const header = columns.map((c) => c.name).join(",");
    const example = columns.map((c) => c.example ?? "").join(",");
    downloadBlob(
      new Blob([header + "\n" + example + "\n"], { type: "text/csv" }),
      `${filename}.csv`,
    );
  } else {
    const ws = XLSX.utils.aoa_to_sheet([
      columns.map((c) => c.name),
      columns.map((c) => c.example ?? ""),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    downloadBlob(
      new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${filename}.xlsx`,
    );
  }
}

/** Export data as a downloadable file (CSV or XLSX). */
export function downloadSpreadsheet(
  headers: string[],
  rows: string[][],
  filename: string,
  format: "csv" | "xlsx",
): void {
  if (format === "csv") {
    downloadBlob(
      new Blob([toCsvText(headers, rows)], { type: "text/csv" }),
      `${filename}.csv`,
    );
  } else {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    downloadBlob(
      new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `${filename}.xlsx`,
    );
  }
}

// ── internal helpers ──────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseCsvText(text: string): ParsedSpreadsheet {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row");
  }
  return {
    headers: parseCsvLine(lines[0]),
    rows: lines.slice(1).map(parseCsvLine),
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current.trim());
  return fields;
}
