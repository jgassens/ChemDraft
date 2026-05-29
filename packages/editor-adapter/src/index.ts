import type { DocumentObject } from "@chemdraft/chem-core";

export interface Disposable {
  dispose(): void;
}

export type EditorFormat = "molfile-v2000" | "molfile-v3000" | "rxnfile" | "smiles" | "svg";

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
  warnings: ["No drawing engine has been connected through EditorAdapter."]
};
