import {
  applyPatch,
  applyPatches,
  createEmptyDocument,
  deserializeDocument,
  serializeDocument,
  type ChemDraftDocument,
  type ChemicalMetadata,
  type CompatibilityWarning,
  type DocumentObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import type { EditorSaveResult } from "@chemdraft/editor-adapter";
import { exportDocumentToSvg, type SvgExportResult } from "@chemdraft/export-engine";

export const phase4Timestamp = "2026-05-29T00:00:00.000Z";

export interface NativeSavePayload {
  filename: string;
  mimeType: "application/vnd.chemdraft+json";
  contents: string;
}

export function createPhase4Document(title = "Untitled.chemdraft"): ChemDraftDocument {
  return createEmptyDocument({
    title,
    now: phase4Timestamp
  });
}

export function createAdapterFallbackMolecule(
  document: ChemDraftDocument,
  analysis?: StructureAnalysisResult
): MoleculeObject {
  const id = nextObjectId(document, "mol_adapter");

  return {
    id,
    type: "molecule",
    x: 180,
    y: 220,
    width: 190,
    height: 96,
    rotation: 0,
    style: {
      source: "editor-adapter-fallback"
    },
    compatibility: {
      sourceFormat: "editor-adapter-fallback",
      warnings: [
        {
          code: "editor.adapter_fallback",
          message: "Inserted through the Phase 4 adapter-backed fallback because no drawing engine is connected."
        }
      ],
      unknown: {}
    },
    structureFormat: "smiles",
    structure: analysis?.input.value ?? "CCO",
    chemistry: analysis ? chemistryMetadataFromAnalysis(analysis) : undefined,
    superatoms: [],
    rGroups: []
  };
}

export function insertAdapterFallbackMolecule(
  document: ChemDraftDocument,
  analysis?: StructureAnalysisResult
): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    throw new Error("Cannot insert adapter fallback molecule: document has no pages.");
  }

  const object = createAdapterFallbackMolecule(document, analysis);
  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function getSelectedObject(document: ChemDraftDocument): DocumentObject | undefined {
  const selectedObjectId = document.selection.objectIds[0];
  if (!selectedObjectId) {
    return undefined;
  }

  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === selectedObjectId);
    if (object) {
      return object;
    }
  }

  return undefined;
}

export function getSelectedMolecule(document: ChemDraftDocument): MoleculeObject | undefined {
  const object = getSelectedObject(document);
  return object?.type === "molecule" ? object : undefined;
}

export function applyAnalysisToSelectedMolecule(
  document: ChemDraftDocument,
  analysis: StructureAnalysisResult
): ChemDraftDocument {
  const selectedMolecule = getSelectedMolecule(document);
  if (!selectedMolecule) {
    throw new Error("Cannot apply chemistry analysis: no molecule is selected.");
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: selectedMolecule.id,
      changes: {
        chemistry: chemistryMetadataFromAnalysis(analysis)
      }
    },
    { now: phase4Timestamp }
  );
}

export function applyEditorSaveResultToSelectedObject(
  document: ChemDraftDocument,
  result: EditorSaveResult
): ChemDraftDocument {
  const selectedObject = getSelectedObject(document);
  if (!selectedObject) {
    throw new Error("Cannot apply editor save result: no document object is selected.");
  }
  if (selectedObject.id !== result.object.id) {
    throw new Error(
      `Cannot apply editor save result: selected object "${selectedObject.id}" does not match saved object "${result.object.id}".`
    );
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: result.object.id,
      changes: result.object
    },
    { now: phase4Timestamp }
  );
}

export function createNativeSavePayload(document: ChemDraftDocument): NativeSavePayload {
  return {
    filename: `${sanitizeFilename(document.title.replace(/\.chemdraft$/i, ""))}.chemdraft`,
    mimeType: "application/vnd.chemdraft+json",
    contents: serializeDocument(document)
  };
}

export function openNativeDocument(contents: string): ChemDraftDocument {
  return deserializeDocument(contents);
}

export function exportPhase4Svg(document: ChemDraftDocument): SvgExportResult {
  return exportDocumentToSvg(document, { includeWarnings: true });
}

export function chemistryMetadataFromAnalysis(result: StructureAnalysisResult): ChemicalMetadata {
  return {
    formula: result.properties.formula,
    averageMass: result.properties.averageMass,
    exactMass: result.properties.exactMass,
    atomCount: result.properties.atomCount,
    bondCount: result.properties.bondCount,
    totalCharge: result.properties.totalCharge,
    radicalCount: 0,
    isotopeLabels: [],
    stereochemistry: result.properties.stereochemistry,
    warnings: chemistryWarningsToCompatibilityWarnings(result.warnings)
  };
}

function chemistryWarningsToCompatibilityWarnings(warnings: StructureAnalysisResult["warnings"]): CompatibilityWarning[] {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message
  }));
}

function nextObjectId(document: ChemDraftDocument, prefix: string): string {
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;

  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }

  return id;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized || "Untitled";
}
