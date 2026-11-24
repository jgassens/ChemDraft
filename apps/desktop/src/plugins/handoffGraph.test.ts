import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type MoleculeObject, type ReactionObject } from "@chemdraft/chem-core";
import { chemicalIdentityMolfile, createSmilesMolecule, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { planBondExtension } from "@chemdraft/layout-engine";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { PluginApiVersion, PluginHandoffGraphResultSchema, ProposedDocumentPatchSchema, type PluginCommandContext } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { createChemistry3dProviders } from "../chemistry3d/client";
import { runChemistry3dJob } from "../chemistry3d/protocol";
import { applyPluginDocumentPatch } from "./applyPluginDocumentPatch";
import { prepareHandoffGraph, suggestConnectionPointsForPlugin } from "./handoffGraph";
import { buildConnectionPointsPatch, verifyConnectionPointEdit } from "./connectionPointEdit";

vi.mock("../chemistry3d/client", async original => ({
  ...await original<typeof import("../chemistry3d/client")>(),
  runHandoffGraphInConformerWorker: (await import("../chemistry3d/handoffAudit")).auditHandoffGraph
}));

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const request = { objectId: "m1" };
const signal = () => new AbortController().signal;
const providers = createChemistry3dProviders(job => runChemistry3dJob(job));
const frame = { x: 50, y: 50, width: 200, height: 160, rotation: 0, style: {} };

function molecule(elements: string[], links: [number, number, MoleculeObject["bonds"][number]["order"]?][] = []): MoleculeObject {
  return { ...frame, id: request.objectId, type: "molecule", structure: "CC", structureFormat: "smiles",
    atoms: elements.map((element, i) => ({ id: `a${i}`, x: 80 + 30 * i, y: i % 2 ? 80 : 100, element, formalCharge: 0 })),
    bonds: links.map(([a, b, order = "single"], i) => ({ id: `b${i}`, fromAtomId: `a${a}`, toAtomId: `a${b}`, order })),
    superatoms: [], rGroups: [] };
}

function selected(mol: MoleculeObject, ...additional: ReactionObject[]): ChemDraftDocument {
  const doc = createEmptyDocument({ id: "d1", pageId: "p1" });
  doc.pages[0]!.objects.push(mol, ...additional);
  doc.selection = { objectIds: [mol.id], pageId: doc.pages[0]!.id };
  return doc;
}

async function audit(doc: ChemDraftDocument) {
  const result = await runChemistry3dJob({ method: "handoffGraph", request: prepareHandoffGraph(request, doc) });
  return PluginHandoffGraphResultSchema.parse(result);
}

function drawAt(mol: MoleculeObject, coordinates: readonly (readonly [number, number])[]): MoleculeObject {
  return { ...mol, structure: "", atoms: mol.atoms.map((atom, i) => ({ ...atom, x: coordinates[i]![0], y: coordinates[i]![1] })) };
}

async function mark(mol: MoleculeObject, anchors = ["a0"]) {
  const doc = selected(mol);
  const { patch, atomIds } = buildConnectionPointsPatch({ ...request, anchors }, mol, doc.pages[0]!);
  const { document } = applyPluginDocumentPatch(doc, ProposedDocumentPatchSchema.parse(patch));
  return verifyConnectionPointEdit(doc, document, { source: mol, pageId: "p1", atomIds, anchors });
}

function tetrahedron(coords: readonly (readonly [number, number])[], style: "wedge" | "hashed") {
  const mol = drawAt(molecule(["C", "F", "Cl", "Br"], [[0, 1], [0, 2], [0, 3]]), coords);
  mol.bonds[0]!.display = { bondStyle: style };
  return mol;
}

async function drawSmiles(smiles: string) {
  const mol = (await ensureRdkit()).get_mol(smiles)!;
  try {
    return { ...createSmilesMolecule(createEmptyDocument(), { x: 200, y: 180 },
      pastedStructureDepictionFromMolfile(mol.get_molblock!()), smiles), id: request.objectId };
  } finally { mol.delete(); }
}

describe("connection point chemistry", () => {
  const drawByHand = /stereochemistry.*Draw X by hand\./;
  it.each(["wedge", "hashed"] as const)("refuses an even-layout %s that would invert when X replaces H", async style => {
    const mol = tetrahedron([[100, 100], [100, 70], [126, 115], [74, 115]], style);
    expect((await audit(selected(mol))).canonicalSmiles).toMatch(/@/);
    await expect(mark(mol)).rejects.toThrow(drawByHand);
  });

  it.each([
    ["fanned", [[120, 120], [155, 120], [153, 130], [145, 145]]],
    ["T", [[120, 120], [120, 85], [155, 120], [85, 120]]]
  ] as const)("refuses a %s tetrahedral layout even when its configuration would be preserved", async (_name, coords) => {
    const mol = tetrahedron(coords, "wedge");
    expect((await audit(selected(mol))).canonicalSmiles).toMatch(/@/);
    await expect(mark(mol)).rejects.toThrow(drawByHand);
  });

  it("refuses a terminal alkene when marking would create double-bond stereo", async () => {
    const mol = drawAt(molecule(["C", "C", "C"], [[0, 1, "double"], [1, 2]]), [[100, 100], [125, 100], [140, 125]]);
    await expect(mark(mol)).rejects.toThrow(/marked molecule.*double-bond stereochemistry.*Draw X by hand\./);
  });

  it.each([[75, "cis"], [125, "trans"]] as const)("refuses existing E/Z when marking an alkene anchor at y=%i", async (y, stereo) => {
    const mol = drawAt(molecule(["C", "C", "C", "C"], [[0, 1, "double"], [0, 2], [1, 3]]),
      [[100, 100], [130, 100], [85, 75], [145, y]]);
    expect((await audit(selected(mol))).graph.bonds[0]!.stereo).toBe(stereo);
    await expect(mark(mol)).rejects.toThrow(drawByHand);
  });

  it("refuses an unassigned stereogenic double bond in a flat drawing", async () => {
    const mol = drawAt(molecule(["C", "C", "C", "C"], [[0, 1, "double"], [0, 2], [1, 3]]),
      [[100, 100], [130, 100], [70, 100], [160, 100]]);
    const { graph, unspecifiedDoubleBonds } = await audit(selected(mol));
    expect(graph.bonds[0]!.stereo).toBe("either");
    expect(unspecifiedDoubleBonds).toEqual([0]);
    await expect(mark(mol, ["a2"])).rejects.toThrow(/original molecule.*double-bond stereochemistry.*Draw X by hand\./);
  });

  it("refuses the entire meso dihalide batch when both centers would invert", async () => {
    const mol = drawAt(molecule(["C", "F", "Cl", "C", "F", "Cl"], [[0, 1], [0, 2], [0, 3], [3, 4], [3, 5]]),
      [[100, 100], [100, 70], [126, 115], [74, 115], [74, 145], [48, 100]]);
    mol.bonds[0]!.display = { bondStyle: "wedge" };
    mol.bonds[3]!.display = { bondStyle: "hashed" };
    const original = structuredClone(mol);
    await expect(mark(mol, ["a0", "a3"])).rejects.toThrow(drawByHand);
    expect(mol).toEqual(original);
  });

  it.each(["wedge", "hashed", "wavy", undefined] as const)("refuses marking one methyl of CC(C)F with %s stereo display", async style => {
    const mol = drawAt(molecule(["C", "F", "C", "C"], [[0, 1], [0, 2], [0, 3]]),
      [[100, 100], [100, 70], [70, 115], [130, 115]]);
    if (style) mol.bonds[0]!.display = { bondStyle: style };
    await expect(mark(mol, ["a2"])).rejects.toThrow(drawByHand);
  });

  it.each([
    ["CCC[C@H](F)CC", "a2"], ["CC(C)(CCCl)[C@H](O)C(C)(C)CCBr", "a9"], ["CCCC(F)CC", "a0"]
  ])("refuses assigned or potential stereo in %s", async (smiles, anchor) => {
    await expect(mark(await drawSmiles(smiles), [anchor])).rejects.toThrow(drawByHand);
  });

  it.each([
    ["C1CCCCC1", ["a0", "a3"], "non-aromatic ring"],
    ["CC1CCC(C)CC1", ["a0"], "non-aromatic ring"],
    ["c1ccc2c(c1)CCCC2", ["a0"], "non-aromatic ring"],
    ["CC=C=CC", ["a0"], "cumulated double bonds"],
    ["O=C=Cc1ccccc1", ["a4"], "cumulated double bonds"],
    ["CN=C=Nc1ccccc1", ["a5"], "cumulated double bonds"],
    ["Cc1ccccc1", ["a2", "a0"], "not an RDKit-aromatic carbon"]
  ] as const)("refuses the whole batch in %s", async (smiles, anchors, reason) => {
    const mol = await drawSmiles(smiles);
    const original = structuredClone(mol);
    await expect(mark(mol, [...anchors])).rejects.toThrow(new RegExp(`${reason}.*Draw X by hand\\.`));
    expect(mol).toEqual(original);
  });

  it("refuses a stale stored stereo assignment on ethane", async () => {
    const mol = await drawSmiles("CC");
    mol.chemistry = { stereochemistry: ["a0:R"], isotopeLabels: [], warnings: [] };
    const original = structuredClone(mol);
    await expect(mark(mol)).rejects.toThrow(/stored stereochemistry.*Draw X by hand\./);
    expect(mol).toEqual(original);
  });

  it.each([false, true])("refuses a CDXML allene with AS=R (source record only: %s)", async sourceOnly => {
    const { document } = openChemDraftPayload(`<CDXML><page id="1"><fragment id="2">
      <n id="3" p="60 60"/><n id="4" p="80 80"/><n id="5" p="110 80" AS="R"/>
      <n id="6" p="140 80"/><n id="7" p="160 100"/>
      <b id="8" B="3" E="4"/><b id="9" B="4" E="5" Order="2"/>
      <b id="10" B="5" E="6" Order="2"/><b id="11" B="6" E="7"/>
      </fragment></page></CDXML>`);
    const mol = { ...document!.pages[0]!.objects.find(object => object.type === "molecule")!, id: request.objectId };
    expect(mol.chemistry?.stereochemistry).toEqual([`${mol.atoms[2]!.id}:R`]);
    if (sourceOnly) delete mol.chemistry;
    const original = structuredClone(mol);
    const reason = sourceOnly ? /retained source stereochemistry attributes/ : /stored stereochemistry/;
    await expect(mark(mol, [mol.atoms[0]!.id])).rejects.toThrow(new RegExp(`${reason.source}.*Draw X by hand\\.`));
    expect(mol).toEqual(original);
  });

  it("refuses an AS attribute retained only in a CDXML abbreviation source node", async () => {
    const mol = await drawSmiles("c1ccccc1");
    const { document } = openChemDraftPayload(`<CDXML><page id="1"><fragment id="2">
      <n id="3" p="60 60" NodeType="Nickname" AS="U"><t><s>C</s></t></n>
      </fragment></page></CDXML>`);
    const imported = document!.pages[0]!.objects.find(object => object.type === "molecule")!;
    expect(imported.chemistry?.stereochemistry).toBeUndefined();
    expect(imported.compatibility?.unknown.cdxmlAbbreviations).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ attrs: expect.objectContaining({ AS: "U" }) }) })
    ]);
    mol.compatibility = imported.compatibility;
    const original = structuredClone(mol);
    await expect(mark(mol)).rejects.toThrow(/retained source stereochemistry attributes.*Draw X by hand\./);
    expect(mol).toEqual(original);
  });

  it.each([
    ["c1ccccc1", ["a0", "a3"]],
    ["c1ccc(-c2ccccc2)cc1", ["a0", "a7"]],
    ["c1ccc2ccccc2c1", ["a0", "a5"]],
    ["c1ccncc1", ["a0", "a4"]],
    ["c1(-c2ccccc2)cc(-c2ccccc2)cc(-c2ccccc2)c1", ["a3", "a11", "a19"]],
    ["c1ccccc1Cc1ccccc1", ["a0", "a10"]],
    ["Cc1ccccc1", ["a2", "a5"]]
  ] as const)(
    "marks aromatic carbons on linker %s", async (smiles, anchors) => {
      const mol = await drawSmiles(smiles);
      const marked = (await mark(mol, [...anchors])).pages[0]!.objects[0] as MoleculeObject;
      expect(marked.atoms.filter(atom => atom.element === "X")).toHaveLength(anchors.length);
      expect(marked.bonds.slice(mol.bonds.length).map(bond => bond.fromAtomId)).toEqual(anchors);
    });

  it("preserves warnings and a stated H count away from the anchor", async () => {
    const mol = await drawSmiles("c1ccccc1C");
    mol.atoms[6] = { ...mol.atoms[6]!, hydrogenCount: 3, warningSuppressed: true };
    mol.chemistry = { stereochemistry: [], warnings: [{ code: "test.annotation", message: "Retained annotation" }], isotopeLabels: [] };
    const marked = (await mark(mol)).pages[0]!.objects[0] as MoleculeObject;
    expect(marked.atoms.slice(0, mol.atoms.length)).toEqual(mol.atoms);
    expect(marked.bonds.slice(0, mol.bonds.length)).toEqual(mol.bonds);
    expect(marked.chemistry?.warnings).toEqual(mol.chemistry.warnings);
  });
});

