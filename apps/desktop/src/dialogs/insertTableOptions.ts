import { TABLE_LIMITS } from "@chemdraft/chem-core";

export interface TableInsertDimensions { rows: number; columns: number; headerRows: number }
export type InsertTableOptions = TableInsertDimensions & { preset: "three-line" | "grid" };
export function validTableDimensions(value: TableInsertDimensions): boolean {
  return Number.isInteger(value.rows) && value.rows >= 1 && value.rows <= TABLE_LIMITS.maxRows &&
    Number.isInteger(value.columns) && value.columns >= 1 && value.columns <= TABLE_LIMITS.maxColumns &&
    Number.isInteger(value.headerRows) && value.headerRows >= 0 && value.headerRows <= value.rows;
}
export function validInsertTableOptions(value: unknown): value is InsertTableOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as InsertTableOptions;
  return validTableDimensions(data) && (data.preset === "three-line" || data.preset === "grid");
}
