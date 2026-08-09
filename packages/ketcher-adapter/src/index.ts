import {
  EditorAdapterError,
  pageLevelEditorGaps,
  type Disposable,
  type EditorAdapter,
  type EditorCapabilityReport,
  type EditorChangeEvent,
  type EditorChangeListener,
  type EditorFormat,
  type EditorLoadRequest,
  type EditorSaveResult,
  type EditorSelectionSnapshot
} from "@chemdraft/editor-adapter";

export const ketcherAdapterStatus = "host-adapter" as const;
export type KetcherMoleculeFormat = Extract<EditorFormat, "molfile-v2000" | "molfile-v3000" | "smiles">;

export interface KetcherStructurePayload {
  format: KetcherMoleculeFormat;
  value: string;
}

export interface KetcherStructureSaveResult extends KetcherStructurePayload {
  warnings?: readonly string[];
}

export interface KetcherEngineHost {
  readonly version?: string;
  focus?(): void;
  clear(): void | Promise<void>;
  loadMolecule(payload: KetcherStructurePayload): void | Promise<void>;
  saveMolecule(format: KetcherMoleculeFormat): KetcherStructureSaveResult | Promise<KetcherStructureSaveResult>;
  exportSvg?(): string | Promise<string>;
  getSelection?(): EditorSelectionSnapshot | Promise<EditorSelectionSnapshot>;
  onChange?(listener: EditorChangeListener): Disposable | (() => void);
}

export type KetcherRuntimeMolfileFormat = "v2000" | "v3000";

export interface KetcherRuntimeApi {
  readonly version?: string;
  setMolecule(structure: string, options?: { needZoom?: boolean }): Promise<void | undefined>;
  getSmiles?(isExtended?: boolean): Promise<string>;
  getMolfile?(format?: KetcherRuntimeMolfileFormat): Promise<string>;
  generateImage?(data: string, options?: { outputFormat?: "svg" | "png" }): Promise<Blob>;
  setZoom?(value: number): void;
}

export interface CreateKetcherAdapterOptions {
  engine?: KetcherEngineHost;
  implementationVersion?: string;
  preferredSaveFormat?: KetcherMoleculeFormat;
  supportedFormats?: readonly KetcherMoleculeFormat[];
}

const defaultSupportedFormats = ["molfile-v2000", "molfile-v3000", "smiles"] satisfies KetcherMoleculeFormat[];

export function createKetcherEngineHost(ketcher: KetcherRuntimeApi): KetcherEngineHost {
  return {
    version: ketcher.version,
    clear() {
      return ketcher.setMolecule("", { needZoom: true });
    },
    loadMolecule(payload) {
      return ketcher.setMolecule(payload.value, { needZoom: true });
    },
    async saveMolecule(format) {
      if (format === "smiles") {
        if (!ketcher.getSmiles) {
          throw new EditorAdapterError("editor.format_unavailable", "Ketcher runtime cannot export SMILES.");
        }

        return {
          format,
          value: await ketcher.getSmiles()
        };
      }

      if (!ketcher.getMolfile) {
        throw new EditorAdapterError("editor.format_unavailable", "Ketcher runtime cannot export Molfile.");
      }

      return {
        format,
        value: await ketcher.getMolfile(format === "molfile-v2000" ? "v2000" : "v3000")
      };
    },
    async exportSvg() {
      if (!ketcher.generateImage || !ketcher.getMolfile) {
        throw new EditorAdapterError("editor.svg_unavailable", "Ketcher runtime cannot export SVG.");
      }

      const molfile = await ketcher.getMolfile("v3000");
      const image = await ketcher.generateImage(molfile, { outputFormat: "svg" });
      return image.text();
    }
  };
}

export const ketcherAdapterDisconnectedCapabilities: EditorCapabilityReport = {
  connected: false,
  implementationName: "KetcherAdapter",
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
  warnings: ["Ketcher engine host is not connected."]
};

