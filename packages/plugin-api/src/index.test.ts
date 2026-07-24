import { describe, expect, it } from "vitest";
import pluginApiPackage from "../package.json";
import type { ChemDraftDocument, DocumentPatch, RecognizedStructureResult } from "./index";
import {
  PluginApiVersion,
  PluginPanelReportSchema,
  RecognizedStructureResultSchema,
  createStructureSourceFingerprint,
  dangerousPluginPermissions,
  parsePluginManifest,
  validatePluginManifest
} from "./index";

describe("createStructureSourceFingerprint", () => {
  const base = {
    documentId: "doc1",
    pageId: "page1",
    objectId: "mol1",
    structureFormat: "smiles",
    structure: "c1ccccc1"
  };

  it("is deterministic and returns a fixed-width hex digest", () => {
    const a = createStructureSourceFingerprint(base);
    const b = createStructureSourceFingerprint({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when any identity or payload field changes", () => {
    const original = createStructureSourceFingerprint(base);
    expect(createStructureSourceFingerprint({ ...base, structure: "CCO" })).not.toBe(original);
    expect(createStructureSourceFingerprint({ ...base, objectId: "mol2" })).not.toBe(original);
    expect(createStructureSourceFingerprint({ ...base, pageId: "page2" })).not.toBe(original);
    expect(createStructureSourceFingerprint({ ...base, structureFormat: "molfile-v2000" })).not.toBe(original);
  });

  it("ignores surrounding whitespace in the payload but distinguishes field boundaries", () => {
    expect(createStructureSourceFingerprint({ ...base, structure: "  c1ccccc1  " })).toBe(
      createStructureSourceFingerprint(base)
    );
    // Field-boundary safety: shifting a character across the id/format boundary changes the hash.
    const left = createStructureSourceFingerprint({ ...base, objectId: "molX", structureFormat: "smiles" });
    const right = createStructureSourceFingerprint({ ...base, objectId: "mol", structureFormat: "Xsmiles" });
    expect(left).not.toBe(right);
  });
});

describe("validatePluginManifest", () => {
  it("accepts a manifest with command, menu, panel, toolbar, and recognizer contributions", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.demo",
      name: "Demo Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read", "document.proposePatch", "image.read", "ui.menu", "ui.panel", "ui.toolbar"],
      contributes: {
        commands: [
          {
            id: "plugin.demo.recognize",
            title: "Recognize Image",
            category: "Tools",
            requiredPermissions: ["document.proposePatch", "image.read"]
          }
        ],
        menus: [
          {
            id: "menu.demo.recognize",
            title: "Recognize Image",
            commandId: "plugin.demo.recognize",
            location: "analyze",
            requiredPermissions: ["ui.menu"]
          }
        ],
        panels: [
          {
            id: "panel.demo.review",
            title: "Recognition Review",
            requiredPermissions: ["ui.panel"]
          }
        ],
        toolbarButtons: [
          {
            id: "toolbar.demo.recognize",
            commandId: "plugin.demo.recognize",
            title: "Recognize",
            requiredPermissions: ["ui.toolbar"]
          }
        ],
        recognizers: [
          {
            id: "recognizer.demo.image",
            title: "Image Recognizer",
            commandId: "plugin.demo.recognize",
            input: "selected-image",
            requiredPermissions: ["image.read"]
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.contributes.commands[0].requiredPermissions).toEqual([
      "document.proposePatch",
      "image.read"
    ]);
  });

  it("rejects undeclared permission names", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.bad",
      name: "Bad Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.teleport"]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Unsupported plugin permission "document.teleport".');
  });

  it("rejects contribution ids outside their documented namespaces", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.bad-names",
      name: "Bad Names",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: {
        commands: [{ id: "document.save", title: "Impersonate Save" }],
        menus: [{ id: "plugin.demo.menu", title: "Menu", commandId: "plugin.demo.run" }],
        panels: [{ id: "nmr.results", title: "Results" }],
        analyzers: [{ id: "analysis.demo.main", title: "Analysis", commandId: "plugin.demo.run" }]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Plugin command ids must use the form "plugin.<pluginName>.<name>"'),
        expect.stringContaining('Plugin menu ids must use the form "menu.<pluginName>.<name>"'),
        expect.stringContaining('Plugin panel ids must use the form "panel.<pluginName>.<name>"'),
        expect.stringContaining('Plugin analyzer ids must use the form "analyzer.<pluginName>.<name>"')
      ])
    );
  });

  it("normalizes the legacy analyzer id in already-packaged standalone plugins", () => {
    const manifest = parsePluginManifest({
      id: "org.chemdraft.nmr.predictor",
      name: "NMR Shift Predictor",
      version: "0.1.0",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: {
        commands: [{ id: "plugin.nmrPredictor.predictSelectedStructure", title: "Predict" }],
        analyzers: [
          {
            id: "plugin.nmrPredictor.forwardPrediction",
            title: "NMR Forward Prediction",
            commandId: "plugin.nmrPredictor.predictSelectedStructure"
          }
        ]
      }
    });

    expect(manifest.contributes.analyzers[0]?.id).toBe("analyzer.nmrPredictor.forwardPrediction");
  });

  it("rejects contribution permissions that are not declared by the manifest", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.bad",
      name: "Bad Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"],
      contributes: {
        commands: [
          {
            id: "plugin.bad.write",
            title: "Write",
            requiredPermissions: ["document.proposePatch"]
          }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('undeclared permission "document.proposePatch"')
    ]);
  });

  it("rejects duplicate permissions and duplicate command IDs", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.duplicate",
      name: "Duplicate Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read", "document.read"],
      contributes: {
        commands: [
          { id: "plugin.duplicate.run", title: "Run" },
          { id: "plugin.duplicate.run", title: "Run Again" }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Duplicate permission"),
      expect.stringContaining("Duplicate command id")
    ]);
  });

  it("rejects duplicate menu, panel, and analyzer ids", () => {
    const result = validatePluginManifest({
      id: "org.chemdraft.duplicate-surfaces",
      name: "Duplicate Surfaces",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: {
        commands: [{ id: "plugin.duplicate.run", title: "Run" }],
        menus: [
          { id: "menu.duplicate.run", title: "Run", commandId: "plugin.duplicate.run" },
          { id: "menu.duplicate.run", title: "Run again", commandId: "plugin.duplicate.run" }
        ],
        panels: [
          { id: "panel.duplicate.result", title: "Result" },
          { id: "panel.duplicate.result", title: "Another result" }
        ],
        analyzers: [
          { id: "analyzer.duplicate.main", title: "Analyze", commandId: "plugin.duplicate.run" },
          { id: "analyzer.duplicate.main", title: "Analyze again", commandId: "plugin.duplicate.run" }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Duplicate menu id"),
        expect.stringContaining("Duplicate panel id"),
        expect.stringContaining("Duplicate analyzer id")
      ])
    );
  });

  it("parses default contribution collections for a minimal manifest", () => {
    const manifest = parsePluginManifest({
      id: "org.chemdraft.minimal",
      name: "Minimal Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: []
    });

    expect(manifest.contributes.commands).toEqual([]);
    expect(manifest.contributes.recognizers).toEqual([]);
  });
});

