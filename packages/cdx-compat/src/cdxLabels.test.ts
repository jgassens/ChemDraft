import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  expandNativeMoleculeLabelGroups, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles
} from "../../document-workflow-core/src/index";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { cdxElementFromOrderedTree, cdxElementToCdxml, readCdx, writeCdx } from "./cdxBinary";
import { XMLParser } from "fast-xml-parser";
import { canonicalVisibleCdxml, exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

type Shape = "chain" | "ring" | "linker" | "metal" | "peptide";
const fixtures: [string, Shape][] = [
  ["SO2", "chain"], ["NMe", "ring"], ["(CH2)3", "linker"], ["Pd(OAc)", "metal"],
  ["Arg", "peptide"], ["D-Leu", "peptide"], ["Trp", "peptide"], ["Glu", "peptide"], ["D-Met", "peptide"],
  ["CO", "chain"], ["COO", "chain"], ["CHCO2", "chain"], ["O2", "chain"], ["O3", "chain"]
];
const cdxFixtures: [string, Shape][] = [
  ...fixtures, ["2-Me", "chain"], ["+NMe2", "chain"], [".5Linker", "chain"]
];

/** Synthetic native graphs: the text tool stores the label in element with labelLiteral=true.
 * Expansions are derived by document-workflow-core, never extra stored, unbonded atoms.
 */
function labelledDocument(label: string, shape: Shape): ChemDraftDocument {
  const document = createEmptyDocument({ title: `Synthetic ${label} ${shape}` });
  const atoms: MoleculeObject["atoms"] = [];
  const bonds: MoleculeObject["bonds"] = [];
  const atom = (element: string, x: number, y: number, literal = false) => {
    const id = `a${atoms.length}`;
    atoms.push({ id, element, x, y, formalCharge: 0, ...(literal ? { labelLiteral: true } : {}) });
    return id;
  };
  const bond = (fromAtomId: string, toAtomId: string, order: "single" | "double" = "single") =>
    bonds.push({ id: `b${bonds.length}`, fromAtomId, toAtomId, order });
  const ring = (cx: number) => {
    const ids = Array.from({ length: 6 }, (_, k) =>
      atom(shape === "ring" && k === 0 ? label : "C", cx + 30 * Math.cos(k * Math.PI / 3),
        100 + 30 * Math.sin(k * Math.PI / 3), shape === "ring" && k === 0));
    ids.forEach((id, k) => bond(id, ids[(k + 1) % ids.length]!));
    return ids;
  };
  if (shape === "ring") ring(100);
  else if (shape === "linker") {
    const left = ring(50), right = ring(200);
    const labelled = atom(label, 125, 100, true);
    bond(left[0]!, labelled);
    bond(labelled, right[3]!);
  } else {
    const left = atom(shape === "metal" ? "P" : "C", 60, 100);
    const labelled = atom(label, 90, 100, true);
    const right = atom(shape === "metal" ? "N" : shape === "peptide" ? "N" : "C", 120, 100);
    bond(left, labelled);
    bond(labelled, right);
    if (shape === "peptide") {
      bond(atom("C", 30, 100), left);
      bond(left, atom("O", 60, 70), "double");
      bond(right, atom("C", 150, 100));
    }
  }
  document.pages[0]!.objects.push({
    id: "synthetic", type: "molecule", x: 0, y: 0, width: 250, height: 150, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  });
  return document;
}

function moleculeOf(result: ReturnType<typeof openChemDraftPayload>): MoleculeObject {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  expect(result.document!.pages[0]!.objects).toHaveLength(1);
  const molecule = result.document!.pages[0]!.objects[0]!;
  expect(molecule.type).toBe("molecule");
  return molecule as MoleculeObject;
}

// Coordinates identify the same drawn attachment atoms across imported/native ID namespaces.
const position = (atom: MoleculeObject["atoms"][number]) => `${atom.x.toFixed(3)},${atom.y.toFixed(3)}`;
function graph(molecule: MoleculeObject) {
  const byId = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return {
    atoms: molecule.atoms.map((atom) => [position(atom), atom.element, atom.formalCharge, atom.isotope, atom.markRadicals ?? 0]).sort(),
    bonds: molecule.bonds.map((bond) => [
      [position(byId.get(bond.fromAtomId)!), position(byId.get(bond.toAtomId)!)].sort(), bond.order, bond.stereo
    ]).sort()
  };
}

async function canonical(molecule: MoleculeObject) {
  // Known groups (e.g. NMe) expand through the app's actual grammar. Unresolved labels use the
  // native writer's explicit dummy atom; graph() separately checks their full text/attachments.
  const identifiers = await computeStructureIdentifiers(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds));
  expect(identifiers?.smiles).toBeTruthy();
  return identifiers!.smiles;
}

