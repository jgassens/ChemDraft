import { z } from "zod";
import { ChemDraftDocumentSchema } from "@chemdraft/chem-core";

import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";

const id = z.string().min(1).max(256);
export const assistantSession = z.object({ requestId: id, pluginId: id, documentKey: id,
  target: z.object({ windowId: id, tabId: id }).strict() }).strict();
export type RuntimeAssistantSession = z.infer<typeof assistantSession>;
export const assistantSnapshot = z.object({ document: ChemDraftDocumentSchema,
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite() }).strict().optional() }).strict();
export type RuntimeAssistantSnapshot = z.infer<typeof assistantSnapshot>;
export const assistantPreparedWrite = z.object({ after: ChemDraftDocumentSchema, selectionDocument: ChemDraftDocumentSchema,
  touchedIds: z.array(id).max(100_000) }).strict();
export type RuntimeAssistantPreparedWrite = z.infer<typeof assistantPreparedWrite>;
const pageGrowth = z.object({ pageId: id, width: z.number().finite().positive(), height: z.number().finite().positive(),
  description: z.string(), itemCount: z.number().int().nonnegative(),
  pages: z.array(z.object({ pageId: id, width: z.number().finite().positive(), height: z.number().finite().positive(),
    objectIds: z.array(id).optional() }).strict()).optional() }).strict();
export const assistantWritePlan = z.object({ patch: ProposedDocumentPatchSchema.shape.patch, verified: ChemDraftDocumentSchema,
  plannedDocument: ChemDraftDocumentSchema, growth: pageGrowth.optional() }).strict();
export type RuntimeAssistantWritePlan = z.infer<typeof assistantWritePlan>;
export const assistantResult = z.object({ split: z.boolean(), touchedIds: z.array(id).max(100_000) }).strict();
