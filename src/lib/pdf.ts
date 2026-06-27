import { jsPDF } from "jspdf";

export function buildPdf(
  headers: string[],
  rows: (string | number)[][],
  title: string,
  subtitle?: string,
) {
  const landscape = headers.length > 5;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const usableW = pageW - margin * 2;
  let y = margin;
  doc.setFontSize(14);
  doc.text(title, margin, y);
  y += 7;
  if (subtitle) { doc.setFontSize(9); doc.text(subtitle, margin, y); y += 6; }
  const colW = usableW / headers.length;
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  headers.forEach((h, i) => doc.text(h, margin + i * colW, y));
  y += 4;
  doc.line(margin, y, pageW - margin, y);
  y += 3;
  doc.setFont("helvetica", "normal");
  for (const row of rows) {
    if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
    row.forEach((cell, i) => doc.text(String(cell ?? ""), margin + i * colW, y));
    y += 4;
  }
  doc.save(`${title.replace(/\s+/g, "-").toLowerCase()}.pdf`);
}
