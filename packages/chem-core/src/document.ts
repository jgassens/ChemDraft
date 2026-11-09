import {
  ChemDraftDocumentSchema,
  DocumentObjectSchema,
  DocumentSchemaVersion,
  GraphicObjectDataSchema,
  GraphicObjectStyleSchema,
  type ChemDraftDocument,
  type DocumentObject
} from "./schemas";
import { engineDocuments } from "./engineDocuments";
import { DefaultPageLayout, createPageLayout, pageMarginFromLayout } from "./page-layout";
import { minimumAppVersionForDocument, NativeDocumentBaselineAppVersion, NativeDocumentFormatVersion } from "./documentFeatures";
import { compareNativeVersions, restoreNativeExtensions, type NativeDocumentWriteWarning } from "./nativeCompatibilityState";
import { readNativeDocument, type NativeDocumentReadResult } from "./documentRead";

export interface CreateEmptyDocumentOptions {
  id?: string;
  pageId?: string;
  title?: string;
  now?: Date | string;
}

export interface DocumentValidationIssue {
  path: string;
  message: string;
}

export type DocumentValidationResult =
  | { ok: true; document: ChemDraftDocument; issues: [] }
  | { ok: false; issues: DocumentValidationIssue[] };

export function createEmptyDocument(options: CreateEmptyDocumentOptions = {}): ChemDraftDocument {
  const timestamp = toIsoTimestamp(options.now ?? new Date());
  const layout = DefaultPageLayout;

  return ChemDraftDocumentSchema.parse({
    schema: DocumentSchemaVersion,
    id: options.id ?? "doc_001",
    title: options.title ?? "Untitled",
    createdAt: timestamp,
    updatedAt: timestamp,
    pages: [
      {
        id: options.pageId ?? "page_001",
        width: layout.widthPx,
        height: layout.heightPx,
        margin: pageMarginFromLayout(layout),
        layout,
        objects: []
      }
    ],
    selection: {
      objectIds: []
    },
    styles: {},
    plugins: {},
    compatibility: {
      warnings: []
    }
  });
}