describe("RecognizedStructureResult", () => {
  it("represents a reviewable image-to-structure result with a real proposed patch envelope", () => {
    const result: RecognizedStructureResult = RecognizedStructureResultSchema.parse({
      sourceImageRef: "fixture://benzene.png",
      proposedSmiles: "c1ccccc1",
      proposedMolfile: "mock molfile placeholder",
      confidence: 0.91,
      atomConfidence: [{ id: "a1", confidence: 0.9 }],
      bondConfidence: [{ id: "b1", confidence: 0.88 }],
      warnings: [{ code: "mock-output", message: "Mocked recognition output, not real inference." }],
      proposedPatch: {
        reason: "recognized-structure",
        patch: {
          op: "addObject",
          pageId: "page_001",
          object: {
            id: "mol_001",
            type: "molecule",
            x: 80,
            y: 96,
            width: 160,
            height: 120,
            rotation: 0,
            style: {},
            structureFormat: "smiles",
            structure: "c1ccccc1",
            atoms: [],
            bonds: [],
            superatoms: [],
            rGroups: []
          }
        }
      }
    });

    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.proposedPatch?.requiresUserApproval).toBe(true);
    expect(result.proposedPatch?.patch.op).toBe("addObject");
  });

  it("keeps dangerous permission names explicit for host review surfaces", () => {
    expect(dangerousPluginPermissions).toContain("native.execute");
    expect(dangerousPluginPermissions).toContain("model.download");
  });

  // The patch interior is deliberately `passthrough()` (chem-core owns its shape, and the SDK boundary
  // forbids a runtime chem-core dependency here), which makes this schema the only checkpoint between
  // untrusted worker output and a trusted `applyPatch`. It must at least refuse keys that are dangerous
  // purely by being copied onto a target. `JSON.parse` and `structuredClone` both produce these as real
  // own keys, so a worker really can send one.
  it("refuses a proposed patch carrying a prototype-polluting key", () => {
    const polluted = (patch: unknown) => () =>
      RecognizedStructureResultSchema.parse({
        sourceImageRef: "fixture://x.png",
        confidence: 0.5,
        proposedPatch: { reason: "recognized-structure", patch }
      });

    // Top level, nested in an object, and nested inside an array element.
    expect(polluted(JSON.parse('{"op":"addObject","__proto__":{"polluted":true}}'))).toThrow(/prototype-polluting/);
    expect(polluted(JSON.parse('{"op":"addObject","object":{"__proto__":{"polluted":true}}}'))).toThrow(/prototype-polluting/);
    expect(polluted(JSON.parse('{"op":"addObject","objects":[{"constructor":{"prototype":{}}}]}'))).toThrow(
      /prototype-polluting/
    );

    // Object.prototype must be intact regardless — the guard rejects, it does not merge.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // An ordinary patch with the same shape but no dangerous key still parses.
    expect(
      RecognizedStructureResultSchema.parse({
        sourceImageRef: "fixture://x.png",
        confidence: 0.5,
        proposedPatch: {
          reason: "recognized-structure",
          patch: JSON.parse('{"op":"addObject","pageId":"page_001","object":{"id":"mol_001"}}')
        }
      }).proposedPatch?.patch.op
    ).toBe("addObject");
  });
});

