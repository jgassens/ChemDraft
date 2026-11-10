import { beforeAll, describe, expect, it } from "vitest";
import { Acs1996StylePreset, RscJournalStylePreset, applyPatches, createEmptyDocument,
  ChemDraftDocumentSchema, snapshotChemicalIdentity, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { applyNativeStylePreset, documentDrawingDefaults, createSmilesMolecule,
  pastedStructureDepictionFromMolfile, nativeSingleBondGraphMetadata, expandNativeMoleculeLabelGroups,
  createNativeTextObject } from "../src/index";
import { ensureRdkit, generateSmiles2DMolfile } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";

beforeAll(() => installRealRdkitModuleLoader());

async function fixture() {
  const document = createEmptyDocument();
  for (const [index, smiles] of ["C[NH3+]", "[13CH3]CO", "[CH2]C", "N[C@@H](C)C(=O)O", "C/C=C/C"].entries()) {
    const molfile = await generateSmiles2DMolfile(smiles);
    const object = createSmilesMolecule(document, { x: 140 + index * 90, y: 150 },
      pastedStructureDepictionFromMolfile(molfile), smiles, undefined, { bondLengthPx: 30 });
    object.id = `m${index}`;
    if (index === 2) object.atoms[0]!.markRadicals = 1;
    object.atoms[0]!.labelOffset = { x: 3, y: -2 };
    document.pages[0]!.objects.push(object);
  }
  const stereo = structuredClone(document.pages[0]!.objects[3]) as MoleculeObject;
  stereo.id = "hashed";
  stereo.bonds = stereo.bonds.map(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? "")
    ? { ...bond, display: { ...bond.display, bondStyle: bond.display?.bondStyle === "wedge" ? "hashed" as const : "wedge" as const } } : bond);
  document.pages[0]!.objects.push(stereo);
  const superatom = structuredClone(document.pages[0]!.objects[0]) as MoleculeObject;
  superatom.id = "superatom";
  superatom.atoms[0]!.element = "Me";
  superatom.superatoms = [{ label: "Me", attachmentPoints: [], warnings: [], expandedStructureFormat: "smiles", expandedStructure: "C" }];
  superatom.rGroups = [{ label: "R1", querySemantics: "display-only", attachmentPoints: [], warnings: [] }];
  document.pages[0]!.objects.push(superatom);
  document.pages[0]!.objects.push(
    { id: "caption", type: "text", x: 100, y: 250, width: 90, height: 30, rotation: 12,
      text: "H2O", style: { color: "blue" }, spans: [
        { text: "H", script: "normal", style: { fontFamily: "Courier", fontSizePx: 28, fontWeight: 700 } },
        { text: "2", script: "subscript", style: {} }, { text: "O", script: "normal", style: {} }] },
    { id: "reaction", type: "reaction", x: 50, y: 90, width: 400, height: 100, rotation: 0, style: {},
      components: [{ role: "reactant", objectId: "m0" }, { role: "agent", objectId: "m1" }, { role: "product", objectId: "m3" }],
      conditionsTextObjectIds: ["caption"], mappingState: "absent" },
    { id: "mechanism", type: "mechanism-arrow", x: 100, y: 110, width: 60, height: 40, rotation: 0, style: {},
      arrowKind: "full-headed", source: { kind: "point", point: { x: 100, y: 110 } },
      target: { kind: "point", point: { x: 160, y: 150 } }, controlPoints: [{ x: 125, y: 90 }], warnings: [] }
  );
  return ChemDraftDocumentSchema.parse(document);
}

function apply(document: ChemDraftDocument, presetId: string, scope: "document" | "selection") {
  const batch = applyNativeStylePreset(document, presetId, scope);
  expect(batch.op).toBe("batch");
  return applyPatches(document, batch.patches, { now: document.updatedAt });
}

