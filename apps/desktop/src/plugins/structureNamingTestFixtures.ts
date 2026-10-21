import type { MoleculeObject } from "@chemdraft/chem-core";
import type { PluginManifest } from "@chemdraft/plugin-api";
import { vi } from "vitest";
import type { StructureNamingEngine, StructureNamingEngineStatus, StructureNamingRawResult } from "./structureNamingEngine";

export const namingMolecule: MoleculeObject = {
  id: "m1", type: "molecule", x: 0, y: 0, width: 20, height: 10, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CCO",
  atoms: [{ id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
    { id: "a2", element: "C", x: 10, y: 0, formalCharge: 0 },
    { id: "a3", element: "O", x: 20, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
    { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }], superatoms: [], rGroups: []
};
export const namingInstalled: StructureNamingEngineStatus = {
  state: "installed", requiredDiskBytes: 1e9, freeDiskBytes: 8e9,
  installed: { receiptVersion: 1, engineDir: "naming-engine", uvVersion: "0.12.18", uvAsset: "test", uvSha256: "test",
    pythonVersion: "3.12", orthonymVersion: "1.0.8", orthonymCommit: "461987b947f76e41ff0baa6c2aa19ecd79cacd0b",
    orthonymWheelSha256: "test", requirementsSha256: "test", centresUrl: "test", centresBytes: 2291742,
    centresSha256: "test", installedAt: "2026-10-21", diskBytes: 3e8 }
};
export const namingRaw: StructureNamingRawResult = {
  name: "ethanol", tier: "pin_verified", isPin: true, opsin: "verified", gateOutcome: "self_consistency_verified",
  limitCode: null, stereoUnexpressed: false, source: "pin_path", elapsedMs: 25,
  opsinReadBack: { smiles: "CCO", failureReason: null }
};
export function fakeNamingEngine(status: StructureNamingEngineStatus = namingInstalled): StructureNamingEngine {
  return { status: vi.fn(async () => status), install: vi.fn(async progress => {
    progress({ phase: "verifying", message: "Checking…" }); return namingInstalled;
  }), cancelInstall: vi.fn(async () => undefined), uninstall: vi.fn(async () => ({ ...status, state: "notInstalled" as const })),
  name: vi.fn(async () => namingRaw), cancel: vi.fn(async () => undefined) };
}
export const namingManifest: PluginManifest = {
  id: "org.chemdraft.naming.test", name: "Naming test", version: "1.0.0", apiVersion: "^0.1.7", entry: "index.js",
  permissions: ["chemistry.compute", "native.execute", "selection.read", "ui.panel"],
  contributes: { commands: [{ id: "plugin.namingTest.run", title: "Name", requiredPermissions: [], enabled: true }],
    panels: [{ id: "panel.namingTest.result", title: "Name", requiredPermissions: ["ui.panel"] }], menus: [], toolbarButtons: [], toolsets: [], inspectors: [],
    templates: [], importers: [], exporters: [], analyzers: [], transformers: [], recognizers: [] }
};
