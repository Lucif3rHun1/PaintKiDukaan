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