async function expectUnchanged(actual: MoleculeObject, original: MoleculeObject, label: string) {
  expect(actual.atoms).toHaveLength(original.atoms.length);
  expect(actual.bonds).toHaveLength(original.bonds.length);
  const labelled = actual.atoms.filter((atom) => atom.element === label);
  expect(labelled).toHaveLength(1);
  expect(actual.bonds.filter((bond) => bond.fromAtomId === labelled[0]!.id || bond.toAtomId === labelled[0]!.id)).toHaveLength(2);
  expect(actual.atoms.filter((atom) => !actual.bonds.some((bond) => bond.fromAtomId === atom.id || bond.toAtomId === atom.id))).toEqual([]);
  expect(graph(actual)).toEqual(graph(original));
  expect(nativeSingleBondGraphMetadata(actual.atoms, actual.bonds)).toMatchObject({
    formula: nativeSingleBondGraphMetadata(original.atoms, original.bonds).formula
  });
  expect(await canonical(actual)).toBe(await canonical(original));
  const expanded = expandNativeMoleculeLabelGroups(actual);
  const expectedExpanded = expandNativeMoleculeLabelGroups(original);
  expect(expanded.molecule.atoms).toHaveLength(expectedExpanded.molecule.atoms.length);
  expect(expanded.molecule.bonds).toHaveLength(expectedExpanded.molecule.bonds.length);
}

describe("synthetic multi-atom labels and attachment atoms", () => {
  for (const [label, shape] of fixtures) {
    const document = labelledDocument(label, shape);
    const original = document.pages[0]!.objects[0] as MoleculeObject;
    it(`already preserves ${label} in a ${shape} through visible CDXML`, async () => {
      const result = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
      expect(result.source).toBe("external-cdxml");
      await expectUnchanged(moleculeOf(result), original, label);
    });
  }
  for (const [label, shape] of cdxFixtures) {
    const document = labelledDocument(label, shape);
    const original = document.pages[0]!.objects[0] as MoleculeObject;
    it(`preserves ${label} in a ${shape} through visible CDX without native metadata`, async () => {
      const exported = exportDocumentToCdx(document, { embedNativePayload: false });
      expect(exported.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "cdx.atom_label_unexpanded", message: expect.stringContaining(`"${label}"`) })
      ]));
      expect(exported.warnings.some((warning) => warning.message.includes("unencodable attribute Element"))).toBe(false);
      const result = importCdx(exported.bytes);
      expect(result.source).toBe("external-cdxml");
      await expectUnchanged(moleculeOf(result), original, label);
    });
    it(`saves and reopens ${label} in a ${shape} as the exact native document`, async () => {
      const result = importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes);
      expect(result.source).toBe("native-payload");
      expect(result.document).toEqual(document);
      await expectUnchanged(moleculeOf(result), original, label);
    });
  }
});

const xmlTree = (content: string) => cdxElementFromOrderedTree(new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
}).parse(`<CDXML><page id="1"><fragment id="2">${content}</fragment></page></CDXML>`));

