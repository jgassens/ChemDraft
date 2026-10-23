import { adoptDerivedDocument, applyPatches, JournalProfileSchema, JournalRequestSchema, nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPatch, type JournalProfile, type JournalRequest,
  type JournalRule } from "@chemdraft/chem-core";
import { applyMoleculeTargetBondLength } from "./molecule";

/** Physical points and cm are converted once to the document's 96 CSS pixels/inch. */
export function journalRulePixels(rule: JournalRule): number {
  if (typeof rule.value !== "number" || !["pt", "cm"].includes(rule.unit)) throw new Error("Expected a physical length rule");
  return rule.value * (rule.unit === "pt" ? 96 / 72 : 96 / 2.54);
}
export function journalTargetIds(document: ChemDraftDocument, scope: JournalRequest["scope"]): Set<string> {
  if (scope === "document") return new Set(document.pages.flatMap(page => page.objects.map(object => object.id)));
  const page = document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0];
  const objects = new Map(page?.objects.map(object => [object.id, object]));
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id) || !objects.has(id)) return;
    ids.add(id);
    const object = objects.get(id)!;
    if (object.type === "group") object.childObjectIds.forEach(visit);
  };
  document.selection.objectIds.forEach(visit);
  return ids;
}
const eligible = (object: DocumentObject) => object.type === "molecule" || object.type === "text";
export function applyJournalStyle(document: ChemDraftDocument, candidate: JournalProfile, input: JournalRequest): ChemDraftDocument {
  const profile = JournalProfileSchema.parse(candidate), request = JournalRequestSchema.parse(input);
  if (profile.id !== request.profileId || !profile.figures.some(figure => figure.id === request.figureType)) throw new Error("Unknown journal profile or figure type");
  if (profile.status === "unverified") throw new Error("This profile has not been verified");
  const ids = journalTargetIds(document, request.scope);
  const targets = document.pages.flatMap(page => page.objects).filter(object => ids.has(object.id) && eligible(object));
  if (!targets.length) throw new Error("Choose a drawing containing a molecule or text, or select those objects first.");
  if (request.resizeBonds && !profile.rules.bondLength) throw new Error("This profile has no verified bond length; resizing is unavailable.");
  // Reuse the existing geometry operation; it scales without reconstructing the chemical graph.
  let next = request.resizeBonds ? applyMoleculeTargetBondLength(document,
    targets.filter(object => object.type === "molecule").map(object => object.id), journalRulePixels(profile.rules.bondLength!)) : document;
  const snapshot = { profileId: profile.id, version: profile.version, journalId: profile.journalId,
    figureType: request.figureType, status: profile.status, checkedAt: profile.checkedAt,
    rules: profile.rules, figure: profile.figures.find(figure => figure.id === request.figureType)!, resizeBonds: request.resizeBonds };
  const patches: DocumentPatch[] = next.pages.flatMap(page => page.objects.flatMap(object => {
    if (!ids.has(object.id) || !eligible(object)) return [];
    const style = { ...object.style };
    delete style.journalPreset;
    const drawing = nativeDrawingStyleFromObjectStyle(style);
    const setLength = (rule: JournalRule | undefined, key: string, fallback: number) => {
      if (!rule) return;
      const px = journalRulePixels(rule);
      style[key] = rule.relation === "minimum" ? Math.max(typeof style[key] === "number" ? style[key] as number : fallback, px) : px;
    };
    const family = profile.rules.fontFamily?.value;
    if (typeof family === "string") style[object.type === "text" ? "fontFamily" : "atomLabelFontFamily"] = family;
    setLength(profile.rules.fontSize, object.type === "text" ? "fontSizePx" : "atomLabelFontSizePx", object.type === "text" ? 18 : drawing.atomLabelFontSizePx);
    if (object.type === "molecule") {
      setLength(profile.rules.lineWidth, "bondStrokeWidthPx", drawing.bondStrokeWidthPx);
      setLength(profile.rules.boldWidth, "bondBoldWidthPx", drawing.bondBoldWidthPx);
      setLength(profile.rules.hashSpacing, "bondHashSpacingPx", drawing.bondHashSpacingPx);
      setLength(profile.rules.marginWidth, "bondMarginWidthPx", drawing.bondMarginWidthPx);
      if (profile.rules.bondSpacing) { style.bondSpacingMode = "percent"; style.bondSpacingPercent = profile.rules.bondSpacing.value; }
      // This is the target for later drawing operations, not a hidden coordinate resize.
      if (profile.rules.bondLength) style.bondLengthPx = journalRulePixels(profile.rules.bondLength);
    }
    style.stylePresetId = `journal.${profile.id}@${profile.version}`;
    style.journalPreset = { ...snapshot, resolvedStyle: { ...style } };
    return [{ op: "updateObject" as const, objectId: object.id, changes: { style } }];
  }));
  next = applyPatches(next, patches);
  // Existing metadata is open-ended. No schema migration, external catalog or font download is
  // required to render this file later; every affected object carries resolved native settings.
  if (request.scope === "document") next = adoptDerivedDocument(next, { ...next, styles: { ...next.styles, journalPreset: snapshot } });
  return next;
}
