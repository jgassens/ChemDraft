import { boundedHandoffText, PluginAppHandoffLimits } from "@chemdraft/plugin-api";
import { z } from "zod";

const { warningCount, warningCharacters, retryInputs, retryLabelCharacters } = PluginAppHandoffLimits;
const displayText = z.string().min(1).refine(value => !value.includes("\0"));
const attributedText = (limit: number) => z.string().min(1).refine(value =>
  value.length <= limit * 2 && boundedHandoffText(value, limit, false) === value);
export const CompanionDialogIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const parameterName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u).refine(name => name !== "__proto__");
const parameterValue = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,31}$/u).refine(value => !value.includes(".."));
const combination = z.record(parameterName, z.string()).refine(row => Object.entries(row).every(([name, value]) =>
  (name === "rebuildAs" ? CompanionDialogIdSchema : parameterValue).safeParse(value).success));
const header = z.object({
  title: z.string().min(1).max(256).refine(value => !value.includes("\0")),
  appName: displayText,
  pluginName: attributedText(80).optional(),
  warnings: z.array(attributedText(warningCharacters)).max(warningCount).optional()
});

export const AppHandoffDialogSnapshotSchema = z.discriminatedUnion("mode", [
  header.extend({
    mode: z.literal("confirm"),
    pipeline: CompanionDialogIdSchema,
    composition: z.object({ formula: z.string().regex(/^(?:[A-Z][a-z]?[0-9]*)+$/u),
      atomCount: z.number().int().safe().positive() }).strict().optional(),
    suggestedCombination: CompanionDialogIdSchema,
    combinations: z.record(CompanionDialogIdSchema, combination),
    /** API 0.1.29: the bounded retry this one confirmation covers. `attempts` includes the first. */
    retry: z.object({
      attempts: z.number().int().min(2).max(retryInputs + 1),
      step: CompanionDialogIdSchema,
      label: attributedText(retryLabelCharacters),
      notEqual: z.number().finite()
    }).strict().optional()
  }).strict(),
  header.extend({
    mode: z.literal("result"),
    combination: CompanionDialogIdSchema,
    rebuildCombination: CompanionDialogIdSchema,
    rebuildLabel: displayText,
    rebuildChanges: z.record(parameterName.refine(name => name !== "rebuildAs"), parameterValue.nullable()),
    twist: z.number().finite().nonnegative().optional()
  }).strict()
]).refine(snapshot => snapshot.mode === "result" ? snapshot.combination !== snapshot.rebuildCombination :
  Object.hasOwn(snapshot.combinations, snapshot.suggestedCombination) &&
  Object.entries(snapshot.combinations).every(([id, row]) =>
    !Object.hasOwn(row, "rebuildAs") || (row.rebuildAs !== id && Object.hasOwn(snapshot.combinations, row.rebuildAs)))
);

export type AppHandoffDialogSnapshot = z.infer<typeof AppHandoffDialogSnapshotSchema>;

export type AppHandoffDialogAction =
  | { action: "confirm"; combinationId: string }
  | { action: "rebuild" }
  | { action: "cancel" };
