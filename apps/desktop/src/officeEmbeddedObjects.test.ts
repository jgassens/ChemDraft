import { readFileSync } from "node:fs";
import { Molecule } from "openchemlib";
import { describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { CHEMDRAFT_OLE_CLASSES, OFFICE_EMBEDDED_OBJECT_TYPES, type ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { createPhase4Document, createSelectionClipboardPayload, insertNativeMolfileMolecule, serializeSelectionClipboardPayload } from "./documentWorkflow";
import { officePasteBackDecision } from "./officePasteBack";

// Paste-back and File ▸ Import Structures recognize ChemDraft's objects by the classes the OLE
// server registers; a class added or changed on one side must change on the other.
describe("ChemDraft's OLE classes and formats", () => {
  it("keeps the TypeScript class list identical to the OLE server's classes", () => {
    const source = readFileSync("apps/desktop/src-tauri/src/office_ole/mod.rs", "utf8");
    const classes = [...source.matchAll(
      /const (?:STABLE|DEV): Self = Self \{\s*clsid: "([^"]+)",\s*prog_id: "([^"]+)",\s*independent: "([^"]+)",/g,
    )].map(([, clsid, progId, independentProgId]) => ({ clsid, progId, independentProgId }));
    expect(classes).toHaveLength(2);
    expect(CHEMDRAFT_OLE_CLASSES).toEqual(classes);
  });

  it("reads the same embedded-object formats, in the same order, as the native clipboard reader", () => {
    const source = readFileSync("apps/desktop/src-tauri/src/clipboard_images.rs", "utf8");
    const formats = /OFFICE_EMBEDDED_OBJECT_TYPES: \[&str; 2\] = \[([^\]]+)\]/.exec(source)?.[1];
    expect(formats && [...formats.matchAll(/"([^"]+)"/g)].map(([, name]) => name)).toEqual([...OFFICE_EMBEDDED_OBJECT_TYPES]);
  });
});

const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(moleculeToMolfileV2000(molecule, {
  fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders,
}).contents).toIsomericSmiles();
const molecules = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

describe("paste of a ChemDraft embedded object (AGENTS.md §7)", () => {
  it.each(["C[C@H]([NH3+])C(=O)[O-]", "[13CH3]C#N", "C[n+]1ccccc1"])("keeps the canonical SMILES of %s", async (smiles) => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 200, y: 200 }, depictSmiles2D(smiles).molfile, "molfile-v2000");
    const json = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
    // What the Windows reader returns for a copied ChemDraft object: its class and its ChemDraftDocument text.
    const read: ClipboardReadPayload = {
      types: ["Object Descriptor", "Embedded Object", "image/emf"], textItems: [],
      officeItems: [{ type: "Embedded Object", clsid: CHEMDRAFT_OLE_CLASSES[0]!.clsid, bytesBase64: Buffer.from(json).toString("base64") }],
    };
    const decision = await officePasteBackDecision(read, () => createPhase4Document());
    expect(decision).toMatchObject({ kind: "selection", message: "Pasted the ChemDraft structure from the copied object." });
    if (decision.kind !== "selection") return;
    const pasted = molecules({ ...createPhase4Document(), pages: [{ ...createPhase4Document().pages[0]!, objects: decision.payload.objects }] });
    expect(pasted.map(canonical)).toEqual([canonical(molecules(source)[0]!)]);
  });
});
