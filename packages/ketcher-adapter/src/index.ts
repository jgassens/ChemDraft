import type { EditorCapabilities } from "@chemdraft/editor-adapter";

export const ketcherAdapterStatus = "not-implemented" as const;

export const ketcherAdapterPlaceholderCapabilities: EditorCapabilities = {
  connected: false,
  implementationName: "KetcherAdapter placeholder",
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
  warnings: ["Ketcher is not connected yet."]
};