describe("standard binary nickname nodes and fragment attachment points", () => {
  const u16 = (n: number) => [n & 255, n >>> 8 & 255];
  const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
  const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
  const object = (tag: number, id: number, ...data: number[][]) => [...u16(tag), ...u32(id), ...data.flat(), 0, 0];
  // Independently encoded bytes: these cases do not use writeCdx or its NodeType table.
  const binaryNickname = (nodeType: number, nickname?: number[]) => new Uint8Array([
    ...new TextEncoder().encode("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0),
    ...object(0x8000, 0, object(0x8001, 1, object(0x8003, 2,
      object(0x8004, 10),
      object(0x8004, 11, property(0x0400, u16(nodeType)),
        ...(nickname
          ? [property(0x0433, nickname)]
          : [object(0x8006, 12, property(0x0700, [0, 0, ...new TextEncoder().encode("NMe")]))])),
      object(0x8004, 13),
      object(0x8005, 14, property(0x0604, u32(10)), property(0x0605, u32(11))),
      object(0x8005, 15, property(0x0604, u32(11)), property(0x0605, u32(13)))
    )))
  ]);

  it.each([4, 5, 6, 7, 14])("reads NodeType=%s text as the bonded label, without another atom", (nodeType) => {
    const opened = importCdx(binaryNickname(nodeType));
    const molecule = moleculeOf(opened);
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "NMe", "C"]);
    expect(molecule.atoms[1]!.labelLiteral).toBe(true);
    expect(molecule.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId])).toEqual([
      [molecule.atoms[0]!.id, molecule.atoms[1]!.id], [molecule.atoms[1]!.id, molecule.atoms[2]!.id]
    ]);
  });

  it.each([
    ["zero style runs", [0, 0, 0x4e, 0x4d, 0x65]],
    ["two style runs", [2, 0, ...[0, 0xffff, 1, 240, 3, 1, 0xffff, 0, 200, 3].flatMap(u16), 0x4e, 0x4d, 0x65]]
  ] as const)("reads a spec CDXString nickname with %s without a text object", (_, data) => {
    const bytes = binaryNickname(7, [...data]);
    expect(readCdx(bytes).kids[0]!.kids[0]!.kids[1]!.attrs.GenericNickname).toBe("NMe");
    const molecule = moleculeOf(importCdx(bytes));
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "NMe", "C"]);
    expect(molecule.atoms[1]!.labelLiteral).toBe(true);
    expect(molecule.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId])).toEqual([
      [molecule.atoms[0]!.id, molecule.atoms[1]!.id], [molecule.atoms[1]!.id, molecule.atoms[2]!.id]
    ]);
  });

  it("keeps a nameless nickname unknown and warns instead of inventing carbon", () => {
    const root = xmlTree('<n id="10" NodeType="GenericNickname"/>');
    const opened = importCdx(writeCdx(root));
    expect(moleculeOf(opened).atoms[0]!.element).toBe("*");
    expect(opened.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cdxml.abbreviation_not_expanded", message: expect.stringContaining("neither label text nor an expanded atom graph") })
    ]));
  });

  it("encodes a text label on one existing node with unique text-object IDs and unchanged bond references", () => {
    const root = xmlTree('<n id="left"/><n id="label" Element="SO2"/><n id="right"/>' +
      '<b id="first" B="left" E="label"/><b id="second" B="label" E="right"/>');
    const unchanged = structuredClone(root);
    const decoded = readCdx(writeCdx(root));
    expect(root).toEqual(unchanged);
    const fragment = decoded.kids[0]!.kids[0]!;
    const nodes = fragment.kids.filter((child) => child.name === "n");
    const bonds = fragment.kids.filter((child) => child.name === "b");
    expect(nodes).toHaveLength(3);
    expect(nodes[1]!.attrs).toMatchObject({ NodeType: "GenericNickname", GenericNickname: "SO2" });
    expect(nodes[1]!.attrs.Element).toBeUndefined();
    expect(nodes[1]!.kids[0]!.kids[0]!.text).toBe("SO2");
    expect(bonds.map((bond) => [bond.attrs.B, bond.attrs.E])).toEqual([
      [nodes[0]!.attrs.id, nodes[1]!.attrs.id], [nodes[1]!.attrs.id, nodes[2]!.attrs.id]
    ]);
    const ids = [decoded, decoded.kids[0]!, fragment, ...nodes, ...bonds, nodes[1]!.kids[0]!].map((child) => child.attrs.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("expands a nested fragment and removes its external connection pseudo-atom exactly once", async () => {
    const root = xmlTree(`<n id="left" p="0 0"/><n id="group" p="30 0" NodeType="Fragment" Element="NMe">
      <fragment id="body"><n id="n" Element="7" p="30 0"/><n id="methyl" p="30 30"/>
        <n id="connection" NodeType="ExternalConnectionPoint"/><b id="inside" B="n" E="methyl"/>
        <b id="attachment" B="connection" E="n"/></fragment><t><s>NMe</s></t></n>
      <n id="right" p="60 0"/><b id="first" B="left" E="group"/><b id="second" B="group" E="right"/>`);
    const control = moleculeOf(openChemDraftPayload(cdxElementToCdxml(root)));
    const result = moleculeOf(importCdx(writeCdx(root)));
    expect(result.atoms.map((atom) => atom.element)).toEqual(["C", "N", "C", "C"]);
    expect(result.bonds).toHaveLength(3);
    expect(graph(result)).toEqual(graph(control));
    expect(await canonical(result)).toBe(await canonical(control));
  });

  it("keeps an unresolved two-attachment fragment label on both bonds when saved again", async () => {
    const root = xmlTree(`<n id="left" p="0 0"/><n id="group" p="30 0" NodeType="Fragment">
      <fragment id="body"><n id="a" p="30 0"/><n id="b" p="45 0"/>
        <n id="cp1" NodeType="ExternalConnectionPoint"/><n id="cp2" NodeType="ExternalConnectionPoint"/>
        <b id="inside" B="a" E="b"/><b id="in1" B="cp1" E="a"/><b id="in2" B="b" E="cp2"/>
      </fragment><t><s>(CH2)3</s></t></n><n id="right" p="60 0"/>
      <b id="first" B="left" E="group" BeginAttach="1"/><b id="second" B="group" E="right" EndAttach="2"/>`);
    const control = openChemDraftPayload(cdxElementToCdxml(root));
    const imported = importCdx(writeCdx(root));
    expect(graph(moleculeOf(imported))).toEqual(graph(moleculeOf(control)));
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cdxml.abbreviation_not_expanded", message: expect.stringContaining('"(CH2)3"') })
    ]));
    const reopened = importCdx(exportDocumentToCdx(imported.document!).bytes);
    await expectUnchanged(moleculeOf(reopened), moleculeOf(imported), "(CH2)3");
  });
});