describe("connection point patch preparation", () => {
  it.each(["replacement", "in-place change", "empty override", "wrong page override", "late replacement"])("refuses %s before applying the patch", async condition => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    const doc = selected(mol);
    const build = vi.fn((...args: Parameters<typeof buildConnectionPointsPatch>) => {
      const patch = buildConnectionPointsPatch(...args);
      if (condition === "late replacement") doc.pages[0]!.objects[0] = molecule(["N", "C"], [[0, 1]]);
      return patch;
    });
    const apply = vi.fn(() => ({ applied: true as const, objectIds: [mol.id] }));
    const host = new PluginHost({ getActiveDocument: () => doc, buildConnectionPointsPatch: build, applyDocumentPatch: apply });
    const commandId = "plugin.mark.scope";
    host.registerPlugin({ id: "org.test.mark", name: "Mark", version: "1", entry: "main.js", apiVersion: PluginApiVersion,
      permissions: ["document.write"], contributes: { commands: [{ id: commandId, title: "Mark" }] } }, {
      commandHandlers: { [commandId]: context => {
        if (condition === "replacement") doc.pages[0]!.objects[0] = molecule(["N", "C"], [[0, 1]]);
        if (condition === "in-place change") mol.atoms[0]!.element = "N";
        return context.documents.addConnectionPoints!({ ...request, anchors: ["a0"] });
      } }
    });
    const writeSelection = condition.endsWith("override") ? { pageId: condition === "wrong page override" ? "p2" : "p1",
      objectIds: condition === "empty override" ? [] : [mol.id], molecules: [] } : undefined;
    await expect(host.invokeCommand(commandId, { writeSelection })).rejects.toThrow(/changed|write scope/);
    expect(build).toHaveBeenCalledTimes(condition === "late replacement" ? 1 : 0);
    expect(apply).not.toHaveBeenCalled();
  });

  it("accepts a content-equivalent molecule and a matching explicit page scope", async () => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    const doc = selected(mol);
    const receipt = { applied: true as const, objectIds: [mol.id] };
    const apply = vi.fn(() => receipt);
    const host = new PluginHost({ getActiveDocument: () => doc, buildConnectionPointsPatch, applyDocumentPatch: apply });
    const commandId = "plugin.mark.scope";
    host.registerPlugin({ id: "org.test.mark", name: "Mark", version: "1", entry: "main.js", apiVersion: PluginApiVersion,
      permissions: ["document.write"], contributes: { commands: [{ id: commandId, title: "Mark" }] } }, {
      commandHandlers: { [commandId]: context => {
        doc.pages[0]!.objects[0] = structuredClone(mol);
        return context.documents.addConnectionPoints!({ ...request, anchors: ["a0"] });
      } }
    });
    await expect(host.invokeCommand(commandId, { writeSelection: { pageId: "p1", objectIds: [mol.id], molecules: [] } })).resolves.toEqual(receipt);
    expect(apply).toHaveBeenCalledOnce();
  });
  it("uses the suggestion coordinates for every new X and preserves the existing graph", () => {
    const doc = selected(molecule(["C", "C"], [[0, 1]]));
    const mol = doc.pages[0]!.objects[0] as MoleculeObject;
    const input = { ...request, anchors: ["a0", "a1"] };
    const suggestions = suggestConnectionPointsForPlugin(input, doc);
    const { patch, atomIds } = buildConnectionPointsPatch(input, mol, doc.pages[0]!);
    expect(patch).toMatchObject({ reason: "Mark connection points", patch: { op: "updateObject", objectId: mol.id,
      changes: { atoms: [...mol.atoms, ...suggestions.points.map(({ x, y }, i) => ({ id: atomIds[i], element: "X", x, y, formalCharge: 0 }))],
        bonds: [...mol.bonds, ...input.anchors.map((fromAtomId, i) =>
          ({ fromAtomId, toAtomId: atomIds[i], order: "single" }))] } } });
  });

  it.each([
    [molecule(["C", "C"], [[0, 1]]), ["a0", "missing"], /"missing".*no drawn atom/],
    [molecule(["C", "C"], [[0, 1]]), ["a0", "a0"], /"a0".*repeated/],
    [molecule(["C", "X"], [[0, 1]]), ["a1"], /"a1".*already an X/],
    [molecule(["C", "X"], [[0, 1]]), ["a0"], /"a0".*already bears an X/],
    [molecule(["C", "C", "C", "C", "C"], [[0, 1], [0, 2], [0, 3], [0, 4]]), ["a0"], /"a0".*no free valence/],
    [molecule([]), ["a0"], /"a0".*no editable/]
  ] as const)("refuses missing, duplicate, marked, saturated, and uneditable anchors", (mol, anchors, error) => {
    const doc = selected(mol);
    const before = structuredClone(doc);
    expect(() => buildConnectionPointsPatch({ ...request, anchors: [...anchors] }, mol, doc.pages[0]!)).toThrow(error);
    expect(doc).toEqual(before);
  });

  it("names the anchor when its molecule is a reaction member or contains a superatom", () => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    const reaction: ReactionObject = { ...frame, id: "reaction", type: "reaction", mappingState: "absent",
      components: [{ objectId: mol.id, role: "reactant" }], conditionsTextObjectIds: [] };
    const input = { ...request, anchors: ["a0"] };
    const reactionDocument = selected(mol, reaction);
    expect(() => buildConnectionPointsPatch(input, mol, reactionDocument.pages[0]!)).toThrow(/"a0".*belongs to a reaction/);
    const superatom = { ...mol, superatoms: [{ label: "Et", atomIds: ["a0", "a1"], attachmentPoints: [], warnings: [] }] };
    expect(() => buildConnectionPointsPatch(input, superatom, selected(mol).pages[0]!)).toThrow(/"a0".*superatom/);
  });

  it("requires document.write and refuses a retained method or a molecule selected after the command started", async () => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    let doc = { ...selected(mol), selection: { pageId: "p1", objectIds: [] as string[] } };
    const host = new PluginHost({ getActiveDocument: () => doc, buildConnectionPointsPatch,
      applyDocumentPatch: () => { throw new Error("A refused command must not apply a patch."); } });
    const input = { ...request, anchors: ["a0"] };
    const commandId = "plugin.mark.write";
    const manifest = { id: "org.test.mark", name: "Mark", version: "1", entry: "main.js", apiVersion: PluginApiVersion,
      contributes: { commands: [{ id: commandId, title: "Mark" }] } };
    host.registerPlugin({ ...manifest, permissions: [] },
      { commandHandlers: { [commandId]: context => expect(context.documents.addConnectionPoints).toBeUndefined() } });
    await host.invokeCommand(commandId);
    host.unregisterPlugin(manifest.id);

    let retained!: NonNullable<PluginCommandContext["documents"]["addConnectionPoints"]>;
    host.registerPlugin({ ...manifest, permissions: ["document.write"] }, { commandHandlers: {
      [commandId]: context => {
        retained = context.documents.addConnectionPoints!;
        doc = { ...doc, selection: { pageId: "p1", objectIds: [mol.id] } };
        return retained(input);
      }
    } });
    await expect(host.invokeCommand(commandId, { writeSelection: { pageId: "p1", objectIds: [mol.id], molecules: [] } }))
      .rejects.toThrow(/"m1" was not selected when the command started/);
    await expect(retained(input)).rejects.toThrow(/active command owned by the plugin/);
  });
});

