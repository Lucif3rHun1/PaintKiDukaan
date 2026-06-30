export interface TsplConfig {
  font: "2" | "3" | "4" | "5";
  xmul: number;         // horizontal multiplier for the font (1–10)
  ymul: number;         // vertical multiplier for the font (1–10)
  topMarginMm: number;  // where the content block starts from the top of the label
  sideMarginMm: number; // minimum horizontal padding from each cell edge before centering
  spacingMm: number;    // uniform gap between every element: lines, text→barcode, barcode→SKU
}

export const DEFAULT_TSPL_CONFIG: TsplConfig = {
  font: "3",
  xmul: 1,
  ymul: 1,
  topMarginMm: 2,
  sideMarginMm: 1,
  spacingMm: 2,
};

const VALID_FONTS = new Set<string>(["2", "3", "4", "5"]);

/**
 * Normalize a raw/parsed TsplConfig to guaranteed-valid values.
 * Catches corrupt DB data, NaN, out-of-range values.
 */
export function normalizeTsplConfig(raw: Partial<TsplConfig> | null | undefined): TsplConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TSPL_CONFIG };
  const { font, xmul, ymul, topMarginMm, sideMarginMm, spacingMm } = raw;
  return {
    font: VALID_FONTS.has(font as string) ? (font as TsplConfig["font"]) : DEFAULT_TSPL_CONFIG.font,
    xmul: xmul != null && Number.isFinite(xmul) ? Math.max(1, Math.min(10, Math.round(xmul))) : DEFAULT_TSPL_CONFIG.xmul,
    ymul: ymul != null && Number.isFinite(ymul) ? Math.max(1, Math.min(10, Math.round(ymul))) : DEFAULT_TSPL_CONFIG.ymul,
    topMarginMm: topMarginMm != null && Number.isFinite(topMarginMm) ? Math.max(0, topMarginMm) : DEFAULT_TSPL_CONFIG.topMarginMm,
    sideMarginMm: sideMarginMm != null && Number.isFinite(sideMarginMm) ? Math.max(0, sideMarginMm) : DEFAULT_TSPL_CONFIG.sideMarginMm,
    spacingMm: spacingMm != null && Number.isFinite(spacingMm) ? Math.max(0, spacingMm) : DEFAULT_TSPL_CONFIG.spacingMm,
  };
}