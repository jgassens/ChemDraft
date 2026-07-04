import {
  DefaultNativeDrawingStyle,
  nativeDrawingStyleFromObjectStyle,
  type ChemDraftStylePreset,
  type CompatibilityWarning,
  type NativeDrawingStyle
} from "@chemdraft/chem-core";
import { importChemDrawStyleSheet } from "@chemdraft/style-compat";

export const moleculeInspectorTemplateFormat = "chemdraft.molecule-inspector.template.v1";
export const moleculeInspectorTemplateMimeType = "application/vnd.chemdraft.molecule-inspector-template+json";
export const moleculeInspectorTemplateExtension = "template";

export type MoleculeInspectorTemplateStylePatch = Omit<NativeDrawingStyle, "stylePresetId">;

export interface MoleculeInspectorTemplateFile {
  format: typeof moleculeInspectorTemplateFormat;
  version: 1;
  name: string;
  exportedAt: string;
  sourceFormat?: string;
  sourceName?: string;
  drawing: NativeDrawingStyle;
}

export interface MoleculeInspectorTemplateImportResult {
  name: string;
  sourceFormat: "chemdraft-template" | "chemdraw-cds";
  sourceName?: string;
  drawing: NativeDrawingStyle;
  warnings: CompatibilityWarning[];
}

export function serializeMoleculeInspectorTemplate(
  name: string,
  drawing: NativeDrawingStyle,
  options: { sourceFormat?: string; sourceName?: string; exportedAt?: string } = {}
): string {
  const normalized = normalizeDrawingStyle(drawing, drawing.stylePresetId || templatePresetIdFromName(name));
  const template: MoleculeInspectorTemplateFile = {
    format: moleculeInspectorTemplateFormat,
    version: 1,
    name: name.trim() || "Molecule Inspector Template",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    ...(options.sourceFormat ? { sourceFormat: options.sourceFormat } : {}),
    ...(options.sourceName ? { sourceName: options.sourceName } : {}),
    drawing: normalized
  };

  return `${JSON.stringify(template, null, 2)}\n`;
}

export function parseMoleculeInspectorTemplate(
  input: Uint8Array | ArrayBuffer | string,
  sourceName = "Molecule Inspector Template"
): MoleculeInspectorTemplateImportResult {
  const bytes = bytesFromInput(input);
  if (hasChemDrawStyleHeader(bytes) || /\.cds$/i.test(sourceName)) {
    const imported = importChemDrawStyleSheet(bytes);
    return {
      name: imported.preset.name,
      sourceFormat: "chemdraw-cds",
      sourceName: imported.source.name ?? sourceName,
      drawing: imported.preset.drawing,
      warnings: imported.warnings
    };
  }

  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Unsupported Molecule Inspector template: ${message}`);
  }

  return templateResultFromJson(parsed, sourceName);
}

export function moleculeInspectorTemplatePatchFromDrawingStyle(
  drawing: NativeDrawingStyle
): MoleculeInspectorTemplateStylePatch {
  const { stylePresetId: _stylePresetId, ...patch } = drawing;
  return patch;
}

export function moleculeInspectorTemplateFilename(name: string): string {
  const basename = name
    .replace(/\.(chemdraft|template|cds)$/i, "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "Molecule-Inspector";
  return `${basename}.${moleculeInspectorTemplateExtension}`;
}

function templateResultFromJson(value: unknown, sourceName: string): MoleculeInspectorTemplateImportResult {
  if (!isRecord(value)) {
    throw new Error("Unsupported Molecule Inspector template: expected a JSON object.");
  }

  const templateName = stringValue(value.name) ?? sourceName.replace(/\.(template|json)$/i, "");
  if (value.format === moleculeInspectorTemplateFormat) {
    return {
      name: templateName,
      sourceFormat: "chemdraft-template",
      sourceName,
      drawing: normalizeDrawingStyle(value.drawing, templatePresetIdFromName(templateName)),
      warnings: []
    };
  }

  const preset = isRecord(value.preset) ? value.preset : value;
  if (isRecord(preset) && isRecord(preset.drawing)) {
    const name = stringValue(preset.name) ?? templateName;
    const presetId = stringValue(preset.id) ?? templatePresetIdFromName(name);
    return {
      name,
      sourceFormat: "chemdraft-template",
      sourceName,
      drawing: normalizeDrawingStyle({ ...preset.drawing, stylePresetId: presetId }, presetId),
      warnings: []
    };
  }

  if (isRecord(value.drawing)) {
    return {
      name: templateName,
      sourceFormat: "chemdraft-template",
      sourceName,
      drawing: normalizeDrawingStyle(value.drawing, templatePresetIdFromName(templateName)),
      warnings: []
    };
  }

  throw new Error("Unsupported Molecule Inspector template: missing drawing style.");
}

function normalizeDrawingStyle(value: unknown, stylePresetId: string): NativeDrawingStyle {
  const style = isRecord(value) ? value : {};
  const resolvedStylePresetId = stringValue(style.stylePresetId) ?? stylePresetId;
  return nativeDrawingStyleFromObjectStyle({
    ...DefaultNativeDrawingStyle,
    ...style,
    stylePresetId: resolvedStylePresetId
  });
}

function bytesFromInput(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function hasChemDrawStyleHeader(bytes: Uint8Array): boolean {
  return new TextDecoder("ascii").decode(bytes.slice(0, 8)) === "VjCD0100";
}

function templatePresetIdFromName(name: string): string {
  const slug = name
    .replace(/\.(template|cds|json)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `template.molecule-inspector.${slug || "style"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function chemDraftStylePresetFromTemplate(
  template: MoleculeInspectorTemplateFile
): ChemDraftStylePreset {
  return {
    id: template.drawing.stylePresetId,
    name: template.name,
    source: "imported",
    sourceFormat: template.sourceFormat,
    sourceName: template.sourceName,
    drawing: template.drawing
  };
}
