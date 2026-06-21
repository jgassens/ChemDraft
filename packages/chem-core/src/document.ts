import {
  ChemDraftDocumentSchema,
  DocumentObjectSchema,
  DocumentSchemaVersion,
  GraphicObjectDataSchema,
  GraphicObjectStyleSchema,
  type ChemDraftDocument,
  type DocumentObject
} from "./schemas";
import { DefaultPageLayout, createPageLayout, pageMarginFromLayout } from "./page-layout";

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
  return JSON.stringify(parseDocument(document), null, 2);
}

export function deserializeDocument(serialized: string): ChemDraftDocument {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(`Native document parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return migrateDocument(parsed);
}

export function migrateDocument(candidate: unknown): ChemDraftDocument {
  const result = validateDocument(candidate);
  if (result.ok) {
    return result.document;
  }

  const migrated = migrateLegacyGraphicObjects(migrateLegacyPageLayouts(candidate));
  if (migrated !== candidate) {
    const migratedResult = validateDocument(migrated);
    if (migratedResult.ok) {
      return migratedResult.document;
    }
  }

  throw new Error(`Unsupported or invalid ChemDraft document: ${formatValidationIssues(result.issues)}`);
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
