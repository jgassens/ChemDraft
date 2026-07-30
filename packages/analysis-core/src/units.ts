/**
 * Structured unit identifiers (PLANS.md §3: "structured unit identifiers (not free strings)").
 *
 * A free-string unit is how "180.159 amu" and "180.042 amu" end up next to each other in a UI when
 * one is a molar mass in g/mol and the other a monoisotopic mass in daltons. The registry below keeps
 * that distinction in the type system: every unit declares a dimension, and a result carries a
 * `UnitId`, so a renderer can group, convert, or refuse to compare without parsing text.
 *
 * The registry is deliberately small. Add a unit when a method needs it, with its dimension — never a
 * display string alone.
 */
import { z } from "zod";

export type UnitDimension =
  | "dimensionless"
  | "count"
  | "mass"
  | "molar-mass"
  | "mass-to-charge"
  | "area"
  | "volume"
  | "length"
  | "log-unit"
  | "temperature"
  | "energy"
  | "molar-energy"
  | "electric-potential"
  | "dipole-moment"
  | "fraction"
  | "abundance";

export interface UnitDefinition {
  readonly id: UnitId;
  readonly dimension: UnitDimension;
  /** Rendered next to a value. */
  readonly symbol: string;
  /** Spoken form for tooltips and the provenance report. */
  readonly label: string;
  /**
   * Why this unit exists as its own entry rather than an alias. Present where a naive reader would
   * expect two entries to be interchangeable — the dalton/gram-per-mole pair above all.
   */
  readonly note?: string;
}

const DEFINITIONS = [
  { id: "dimensionless", dimension: "dimensionless", symbol: "", label: "dimensionless" },
  { id: "count", dimension: "count", symbol: "", label: "count" },
  {
    id: "dalton",
    dimension: "mass",
    symbol: "Da",
    label: "dalton",
    note:
      "Mass of one specific isotopologue. Monoisotopic and exact masses are daltons, NOT g/mol: they " +
      "describe a single molecule, not a mole-weighted average over natural isotope abundances."
  },
  {
    id: "gram-per-mole",
    dimension: "molar-mass",
    symbol: "g/mol",
    label: "gram per mole",
    note:
      "Abundance-weighted molar mass. Numerically close to the monoisotopic value for small organics, " +
      "which is exactly why it must not share a unit id with `dalton`."
  },
  { id: "thomson", dimension: "mass-to-charge", symbol: "m/z", label: "mass-to-charge ratio" },
  { id: "square-angstrom", dimension: "area", symbol: "Å²", label: "square ångström" },
  { id: "cubic-angstrom", dimension: "volume", symbol: "Å³", label: "cubic ångström" },
  { id: "angstrom", dimension: "length", symbol: "Å", label: "ångström" },
  {
    id: "cubic-centimetre-per-mole",
    dimension: "volume",
    symbol: "cm³/mol",
    label: "cubic centimetre per mole",
    note: "Molar refractivity (Crippen MR) is reported in these units."
  },
  {
    id: "log10-unit",
    dimension: "log-unit",
    symbol: "log units",
    label: "base-10 logarithmic unit",
    note: "logP, logD, logS, and pKa are all log10 units; they are not interconvertible with each other."
  },
  { id: "kelvin", dimension: "temperature", symbol: "K", label: "kelvin" },
  { id: "kilocalorie-per-mole", dimension: "molar-energy", symbol: "kcal/mol", label: "kilocalorie per mole" },
  { id: "kilojoule-per-mole", dimension: "molar-energy", symbol: "kJ/mol", label: "kilojoule per mole" },
  { id: "electronvolt", dimension: "energy", symbol: "eV", label: "electronvolt" },
  { id: "debye", dimension: "dipole-moment", symbol: "D", label: "debye" },
  { id: "elementary-charge", dimension: "dimensionless", symbol: "e", label: "elementary charge" },
  { id: "fraction", dimension: "fraction", symbol: "", label: "fraction of unity" },
  { id: "percent", dimension: "fraction", symbol: "%", label: "percent" },
  {
    id: "relative-abundance",
    dimension: "abundance",
    symbol: "%",
    label: "relative abundance",
    note: "Isotope-envelope intensities normalised to the base peak. Not a measured ion current."
  }
] as const satisfies readonly { id: string; dimension: UnitDimension; symbol: string; label: string; note?: string }[];

export type UnitId = (typeof DEFINITIONS)[number]["id"];

export const UnitIds = DEFINITIONS.map((definition) => definition.id) as readonly UnitId[];

export const UnitIdSchema = z.enum(UnitIds as [UnitId, ...UnitId[]]);

const BY_ID = new Map<UnitId, UnitDefinition>(
  DEFINITIONS.map((definition) => [definition.id, definition as UnitDefinition])
);

export function unit(id: UnitId): UnitDefinition {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unknown unit id: ${id}`);
  return definition;
}

/**
 * Two values may only be compared, subtracted, or plotted on one axis when their units share a
 * dimension. `dalton` and `gram-per-mole` deliberately fail this test.
 */
export function isComparable(a: UnitId, b: UnitId): boolean {
  return unit(a).dimension === unit(b).dimension;
}

export function formatWithUnit(value: number, id: UnitId): string {
  const symbol = unit(id).symbol;
  return symbol ? `${value} ${symbol}` : `${value}`;
}
