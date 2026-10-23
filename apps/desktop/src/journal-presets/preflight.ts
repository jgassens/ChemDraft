import { JournalFigureSchema, type ChemDraftDocument, type JournalFigure } from "@chemdraft/chem-core";
import { isExportFormatImplemented, type ExportFormatId } from "@chemdraft/export-engine";

export function checkJournalExport(figure: JournalFigure, format: ExportFormatId, widthMm: number, heightMm: number, dpi?: number): string[] {
  const messages: string[] = [];
  if (!isExportFormatImplemented(format)) messages.push(`${format.toUpperCase()} export is not implemented.`);
  if (![widthMm, heightMm].every(value => Number.isFinite(value) && value > 0)) return [...messages, "Export physical dimensions could not be determined."];
  if (figure.maxWidthMm && widthMm > figure.maxWidthMm + 0.01) messages.push(`Export width ${widthMm.toFixed(1)} mm exceeds ${figure.maxWidthMm.toFixed(1)} mm.`);
  if (figure.minWidthMm && widthMm < figure.minWidthMm - 0.01) messages.push(`Export width ${widthMm.toFixed(1)} mm is below ${figure.minWidthMm.toFixed(1)} mm.`);
  if (figure.maxHeightMm && heightMm > figure.maxHeightMm + 0.01) messages.push(`Export height ${heightMm.toFixed(1)} mm exceeds ${figure.maxHeightMm.toFixed(1)} mm (including any required caption).`);
  if (figure.formats && !figure.formats.includes(format)) messages.push(`${format.toUpperCase()} is not among this figure type's listed formats: ${figure.formats.join(", ").toUpperCase()}.`);
  const raster = ["png", "jpeg", "tiff", "bmp", "gif"].includes(format);
  if (raster && figure.minDpi) {
    const minimum = Math.max(...Object.values(figure.minDpi));
    if (dpi === undefined || dpi < minimum) messages.push(`Raster resolution: use at least ${minimum} dpi for line art; check the journal's artwork category before reducing it.`);
  }
  return messages;
}
/** Uses saved constraints, never the current catalog. Selection presets do not label other pages. */
export function savedJournalFigures(document: ChemDraftDocument, pageIndex = 0): JournalFigure[] {
  const figures = new Map<string, JournalFigure>();
  for (const object of document.pages[pageIndex]?.objects ?? []) {
    const preset = (object.style as Record<string, unknown>).journalPreset;
    if (!preset || typeof preset !== "object") continue;
    const figure = JournalFigureSchema.safeParse((preset as Record<string, unknown>).figure);
    if (figure.success) figures.set(JSON.stringify(figure.data), figure.data);
  }
  return [...figures.values()];
}

export function journalPreflightMessages(document: ChemDraftDocument, format: ExportFormatId,
  physical: { widthMm: number; heightMm: number; scaleX: number; scaleY: number; dpi?: number }): string[] {
  const messages = savedJournalFigures(document).flatMap(figure => checkJournalExport(figure, format, physical.widthMm, physical.heightMm, physical.dpi));
  if (Math.abs(physical.scaleX - physical.scaleY) > 0.001) messages.push("Nonuniform export scaling can distort chemical drawings. Use linked dimensions.");
  const scale = Math.min(physical.scaleX, physical.scaleY);
  for (const object of document.pages[0]?.objects ?? []) {
    if (object.type !== "molecule" && object.type !== "text") continue;
    const snapshot = object.style.journalPreset as { rules?: Record<string, { value?: unknown; unit?: unknown; relation?: unknown }> } | undefined;
    if (!snapshot || typeof snapshot !== "object" || !snapshot.rules || typeof snapshot.rules !== "object") continue;
    for (const [name, styleKey] of [["fontSize", object.type === "text" ? "fontSizePx" : "atomLabelFontSizePx"], ["lineWidth", "bondStrokeWidthPx"]]) {
      if (name === "lineWidth" && object.type !== "molecule") continue;
      const rule = snapshot.rules[name];
      if (!rule || typeof rule !== "object" || typeof rule.value !== "number" || !Number.isFinite(rule.value) || !["pt", "cm"].includes(String(rule.unit))) continue;
      const expectedPt = rule.value * (rule.unit === "cm" ? 72 / 2.54 : 1);
      const px = object.style[styleKey];
      if (typeof px !== "number") continue;
      const actualPt = px / (96 / 72) * scale;
      if (rule.relation === "minimum" ? actualPt + 0.01 < expectedPt : Math.abs(actualPt - expectedPt) > 0.02) {
        messages.push(`${object.id}: exported ${name === "fontSize" ? "font size" : "bond width"} is ${actualPt.toFixed(2)} pt; preset ${rule.relation === "minimum" ? "minimum" : "target"} is ${expectedPt.toFixed(2)} pt. Check export scaling.`);
      }
    }
  }
  return [...new Set(messages)];
}
