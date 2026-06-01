import { describe, expect, it } from "vitest";
import type { RecognizedStructureResult } from "./index";
import {
  RecognizedStructureResultSchema,
  dangerousPluginPermissions,
  parsePluginManifest,
  validatePluginManifest
} from "./index";

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