describe("linkedFigure panel section (ADR-0015)", () => {
  const figureReport = {
    title: "NMR Prediction",
    sections: [
      {
        kind: "linkedFigure" as const,
        title: "Predicted ¹H NMR",
        caption: "Hover a peak to highlight its atoms.",
        spectrum: {
          nucleus: "1H",
          domain: { min: 0, max: 8 },
          reversed: true,
          comparison: { primaryLabel: "database", alternativeLabel: "rule", alternativeMarker: "ᵣ" },
          peaks: [
            { id: "h-0", ppm: 7.34, intensity: 2, label: "7.34", atomIndices: [0, 2] },
            { id: "h-5", ppm: 2.43, intensity: 2, atomIndices: [5] }
          ]
        },
        structure: {
          atoms: [
            { index: 0, x: 0, y: 0, element: "C" },
            { index: 2, x: 1.2, y: 0.4, element: "C" },
            { index: 5, x: -0.8, y: 1.1, element: "C" }
          ],
          bonds: [{ from: 0, to: 2, order: 2 }]
        }
      }
    ]
  };

  it("accepts a data-only interactive figure (spectrum + structure geometry)", () => {
    expect(() => PluginPanelReportSchema.parse(figureReport)).not.toThrow();
  });

  it("accepts a figure with no structure (fixture backends omit geometry)", () => {
    const noStructure = {
      ...figureReport,
      sections: [{ ...figureReport.sections[0], structure: undefined }]
    };
    expect(() => PluginPanelReportSchema.parse(noStructure)).not.toThrow();
  });

  it("rejects a stray/script-carrying property (strict, data-only)", () => {
    const withScript = {
      ...figureReport,
      sections: [{ ...figureReport.sections[0], onClick: "alert(1)" }]
    };
    expect(() => PluginPanelReportSchema.parse(withScript)).toThrow();
  });

  it("rejects a negative bond order", () => {
    const badBond = {
      ...figureReport,
      sections: [
        {
          ...figureReport.sections[0],
          structure: { atoms: figureReport.sections[0].structure.atoms, bonds: [{ from: 0, to: 2, order: 0 }] }
        }
      ]
    };
    expect(() => PluginPanelReportSchema.parse(badBond)).toThrow();
  });
});

describe("SDK document-type re-exports (M33 boundary)", () => {
  it("keeps the published package version aligned with the advertised API contract", () => {
    expect(pluginApiPackage.version).toBe(PluginApiVersion);
  });

  it("re-exports ChemDraftDocument and DocumentPatch so plugins never import chem-core directly", () => {
    // Compile-time guarantee: if the SDK stopped re-exporting these, `tsc` (lint) fails here. The
    // runtime assertion just keeps the test non-empty; the value is the typed signature above.
    const identity = (document: ChemDraftDocument | undefined, patch: DocumentPatch | undefined): number =>
      (document ? 1 : 0) + (patch ? 1 : 0);
    expect(identity(undefined, undefined)).toBe(0);
  });
});