export function createKetcherAdapter(options: CreateKetcherAdapterOptions = {}): EditorAdapter {
  const supportedFormats = [...(options.supportedFormats ?? defaultSupportedFormats)];
  const preferredSaveFormat = options.preferredSaveFormat ?? "molfile-v3000";
  let loadedObject: EditorLoadRequest["object"] | undefined;
  const listeners = new Set<EditorChangeListener>();
  let engineUnlisten: Disposable | (() => void) | undefined;

  const emitChange = (event: EditorChangeEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const ensureEngineListener = () => {
    if (!engineUnlisten) {
      engineUnlisten = options.engine?.onChange?.((event) => emitChange(event));
    }
  };

  return {
    id: "ketcher",
    focus() {
      options.engine?.focus?.();
    },
    async clear() {
      const engine = ensureEngine(options.engine);
      loadedObject = undefined;
      await engine.clear();
      emitChange({ reason: "content" });
    },
    async loadObject(request) {
      const engine = ensureEngine(options.engine);
      if (request.object.type !== "molecule") {
        throw new EditorAdapterError(
          "editor.unsupported_object",
          `KetcherAdapter can load molecule objects only; received "${request.object.type}".`
        );
      }

      const format = request.format ?? request.object.structureFormat;
      if (!isKetcherMoleculeFormat(format)) {
        throw new EditorAdapterError(
          "editor.unsupported_format",
          `KetcherAdapter cannot load "${format}" structures as editable molecules.`
        );
      }
      if (!supportedFormats.includes(format)) {
        throw new EditorAdapterError(
          "editor.unsupported_format",
          `KetcherAdapter cannot load "${format}" structures.`
        );
      }

      // Record the object only once the engine actually holds it. Assigning first meant a rejected
      // load left the adapter claiming the new object while the engine still had the previous
      // molecule, so the next save wrote the old structure under the new object's id.
      await engine.loadMolecule({ format, value: request.object.structure });
      loadedObject = request.object;
      emitChange({ reason: "content", warnings: warningStringsForObject(request.object) });
    },
    async saveObject(): Promise<EditorSaveResult> {
      const engine = ensureEngine(options.engine);
      if (!loadedObject) {
        throw new EditorAdapterError("editor.empty_session", "KetcherAdapter has no loaded molecule to save.");
      }
      if (loadedObject.type !== "molecule") {
        throw new EditorAdapterError(
          "editor.unsupported_object",
          `KetcherAdapter can save molecule objects only; loaded "${loadedObject.type}".`
        );
      }

      const result = await engine.saveMolecule(preferredSaveFormat);
      const warnings = [...warningStringsForObject(loadedObject), ...(result.warnings ?? [])];

      return {
        object: {
          ...loadedObject,
          structureFormat: result.format,
          structure: result.value,
          compatibility: {
            sourceFormat: result.format,
            originalId: loadedObject.compatibility?.originalId,
            warnings: [
              ...(loadedObject.compatibility?.warnings ?? []),
              ...warnings.map((message) => ({
                code: "editor.adapter_warning",
                message,
                objectId: loadedObject?.id
              }))
            ],
            unknown: loadedObject.compatibility?.unknown ?? {}
          }
        },
        warnings
      };
    },
    async getSelection() {
      return (
        (await options.engine?.getSelection?.()) ?? {
          objectIds: loadedObject ? [loadedObject.id] : [],
          atomIds: [],
          bondIds: []
        }
      );
    },
    async exportSvg() {
      const engine = ensureEngine(options.engine);
      if (engine.exportSvg) {
        return engine.exportSvg();
      }

      throw new EditorAdapterError("editor.svg_unavailable", "KetcherAdapter host does not expose SVG export.");
    },
    getCapabilities() {
      if (!options.engine) {
        return ketcherAdapterDisconnectedCapabilities;
      }

      return {
        connected: true,
        implementationName: "KetcherAdapter",
        implementationVersion: options.implementationVersion ?? options.engine.version,
        supportedFormats,
        canEditMolecules: true,
        canEditReactions: false,
        canEditStereochemistry: true,
        canEditSuperatoms: false,
        canEditRGroups: false,
        canEditSGroups: false,
        canUseTemplates: false,
        canRenderMechanismAnnotations: false,
        canEditPageLayoutObjects: false,
        gaps: pageLevelEditorGaps,
        warnings: [
          "KetcherAdapter edits one molecule object at a time; chem-core remains the composited page source of truth.",
          "Reaction objects, mechanism annotations, page layout, superatoms, and R-group metadata are outside this adapter boundary."
        ]
      };
    },
    onChange(listener) {
      listeners.add(listener);
      ensureEngineListener();
      return {
        dispose() {
          listeners.delete(listener);
          if (listeners.size === 0) {
            disposeEngineListener(engineUnlisten);
            engineUnlisten = undefined;
          }
        }
      };
    }
  };
}

function ensureEngine(engine: KetcherEngineHost | undefined): KetcherEngineHost {
  if (!engine) {
    throw new EditorAdapterError("editor.engine_not_connected", "Ketcher engine host is not connected.");
  }

  return engine;
}

function isKetcherMoleculeFormat(format: string): format is KetcherMoleculeFormat {
  return format === "molfile-v2000" || format === "molfile-v3000" || format === "smiles";
}

function disposeEngineListener(disposable: Disposable | (() => void) | undefined): void {
  if (!disposable) {
    return;
  }

  if (typeof disposable === "function") {
    disposable();
    return;
  }

  disposable.dispose();
}

function warningStringsForObject(object: EditorLoadRequest["object"]): string[] {
  if (object.type !== "molecule") {
    return [];
  }

  const warnings: string[] = [];
  if (object.superatoms.length > 0) {
    warnings.push("Superatom metadata is preserved on the ChemDraft object but is not editable through KetcherAdapter.");
  }
  if (object.rGroups.length > 0) {
    warnings.push("R-group metadata is preserved on the ChemDraft object but is not editable through KetcherAdapter.");
  }

  return warnings;
}