export function validateDocument(candidate: unknown): DocumentValidationResult {
  const result = ChemDraftDocumentSchema.safeParse(candidate);

  if (result.success) {
    return { ok: true, document: result.data, issues: [] };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

export function parseDocument(candidate: unknown): ChemDraftDocument {
  return ChemDraftDocumentSchema.parse(candidate);
}

export function validateDocumentObject(candidate: unknown): DocumentObject {
  return DocumentObjectSchema.parse(candidate);
}

export function serializeDocument(document: ChemDraftDocument): string {
  return serializeDocumentWithWarnings(document).contents;
}

/** Save result for callers that present compatibility warnings in addition to the log. */
export function serializeDocumentWithWarnings(document: ChemDraftDocument): { contents: string; warnings: NativeDocumentWriteWarning[] } {
  // An engine document is validated and normalized already; re-parsing it on every save was a full
  // schema pass over every object.
  const validated = engineDocuments.has(document) ? document : parseDocument(document);
  const { value, warnings } = prepareNativeDocumentForSerializationWithWarnings(validated);
  return { contents: JSON.stringify(value, null, 2), warnings };
}

/**
 * Native JSON value for an already validated document. Container writers (the CDXML envelope)
 * validate once for their visible layer, then use this to share version/preservation behavior
 * without repeating the schema pass. The returned file data may contain unknown future values;
 * it is deliberately not typed as the active ChemDraftDocument model.
 */
export function prepareNativeDocumentForSerialization(validated: ChemDraftDocument): unknown {
  return prepareNativeDocumentForSerializationWithWarnings(validated).value;
}

export function prepareNativeDocumentForSerializationWithWarnings(validated: ChemDraftDocument): { value: unknown; warnings: NativeDocumentWriteWarning[] } {
  const minAppVersion = minimumAppVersionForDocument(validated);
  const extensions = validated.compatibility.nativeExtensions;
  const output = { ...validated, compatibility: { ...validated.compatibility } };
  delete output.compatibility.nativeExtensions;
  delete output.formatVersion;
  delete output.minAppVersion;
  // Clone only when reconstruction will mutate nested objects. Ordinary saves keep the engine's
  // fast, already-validated path and retain the released writer's property order and defaults.
  const restored = extensions?.length ? JSON.parse(JSON.stringify(output)) as ChemDraftDocument : output;
  const { restored: restoredCount, warnings } = extensions?.length ? restoreNativeExtensions(restored, extensions) : { restored: 0, warnings: [] };
  for (const warning of warnings) console.warn("Native document compatibility", warning);
  if (compareNativeVersions(minAppVersion, NativeDocumentBaselineAppVersion) > 0) {
    restored.formatVersion = restoredCount && validated.formatVersion
      && compareNativeVersions(validated.formatVersion, NativeDocumentFormatVersion) > 0
      ? validated.formatVersion : NativeDocumentFormatVersion;
    restored.minAppVersion = minAppVersion;
  }
  return { value: restored, warnings };
}

export function deserializeDocument(serialized: string): ChemDraftDocument {
  return readSerializedDocument(serialized).document;
}

/** Native file reader with named warnings and the file's version envelope. */
export function readSerializedDocument(serialized: string): NativeDocumentReadResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(`Native document parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return readDocument(parsed);
}

/** Read an already-decoded native file. parseDocument remains the strict in-memory validator. */
export function readDocument(candidate: unknown): NativeDocumentReadResult {
  return readNativeDocument(candidate, migrateDocument);
}

export function migrateDocument(candidate: unknown): ChemDraftDocument {
  const result = validateDocument(candidate);
  if (result.ok) {
    return result.document;
  }

  const migrated = migrateLegacyTableObjects(migrateLegacyGraphicObjects(migrateLegacyPageLayouts(candidate)));
  if (migrated !== candidate) {
    const migratedResult = validateDocument(migrated);
    if (migratedResult.ok) {
      return migratedResult.document;
    }
  }

  const detail = formatValidationIssues(result.issues);
  // Strict schemas reject keys written by newer builds (e.g. labelLiteral). Name that case so a
  // one-way-door file reads as a version problem, not corruption.
  const newerVersionHint = result.issues.some((issue) => /unrecognized key/i.test(issue.message) ||
    (issue.path.endsWith(".type") && /discriminator/i.test(issue.message)) ||
    (issue.path.endsWith(".tableVersion") && /literal/i.test(issue.message)))
    ? " The file may have been saved by a newer version of ChemDraft."
    : "";
  throw new Error(`Unsupported or invalid ChemDraft document: ${detail}${newerVersionHint}`);
}

// tableVersion is the hook for future table-shape changes.
export function migrateLegacyTableObjects(candidate: unknown): unknown {
  return candidate;
}

export function cloneDocument(document: ChemDraftDocument): ChemDraftDocument {
  return parseDocument(JSON.parse(JSON.stringify(document)) as unknown);
}

export function toIsoTimestamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function formatValidationIssues(issues: DocumentValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
}

function migrateLegacyPageLayouts(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.pages)) {
    return candidate;
  }

  let changed = false;
  const pages = candidate.pages.map((page) => {
    if (!isRecord(page) || "layout" in page) {
      return page;
    }

    const margin = isMargin(page.margin) ? page.margin : undefined;
    const layout = createPageLayout("letter", "portrait", margin);
    changed = true;

    return {
      ...page,
      width: layout.widthPx,
      height: layout.heightPx,
      margin: pageMarginFromLayout(layout),
      layout
    };
  });

  return changed ? { ...candidate, pages } : candidate;
}

const GRAPHIC_STYLE_KEYS: ReadonlySet<string> = new Set(Object.keys(GraphicObjectStyleSchema.shape));
const GRAPHIC_DATA_KEYS: ReadonlySet<string> = new Set(Object.keys(GraphicObjectDataSchema.shape));

// Older `chemdraft.document.v1` graphic objects stored free-form metadata in `style`/`data` and
// encoded arcs as `arcStartDegrees`/`arcAngleDegrees`. The current schema narrows both to strict
// allowlists, so legacy documents are migrated here: arcs are converted to signed radians and any
// remaining unknown keys are dropped so the document validates instead of failing to open.
function migrateLegacyGraphicObjects(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.pages)) {
    return candidate;
  }

  let changed = false;
  const pages = candidate.pages.map((page) => {
    if (!isRecord(page) || !Array.isArray(page.objects)) {
      return page;
    }

    const objects = page.objects.map((object) => {
      if (!isRecord(object) || object.type !== "graphic") {
        return object;
      }

      const nextObject: Record<string, unknown> = { ...object };
      let objectChanged = false;

      if (isRecord(object.data)) {
        const nextData = migrateLegacyGraphicData(object.data);
        if (nextData !== object.data) {
          nextObject.data = nextData;
          objectChanged = true;
        }
      }

      if (isRecord(object.style)) {
        const nextStyle = stripUnknownKeys(object.style, GRAPHIC_STYLE_KEYS);
        if (nextStyle !== object.style) {
          nextObject.style = nextStyle;
          objectChanged = true;
        }
      }

      if (!objectChanged) {
        return object;
      }

      changed = true;
      return nextObject;
    });

    return {
      ...page,
      objects
    };
  });

  return changed ? { ...candidate, pages } : candidate;
}

function migrateLegacyGraphicData(data: Record<string, unknown>): Record<string, unknown> {
  const nextData: Record<string, unknown> = { ...data };
  let changed = false;

  const legacyStartDegrees = finiteNumber(data.arcStartDegrees);
  const legacySweepDegrees = finiteNumber(data.arcAngleDegrees);
  if (legacyStartDegrees !== undefined && finiteNumber(nextData.arcStartRadians) === undefined) {
    nextData.arcStartRadians = degreesToRadians(legacyStartDegrees);
    changed = true;
  }
  if (legacySweepDegrees !== undefined && finiteNumber(nextData.arcSweepRadians) === undefined) {
    // Preserve the legacy sweep direction; a negative legacy sweep encodes a clockwise arc and the
    // current model carries that sign through to rendering.
    nextData.arcSweepRadians = degreesToRadians(legacySweepDegrees);
    changed = true;
  }

  // Drop the now-consumed legacy degree fields plus any other free-form keys the strict
  // graphic-data schema no longer accepts.
  for (const key of Object.keys(nextData)) {
    if (!GRAPHIC_DATA_KEYS.has(key)) {
      delete nextData[key];
      changed = true;
    }
  }

  return changed ? nextData : data;
}

function stripUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowedKeys.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }

  return changed ? next : record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function isMargin(value: unknown): value is { top: number; right: number; bottom: number; left: number } {
  return (
    isRecord(value) &&
    typeof value.top === "number" &&
    typeof value.right === "number" &&
    typeof value.bottom === "number" &&
    typeof value.left === "number"
  );
}
