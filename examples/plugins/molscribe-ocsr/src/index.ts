import type { MoleculeObject } from "@chemdraft/chem-core";
import type {
  PluginCommandContext,
  PluginCommandHandler,
  PluginManifest,
  RecognitionWarning,
  RecognizedStructureResult
} from "@chemdraft/plugin-api";

export const molscribeOcsrCommandId = "plugin.molscribeOcsr.recognizeImage";
export const molscribeOcsrPanelId = "panel.molscribeOcsr.review";
export const molscribeOcsrRecognizerId = "recognizer.molscribeOcsr.image";

export const mockSourceImageRef = "fixture://molscribe-ocsr/benzene.png";
export const mockBenzeneSmiles = "c1ccccc1";
export const mockBenzeneMolfile = [
  "MolScribe OCSR mock fixture",
  "  ChemDraft",
  "",
  "  0  0  0  0  0  0            999 V3000",
  "M  V30 BEGIN CTAB",
  "M  V30 COUNTS 6 6 0 0 0",
  "M  V30 END CTAB",
  "M  END"
].join("\n");

export const molscribeOcsrManifest: PluginManifest = {
  id: "org.chemdraft.ocsr.molscribe",
  name: "MolScribe OCSR",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  description: "Fixture-backed scaffold for optional image-to-structure recognition.",
  entry: "dist/plugin.js",
  permissions: [
    "image.read",
    "document.proposePatch",
    "analysis.write",
    "ui.menu",
    "ui.panel",
    "plugin.storage"
  ],
  contributes: {
    commands: [
      {
        id: molscribeOcsrCommandId,
        title: "Recognize Structure from Image",
        category: "Tools",
        description: "Mocked fixture recognizer; queues a proposed patch for user review.",
        requiredPermissions: ["image.read", "document.proposePatch", "analysis.write"],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.molscribeOcsr.recognizeImage",
        title: "Recognize Structure from Image",
        commandId: molscribeOcsrCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: molscribeOcsrPanelId,
        title: "MolScribe OCSR Review",
        commandId: molscribeOcsrCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],
    toolbarButtons: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],
    analyzers: [],
    transformers: [],
    recognizers: [
      {
        id: molscribeOcsrRecognizerId,
        title: "MolScribe OCSR Image Recognizer",
        input: "selected-image",
        commandId: molscribeOcsrCommandId,
        requiredPermissions: ["image.read", "document.proposePatch"]
      }
    ]
  }
};

export interface MolScribeOcsrInput {
  sourceImageRef: string;
  pageId?: string;
  insertion?: {
    x: number;
    y: number;
  };
}

export interface MolScribeOcsrPanelState {
  panelId: string;
  title: string;
  sourceImageRef: string;
  proposedSmiles?: string;
  confidencePercent: number;
  warnings: RecognitionWarning[];
  canAccept: boolean;
  proposedPatchReason?: string;
}

export type MolScribeOcsrInputProvider = (
  context: PluginCommandContext
) => MolScribeOcsrInput | Promise<MolScribeOcsrInput>;

const mockWarnings: RecognitionWarning[] = [
  {
    code: "mock-output",
    message: "Fixture-backed scaffold output; no real MolScribe inference was run."
  },
  {
    code: "review-required",
    message: "Recognized chemistry must be reviewed before insertion."
  }
];

export function createMolScribeOcsrCommandHandler(
  inputProvider: MolScribeOcsrInputProvider = () => ({
    sourceImageRef: mockSourceImageRef,
    pageId: "page_001"
  })
): PluginCommandHandler<RecognizedStructureResult> {
  return async (context) => {
    context.requirePermission("image.read");
    context.requirePermission("document.proposePatch");
    context.requirePermission("analysis.write");

    const input = await inputProvider(context);
    const result = runMolScribeOcsrMockRecognition(input);

    await context.storage?.set("lastSourceImageRef", result.sourceImageRef);
    await context.storage?.set("lastRecognitionSummary", {
      sourceImageRef: result.sourceImageRef,
      proposedSmiles: result.proposedSmiles,
      confidence: result.confidence
    });

    if (result.proposedPatch) {
      await context.documents.proposePatch(result.proposedPatch);
    }

    return result;
  };
}

export function runMolScribeOcsrMockRecognition(input: MolScribeOcsrInput): RecognizedStructureResult {
  return {
    sourceImageRef: input.sourceImageRef,
    proposedSmiles: mockBenzeneSmiles,
    proposedMolfile: mockBenzeneMolfile,
    confidence: 0.91,
    atomConfidence: [
      { id: "a1", confidence: 0.92 },
      { id: "a2", confidence: 0.9 },
      { id: "a3", confidence: 0.91 },
      { id: "a4", confidence: 0.89 },
      { id: "a5", confidence: 0.92 },
      { id: "a6", confidence: 0.9 }
    ],
    bondConfidence: [
      { id: "b1", confidence: 0.88 },
      { id: "b2", confidence: 0.9 },
      { id: "b3", confidence: 0.89 },
      { id: "b4", confidence: 0.9 },
      { id: "b5", confidence: 0.88 },
      { id: "b6", confidence: 0.89 }
    ],
    warnings: mockWarnings,
    proposedPatch: {
      reason: "molscribe-ocsr.mock-recognition",
      warnings: mockWarnings,
      requiresUserApproval: true,
      patch: {
        op: "addObject",
        pageId: input.pageId ?? "page_001",
        object: createMockBenzeneObject(input)
      }
    }
  };
}

export function createMolScribeOcsrPanelState(result: RecognizedStructureResult): MolScribeOcsrPanelState {
  return {
    panelId: molscribeOcsrPanelId,
    title: "MolScribe OCSR Review",
    sourceImageRef: result.sourceImageRef,
    proposedSmiles: result.proposedSmiles,
    confidencePercent: Math.round(result.confidence * 100),
    warnings: result.warnings,
    canAccept: Boolean(result.proposedPatch),
    proposedPatchReason: result.proposedPatch?.reason
  };
}

function createMockBenzeneObject(input: MolScribeOcsrInput): MoleculeObject {
  return {
    id: "mol_molscribe_mock_benzene",
    type: "molecule",
    x: input.insertion?.x ?? 96,
    y: input.insertion?.y ?? 96,
    width: 180,
    height: 140,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: mockBenzeneSmiles,
    chemistry: {
      atomCount: 6,
      bondCount: 6,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: [],
    compatibility: {
      sourceFormat: "molscribe-ocsr-mock",
      warnings: [
        {
          code: "mock-output",
          message: "Fixture-backed MolScribe OCSR scaffold output."
        }
      ],
      unknown: {
        sourceImageRef: input.sourceImageRef
      }
    }
  };
}