describe("selected handoff graph from the live drawing", () => {
  it("reports RDKit's unspecified centers and either double bonds in graph order", async () => {
    const mol = molecule(["C", "F", "Cl", "Br", "C", "C", "C", "C"], [[0, 1], [0, 2], [0, 3], [4, 5], [5, 6, "double"], [6, 7]]);
    mol.bonds[4]!.stereo = "either";
    mol.bonds[0]!.display = { bondStyle: "wavy" };
    const result = await audit(selected(mol));
    expect(result.unspecifiedStereocenters).toEqual([0]);
    expect(result.unspecifiedDoubleBonds).toEqual([4]);
    expect(result.graph.bonds[0]).toMatchObject({ drawnStereo: { style: "wavy", from: 0 } });
    expect(result.graph.bonds[4]).toMatchObject({ a: 5, b: 6, order: 2, stereo: "either" });
  });

  it("uses RDKit to find a potential double bond with no explicit either flag", async () => {
    const mol = molecule(["C", "C", "C", "C"], [[0, 1], [1, 2, "double"], [2, 3]]);
    mol.atoms.forEach(atom => { atom.y = 100; });
    expect((await audit(selected(mol))).unspecifiedDoubleBonds).toEqual([1]);
    const symmetric = molecule(["C", "C", "C"], [[0, 1], [1, 2, "double"]]);
    expect((await audit(selected(symmetric))).unspecifiedDoubleBonds).toEqual([]);
  });

  it("retains native reaction roles, opaque CDXML mappings, and CTAB map numbers with source indices", async () => {
    const mol = molecule(["C", "O"], [[0, 1]]);
    const ctab = chemicalIdentityMolfile(mol).split("\n");
    ctab[4] = ctab[4]!.slice(0, 60) + "  7" + ctab[4]!.slice(63);
    mol.structureFormat = "molfile-v2000";
    mol.structure = ctab.join("\n");
    const reaction: ReactionObject = { ...frame, type: "reaction", id: "reaction", mappingState: "unknown",
      components: [{ objectId: mol.id, role: "reactant" }, { objectId: "other", role: "product" }],
      conditionsTextObjectIds: ["condition"], compatibility: { warnings: [], unknown: {
        cdxmlStepAttributes: { ReactionStepAtomMap: "101 301", ReactionStepAtomMapManual: "101 301" }
      } } };
    const result = await audit(selected(mol, reaction));
    expect(result.reactionMembership).toEqual([{ reactionId: "reaction", role: "reactant", mappingState: "unknown",
      atomMaps: [{ attribute: "ReactionStepAtomMap", value: "101 301" }, { attribute: "ReactionStepAtomMapManual", value: "101 301" }]
    }]);
    expect(result.sourceAtomMaps).toEqual([{ atom: 1, map: 7 }]);
    expect(result.canonicalSmiles).toBe("CO");
  });

  it("retains atom map indices after wrapped V3000 atom records", () => {
    const mol = molecule(["C", "O"], [[0, 1]]);
    mol.structureFormat = "molfile-v3000";
    mol.structure = [
      "Test", "", "", "  0  0  0     0  0            999 V3000",
      "M  V30 BEGIN CTAB", "M  V30 COUNTS 2 1 0 0 0", "M  V30 BEGIN ATOM",
      "M  V30 1 C 0 0 0 4-", "M  V30 2 -", "M  V30 CFG=0",
      "M  V30 2 O 1 0 0 20", "M  V30 END ATOM", "M  V30 BEGIN BOND",
      "M  V30 1 1 1 2", "M  V30 END BOND", "M  V30 END CTAB", "M  END"
    ].join("\r\n");
    expect(prepareHandoffGraph(request, selected(mol)).sourceAtomMaps)
      .toEqual([{ atom: 1, map: 42 }, { atom: 2, map: 20 }]);
  });

  it("refuses radical, unknown-bond and writer losses with specific reasons", () => {
    const radical = molecule(["C"]);
    radical.atoms[0]!.markRadicals = 3;
    expect(() => prepareHandoffGraph(request, selected(radical))).toThrow(/a0 has 3 radical electrons/);
    const unknown = molecule(["C", "O"], [[0, 1, "unknown"]]);
    expect(() => prepareHandoffGraph(request, selected(unknown))).toThrow(/b0/);
    expect(() => prepareHandoffGraph(request, selected(molecule(["C", "Ome"], [[0, 1]])))).toThrow(/"Ome"/);
    expect(() => prepareHandoffGraph(request, selected(molecule([])))).toThrow(/no live drawn graph.*fallback/);
    expect(() => prepareHandoffGraph(request, selected(molecule(Array.from({ length: 1000 }, () => "C")))))
      .toThrow(/V2000 supports at most 999 atoms.*fallback/);
  });

  it("expands known labels, preserves isotopes, H counts, charges and radicals, and matches drawn canonical SMILES", async () => {
    const mol = molecule(["C", "OMe", "D", "Na", "O", "C"], [[0, 1], [0, 2]]);
    mol.atoms[3]!.formalCharge = 1;
    mol.atoms[4]!.formalCharge = -1;
    mol.atoms[5]!.markRadicals = 1;
    const result = await audit(selected(mol));
    const independent = (await ensureRdkit()).get_mol(chemicalIdentityMolfile(mol), '{"removeHs":false}')!;
    try { expect(result.canonicalSmiles).toBe(independent.get_smiles!()); }
    finally { independent.delete(); }
    expect(result.canonicalSmiles).not.toBe(mol.structure);
    expect(result.expandedLabels).toEqual([{ label: "OMe", atomId: "a1" }]);
    expect(result.graph.atoms).toHaveLength(7);
    expect(result.graph.atoms[0]).toMatchObject({ explicitHydrogenCount: 1, hydrogenCount: 2 });
    expect(result.graph.atoms[1]).toMatchObject({ drawnLabel: "OMe", element: "O" });
    expect(result.graph.atoms[2]).toMatchObject({ drawnLabel: "D", element: "H", isotope: 2 });
    expect(result.graph.atoms[3]).toMatchObject({ element: "Na", charge: 1 });
    expect(result.graph.atoms[5]).toMatchObject({ radicalElectrons: 1 });
  });

  it("keeps exact X placeholders separate from R-groups and preserves replacements through graph embedding", async () => {
    const mol = molecule(["C", "C", "C", "C", "C", "C", "X", "X"],
      [[0, 1, "aromatic"], [1, 2, "aromatic"], [2, 3, "aromatic"], [3, 4, "aromatic"],
        [4, 5, "aromatic"], [5, 0, "aromatic"], [0, 6], [3, 7]]);
    const graph = (await audit(selected(mol))).graph;
    expect(graph.atoms.filter(atom => atom.isConnectionPoint).map(atom => atom.drawnLabel)).toEqual(["X", "X"]);
    await expect(providers.embed3d({ components: [{ graph }] }, signal())).rejects.toThrow(/replace connection point/);
    const input = { ...graph, atoms: graph.atoms.map(atom => atom.isConnectionPoint ? { ...atom, element: "H" } : atom) };
    const embedded = await providers.embed3d({ components: [{ graph: input }, { smiles: "O" }] }, signal());
    expect(embedded.model.atoms.slice(0, 8).map(atom => [atom.element, atom.addedHydrogen]))
      .toEqual([...Array.from({ length: 6 }, () => ["C", false]), ["H", false], ["H", false]]);
    expect(embedded.model.bonds.filter(bond => bond.order === "aromatic")).toHaveLength(6);
    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: false }, signal());
    expect(minimized.model.atoms).toEqual(embedded.model.atoms);
    expect(minimized.model.bonds).toEqual(embedded.model.bonds);
    mol.atoms[7]!.element = "R1";
    expect(() => prepareHandoffGraph(request, selected(mol))).toThrow(/"R1"/);
  });

  it("preserves assigned stereo when graph order is different from canonical SMILES traversal", async () => {
    const mol = molecule(["Br", "Cl", "F", "C"], [[3, 0], [3, 1], [3, 2]]);
    mol.atoms[0] = { ...mol.atoms[0]!, x: 50, y: 140 };
    mol.atoms[1] = { ...mol.atoms[1]!, x: 115, y: 140 };
    mol.atoms[2] = { ...mol.atoms[2]!, x: 80, y: 65 };
    mol.atoms[3] = { ...mol.atoms[3]!, x: 80, y: 100 };
    mol.bonds[0]!.display = { bondStyle: "wedge" };
    const result = await audit(selected(mol));
    expect(result.canonicalSmiles).toContain("@");
    expect(result.graph.atoms[3]!.stereo).toBeDefined();
    const embedded = await providers.embed3d({ components: [{ graph: result.graph }] }, signal());
    expect(embedded.model.atoms.slice(0, 4).map(atom => atom.element)).toEqual(["Br", "Cl", "F", "C"]);
    const flat = await providers.flatten3d({ model: embedded.model, view: "auto" }, signal());
    expect(flat.objects[0]).toMatchObject({ type: "molecule" });
  });

  it("refuses a graph that RDKit cannot sanitize", async () => {
    const atom = { element: "C", charge: 0, radicalElectrons: 0, hydrogenCount: 5 };
    await expect(providers.embed3d({ components: [{ graph: { atoms: [atom], bonds: [] } }] }, signal()))
      .rejects.toThrow(/could not sanitize/);
  });

  it("carries specified E/Z through graph embedding and minimization", async () => {
    const mol = molecule(["C", "C", "C", "C"], [[0, 1], [1, 2, "double"], [2, 3]]);
    ([[50, 140], [80, 110], [110, 110], [140, 80]] as const).forEach(([x, y], i) => Object.assign(mol.atoms[i]!, { x, y }));
    const result = await audit(selected(mol));
    expect(result.canonicalSmiles).toBe("C/C=C/C");
    expect(result.unspecifiedDoubleBonds).toEqual([]);
    expect(result.graph.bonds[1]).toMatchObject({ stereo: "trans", stereoAtoms: [0, 3] });
    const embedded = await providers.embed3d({ components: [{ graph: result.graph }] }, signal());
    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: false }, signal());
    expect(minimized.model.components[0]!.smiles).toBe(result.canonicalSmiles);
  });

  it("places new X atoms with the bond tool's styled click direction and rejects unknown anchors", () => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    const doc = selected(mol);
    const page = doc.pages[0]!;
    const style = nativeDrawingStyleFromObjectStyle(mol.style);
    const plan = planBondExtension({ atoms: mol.atoms, bonds: mol.bonds, clickPoint: mol.atoms[1]!,
      bondLength: style.bondLengthPx, targetBondAngleDegrees: style.chainAngleDegrees,
      preferredAtomId: "a1", hitRadius: 8, pageBounds: { x: 0, y: 0, width: page.width, height: page.height } });
    const result = suggestConnectionPointsForPlugin({ ...request, anchors: ["a1", "a0"] }, doc);
    expect(result.points[0]).toEqual({ anchorAtomId: "a1", ...plan!.newAtomPoint });
    expect(result.points[1]!.anchorAtomId).toBe("a0");
    expect(() => suggestConnectionPointsForPlugin({ ...request, anchors: ["unknown"] }, doc)).toThrow(/unknown/);
    expect(mol.atoms).toHaveLength(2);
  });
});
