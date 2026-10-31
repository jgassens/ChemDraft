// Integration: desktop must declare zod ^3.25.76 (its v4 entry supplies JSON Schema export).
import { z } from "zod/v4";
import { TABLE_LIMITS } from "@chemdraft/chem-core";
import { TableSpecSchema } from "@chemdraft/document-workflow-core";

// Zod 4 supplies the wire JSON schema. The shared builder's Zod 3 schema remains the
// authority for cross-field validation (ragged rows, header totals, and matching spans).
const formulaRule = z.enum(["auto", "off"]);
const tableCell = z.union([z.string().max(TABLE_LIMITS.maxCellCharacters), z.object({
  text: z.string().max(TABLE_LIMITS.maxCellCharacters),
  spans: z.array(z.object({ text: z.string(), script: z.enum(["normal", "subscript", "superscript"]).optional(),
    bold: z.boolean().optional(), italic: z.boolean().optional() }).strict())
    .max(TABLE_LIMITS.maxSpansPerCell, { error: issue =>
      `maxSpansPerCell is ${TABLE_LIMITS.maxSpansPerCell}; actual value is `
      + `${(issue.input as unknown[]).length}` })
    .optional(),
  formula: formulaRule.optional()
}).strict()]);
const tableSpec = z.object({
  columns: z.array(z.object({ header: tableCell.optional(), align: z.enum(["left", "center", "right", "decimal"]).optional(),
    widthPx: z.number().positive().max(4000).optional(), formula: formulaRule.optional() }).strict()).min(1).max(TABLE_LIMITS.maxColumns),
  rows: z.array(z.array(tableCell)).max(TABLE_LIMITS.maxRows),
  headerRows: z.array(z.array(tableCell)).optional(), caption: tableCell.optional(),
  footnotes: z.array(tableCell).max(TABLE_LIMITS.maxFootnotes).optional(),
  style: z.object({ preset: z.enum(["three-line", "grid"]).optional(), headerBold: z.boolean().optional(),
    fontFamily: z.string().max(TABLE_LIMITS.maxFontFamilyLength, { error: issue =>
      `maxFontFamilyLength is ${TABLE_LIMITS.maxFontFamilyLength}; `
      + `actual value is ${(issue.input as string).length}` })
      .optional(),
    fontSizePx: z.number().min(1, {
      error: issue => `fontSizePx must be 1..400; actual value is ${issue.input}`
    }).max(TABLE_LIMITS.maxFontSizePx, {
      error: issue => `fontSizePx must be 1..400; actual value is ${issue.input}` })
      .optional() }).strict().optional(),
  besideObjectId: z.string().min(1).max(256).optional()
}).strict().superRefine(({ besideObjectId: _beside, ...spec }, ctx) => {
  const result = TableSpecSchema.safeParse(spec);
  if (!result.success) for (const issue of result.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});

export const SMILES = z.string().min(1).max(5000);
const id = z.string().min(1).max(256);
const ids = z.array(id).min(1).max(100);
const text = z.string().min(1).max(2000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
export const textStyleSchema = z.object({
  fontSizePx: z.number().min(1).max(200).optional(), bold: z.boolean().optional(),
  italic: z.boolean().optional(), color: color.optional()
}).strict();
const side = z.enum(["above", "below", "left", "right"]);
const relativeTo = z.object({ objectId: id, side }).strict();
const molecule = z.object({ kind: z.literal("molecule"), smiles: SMILES, label: text.optional() }).strict();
const group = z.object({ kind: z.literal("group"), label: z.string().trim().min(1).max(80)
  .describe("Native standalone abbreviation or condensed formula label, e.g. CH3 (methyl), Me, Et, Ph, Bn, Boc, OTs, OMe, NO2, CF3. No placeholders or bare element symbols.") }).strict();
const textItem = z.object({ kind: z.literal("text"), text, style: textStyleSchema.optional() }).strict();
export const toolSchemas = {
  get_document: z.object({ includeSmiles: z.boolean().default(true), maxObjects: z.number().int().min(1).max(500).default(200) }).strict(),
  get_selection: z.object({}).strict(),
  get_structure: z.object({ objectId: id, format: z.enum(["smiles", "molfile"]) }).strict(),
  render: z.object({
    target: z.enum(["document", "selection", "objects"]), objectIds: z.array(id).min(1).max(50).optional(),
    pageId: id.optional(), maxDimensionPx: z.number().int().min(256).max(2048).default(1568),
    background: z.union([color, z.literal("transparent")]).optional()
  }).strict(),
  name_to_structure: z.object({ name: text }).strict(),
  validate_smiles: z.object({ smiles: SMILES }).strict(),
  structure_to_name: z.object({ objectId: id }).strict(),
  insert_structures: z.object({
    items: z.array(z.discriminatedUnion("kind", [molecule, group, textItem])).min(1).max(24),
    arrangement: z.enum(["row", "grid", "auto"]).default("auto")
  }).strict(),
  insert_reaction: z.object({
    reactants: z.array(SMILES).min(1).max(6), products: z.array(SMILES).min(1).max(6),
    above: z.array(text).max(6).optional(), below: z.array(text).max(6).optional(),
    caption: text.max(300).optional(),
    reagents: z.array(text).max(3).optional().describe("Compatibility: appended to above, one per line."),
    conditions: z.array(text).max(3).optional().describe("Compatibility: appended to below, one per line."),
    arrowKind: z.enum(["forward", "equilibrium", "retrosynthetic", "resonance"]).default("forward")
  }).strict(),
  insert_text: z.object({ text, relativeTo: relativeTo.optional(), style: textStyleSchema.optional() }).strict(),
  insert_table: tableSpec,
  edit_structure: z.object({ objectId: id, smiles: SMILES, keepPosition: z.boolean().default(true) }).strict(),
  delete_objects: z.object({ objectIds: ids }).strict(),
  style_objects: z.object({ objectIds: ids, style: z.object({
    color: color.optional(), strokeWidth: z.number().min(0.1).max(20).optional(),
    fontSizePx: z.number().min(1).max(200).optional(),
    bondDisplay: z.enum(["solid", "wedge", "hashed", "wavy", "dashed", "bold"]).optional(),
    ringStyles: z.array(z.object({ ringKey: z.string().min(1).max(256),
      fillColor: z.union([color, z.literal("none")]).optional(), fillOpacity: z.number().min(0).max(1).optional()
    }).strict()).max(100).optional()
  }).strict() }).strict(),
  move_objects: z.object({ objectIds: ids, to: z.union([
    z.object({ relativeTo: id, side }).strict(), z.object({ arrange: z.enum(["row", "grid"]) }).strict()
  ]) }).strict()
};
export type AssistantToolName = keyof typeof toolSchemas;
export type ToolInput<N extends AssistantToolName> = z.output<(typeof toolSchemas)[N]>;
export function toolJsonSchema(name: AssistantToolName): Record<string, unknown> {
  return z.toJSONSchema(toolSchemas[name], { io: "input", target: "draft-7" });
}
