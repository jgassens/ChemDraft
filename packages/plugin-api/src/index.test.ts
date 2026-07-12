import { describe, expect, it } from "vitest";
import type { RecognizedStructureResult } from "./index";
import {
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
