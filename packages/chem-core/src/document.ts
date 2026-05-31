import {
  ChemDraftDocumentSchema,
  DocumentObjectSchema,
  DocumentSchemaVersion,
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

  const migrated = migrateLegacyPageLayouts(candidate);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
