/**
 * Shared print functions — re-exports from POS for domain slice usage.
 * This breaks the Domain → POS circular dependency by providing a shared layer.
 */

export { printLabel, type LabelSpec, type ThermalSize, THERMAL_SIZES, type PrintConfig, type BatchLabel } from "../pos/print";