import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, moleculeToMolfileV3000, type BracketObject, type MoleculeObject } from "@chemdraft/chem-core";
import type { BuiltSmilesDocument } from "../document";
import * as documentBuilder from "../document";
import { exportPerJobFormat, runExportCommand } from "./export";
import { installNodeEngines } from "../engine";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

describe("CLI bracket context", () => {
  it.each(["sru", "multiple"] as const)("warns on MOL, SDF and SMILES export of %s members", async bracketUsage => {
    installNodeEngines();
    const molecule: MoleculeObject = { id: "m", type: "molecule", x: 50, y: 50, width: 20, height: 20, rotation: 0, style: {},
      structure: "", structureFormat: "unknown", atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "b", element: "O", x: 20, y: 0, formalCharge: 0 }], bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single" }], superatoms: [], rGroups: [] };
    const built: BuiltSmilesDocument = { document: createEmptyDocument(), molecule, name: "synthetic", smiles: "CO", engine: "rdkit",
      stereoCenters: 0, unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0, dativeBonds: 0, sourceCanonicalSmiles: "CO",
      identityVerifiedByRdkit: true, identityMolfile: moleculeToMolfileV3000(molecule, { kekuleBondOrders: new Map() }).contents, warnings: [] };
    built.document.pages[0].objects = [molecule];
    const bracket: BracketObject = { id: "open", type: "bracket", bracketKind: "square", side: "open", pairId: "p", bracketUsage,
      repeatCount: bracketUsage === "multiple" ? 3 : undefined, x: 10, y: 10, width: 10, height: 100, rotation: 0, style: {}, containedObjectIds: [built.molecule.id] };
    built.document.pages[0].objects.push(bracket, { ...bracket, id: "close", side: "close", x: 200, label: "n" });
    const description = bracketUsage === "multiple" ? "multiple group x3" : "repeat unit n";
    expect((await exportPerJobFormat("mol", built)).warnings.some(message => message.includes(description))).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-bracket-export-"));
    directories.push(directory);
    const spy = vi.spyOn(documentBuilder, "buildSmilesDocument").mockResolvedValue(built);
    try {
      for (const format of ["sdf", "smi"]) {
        const lines: string[] = [];
        expect(await runExportCommand(["--smiles", "CO", "--out", join(directory, "one." + format)], { stdout: line => lines.push(line), stderr: () => {} })).toBe(0);
        expect(JSON.parse(lines[0])).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining(description)]) });
      }
    } finally { spy.mockRestore(); }
  });
});
