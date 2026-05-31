import type { DocumentObject } from "@chemdraft/chem-core";

export interface Disposable {
  dispose(): void;
}

export type EditorFormat = "molfile-v2000" | "molfile-v3000" | "rxnfile" | "smiles" | "svg";
export type EditorCapabilityGapSeverity = "info" | "warning" | "error";
export type EditorObjectType = DocumentObject["type"];

export interface EditorCapabilityGap {
  code: string;
  severity: EditorCapabilityGapSeverity;
  affectedObjectTypes: readonly EditorObjectType[];
  message: string;
}

export interface EditorCapabilityReport {
  connected: boolean;
  implementationName: string;
  implementationVersion?: string;
  supportedFormats: readonly EditorFormat[];
  canEditMolecules: boolean;
  canEditReactions: boolean;
  canEditStereochemistry: boolean;
  canEditSuperatoms: boolean;
  canEditRGroups: boolean;
  canEditSGroups: boolean;
  canUseTemplates: boolean;
  canRenderMechanismAnnotations: boolean;
  canEditPageLayoutObjects: boolean;
  gaps: readonly EditorCapabilityGap[];
  warnings: readonly string[];
}

export type EditorCapabilities = EditorCapabilityReport;

export interface EditorLoadRequest {
  object: DocumentObject;
  format?: EditorFormat;
}

export interface EditorSaveResult {
  object: DocumentObject;
  warnings: readonly string[];
}

export interface EditorSelectionSnapshot {
  objectIds: readonly string[];
  atomIds: readonly string[];
  bondIds: readonly string[];
}

export type EditorChangeReason = "content" | "selection" | "capabilities" | "focus" | "error";

export interface EditorChangeEvent {
  reason: EditorChangeReason;
  warnings?: readonly string[];
}

export type EditorChangeListener = (event: EditorChangeEvent) => void;

export interface EditorAdapter {
  readonly id: string;
  focus(): void;
  clear(): Promise<void>;
  loadObject(request: EditorLoadRequest): Promise<void>;
  saveObject(): Promise<EditorSaveResult>;
  getSelection(): Promise<EditorSelectionSnapshot>;
  exportSvg(): Promise<string>;
  getCapabilities(): EditorCapabilityReport;
  onChange(listener: EditorChangeListener): Disposable;
}

export class EditorAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EditorAdapterError";
    this.code = code;
  }
}

export const pageLevelEditorGaps: readonly EditorCapabilityGap[] = [
  {
    code: "editor.gap.mechanism_annotations",
    severity: "warning",
    affectedObjectTypes: ["mechanism-arrow", "electron-mark"],
    message: "Mechanism annotations are ChemDraft page objects and are not editable inside the structure editor."
  },
  {
    code: "editor.gap.page_layout",
    severity: "warning",
    affectedObjectTypes: [
      "reaction-arrow",
      "text",
      "bracket",
      "graphic",
      "plus",
      "group",
      "annotation",
      "unknown-compatibility-object"
    ],
    message: "Page layout objects remain owned by chem-core and layout packages, not by the structure editor."
  },
  {
    code: "editor.gap.superatoms_rgroups",
    severity: "warning",
    affectedObjectTypes: ["molecule", "superatom", "r-group-label", "generic-atom-label"],
    message: "Superatom, R-group, and generic-atom metadata are preserved by ChemDraft but not yet editable through the structure editor."
  }
];

export const disconnectedEditorCapabilities: EditorCapabilityReport = {
  connected: false,
  implementationName: "EditorAdapter not connected",
  supportedFormats: [],
  canEditMolecules: false,
  canEditReactions: false,
  canEditStereochemistry: false,
  canEditSuperatoms: false,
  canEditRGroups: false,
  canEditSGroups: false,
  canUseTemplates: false,
  canRenderMechanismAnnotations: false,
  canEditPageLayoutObjects: false,
  gaps: pageLevelEditorGaps,
  warnings: ["No drawing engine has been connected through EditorAdapter."]
};