async function canonical(molecule: MoleculeObject) {
  const module = await ensureRdkit();
  const expanded = expandNativeMoleculeLabelGroups(molecule).molecule;
  const raw = module.get_mol(moleculeToMolfileV2000(expanded, {
    fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders
  }).contents);
  if (!raw) throw new Error("Fixture molfile could not be parsed");
  try { return raw.get_smiles!(); } finally { raw.delete(); }
}

describe("applyNativeStylePreset", () => {
  it.each([Acs1996StylePreset, RscJournalStylePreset])("preserves chemistry and scales uniformly about each centre: $id", async preset => {
    const document = await fixture();
    const before = structuredClone(document);
    const result = apply(document, preset.id, "document");
    expect(document).toEqual(before);
    expect(ChemDraftDocumentSchema.safeParse(result).success).toBe(true);
    const molecules = document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
    expect(molecules.some(molecule => molecule.atoms.some(atom => atom.formalCharge !== 0))).toBe(true);
    expect(molecules.some(molecule => molecule.atoms.some(atom => atom.isotope))).toBe(true);
    expect(molecules.some(molecule => molecule.atoms.some(atom => atom.markRadicals))).toBe(true);
    expect(molecules.some(molecule => molecule.bonds.some(bond => bond.display?.bondStyle === "wedge"))).toBe(true);
    expect(molecules.some(molecule => molecule.bonds.some(bond => bond.display?.bondStyle === "hashed"))).toBe(true);
    for (const original of molecules) {
      const styled = result.pages[0]!.objects.find(object => object.id === original.id) as MoleculeObject;
      expect(snapshotChemicalIdentity(styled)).toEqual(snapshotChemicalIdentity(original));
      expect(nativeSingleBondGraphMetadata(styled.atoms, styled.bonds)).toEqual(nativeSingleBondGraphMetadata(original.atoms, original.bonds));
      expect(await canonical(styled)).toBe(await canonical(original));
      expect(styled.bonds).toEqual(original.bonds);
      expect(styled.superatoms).toEqual(original.superatoms);
      expect(styled.rGroups).toEqual(original.rGroups);
      expect(styled.atoms).toHaveLength(original.atoms.length);
      const centre = (axis: "x" | "y") => (Math.min(...original.atoms.map(atom => atom[axis])) + Math.max(...original.atoms.map(atom => atom[axis]))) / 2;
      const bondLengths = (molecule: MoleculeObject) => molecule.bonds.map(bond => {
        const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
        const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
        return Math.hypot(to.x - from.x, to.y - from.y);
      }).sort((a, b) => a - b);
      const lengths = bondLengths(styled);
      const median = (lengths[Math.floor((lengths.length - 1) / 2)]! + lengths[Math.floor(lengths.length / 2)]!) / 2;
      expect(median).toBeCloseTo(preset.drawing.bondLengthPx, 9);
      const scale = lengths[0]! / bondLengths(original)[0]!;
      original.atoms.forEach((atom, index) => {
        const next = styled.atoms[index]!;
        for (const axis of ["x", "y"] as const) expect(next[axis]).toBeCloseTo(centre(axis) + (atom[axis] - centre(axis)) * scale, 9);
        const { x: _x, y: _y, labelOffset: _offset, ...identity } = atom;
        const { x: _nx, y: _ny, labelOffset: _nextOffset, ...nextIdentity } = next;
        expect(nextIdentity).toEqual(identity);
        if (atom.labelOffset) {
          expect(next.labelOffset!.x).toBeCloseTo(atom.labelOffset.x * scale, 9);
          expect(next.labelOffset!.y).toBeCloseTo(atom.labelOffset.y * scale, 9);
        }
      });
    }
    for (const id of ["reaction", "mechanism"]) {
      expect(result.pages[0]!.objects.find(object => object.id === id)).toEqual(document.pages[0]!.objects.find(object => object.id === id));
    }
    expect(result.selection.objectIds).toEqual([...molecules.map(molecule => molecule.id), "caption"]);
    expect(documentDrawingDefaults(result).drawing).toEqual(preset.drawing);
    expect(documentDrawingDefaults(result).textStyle).toMatchObject({ fontSizePx: preset.drawing.atomLabelFontSizePx, fontWeight: 400 });
    expect(applyNativeStylePreset(result, preset.id, "document").patches).toEqual([]);
    expect(apply(result, preset.id, "document")).toBe(result);
  });

  it("styles only selected molecules/text and keeps all other objects and defaults untouched", async () => {
    const document = await fixture();
    document.selection = { pageId: document.pages[0]!.id, objectIds: ["m0", "caption", "mechanism"] };
    const result = apply(document, Acs1996StylePreset.id, "selection");
    for (const original of document.pages[0]!.objects) {
      const next = result.pages[0]!.objects.find(object => object.id === original.id)!;
      if (!["m0", "caption"].includes(original.id)) expect(next).toEqual(original);
    }
    expect(result.styles).toEqual(document.styles);
    expect(result.selection.objectIds).toEqual(["m0", "caption"]);
    const caption = result.pages[0]!.objects.find(object => object.id === "caption")!;
    if (caption.type !== "text") throw new Error("Expected text");
    expect(caption.spans[1]!.script).toBe("subscript");
    expect(caption.spans[0]!.style).toMatchObject({ fontSizePx: Acs1996StylePreset.drawing.atomLabelFontSizePx, fontWeight: 400 });
    expect(caption.style.color).toBe("blue");
    expect(applyNativeStylePreset(result, Acs1996StylePreset.id, "selection").patches).toEqual([]);
  });

  it("sets insertion defaults on an empty document and refuses unknown presets", () => {
    const document = createEmptyDocument();
    expect(applyNativeStylePreset(document, Acs1996StylePreset.id, "selection").patches).toEqual([]);
    const styled = apply(document, Acs1996StylePreset.id, "document");
    expect(documentDrawingDefaults(styled).drawing).toEqual(Acs1996StylePreset.drawing);
    expect(createNativeTextObject(styled, { x: 100, y: 100 }, "New caption").style)
      .toMatchObject({ fontFamily: Acs1996StylePreset.drawing.atomLabelFontFamily,
        fontSizePx: Acs1996StylePreset.drawing.atomLabelFontSizePx, fontWeight: 400 });
    const molecule = createSmilesMolecule(styled, { x: 100, y: 100 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "CC");
    expect(molecule.style).toMatchObject(Acs1996StylePreset.drawing);
    expect(() => applyNativeStylePreset(document, "missing", "document")).toThrow("Unknown native style preset");
  });

  it("handles grouped selections, all pages, and native edits larger than an external batch", () => {
    const document = createEmptyDocument();
    const first = document.pages[0]!;
    first.objects = [createNativeTextObject(document, { x: 100, y: 100 }, "First")];
    first.objects.push({ id: "group", type: "group", x: 0, y: 0, width: 200, height: 200, rotation: 0,
      style: {}, childObjectIds: [first.objects[0]!.id] });
    document.pages.push({ ...first, id: "second", objects: Array.from({ length: 300 }, (_, index) => ({
      ...first.objects[0]!, id: `text-${index}`
    })) });
    document.selection = { pageId: first.id, objectIds: ["group"] };
    const selected = apply(document, RscJournalStylePreset.id, "selection");
    expect(selected.pages[1]).toEqual(document.pages[1]);
    expect(selected.pages[0]!.objects[0]!.style.stylePresetId).toBe(RscJournalStylePreset.id);
    expect(selected.pages[0]!.objects[1]).toEqual(first.objects[1]);
    const all = apply(document, RscJournalStylePreset.id, "document");
    expect(all.pages[1]!.objects.every(object => object.style.stylePresetId === RscJournalStylePreset.id)).toBe(true);
    expect(all.selection).toEqual({ pageId: first.id, objectIds: [first.objects[0]!.id] });
    expect(applyNativeStylePreset(all, RscJournalStylePreset.id, "document").patches).toEqual([]);
  });
});
