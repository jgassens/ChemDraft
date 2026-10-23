import { z } from "zod";

const shortText = z.string().min(1).max(256);
const positive = z.number().finite().positive().max(10000);
const sourceUrl = z.string().url().max(1024).refine(url => url.startsWith("https://"), "Use an HTTPS source");
export const JournalRuleSchema = z.object({
  value: z.union([positive, shortText]),
  unit: z.enum(["pt", "cm", "percent", "font-stack"]),
  relation: z.enum(["exact", "minimum"]),
  sourceUrl: sourceUrl.nullable(),
  section: shortText
}).strict().superRefine((rule, context) => {
  if ((rule.unit === "font-stack") !== (typeof rule.value === "string")) context.addIssue({ code: "custom", message: "Rule unit and value disagree" });
});
export const JournalRulesSchema = z.object({
  fontFamily: JournalRuleSchema.optional(), fontSize: JournalRuleSchema.optional(),
  bondLength: JournalRuleSchema.optional(), lineWidth: JournalRuleSchema.optional(),
  boldWidth: JournalRuleSchema.optional(), hashSpacing: JournalRuleSchema.optional(),
  marginWidth: JournalRuleSchema.optional(), bondSpacing: JournalRuleSchema.optional()
}).strict();
export const JournalFigureSchema = z.object({
  id: shortText, label: shortText,
  maxWidthMm: positive.nullable(), maxHeightMm: positive.nullable(), minWidthMm: positive.nullable(),
  formats: z.array(shortText).max(20).nullable(),
  minDpi: z.object({ "line-art": positive, grayscale: positive, color: positive }).strict().nullable(),
  sourceUrl: sourceUrl.nullable(), section: shortText
}).strict();
export const JournalProfileSchema = z.object({
  id: shortText, journalId: shortText, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  checkedAt: z.string().date(), status: z.enum(["verified", "partial", "unverified", "custom"]),
  rules: JournalRulesSchema, figures: z.array(JournalFigureSchema).min(1).max(20),
  limitations: z.array(z.string().max(1024)).max(20)
}).strict().superRefine((profile, context) => {
  for (const [name, rule] of Object.entries(profile.rules)) {
    if (!rule) continue;
    if (profile.status !== "custom" && !rule.sourceUrl) context.addIssue({ code: "custom", message: "Published rules require a source" });
    const valid = name === "fontFamily" ? rule.unit === "font-stack"
      : name === "bondSpacing" ? rule.unit === "percent" && Number(rule.value) <= 100
      : ["pt", "cm"].includes(rule.unit);
    if (!valid) context.addIssue({ code: "custom", message: `Invalid unit for ${name}` });
  }
  if (new Set(profile.figures.map(figure => figure.id)).size !== profile.figures.length) context.addIssue({ code: "custom", message: "Duplicate figure types" });
});
export const JournalRequestSchema = z.object({
  profileId: shortText, figureType: shortText, scope: z.enum(["selection", "document"]),
  resizeBonds: z.boolean(),
  custom: z.object({ fontFamily: shortText, fontSizePt: positive.max(100), lineWidthPt: positive.max(20), bondLengthPt: positive.max(100) }).strict().optional()
}).strict().superRefine((request, context) => {
  if ((request.profileId === "custom") !== !!request.custom) context.addIssue({ code: "custom", message: "Custom settings must belong to a custom preset" });
});
export type JournalRule = z.infer<typeof JournalRuleSchema>;
export type JournalProfile = z.infer<typeof JournalProfileSchema>;
export type JournalFigure = z.infer<typeof JournalFigureSchema>;
export type JournalRequest = z.infer<typeof JournalRequestSchema>;

export const JournalMetadataSchema = z.object({
  id: z.string().min(1).max(256), title: z.string().min(1).max(256), publisher: z.string().min(1).max(256),
  aliases: z.array(z.string().max(256)).max(30), issns: z.array(z.string().regex(/^\d{4}-\d{3}[\dX]$/)).min(1).max(10),
  guidelinesUrl: z.string().url().startsWith("https://"), identitySource: z.string().url().startsWith("https://"), identityCheckedAt: z.string().date()
}).strict();

export function parseJournalCatalog(identities: unknown, formatting: unknown) {
  const nextJournals = z.array(JournalMetadataSchema).max(1000).parse(identities);
  const nextProfiles = z.array(JournalProfileSchema).max(1000).parse(formatting);
  if (new Set(nextJournals.map(journal => journal.id)).size !== nextJournals.length ||
      new Set(nextProfiles.map(profile => profile.id)).size !== nextProfiles.length ||
      nextProfiles.some(profile => !nextJournals.some(journal => journal.id === profile.journalId)) ||
      nextJournals.some(journal => !nextProfiles.some(profile => profile.journalId === journal.id))) throw new Error("Invalid journal catalog identities");
  return { journals: nextJournals, profiles: nextProfiles };
}
